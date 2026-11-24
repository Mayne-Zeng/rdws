import { randomUUID } from 'node:crypto';
import { userInfo } from 'node:os';
import { bodyHash } from '@rdws/dsh/access';
import { maxOutputBudgetBytes } from '@rdws/dsh/execution';
import { businessError, type Actor } from './business.ts';
import {
  diffNamesProtectedPath,
  outputHead,
  outputPolicy,
  reassembleAndScrub,
} from './shell-output-handling.ts';
import { protectedWritePath } from '@rdws/dsh/write-tool-arguments';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';

type Broker = ReturnType<typeof createOwnedWriteHandoff>;
type Invocation = Parameters<Broker['execute']>[1];
// The Shell call of the first batch is T06's test mode of one file; the
// Git call is one of the two fixed read-only queries.
export type ShellRequest = Extract<
  Invocation['request'],
  { tool: 'test' } | { tool: 'git' }
>;
export type ShellToolState =
  'ready' | 'pending' | 'ok' | 'aborted' | 'failed' | 'unknown';
export type ShellStream = {
  text: string;
  truncated: boolean;
  total: number;
  // The registered continuation the model reads on (absent when the
  // output was given whole or the budget ended the process).
  spillPath?: string;
};
// §11.23 C4: the structured result of one controlled commit, produced
// by the fixed worker and confirmed by the three in-script checks.
export type CommitPathRecord = {
  path: string;
  type: string;
  digest: string | null;
};
export type CommitOutput = {
  head: string;
  parent: string;
  messageSha256: string;
  paths: CommitPathRecord[];
};
export type ShellOutput = {
  state: ShellToolState;
  outcome: 'finished' | 'refused' | 'unknown';
  exitCode: number | null;
  stdout: ShellStream;
  stderr: ShellStream;
  timedOut: boolean;
  // T06's default deadline, the one the supervisor enforces.
  timeoutMs: 10000;
  // The reason the platform itself stopped the process (the output budget).
  stopped?: string;
  reason?: string;
  // What the content handling rewrote or masked, for the evidence.
  handled?: { prefixes: number; credentials: number };
  // §11.23: the commit result of a Git commit call, and the append-only
  // snapshot row recorded for it (absent until the recording succeeded).
  commit?: CommitOutput;
  snapshot?: {
    requirementId: string;
    repositoryId: string;
    snapshotSeq: number;
    commitHash: string;
    contentDigest: string;
    commandId: string;
  };
};

// A long output is given as a head of this size and continued by read.
export const shellHeadBytes = 16 * 1024;
// The reply of write-tool-output stays under the 48 KiB cap of FD3.
const replyBudget = 44 * 1024;

const denied = () => businessError(403, '原生写工具作业未获授权');
const empty = (): ShellStream => ({ text: '', truncated: false, total: 0 });

// Splits a scrubbed stream into the directly given part and, when long,
// the registered continuation.
function splitStream(
  text: string,
  limit: number,
  register: (bytes: Buffer, from: number) => Promise<string | undefined>,
): Promise<ShellStream> {
  const total = Buffer.byteLength(text);
  if (total <= limit) return Promise.resolve({ text, truncated: false, total });
  const head = outputHead(text, limit);
  return register(Buffer.from(text), head.from).then((spillPath) => ({
    text: head.text,
    // Without a continuation (the budget or the deadline ended the
    // process) the locked renderer must not point the model at one; the
    // platform's own stop or deadline marker says why the output ends.
    truncated: spillPath !== undefined,
    total,
    ...(spillPath && { spillPath }),
  }));
}

const hash40 = /^[0-9a-f]{40}$/;
const digest64 = /^[a-f0-9]{64}$/;

