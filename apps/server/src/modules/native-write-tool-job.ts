import { createHash, randomUUID } from 'node:crypto';
import { bodyHash, isRecord } from '@rdws/dsh/access';
import type { ExecutionRequest } from '@rdws/dsh/execution';
import { literalEdit } from '@rdws/dsh/write-tool-arguments';
import { businessError, type Actor } from './business.ts';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';

type Broker = ReturnType<typeof createOwnedWriteHandoff>;
type Invocation = Parameters<Broker['execute']>[1];
export type WriteFileRequest = Extract<
  ExecutionRequest,
  { tool: 'file'; operation: 'write' | 'edit' }
>;
export type WriteToolState =
  'ready' | 'pending' | 'ok' | 'aborted' | 'failed' | 'unknown';
export type WriteRefusal =
  | 'limit'
  | 'not-found'
  | 'ambiguous'
  | 'not-utf8'
  | 'invalid'
  | 'not-started'
  | 'aborted'
  | 'rejected'
  | 'file';
export type WriteToolOutcome =
  | {
      kind: 'applied';
      existed: boolean;
      created: boolean;
      replacements?: number;
      before: Buffer | null;
      after: Buffer;
    }
  | { kind: 'refused'; reason: WriteRefusal; exitCode: number | null }
  | { kind: 'unknown'; reason: string };
export const writeToolOperations = [
  'write-tool-begin',
  'write-tool-status',
  'write-tool-cancel',
  'write-tool-output',
] as const;

