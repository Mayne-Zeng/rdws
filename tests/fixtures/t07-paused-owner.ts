import { once } from 'node:events';
import { buildApp } from '@rdws/server';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import type { WriteHandoffScope } from '../../apps/server/src/modules/write-handoff.ts';

export type OwnerBoot = {
  databaseUrl: string;
  secret: string;
  origin: string;
  root: string;
  ticket: string;
  gitPath: string;
};

export type OwnerCommand =
  | {
      kind: 'execute';
      scope: WriteHandoffScope;
      generation: string;
      commandId: string;
    }
  | { kind: 'stop' };

export type OwnerReport =
  | { kind: 'listening'; address: string }
  | { kind: 'authority-denied' | 'failed' | 'execution-ended' | 'stopped' };

async function run() {
  if (!process.send || process.env.RDWS_MODE !== 'test')
    throw new Error('Isolated owner fixture requires IPC');
  const send = (report: OwnerReport) => {
    if (process.connected) process.send!(report);
  };
  const [boot] = (await once(process, 'message')) as [OwnerBoot];
  if (!process.connected) return;
  const app = buildApp({
    databaseUrl: boot.databaseUrl,
    secret: boot.secret,
    origin: boot.origin,
    nativeRuntimeRoot: boot.root,
    repositoryHome: boot.root,
    authorityTicket: boot.ticket,
    isolatedWrite: { gitPath: boot.gitPath, fleetCommands: true },
  });
  let stopping: Promise<unknown> | undefined;
  function stop() {
    return (stopping ??= app
      .stopRuntime()
      .then(
        () => send({ kind: 'stopped' }),
        () => {
          process.exitCode = 1;
          send({ kind: 'failed' });
        },
      )
      .finally(() => {
        if (process.connected) process.disconnect!();
      }));
  }
  process.once('disconnect', () => void stop());
  let address: string;
  try {
    address = await app.listen({ host: '127.0.0.1', port: 0 });
  } catch (error) {
    process.exitCode = 1;
    send({
      kind:
        error instanceof Error &&
        error.message === 'Database authority ownership could not be confirmed'
          ? 'authority-denied'
          : 'failed',
    });
    await stop();
    return;
  }
  const broker = app.getDecorator<() => OwnedWriteHandoff | undefined>(
    'isolatedWriteHandoff',
  )()!;
  let launched = false;
  process.on('message', (command: OwnerCommand) => {
    if (command.kind === 'stop') return void stop();
    if (command.kind !== 'execute' || stopping || launched) return;
    launched = true;
    void broker
      .execute(command.scope, {
        commandId: command.commandId,
        repositoryId: 'app',
        generation: command.generation,
        request: {
          tool: 'shell',
          script: [
            "printf '|started' >> sample.txt || exit 1",
            'printf \'%s\\n\' "$$" > fixture-running || exit 1',
            'deadline=$((SECONDS + 25))',
            'while [[ ! -f fixture-stop && $SECONDS -lt $deadline ]]; do :; done',
          ].join('\n'),
        },
      })
      .then(
        () => send({ kind: 'execution-ended' }),
        () => send({ kind: 'failed' }),
      );
  });
  send({ kind: 'listening', address });
}

await run();