// §11.23 C4: the commit call of the fixed worker. The exit code alone is
// never a success: state ok needs the structured committed record whose
// three in-script checks passed; a structured refusal is definite
// (zero commit — the worker restored the list's index state first);
// everything else stays a result unknown.
function commitShellOutput(
  result: { status: string; stop: string; exitCode: number | null },
  base: { exitCode: number | null; timeoutMs: 10000 },
  stdoutText: string,
  stderrText = '',
): ShellOutput {
  const parsed: unknown = (() => {
    try {
      return JSON.parse(stdoutText) as unknown;
    } catch {
      return undefined;
    }
  })();
  const refused = (reason: string): ShellOutput => ({
    ...base,
    state: 'failed',
    outcome: 'refused',
    reason,
    stdout: empty(),
    stderr: empty(),
    timedOut: false,
  });
  const unknownResult = (reason: string): ShellOutput => ({
    ...base,
    state: 'unknown',
    outcome: 'unknown',
    reason,
    stdout: empty(),
    stderr: empty(),
    timedOut: false,
  });
  if (result.status === 'rejected') return refused('rejected');
  if (result.stop === 'not-started') return refused('not-started');
  if (result.stop !== 'confirmed' || !['ok', 'failed'].includes(result.status))
    return unknownResult('the execution ended as ' + result.status);
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    !('stage' in parsed) ||
    typeof (parsed as { stage: unknown }).stage !== 'string'
  )
    return unknownResult(
      'the commit result could not be confirmed: ' + stderrText.slice(0, 300),
    );
  const stage = (parsed as { stage: string }).stage;
  if (stage === 'refused')
    return refused(
      'commit-refused:' +
        String((parsed as { reason?: unknown }).reason ?? 'unspecified'),
    );
  if (stage !== 'committed' || result.status !== 'ok')
    return unknownResult('the commit may have landed but was not confirmed');
  const record = parsed as {
    head?: unknown;
    parent?: unknown;
    messageSha256?: unknown;
    paths?: unknown;
  };
  if (
    typeof record.head !== 'string' ||
    !hash40.test(record.head) ||
    typeof record.parent !== 'string' ||
    !hash40.test(record.parent) ||
    typeof record.messageSha256 !== 'string' ||
    !digest64.test(record.messageSha256) ||
    !Array.isArray(record.paths) ||
    record.paths.length === 0 ||
    !record.paths.every(
      (entry) =>
        typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { path?: unknown }).path === 'string' &&
        typeof (entry as { type?: unknown }).type === 'string' &&
        ((entry as { digest?: unknown }).digest === null ||
          (typeof (entry as { digest?: unknown }).digest === 'string' &&
            digest64.test((entry as { digest: string }).digest))),
    )
  )
    return unknownResult('the commit record is not well formed');
  return {
    ...base,
    state: 'ok',
    outcome: 'finished',
    stdout: {
      text: stdoutText,
      truncated: false,
      total: Buffer.byteLength(stdoutText),
    },
    stderr: empty(),
    timedOut: false,
    commit: {
      head: record.head,
      parent: record.parent,
      messageSha256: record.messageSha256,
      paths: record.paths as CommitPathRecord[],
    },
  };
}

export class NativeShellToolJob {
  readonly commandId = randomUUID();
  private readonly scope: WriteHandoffScope;
  private readonly invocation: Invocation;
  private readonly contextVersion: number;
  private readonly controller = new AbortController();
  private authorization?: {
    digest: string;
    expiresAt: number;
    current: () => boolean;
  };
  private state: ShellToolState = 'ready';
  private output?: ShellOutput;
  private pending?: Promise<void>;
  private reading = false;
  private readonly streams = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
  private readonly hostClosed = () => this.cancel();
  private listening = true;
  private settled = false;

  constructor(
    private readonly options: {
      scope: WriteHandoffScope;
      grant: { generation: string; contextVersion: number };
      broker: Broker;
      repositoryId: string;
      request: ShellRequest;
      hostSignal: AbortSignal;
      // Told once the job reached a terminal state: the owner then drops
      // its reference, so a finished job lives only as long as its result.
      onSettled?: () => void;
      // §11.23: the append-only snapshot recording of a confirmed commit
      // (the hash is read back through the restricted read-only chain
      // inside the broker before the row is written).
      onCommit?: (input: {
        scope: WriteHandoffScope;
        repositoryId: string;
        generation: string;
        commandId: string;
        commit: CommitOutput;
      }) => Promise<unknown>;
    },
  ) {
    if (process.env.RDWS_MODE !== 'test' || process.platform !== 'darwin')
      denied();
    this.scope = structuredClone(options.scope);
    this.contextVersion = options.grant.contextVersion;
    this.invocation = {
      generation: options.grant.generation,
      commandId: this.commandId,
      repositoryId: options.repositoryId,
      request: structuredClone(options.request),
      // W10: the test mode runs under the bounded budget of 1 MiB; a Git
      // query keeps the 64 KiB default.
      ...(options.request.tool === 'test' && {
        outputLimitBytes: maxOutputBudgetBytes,
      }),
    };
    options.hostSignal.addEventListener('abort', this.hostClosed, {
      once: true,
    });
    if (options.hostSignal.aborted) this.cancel();
  }