const denied = () => businessError(403, '原生写工具作业未获授权');
const sha256 = (bytes: Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const refusals: Record<number, WriteRefusal> = {
  1: 'file',
  2: 'invalid',
  3: 'limit',
  4: 'not-utf8',
  5: 'not-found',
  6: 'ambiguous',
  7: 'invalid',
};

type Receipt = Record<string, unknown>;

// §11.20.27 W5: judge the two receipts of a file write tool against the
// request. The after bytes are derived here from the request and the bytes
// before (never taken from the worker) and must hash to the second receipt;
// a missing or inconsistent digest is an unknown result that never counts as
// success (R20). A nonzero exit without any receipt refused before the first
// receipt, so nothing was written.
export function judgeWriteReceipts(
  request: WriteFileRequest,
  result: { status: string; stop: string; exitCode: number | null },
  stdout: Buffer,
): WriteToolOutcome {
  const unknown = (reason: string): WriteToolOutcome => ({
    kind: 'unknown',
    reason,
  });
  if (result.status === 'rejected')
    return { kind: 'refused', reason: 'rejected', exitCode: result.exitCode };
  if (result.stop === 'not-started')
    return {
      kind: 'refused',
      reason: 'not-started',
      exitCode: result.exitCode,
    };
  if (result.stop !== 'confirmed')
    return unknown('the process could not be confirmed stopped');
  if (!['ok', 'failed'].includes(result.status)) {
    // A run the platform stopped with the stop confirmed (a cancellation,
    // the deadline): without a first receipt nothing reached the disk, which
    // is a definite refusal; with one, the file may have changed. Any other
    // ending is unknown.
    if (
      (result.status === 'aborted' || result.status === 'timeout') &&
      stdout.length === 0
    )
      return { kind: 'refused', reason: 'aborted', exitCode: result.exitCode };
    return unknown('the execution ended as ' + result.status);
  }
  let receipts: Receipt[];
  try {
    receipts = stdout
      .toString('utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Receipt);
  } catch {
    return unknown('a receipt could not be read');
  }
  if (receipts.length === 0) {
    // No first receipt: the worker never reached its rename.
    return result.status === 'ok'
      ? unknown('a success without receipts')
      : {
          kind: 'refused',
          reason: refusals[result.exitCode ?? 0] ?? 'file',
          exitCode: result.exitCode,
        };
  }
  const [before, after, ...rest] = receipts;
  if (
    !isRecord(before) ||
    before.kind !== 'before' ||
    typeof before.existed !== 'boolean' ||
    typeof before.bytes !== 'string' ||
    rest.length > 0
  )
    return unknown('the first receipt is malformed');
  let beforeBytes: Buffer | null;
  try {
    beforeBytes = Buffer.from(before.bytes, 'base64');
  } catch {
    return unknown('the bytes before the write could not be decoded');
  }
  if (beforeBytes.length !== before.size)
    return unknown('the size before differs');
  // The first receipt left, the second did not: the rename may or may not
  // have happened (R20).
  if (!isRecord(after) || after.kind !== 'after')
    return unknown('the receipt after the write is missing');
  if (result.status !== 'ok' || result.exitCode !== 0)
    return unknown('the worker failed after its first receipt');
  // A file that did not exist has no bytes to digest.
  if (before.existed && sha256(beforeBytes) !== before.sha256)
    return unknown('the digest before differs');
  let afterBytes: Buffer;
  let replacements: number | undefined;
  if (request.operation === 'write') {
    afterBytes = Buffer.from(request.text, 'utf8');
  } else {
    if (!before.existed) return unknown('an edit of a file that did not exist');
    const edit = literalEdit(beforeBytes.toString('utf8'), request);
    if (edit.count === 0 || (edit.count > 1 && !request.replace_all))
      return unknown('the worker applied an edit the parent refuses');
    afterBytes = Buffer.from(edit.after, 'utf8');
    replacements = edit.count;
  }
  if (
    after.existed !== before.existed ||
    after.created !== !before.existed ||
    (replacements !== undefined && after.replacements !== replacements) ||
    sha256(afterBytes) !== after.sha256 ||
    afterBytes.length !== after.size
  )
    return unknown('the digest after the write differs');
  return {
    kind: 'applied',
    existed: before.existed,
    created: !before.existed,
    ...(replacements !== undefined && { replacements }),
    before: before.existed ? beforeBytes : null,
    after: afterBytes,
  };
}

export class NativeWriteToolJob {
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
  private state: WriteToolState = 'ready';
  private outcome?: WriteToolOutcome;
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
      request: WriteFileRequest;
      hostSignal: AbortSignal;
      // Told once the job reached a terminal state.
      onSettled?: () => void;
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
    // The write generation, the frozen version and every fence, once more
    // at the moment the permit is issued.
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
    // An expired permit, a step that moved on or a cancelled run: the late
    // begin is refused with the authority conflict of §11.20.27.
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
        // Whole streams, reassembled by the parent and judged once.
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
            this.outcome = {
              kind: 'unknown',
              reason: 'the execution could not be confirmed',
            };
            this.state = 'unknown';
            return;
          }
          const { status, stop, exitCode } = receipt.result;
          this.outcome = judgeWriteReceipts(
            this.options.request,
            { status, stop, exitCode },
            Buffer.concat(this.streams.stdout),
          );
          this.state =
            this.outcome.kind === 'applied'
              ? 'ok'
              : this.outcome.kind === 'refused'
                ? 'failed'
                : 'unknown';
        },
        () => {
          this.outcome = { kind: 'unknown', reason: 'the Broker failed' };
          this.state = 'unknown';
        },
      )
      .finally(() => this.release());
  }

  // A terminal job keeps only its outcome: the raw receipts are dropped,
  // the host signal listener goes, and the owner forgets the job.
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
    if (this.reading) return denied();
    this.reading = true;
    try {
      await canRead(this.scope);
      if (operation === 'status') return { state: this.state };
      return this.output();
    } finally {
      this.reading = false;
    }
  }

  // The FD3 reply of write-tool-output: the state, the judgement and, for
  // an applied result, the bytes before (base64, at most 16 KiB of the file
  // so one reply) and the digests the Host compares with its own
  // derivation. The after bytes themselves stay in the parent.
  output() {
    const outcome = this.outcome;
    const base = { state: this.state };
    if (!outcome) return base;
    if (outcome.kind === 'applied')
      return {
        ...base,
        outcome: 'applied',
        existed: outcome.existed,
        created: outcome.created,
        ...(outcome.replacements !== undefined && {
          replacements: outcome.replacements,
        }),
        before: outcome.before?.toString('base64') ?? '',
        after: {
          size: outcome.after.length,
          sha256: sha256(outcome.after),
        },
      };
    if (outcome.kind === 'refused')
      return {
        ...base,
        outcome: 'refused',
        reason: outcome.reason,
        exitCode: outcome.exitCode,
      };
    return { ...base, outcome: 'unknown', reason: outcome.reason };
  }

  cancel() {
    this.controller.abort();
    if (this.state === 'ready') {
      this.state = 'aborted';
      this.outcome = { kind: 'refused', reason: 'not-started', exitCode: null };
      // A definite zero-execution terminal state: released at once.
      this.release();
    }
  }

  async close() {
    this.cancel();
    await this.pending;
    this.release();
    // Only a stop the Broker could not confirm keeps the job unresolved.
    if (this.state === 'unknown')
      throw new Error('Native write execution could not be confirmed stopped');
  }
}
