import { fork } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { link, lstat, open, realpath, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionRequest, runMacosWorktree } from './macos.ts';

type Worktree = Awaited<ReturnType<Parameters<typeof runMacosWorktree>[0]>>;
type Result = Awaited<ReturnType<typeof runMacosWorktree>>;
type Output = Parameters<
  NonNullable<NonNullable<Parameters<typeof runMacosWorktree>[3]>['onOutput']>
>[0];

export type ExecutionProofBinding = {
  version: 1;
  runId: string;
  generation: string;
  ownerGeneration: string;
  projectId: string;
  requirementId: string;
  repositoryId: string;
  actorId: string;
  commandId: string;
  receiptDigest: string;
};

type StopOutcome = Pick<Result, 'exitCode' | 'status'> & {
  stop: 'not-started' | 'confirmed';
};
export type SupervisedStopProof = {
  binding: ExecutionProofBinding;
  supervisorPid: number;
  outcome: StopOutcome;
};
export type SupervisorCommand =
  | {
      kind: 'prepare';
      scope: Worktree;
      gitPath: string;
      request: ExecutionRequest;
      binding: ExecutionProofBinding;
    }
  | { kind: 'go'; validBefore: number }
  | { kind: 'stop'; outputFailed?: true };
export type SupervisorEvent =
  | { kind: 'armed' }
  | { kind: 'output'; event: Output }
  | { kind: 'finished'; result: Result };

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/;
const safeId = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const maxRecordBytes = 4096;
const terminalStatuses = new Set([
  'ok',
  'failed',
  'rejected',
  'unavailable',
  'aborted',
  'timeout',
  'output-limit',
]);

function canPublishStop(binding: ExecutionProofBinding) {
  return (
    Buffer.byteLength(
      JSON.stringify({
        binding,
        supervisorPid: Number.MAX_SAFE_INTEGER,
        outcome: {
          status: 'output-limit',
          stop: 'not-started',
          exitCode: null,
        },
      }) + '\n',
    ) <= maxRecordBytes
  );
}

function missing(error: unknown) {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function assertDirectory(path: string) {
  const info = await lstat(path);
  if (
    !info.isDirectory() ||
    info.uid !== process.getuid!() ||
    (info.mode & 0o022) !== 0
  )
    throw new Error('Untrusted execution proof directory');
}

async function controlDirectory(root: string, binding: ExecutionProofBinding) {
  if (
    binding.version !== 1 ||
    !safeId.test(binding.projectId) ||
    !safeId.test(binding.repositoryId) ||
    !uuid.test(binding.requirementId) ||
    !uuid.test(binding.runId) ||
    (await realpath(root)) !== root
  )
    throw new Error('Invalid execution proof binding');
  await assertDirectory(root);
  let path = root;
  for (const part of [
    'projects',
    binding.projectId,
    'demands',
    binding.requirementId,
    '.rdws-worktree',
  ]) {
    path = join(path, part);
    await assertDirectory(path);
  }
  return path;
}

async function syncDirectory(path: string) {
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
  );
  try {
    await file.sync();
  } finally {
    await file.close();
  }
}

function proofPath(control: string, runId: string, phase: 'armed' | 'stopped') {
  return join(control, `execution-${runId}.${phase}.json`);
}

async function publish(control: string, path: string, value: unknown) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n');
  if (bytes.length > maxRecordBytes)
    throw new Error('Execution proof exceeds its size limit');
  const staging = path + '.' + randomUUID();
  const file = await open(staging, 'wx', 0o600);
  try {
    try {
      await file.writeFile(bytes);
      await file.sync();
    } finally {
      await file.close();
    }
    await link(staging, path);
  } finally {
    await unlink(staging);
  }
  await syncDirectory(control);
}

export async function publishArmedProof(
  scope: Worktree,
  binding: ExecutionProofBinding,
) {
  const control = await controlDirectory(scope.runtimeRoot, binding);
  if (control !== scope.control)
    throw new Error('Mismatched execution control directory');
  await publish(control, proofPath(control, binding.runId, 'armed'), {
    binding,
    supervisorPid: process.pid,
  });
}

export async function publishStopProof(
  scope: Worktree,
  binding: ExecutionProofBinding,
  result: Result,
) {
  const control = await controlDirectory(scope.runtimeRoot, binding);
  if (
    control !== scope.control ||
    result.runId !== binding.runId ||
    result.stop === 'unconfirmed' ||
    result.marker === 'retained'
  )
    throw new Error('Execution stopping could not be confirmed');
  const marker = await lstat(join(control, 'isolated-execution')).catch(
    (error: unknown) => {
      if (!missing(error)) throw error;
      return undefined;
    },
  );
  if (marker) throw new Error('Execution marker is still occupied');
  await syncDirectory(control);
  const { status, exitCode, stop } = result;
  await publish(control, proofPath(control, binding.runId, 'stopped'), {
    binding,
    supervisorPid: process.pid,
    outcome: { status, exitCode, stop },
  } satisfies SupervisedStopProof);
}