  offer(
    who: Actor,
    requirementId: string,
    sessionId: string,
    contextVersion: number | undefined,
    digest: string,
    expiresAt: number,
    current: () => boolean,
  ) {
    if (
      this.authorization ||
      this.controller.signal.aborted ||
      this.scope.who.userId !== who.userId ||
      this.scope.who.authSessionId !== who.authSessionId ||
      this.scope.requirementId !== requirementId ||
      this.scope.sessionId !== sessionId ||
      contextVersion !== this.contextVersion
    )
      return denied();
    this.options.broker.assertWireLease(
      this.scope,
      this.invocation.generation,
      this.contextVersion,
    );
    this.authorization = { digest, expiresAt, current };
    return this.commandId;
  }

  private start() {
    if (this.state !== 'ready') return;
    const permit = this.authorization;
    const current = () =>
      permit &&
      !this.controller.signal.aborted &&
      !this.options.hostSignal.aborted &&
      permit.expiresAt > Date.now() &&
      permit.current();
    if (!permit) return denied();
    // A permit that expired, a step that moved on or a cancelled run leave
    // the late begin refused with the authority conflict of §11.20.27.
    if (!current()) businessError(409, '当前会话没有可用的写入资格');
    this.options.broker.assertWireLease(
      this.scope,
      this.invocation.generation,
      this.contextVersion,
    );
    this.state = 'pending';
    this.pending = this.options.broker
      .execute(
        this.scope,
        this.invocation,
        ({ stream, chunk }) => {
          this.streams[stream].push(Buffer.from(chunk));
        },
        this.controller.signal,
        (contextVersion) => {
          if (!current() || contextVersion !== this.contextVersion)
            this.controller.abort();
        },
      )
      .then(
        (receipt) => {
          if (receipt.status !== 'finished') {
            this.output = {
              state: 'unknown',
              outcome: 'unknown',
              reason: 'the execution could not be confirmed',
              exitCode: null,
              stdout: empty(),
              stderr: empty(),
              timedOut: false,
              timeoutMs: 10000,
            };
            this.state = 'unknown';
            this.release();
            return;
          }
          return this.finish(receipt.result)
            .then(async (output) => {
              if (output.commit) await this.recordCommit(output);
              return output;
            })
            .then(
              (output) => {
                this.output = output;
                this.state = output.state;
              },
              () => {
                this.output = {
                  state: 'unknown',
                  outcome: 'unknown',
                  reason: 'the output could not be handled',
                  exitCode: null,
                  stdout: empty(),
                  stderr: empty(),
                  timedOut: false,
                  timeoutMs: 10000,
                };
                this.state = 'unknown';
              },
            );
        },
        () => {
          this.output = {
            state: 'unknown',
            outcome: 'unknown',
            reason: 'the Broker failed',
            exitCode: null,
            stdout: empty(),
            stderr: empty(),
            timedOut: false,
            timeoutMs: 10000,
          };
          this.state = 'unknown';
        },
      )
      .finally(() => this.release());
  }

  // A terminal job keeps only its result: the raw output is dropped, the
  // host signal listener goes, and the owner forgets the job.
  private release() {
    if (this.settled) return;
    this.settled = true;
    this.streams.stdout.length = 0;
    this.streams.stderr.length = 0;
    if (this.listening) {
      this.listening = false;
      this.options.hostSignal.removeEventListener('abort', this.hostClosed);
    }
    this.options.onSettled?.();
  }

