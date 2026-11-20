import childProcesses from 'node:child_process';
import { once } from 'node:events';
import files from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { buildApp } from '@rdws/server';
import { Pool, type PoolClient } from 'pg';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import type { WriteHandoffScope } from '../../apps/server/src/modules/write-handoff.ts';

export type OwnerBoot = {
  databaseUrl: string;
  secret: string;
  origin: string;
  root: string;
  ticket: string;
  gitPath: string;
  supervisedExecution?: true;
  fault?:
    | 'hold-armed'
    | 'rollback-go'
    | 'lose-go'
    | 'disconnect-before-go'
    | 'hold-takeover'
    | 'hold-grant'
    | 'hold-cold'
    | 'rollback-cold'
    | 'lose-cold';
  faultCommand?: string;
  observeGo?: true;
  dropStopAck?: true;
  outputFailure?: true;
  denyProofSync?: true;
  holdProofSync?: true;
  holdLogin?: string;
  readSnapshots?: true;
  holdReadWorker?: true;
  denyReadStop?: true;
};

export type OwnerCommand =
  | {
      kind: 'execute';
      scope: WriteHandoffScope;
      generation: string;
      commandId: string;
      exitCode?: 7;
    }
  | {
      kind: 'read';
      scope: WriteHandoffScope;
      request: Parameters<OwnedWriteHandoff['readWorktree']>[1];
      holdDelivery?: true;
    }
  | { kind: 'stop' | 'release-fault' | 'release-login' | 'release-read' };

export type OwnerReport =
  | { kind: 'listening'; address: string }
  | { kind: 'go-sent'; validBefore: number }
  | { kind: 'fault-completed'; command: string }
  | { kind: 'backend-held'; pid: number }
  | { kind: 'read-worker-held'; pid: number }
  | {
      kind: 'read-result';
      result: Awaited<ReturnType<OwnedWriteHandoff['readWorktree']>>;
    }
  | { kind: 'read-failed'; status: number | undefined }
  | {
      kind:
        | 'authority-denied'
        | 'failed'
        | 'execution-ended'
        | 'stopped'
        | 'fault-entered'
        | 'backend-disconnected'
        | 'stop-ack-dropped'
        | 'proof-sync-denied'
        | 'proof-sync-held'
        | 'proof-sync-completed'
        | 'read-delivery-held'
        | 'login-held';
    };