export async function readSupervisedStop(
  root: string,
  binding: ExecutionProofBinding,
): Promise<SupervisedStopProof | undefined> {
  try {
    const control = await controlDirectory(root, binding);
    const file = await open(
      proofPath(control, binding.runId, 'stopped'),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
    );
    try {
      const stat = await file.stat();
      if (
        !stat.isFile() ||
        stat.uid !== process.getuid!() ||
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        stat.size < 1 ||
        stat.size > maxRecordBytes
      )
        return;
      const data = Buffer.alloc(maxRecordBytes + 1);
      if ((await file.read(data, 0, data.length, 0)).bytesRead !== stat.size)
        return;
      const proof = JSON.parse(
        data.subarray(0, stat.size).toString(),
      ) as SupervisedStopProof;
      if (
        !proof ||
        !proof.binding ||
        !proof.outcome ||
        Object.keys(proof).length !== 3 ||
        Object.keys(proof.binding).length !== Object.keys(binding).length ||
        !Object.entries(binding).every(
          ([key, value]) =>
            proof.binding[key as keyof ExecutionProofBinding] === value,
        ) ||
        !Number.isSafeInteger(proof.supervisorPid) ||
        proof.supervisorPid < 2 ||
        Object.keys(proof.outcome).length !== 3 ||
        !terminalStatuses.has(proof.outcome.status) ||
        (proof.outcome.stop !== 'not-started' &&
          proof.outcome.stop !== 'confirmed') ||
        (proof.outcome.exitCode !== null &&
          (!Number.isInteger(proof.outcome.exitCode) ||
            proof.outcome.exitCode < 0 ||
            proof.outcome.exitCode > 255))
      )
        return;
      await file.sync();
      await syncDirectory(control);
      return proof;
    } finally {
      await file.close();
    }
  } catch (error) {
    if (
      missing(error) ||
      error instanceof SyntaxError ||
      (error as NodeJS.ErrnoException).code === 'ELOOP'
    )
      return;
    throw error;
  }
}

export async function runSupervisedMacosWorktree(
  verifiedScope: () => Promise<Worktree>,
  gitPath: string,
  request: ExecutionRequest,
  binding: ExecutionProofBinding,
  options: {
    signal: AbortSignal;
    onOutput?: (event: Output) => void;
    arm: () => Promise<void>;
    authorizeStart: (go: (validBefore: number) => void) => Promise<void>;
  },
): Promise<Result> {
  const unknown: Result = {
    runId: binding.runId,
    stop: 'unconfirmed',
    marker: 'retained',
    status: 'unavailable',
    exitCode: null,
    stdout: '',
    stderr: '',
  };
  if (process.platform !== 'darwin' || process.env.RDWS_MODE !== 'test')
    return unknown;
  const scope = await verifiedScope().catch(() => undefined);
  if (!scope || options.signal.aborted || !canPublishStop(binding))
    return {
      ...unknown,
      status: options.signal.aborted ? 'aborted' : 'rejected',
      stop: 'not-started',
      marker: 'none',
    };
  const child = fork(new URL('./macos-supervisor.ts', import.meta.url), {
    detached: true,
    execArgv: [],
    env: { PATH: '/usr/bin:/bin', LC_ALL: 'C', RDWS_MODE: 'test' },
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    serialization: 'advanced',
  });
  let activation: Promise<void> | undefined;
  let result: Result | undefined;
  function send(command: SupervisorCommand) {
    if (!child.connected)
      throw new Error('Execution supervisor is disconnected');
    child.send(command, (error) => {
      if (error) {
        if (child.connected) child.disconnect();
      }
    });
  }
  function stop(outputFailed?: true) {
    if (!child.connected) return;
    try {
      send({ kind: 'stop', outputFailed });
    } catch {
      if (child.connected) child.disconnect();
    }
  }
  const closed = once(child, 'close', { signal: AbortSignal.timeout(17_000) });
  child.on('message', (event: SupervisorEvent) => {
    if (event.kind === 'armed' && !activation) {
      activation = (async () => {
        options.signal.throwIfAborted();
        await options.arm();
        options.signal.throwIfAborted();
        await options.authorizeStart((validBefore) =>
          send({ kind: 'go', validBefore }),
        );
      })().catch(() => stop());
    } else if (event.kind === 'finished') {
      result = event.result;
    } else if (event.kind === 'output' && event.event.runId === binding.runId) {
      try {
        void Promise.resolve(options.onOutput?.(event.event)).catch(() =>
          stop(true),
        );
      } catch {
        stop(true);
      }
    }
  });
  const abort = () => stop();
  options.signal.addEventListener('abort', abort, { once: true });
  try {
    send({ kind: 'prepare', scope, gitPath, request, binding });
    if (options.signal.aborted) stop();
    const [code, signal] = await closed;
    await activation;
    if (code !== 0 || signal !== null || result?.runId !== binding.runId)
      return unknown;
    const proof = await readSupervisedStop(scope.runtimeRoot, binding);
    if (
      !proof ||
      proof.supervisorPid !== child.pid ||
      result.marker === 'retained' ||
      proof.outcome.stop !== result.stop ||
      proof.outcome.status !== result.status ||
      proof.outcome.exitCode !== result.exitCode
    )
      return unknown;
    return result;
  } catch {
    stop();
    if (child.connected) child.disconnect();
    child.unref();
    await closed.catch(() => {});
    await activation;
    return unknown;
  } finally {
    options.signal.removeEventListener('abort', abort);
  }
}