  // For the evidence: the raw bytes still held and whether the job still
  // listens to the host signal.
  get retained() {
    return {
      bytes:
        this.streams.stdout.reduce((n, c) => n + c.length, 0) +
        this.streams.stderr.reduce((n, c) => n + c.length, 0),
      listening: this.listening,
    };
  }

  // §11.23 C4/S1: after a confirmed commit the parent reads the commit
  // hash back through the restricted read-only chain and records the
  // append-only snapshot row; only then is the result a success. A
  // missing or failed recording stays a result unknown (E3): the
  // original key answers the same way on a re-query.
  private async recordCommit(output: ShellOutput) {
    const commit = output.commit;
    if (!commit) return;
    try {
      const recorded = await this.options.onCommit?.({
        scope: this.scope,
        repositoryId: this.options.repositoryId,
        generation: this.invocation.generation,
        commandId: this.commandId,
        commit,
      });
      if (
        recorded &&
        typeof recorded === 'object' &&
        'snapshot' in recorded &&
        recorded.snapshot
      ) {
        const snapshot = recorded.snapshot as {
          requirementId: string;
          repositoryId: string;
          snapshotSeq: number;
          commitHash: string;
          contentDigest: string;
        };
        output.snapshot = { ...snapshot, commandId: this.commandId };
        return;
      }
      throw new Error('the snapshot was not recorded');
    } catch {
      output.commit = undefined;
      output.snapshot = undefined;
      output.state = 'unknown';
      output.outcome = 'unknown';
      output.reason = 'the snapshot could not be recorded';
      output.stdout = empty();
      output.stderr = empty();
    }
  }

  // W18 and W10: the whole output is reassembled per stream, handled once,
  // and only then split into the directly given head and the registered
  // continuation. A run that the budget or the deadline ended carries the
  // platform's own marker; a budget end never gets a continuation.
  private async finish(result: {
    status: string;
    stop: string;
    exitCode: number | null;
  }): Promise<ShellOutput> {
    const base = {
      exitCode: result.exitCode,
      timeoutMs: 10000 as const,
    };
    if (result.status === 'rejected')
      return {
        ...base,
        state: 'failed',
        outcome: 'refused',
        reason: 'rejected',
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
      };
    if (result.stop === 'not-started')
      return {
        ...base,
        state: 'aborted',
        outcome: 'refused',
        reason: 'not-started',
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
      };
    if (
      result.stop !== 'confirmed' ||
      !['ok', 'failed', 'timeout', 'output-limit', 'aborted'].includes(
        result.status,
      )
    )
      return {
        ...base,
        state: 'unknown',
        outcome: 'unknown',
        reason: 'the execution ended as ' + result.status,
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
      };
    // W18: the prefixes of this execution. When the Broker cannot name
    // the locations the output is not given out at all (fail-closed): no
    // empty policy ever stands in for the handling.
    let locations: { tree: string; runtimeRoot: string };
    try {
      locations = await this.options.broker.executionLocations(
        this.scope,
        this.options.repositoryId,
      );
    } catch {
      return {
        ...base,
        state: 'failed',
        outcome: 'refused',
        reason: 'output-policy-unavailable',
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
      };
    }
    if (!locations?.tree || !locations?.runtimeRoot)
      return {
        ...base,
        state: 'failed',
        outcome: 'refused',
        reason: 'output-policy-unavailable',
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
      };
    const policy = outputPolicy({
      tree: locations.tree,
      runtimeRoot: locations.runtimeRoot,
      home: userInfo().homedir,
      node: process.execPath,
    });
    // Whole streams are reassembled from their chunks first and handled
    // once: a prefix or a credential split across chunks is still whole.
    const stdout = reassembleAndScrub(this.streams.stdout, policy);
    const stderr = reassembleAndScrub(this.streams.stderr, policy);
    if (this.options.request.tool === 'git') {
      // W8: a diff that names a protected location is an error without a
      // body; no omission stands in for it.
      if (
        this.options.request.operation === 'diff' &&
        diffNamesProtectedPath(stdout.text, protectedWritePath)
      )
        return {
          ...base,
          state: 'failed',
          outcome: 'refused',
          reason: 'protected-diff',
          stdout: empty(),
          stderr: empty(),
          timedOut: false,
        };
    }
    // A platform stop is stated in the result itself: the locked bash
    // renderer shows stderr in a marked section and only knows the
    // deadline and exit markers, so the budget end and a cancellation are
    // announced on stderr, the stream a process would use to say why it
    // stopped. A budget end never gets a continuation.
    const platformStop =
      result.status === 'output-limit'
        ? '[output budget reached; the process was terminated]'
        : result.status === 'aborted'
          ? '[cancelled; the process was terminated]'
          : undefined;
    const errText = platformStop
      ? platformStop + (stderr.text ? '\n' + stderr.text : '')
      : stderr.text;
    const ended =
      result.status === 'output-limit' || result.status === 'timeout';
    // §11.23 C4: a commit call is judged by the structured protocol of
    // the fixed worker, not by the exit code alone.
    if (
      this.options.request.tool === 'git' &&
      this.options.request.operation === 'commit'
    )
      return commitShellOutput(result, base, stdout.text, errText);
    const register = async (bytes: Buffer, from: number) =>
      ended
        ? undefined
        : this.options.broker
            .registerOutputSnapshot(
              this.scope,
              this.options.repositoryId,
              bytes,
              from,
            )
            .catch(() => undefined);
    let limit = shellHeadBytes;
    for (;;) {
      const out = await splitStream(stdout.text, limit, register);
      const err = await splitStream(errText, limit, register);
      const output: ShellOutput = {
        ...base,
        state: result.status === 'ok' ? 'ok' : 'failed',
        outcome: 'finished',
        stdout: out,
        stderr: err,
        timedOut: result.status === 'timeout',
        ...(platformStop && { stopped: platformStop }),
        handled: {
          prefixes: stdout.prefixes + stderr.prefixes,
          credentials: stdout.credentials + stderr.credentials,
        },
      };
      if (
        Buffer.byteLength(JSON.stringify(output)) <= replyBudget ||
        limit <= 1024
      )
        return output;
      limit = Math.floor(limit / 2);
    }
  }