async function run() {
  if (!process.send || process.env.RDWS_MODE !== 'test')
    throw new Error('Isolated owner fixture requires IPC');
  const send = (report: OwnerReport) => {
    if (process.connected) process.send!(report);
  };
  const [boot] = (await once(process, 'message')) as [OwnerBoot];
  if (!process.connected) return;
  if (boot.holdReadWorker) {
    const spawn = childProcesses.spawn;
    childProcesses.spawn = ((...args: unknown[]) => {
      const child = Reflect.apply(spawn, childProcesses, args) as ReturnType<
        typeof spawn
      >;
      if (
        Array.isArray(args[1]) &&
        args[1].some(
          (item) =>
            typeof item === 'string' &&
            item.endsWith('/read-snapshot-worker.mjs'),
        )
      )
        child.once('spawn', () => {
          const pid = child.pid;
          if (pid && child.exitCode === null && process.kill(pid, 'SIGSTOP')) {
            if (boot.denyReadStop) {
              const stop = process.kill;
              process.kill = ((
                target: number,
                signal?: NodeJS.Signals | number,
              ) =>
                target === -pid && signal === 'SIGKILL'
                  ? true
                  : stop.call(process, target, signal)) as typeof stop;
            }
            send({ kind: 'read-worker-held', pid });
          }
        });
      return child;
    }) as typeof spawn;
    syncBuiltinESMExports();
  }
  if (boot.observeGo || boot.dropStopAck) {
    const fork = childProcesses.fork;
    childProcesses.fork = ((...args: unknown[]) => {
      const child = Reflect.apply(fork, childProcesses, args) as ReturnType<
        typeof fork
      >;
      if (
        args[0] instanceof URL &&
        args[0].pathname.endsWith('/macos-supervisor.ts')
      ) {
        if (boot.observeGo) {
          const transmit = child.send;
          child.send = ((...params: unknown[]) => {
            const emitted = Reflect.apply(transmit, child, params);
            const envelope = params[0] as
              { kind?: string; validBefore?: number } | undefined;
            if (
              envelope?.kind === 'go' &&
              typeof envelope.validBefore === 'number'
            )
              send({ kind: 'go-sent', validBefore: envelope.validBefore });
            return emitted;
          }) as typeof transmit;
        }
        if (boot.dropStopAck) {
          const emit = child.emit;
          child.emit = ((event: string, ...params: unknown[]) => {
            if (
              event === 'message' &&
              (params[0] as { kind?: string })?.kind === 'finished'
            ) {
              send({ kind: 'stop-ack-dropped' });
              return true;
            }
            return Reflect.apply(emit, child, [event, ...params]);
          }) as typeof emit;
        }
      }
      return child;
    }) as typeof fork;
    syncBuiltinESMExports();
  }
  let watchedCommand: string | undefined;
  let releaseFault = () => {};
  let releaseLogin = () => {};
  let releaseRead = () => {};
  let heldRead: { sessionId: string; remaining: number } | undefined;
  let loginHeld = false;
  let fixtureStopping = false;
  if (boot.denyProofSync || boot.holdProofSync) {
    let enabled = false;
    let releaseProof = () => {};
    releaseFault = () => {
      enabled = true;
      releaseProof();
    };
    const open = files.open;
    files.open = (async (...args: unknown[]) => {
      const file = (await Reflect.apply(open, files, args)) as Awaited<
        ReturnType<typeof open>
      >;
      if (typeof args[0] === 'string' && args[0].endsWith('.stopped.json')) {
        const sync = file.sync;
        file.sync = async () => {
          if (!enabled) {
            if (boot.denyProofSync) {
              send({ kind: 'proof-sync-denied' });
              throw new Error('Synthetic independent proof fsync failure');
            }
            const gate = new Promise<void>((resolve) => {
              releaseProof = resolve;
            });
            send({ kind: 'proof-sync-held' });
            await gate;
          }
          await sync.call(file);
          send({ kind: 'proof-sync-completed' });
        };
      }
      return file;
    }) as typeof open;
    syncBuiltinESMExports();
  }
  let faultFinished = false;
  let armedCommitted = false;
  if (boot.fault || boot.readSnapshots) {
    const connect = Pool.prototype.connect;
    Pool.prototype.connect = function (this: Pool, ...args: unknown[]) {
      const opened = Reflect.apply(connect, this, args);
      const faultCommand = boot.faultCommand ?? watchedCommand;
      if (
        args.length ||
        fixtureStopping ||
        ((!faultCommand || faultFinished) && !heldRead)
      )
        return opened;
      return opened.then((client: PoolClient) => {
        const query = client.query;
        let armed = false;
        let readsExecution = false;
        let writesExecution = false;
        let writesCold = false;
        let writesTakeover = false;
        client.query = ((...params: unknown[]) => {
          const input = params[0] as
            string | { text: string; values?: unknown[] };
          const sql = typeof input === 'string' ? input : input.text;
          const values = Array.isArray(params[1])
            ? params[1]
            : typeof input === 'string'
              ? undefined
              : input.values;
          if (
            !fixtureStopping &&
            heldRead &&
            sql.startsWith('select "id" from "native_session"') &&
            values?.includes(heldRead.sessionId) &&
            --heldRead.remaining === 0
          ) {
            heldRead = undefined;
            const pause = new Promise<void>((resolve) => {
              releaseRead = resolve;
            });
            return Reflect.apply(query, client, params).then(
              async (result: unknown) => {
                send({ kind: 'read-delivery-held' });
                await pause;
                return result;
              },
            );
          }
          if (
            !fixtureStopping &&
            !loginHeld &&
            boot.holdLogin &&
            values?.includes(boot.holdLogin) &&
            sql.includes('from "auth_session"') &&
            sql.endsWith('for share')
          ) {
            loginHeld = true;
            const pause = new Promise<void>((resolve) => {
              releaseLogin = resolve;
            });
            return Reflect.apply(query, client, params).then(
              async (result: unknown) => {
                send({ kind: 'login-held' });
                await pause;
                return result;
              },
            );
          }
          if (faultCommand && values?.includes(faultCommand)) {
            if (sql.startsWith('update "command_receipt"')) {
              writesExecution = true;
              armed = values.some(
                (value) =>
                  typeof value === 'string' &&
                  value.includes('"stage":"armed"'),
              );
              writesCold = values.some(
                (value) =>
                  typeof value === 'string' && value.includes('"coldStop":'),
              );
              const takeoverState =
                boot.fault === 'hold-grant' ? 'acquired' : 'pending';
              writesTakeover = values.some(
                (value) =>
                  typeof value === 'string' &&
                  value.includes(`"state":"${takeoverState}"`),
              );
            }
            if (
              sql.startsWith('select ') &&
              sql.includes('from "command_receipt"')
            ) {
              readsExecution = true;
              if (
                boot.fault === 'disconnect-before-go' &&
                armedCommitted &&
                !faultFinished
              ) {
                faultFinished = true;
                const pause = new Promise<void>((resolve) => {
                  releaseFault = resolve;
                });
                return Reflect.apply(query, client, params).then(
                  async (result: unknown) => {
                    const backend = (await Reflect.apply(query, client, [
                      'select pg_backend_pid() as pid',
                    ])) as { rows: { pid: number }[] };
                    client.once('error', () =>
                      send({ kind: 'backend-disconnected' }),
                    );
                    send({ kind: 'backend-held', pid: backend.rows[0]!.pid });
                    await pause;
                    return result;
                  },
                );
              }
            }
          }
          if (sql === 'commit' || sql === 'rollback') client.query = query;
          if (
            sql === 'commit' &&
            boot.fault === 'disconnect-before-go' &&
            armed
          )
            return Reflect.apply(query, client, params).then(
              (result: unknown) => {
                armedCommitted = true;
                return result;
              },
            );
          const hold =
            boot.fault === 'hold-armed' ||
            boot.fault === 'hold-takeover' ||
            boot.fault === 'hold-grant' ||
            boot.fault === 'hold-cold';
          const watched =
            boot.fault === 'hold-armed'
              ? armed
              : boot.fault === 'hold-takeover' || boot.fault === 'hold-grant'
                ? writesTakeover
                : boot.fault?.endsWith('-cold')
                  ? writesCold
                  : readsExecution && !writesExecution;
          if (
            sql === 'commit' &&
            boot.fault !== 'disconnect-before-go' &&
            !fixtureStopping &&
            !faultFinished &&
            watched
          ) {
            faultFinished = true;
            const pause = new Promise<void>((resolve) => {
              releaseFault = resolve;
            });
            if (hold)
              return Reflect.apply(query, client, params).then(
                async (result: unknown) => {
                  send({ kind: 'fault-entered' });
                  await pause;
                  return result;
                },
              );
            send({ kind: 'fault-entered' });
            return pause.then(async () => {
              const result = (await Reflect.apply(
                query,
                client,
                boot.fault === 'rollback-go' || boot.fault === 'rollback-cold'
                  ? ['rollback']
                  : params,
              )) as { command: string };
              send({ kind: 'fault-completed', command: result.command });
              throw new Error('Synthetic execution commit reply lost');
            });
          }
          return Reflect.apply(query, client, params);
        }) as typeof client.query;
        return client;
      });
    } as typeof connect;
  }
  const app = buildApp({
    databaseUrl: boot.databaseUrl,
    secret: boot.secret,
    origin: boot.origin,
    nativeRuntimeRoot: boot.root,
    repositoryHome: boot.root,
    authorityTicket: boot.ticket,
    isolatedWrite: {
      gitPath: boot.gitPath,
      fleetCommands: true,
      supervisedExecution: boot.supervisedExecution,
      readSnapshots: boot.readSnapshots,
    },
  });
  let stopping: Promise<unknown> | undefined;
  function stop() {
    fixtureStopping = true;
    releaseFault();
    releaseLogin();
    releaseRead();
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
    if (command.kind === 'release-fault') return releaseFault();
    if (command.kind === 'release-login') return releaseLogin();
    if (command.kind === 'release-read') return releaseRead();
    if (command.kind === 'read' && boot.readSnapshots && !stopping) {
      if (command.holdDelivery)
        heldRead = { sessionId: command.scope.sessionId, remaining: 3 };
      void broker.readWorktree(command.scope, command.request).then(
        (result) => send({ kind: 'read-result', result }),
        (error: unknown) =>
          send({
            kind: 'read-failed',
            status: (error as { statusCode?: number }).statusCode,
          }),
      );
      return;
    }
    if (command.kind !== 'execute' || stopping || launched) return;
    launched = true;
    watchedCommand = command.commandId;
    void broker
      .execute(
        command.scope,
        {
          commandId: command.commandId,
          repositoryId: 'app',
          generation: command.generation,
          request: {
            tool: 'shell',
            script: [
              ...(boot.supervisedExecution
                ? [
                    'if printf denied > ../../.rdws-worktree/forbidden-proof-write; then exit 77; fi',
                  ]
                : []),
              "printf '|started' >> sample.txt || exit 1",
              'printf \'%s\\n\' "$$" > fixture-running || exit 1',
              ...(boot.outputFailure ? ["printf 'test output\\n'"] : []),
              'deadline=$((SECONDS + 25))',
              'while [[ ! -f fixture-stop && $SECONDS -lt $deadline ]]; do :; done',
              ...(command.exitCode === 7 ? ['exit 7'] : []),
            ].join('\n'),
          },
        },
        boot.outputFailure
          ? async ({ stream }) => {
              if (stream === 'stdout')
                throw new Error('Synthetic asynchronous output rejection');
            }
          : undefined,
      )
      .then(
        () => {
          launched = false;
          send({ kind: 'execution-ended' });
        },
        () => {
          launched = false;
          send({ kind: 'failed' });
        },
      );
  });
  send({ kind: 'listening', address });
}

await run();
