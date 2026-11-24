import { runMacosWorktree } from './macos.ts';
import {
  publishArmedProof,
  publishStopProof,
  type SupervisorCommand,
  type SupervisorEvent,
} from './macos-supervised.ts';

if (
  process.platform !== 'darwin' ||
  process.env.RDWS_MODE !== 'test' ||
  !process.send
)
  throw new Error('Execution supervisor requires its private test channel');

const control = new AbortController();
let started = false;
let outputFailed = false;
let allow: ((validBefore?: number) => void) | undefined;
const cutoff = setTimeout(stop, 15_000);
function stop() {
  control.abort();
  allow?.();
  if (!started) {
    clearTimeout(cutoff);
    if (process.connected) process.disconnect!();
  }
}
function send(event: SupervisorEvent) {
  if (process.connected)
    process.send!(event, undefined, undefined, (error) => {
      if (error) stop();
    });
}

process.once('disconnect', stop);
process.on('message', (command: SupervisorCommand) => {
  if (command.kind === 'stop') {
    if (!control.signal.aborted && command.outputFailed) outputFailed = true;
    return stop();
  }
  if (command.kind === 'go') {
    const accept = allow;
    allow = undefined;
    accept?.(command.validBefore);
    return;
  }
  if (started || command.kind !== 'prepare') return;
  started = true;
  void execute(command)
    .catch(() => {
      process.exitCode = 1;
    })
    .finally(() => {
      clearTimeout(cutoff);
      if (process.connected) process.disconnect!();
    });
});

async function execute({
  scope,
  gitPath,
  request,
  binding,
  outputLimitBytes,
}: Extract<SupervisorCommand, { kind: 'prepare' }>) {
  try {
    const observed = await runMacosWorktree(
      () => Promise.resolve(scope),
      gitPath,
      request,
      {
        runId: binding.runId,
        signal: control.signal,
        ...(outputLimitBytes !== undefined && { outputLimitBytes }),
        onOutput: (event) => send({ kind: 'output', event }),
        async authorizeStart(start) {
          const location = await publishArmedProof(scope, binding);
          control.signal.throwIfAborted();
          const validBefore = await new Promise<number | undefined>(
            (resolve) => {
              allow = resolve;
              send({ kind: 'armed', location });
            },
          );
          allow = undefined;
          if (
            !process.connected ||
            control.signal.aborted ||
            !Number.isFinite(validBefore) ||
            !(Date.now() < validBefore!)
          )
            return;
          start();
        },
      },
    );
    const result =
      outputFailed && observed.status === 'aborted'
        ? { ...observed, status: 'failed' as const }
        : observed;
    await publishStopProof(scope, binding, result);
    // The result may be large: wait until the IPC write completed before the
    // channel closes, or the parent would never see the terminal state.
    await new Promise<void>((resolve) => {
      if (!process.connected) return resolve();
      process.send!({ kind: 'finished', result }, undefined, undefined, () =>
        resolve(),
      );
    });
  } catch {
    process.exitCode = 1;
  }
}