  async control(
    operation: 'begin' | 'status' | 'cancel' | 'output',
    input: Record<string, unknown>,
    canRead: (scope: WriteHandoffScope) => Promise<void>,
  ) {
    const { jobId, ...body } = input;
    if (jobId !== this.commandId || !this.authorization) return denied();
    if (operation !== 'output' && bodyHash(body) !== this.authorization.digest)
      return denied();
    if (operation === 'begin') {
      this.start();
      return { accepted: true };
    }
    if (operation === 'cancel') {
      this.cancel();
      return { accepted: true };
    }
    // Status answers at once with the current state (the Host polls it
    // while a long command runs); only the output waits for the end.
    if (operation === 'status') {
      if (this.reading) return denied();
      this.reading = true;
      try {
        await canRead(this.scope);
        return { state: this.state };
      } finally {
        this.reading = false;
      }
    }
    if (this.reading) return denied();
    this.reading = true;
    try {
      await canRead(this.scope);
      await this.pending;
      return this.output ?? { state: this.state };
    } finally {
      this.reading = false;
    }
  }

  cancel() {
    this.controller.abort();
    if (this.state === 'ready') {
      this.state = 'aborted';
      this.output = {
        state: 'aborted',
        outcome: 'refused',
        reason: 'not-started',
        exitCode: null,
        stdout: empty(),
        stderr: empty(),
        timedOut: false,
        timeoutMs: 10000,
      };
      // A definite zero-execution terminal state: the job is released at
      // once, not only when the owner closes it.
      this.release();
    }
  }

  async close() {
    this.cancel();
    await this.pending;
    this.release();
    // Only a stop the Broker could not confirm keeps the job unresolved;
    // the owner must then refuse the normal hand-over (§11.20.9, §11.20.22).
    if (this.state === 'unknown')
      throw new Error('Native shell execution could not be confirmed stopped');
  }
}
