import { randomBytes } from 'node:crypto';
import { isAbsolute } from 'node:path';
import Fastify, { type FastifyError } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { Health } from '@rdws/contracts';
import {
  assertModelCarrierDiagnostics,
  resolveNativeModelEgress,
} from '@rdws/dsh/web';
import { registerWorkbench } from './modules/workbench.ts';
import { mainModelPolicy } from './modules/model-egress-policy.ts';
import {
  validateSessionModelStorage,
  type SessionModelPilot,
} from './modules/session-model-selection.ts';
import type {
  FixtureToolArm,
  FixtureToolAssembly,
} from './modules/native-fixture-tool-job.ts';
import {
  armedSizes,
  armRequest,
  type ReadToolArm,
  type ReadToolAssembly,
  type WriteToolArm,
  type WriteToolAssembly,
} from './modules/native-projects.ts';
import { createWriteCommands } from './modules/write-tool-commands.ts';
import {
  createOwnedWriteHandoff,
  validateWriteHandoffDatabase,
  type ReadsWindow,
} from './modules/write-handoff.ts';
import { checkedWriteTransaction } from './modules/checked-write-transaction.ts';
import { isWriteAuthorityCommand } from './modules/workbench-paths.ts';
import {
  createAuth,
  logoutRevocationHeader,
  logoutUnavailableMessage,
} from './modules/auth.ts';
export function buildApp(options: {
  databaseUrl: string;
  secret: string;
  origin: string;
  nativeHost?: import('@rdws/dsh/web').NativeWebHost;
  repositoryHome?: string;
  nativeRuntimeRoot?: string;
  nativeProfiles?: ReadonlyMap<string, string>;
  authorityTicket?: string;
  mainModelPolicy?: unknown;
  sessionModelPilot?: { alternateModel: string; databaseFixture: string };
  isolatedWrite?: {
    gitPath: string;
    fixtureTool?: true;
    fleetCommands?: true;
    supervisedExecution?: true;
    readSnapshots?: true;
    // §11.20.26 Read loopback: the page window carrier and the repository the
    // isolated Read probe reads.
    readTool?: {
      window: ReadsWindow;
      repositoryId: string;
      readStreamMinSize?: number;
    };
    // §11.20.27 A segment: the file write tools (edit, write) of the
    // writable session, bound to the repository the armed run writes; B
    // segment: shellGit arms the Shell and Git tools beside them.
    writeTools?: { repositoryId: string; shellGit?: true };
  };
}) {
  const modelEgress = resolveNativeModelEgress(
    process.env.RDWS_NATIVE_MODEL_EGRESS,
  );
  if (options.nativeHost && options.nativeHost.modelEgress !== modelEgress)
    throw new Error(
      'Native Host model egress does not match BFF configuration',
    );
  const ticket = options.authorityTicket;
  const isolatedWrite = options.isolatedWrite;
  const fixtureTool = isolatedWrite?.fixtureTool === true;
  const readTool = isolatedWrite?.readTool;
  const writeTools = isolatedWrite?.writeTools;
  if (
    isolatedWrite &&
    (process.env.RDWS_MODE !== 'test' ||
      process.platform !== 'darwin' ||
      !ticket ||
      // §11.20.22 banned co-assembling the supervised protocol with mediated
      // Native tools for its round; §11.20.27 A segment lifts that for the
      // supervised execution (every write tool execution runs supervised).
      // The constant fixture tool still never joins the read snapshots.
      (isolatedWrite.readSnapshots && fixtureTool) ||
      modelEgress !==
        (fixtureTool || readTool || writeTools ? 'mediated' : 'paused') ||
      options.nativeHost ||
      !isAbsolute(isolatedWrite.gitPath))
  )
    throw new Error('Isolated write handoff requires a managed macOS test BFF');
  // §11.20.27 hop 2: the write tools are armed only in the supervised
  // assembly — read snapshots and supervised execution on, no constant
  // fixture tool, the loopback page carrier of this run (L4), fleet
  // commands, and a repository the armed run is bound to.
  if (
    writeTools &&
    (isolatedWrite?.supervisedExecution !== true ||
      isolatedWrite.readSnapshots !== true ||
      fixtureTool ||
      !isolatedWrite.fleetCommands ||
      !readTool ||
      !writeTools.repositoryId)
  )
    throw new Error('Isolated write tools require the supervised assembly');
  // L4 assembly: the page carrier must be this loopback HTTPS endpoint;
  // anything else is refused before any connection is made.
  if (
    readTool &&
    (isolatedWrite?.readSnapshots !== true ||
      fixtureTool ||
      new URL(readTool.window.destination).protocol !== 'https:' ||
      new URL(readTool.window.destination).hostname !== '127.0.0.1' ||
      !readTool.repositoryId)
  )
    throw new Error('Isolated read loopback requires a loopback page carrier');
  const mediated = modelEgress === 'mediated';
  if (
    mediated &&
    (options.nativeHost || !ticket || process.version !== 'v24.20.0')
  )
    throw new Error(
      'Mediated Native egress requires an owned runtime on Node v24.20.0',
    );
  if (mediated !== (options.mainModelPolicy !== undefined))
    throw new Error(
      'Mediated Native egress policy and mode must be set together',
    );
  const policy = mediated
    ? mainModelPolicy(options.mainModelPolicy)
    : undefined;
  let sessionModelPilot: SessionModelPilot | undefined;
  const requestedPilot = options.sessionModelPilot;
  if (requestedPilot !== undefined) {
    const alternate = requestedPilot?.alternateModel;
    let database: URL | undefined;
    try {
      database = new URL(options.databaseUrl);
    } catch {
      database = undefined;
    }
    if (
      process.env.RDWS_MODE !== 'test' ||
      process.platform !== 'darwin' ||
      !policy ||
      !ticket ||
      isolatedWrite ||
      policy.firstMessageTitle ||
      new URL(policy.destination).hostname !== '127.0.0.1' ||
      !database ||
      !['postgres:', 'postgresql:'].includes(database.protocol) ||
      database.hostname !== '127.0.0.1' ||
      database.pathname !== '/rdws_test' ||
      database.username !== 'rdws_test_app' ||
      !database.port ||
      !!database.search ||
      !!database.hash ||
      !options.nativeRuntimeRoot ||
      !isAbsolute(options.nativeRuntimeRoot) ||
      !options.repositoryHome ||
      !isAbsolute(options.repositoryHome) ||
      typeof requestedPilot?.databaseFixture !== 'string' ||
      !requestedPilot.databaseFixture ||
      requestedPilot.databaseFixture.length > 128 ||
      typeof alternate !== 'string' ||
      alternate.length < 1 ||
      alternate.length > 160 ||
      alternate === policy.model
    )
      throw new Error(
        'Session model pilot requires an isolated mediated test runtime',
      );
    sessionModelPilot = {
      projectId: policy.projectId,
      provider: policy.provider,
      defaultModel: policy.model,
      models: new Set([policy.model, alternate]),
    };
  }
  const managedWork = !!isolatedWrite || !!sessionModelPilot;
  if (
    fixtureTool &&
    (!policy ||
      policy.firstMessageTitle ||
      new URL(policy.destination).hostname !== '127.0.0.1')
  )
    throw new Error('Isolated tool probe requires a loopback model supplier');
  if (
    readTool &&
    (!policy ||
      policy.firstMessageTitle ||
      new URL(policy.destination).hostname !== '127.0.0.1')
  )
    throw new Error(
      'Isolated read loopback requires a loopback model supplier',
    );
  if (
    policy?.firstMessageTitle &&
    (process.env.RDWS_MODE !== 'test' ||
      new URL(policy.destination).hostname !== '127.0.0.1')
  )
    throw new Error(
      'Managed first-message title requires an isolated loopback supplier',
    );
  if (mediated) assertModelCarrierDiagnostics();
  if (
    ticket !== undefined &&
    (modelEgress === 'direct' || !/^[0-9a-f]{64}$/.test(ticket))
  )
    throw new Error('Invalid database authority startup ticket');
  const proof =
    ticket === undefined ? undefined : randomBytes(32).toString('hex');
  const database = connectDatabase(
    options.databaseUrl,
    proof,
    managedWork ? 3_000 : undefined,
    managedWork,
  );
  let ownedWrite: ReturnType<typeof createOwnedWriteHandoff> | undefined;
  const fixture: FixtureToolAssembly | undefined = fixtureTool ? {} : undefined;
  const read: ReadToolAssembly | undefined = readTool
    ? {
        readStreamMinSize: readTool.readStreamMinSize,
        arms: new Map(),
        offered: new Map(),
      }
    : undefined;
  const write: WriteToolAssembly | undefined = writeTools
    ? {
        arms: new Map(),
        offered: new Map(),
        ...(writeTools.shellGit && { shellGit: true }),
      }
    : undefined;
  let workbench: Awaited<ReturnType<typeof registerWorkbench>> | undefined;
  const auth = createAuth(database.db, {
    secret: options.secret,
    origin: options.origin,
    onLogout: async (id) => workbench?.closeLogin(id) ?? false,
  });
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
    ...(sessionModelPilot && { forceCloseConnections: true }),
  }).withTypeProvider<TypeBoxTypeProvider>();
  let authority: string | null = null;
  let stopping: Promise<undefined> | undefined;
  let closing = false;
  const active = new Set<Promise<unknown>>();
  function trackWork<T>(work: () => Promise<T>) {
    const pending = work();
    active.add(pending);
    const remove = () => {
      active.delete(pending);
    };
    void pending.then(remove, remove);
    return pending;
  }
  const checked = managedWork
    ? checkedWriteTransaction(database.pool)
    : undefined;
  if (managedWork)
    app.addHook('onRoute', (route) => {
      if (route.websocket) return;
      const handler = route.handler;
      route.handler = function (request, reply) {
        if (closing) return reply.code(503).send({ error: '共享运行正在关闭' });
        return trackWork(async () => handler.call(this, request, reply));
      };
    });
  let closingDatabase: Promise<void> | undefined;
  const closeDatabase = () =>
    (closingDatabase ??= (async () => {
      while (active.size) await Promise.allSettled(active);
      await checked?.drain();
      await database.close();
    })());
  async function releaseConfirmedOwner() {
    if (!authority || !proof) return;
    if (app.server.listening)
      throw new Error('HTTP shutdown was not confirmed');
    const control = connectDatabase(options.databaseUrl, proof);
    try {
      await releaseAuthority(control.pool, authority);
      authority = null;
    } finally {
      await control.pool.end();
    }
  }
  if (isolatedWrite) {
    app.decorate('isolatedWriteHandoff', () => ownedWrite);
    app.decorate('recoverIsolatedWriteAuthority', () =>
      workbench?.recoverWriteAuthority(),
    );
  }
  if (fixture) {
    app.decorate(
      'armIsolatedNativeTool',
      (input: Omit<FixtureToolArm, 'broker'>) => {
        if (
          !ownedWrite ||
          closing ||
          fixture.arm ||
          input.scope.projectId !== policy!.projectId ||
          !input.requestId ||
          input.requestId.length > 128
        )
          throw new Error('Isolated tool probe cannot be armed');
        ownedWrite.assertWireLease(
          input.scope,
          input.grant.generation,
          input.grant.contextVersion,
        );
        fixture.arm = { ...structuredClone(input), broker: ownedWrite };
      },
    );
  }
  if (read) {
    // One armed Prompt request binds the only run the Read probe may
    // declare for (hop 1 to hop 3); reading needs no write generation.
    app.decorate(
      'armIsolatedReadTool',
      (input: Omit<ReadToolArm, 'broker' | 'repositoryId'>) => {
        if (
          !ownedWrite ||
          closing ||
          read.arms?.has(input.requestId) ||
          input.scope.projectId !== policy!.projectId ||
          !input.requestId ||
          input.requestId.length > 128
        )
          throw new Error('Isolated read probe cannot be armed');
        // §11.20.27 B-1: one entry per armed request key, inserted by the
        // same bounded insert as the offered tables (oldest evicted first).
        read.arms ??= new Map();
        armRequest(read.arms, input.requestId, {
          ...structuredClone(input),
          repositoryId: readTool!.repositoryId,
          broker: ownedWrite,
        });
      },
    );
  }
  if (write) {
    // §11.20.27 hop 2: one armed Prompt request of the writable session.
    // The write generation itself is read from the Broker when the Prompt
    // is forwarded, never supplied by the caller.
    app.decorate(
      'armIsolatedWriteTools',
      (input: Omit<WriteToolArm, 'broker'>) => {
        if (
          !ownedWrite ||
          closing ||
          write.arms?.has(input.requestId) ||
          input.scope.projectId !== policy!.projectId ||
          input.repositoryId !== writeTools!.repositoryId ||
          !input.requestId ||
          input.requestId.length > 128
        )
          throw new Error('Isolated write tools cannot be armed');
        write.arms ??= new Map();
        armRequest(write.arms, input.requestId, {
          ...structuredClone(input),
          broker: ownedWrite,
        });
      },
    );
    // Live sizes of the arming tables and the job registry, for the
    // evidence that they stay bounded across many runs.
    app.decorate('isolatedWriteToolStats', () => ({
      ...armedSizes(read!, write),
      ...(write.stats?.() ?? {}),
    }));
  }
  app.addHook('onReady', async () => {
    try {
      const prepared = workbench;
      if (isolatedWrite) {
        if (closing) throw new Error('Write handoff closed during startup');
        if (!prepared)
          throw new Error('Write handoff workbench could not be assembled');
        await validateWriteHandoffDatabase(database);
      }
      if (sessionModelPilot) {
        if (closing || !prepared)
          throw new Error('Session model pilot closed before startup');
        await validateWriteHandoffDatabase(database);
        await validateSessionModelStorage(
          database,
          requestedPilot!.databaseFixture,
        );
      }
      authority = await acquireAuthority(
        database.pool,
        modelEgress !== 'direct',
        ticket,
      );
      if ((mediated || isolatedWrite) && !authority)
        throw new Error('Mediated Native database ownership was not confirmed');
      if (managedWork && closing)
        throw new Error('Write handoff closed during startup');
      if (isolatedWrite && prepared && authority) {
        ownedWrite = createOwnedWriteHandoff(
          database,
          authority,
          prepared.writeWorktrees,
          isolatedWrite.gitPath,
          undefined,
          prepared.writeLoginClosed,
          isolatedWrite.supervisedExecution === true,
          isolatedWrite.readSnapshots === true,
          readTool?.window,
        );
        ownedWrite.startStopRecovery();
        // §11.20.27 W6: the command set is registered when a write
        // generation becomes the confirmed holding (acquire, takeover).
        if (write && ownedWrite) {
          write.commands = createWriteCommands(ownedWrite);
          // The repository of every armed request (they share one in this
          // assembly); a BFF armed later registers at the first offer.
          ownedWrite.watchGrants((scope, grant) => {
            for (const repositoryId of new Set(
              [...(write.arms?.values() ?? [])].map((arm) => arm.repositoryId),
            ))
              void write.commands!.confirm(
                scope,
                grant.generation,
                repositoryId,
              );
          });
        }
      }
    } catch (error) {
      if (managedWork) {
        try {
          await workbench?.closeWorkflows();
        } finally {
          await closeDatabase();
        }
        if (!ownedWrite) await releaseConfirmedOwner();
      }
      throw error;
    }
  });
  if (!managedWork) app.addHook('onClose', closeDatabase);
  app.addHook('onRequest', async (request, reply) => {
    if (isWriteAuthorityCommand(request))
      reply.header('cache-control', 'no-store');
    if (managedWork && closing)
      return reply.code(503).send({ error: '共享运行正在关闭' });
    if (request.method === 'POST' && request.headers.origin !== options.origin)
      return reply.code(403).send({ error: '请求来源不受信任' });
  });
  app.get(
    '/api/health',
    { schema: { response: { 200: Health } } },
    async () => {
      await database.pool.query('select 1');
      return { status: 'ok' as const };
    },
  );
  app.route({
    method: ['GET', 'POST'],
    url: '/api/auth/*',
    handler: async (request, reply) => {
      const headers = fromNodeHeaders(request.headers);
      headers.set('x-rdws-client-ip', request.ip);
      const action = new URL(request.url, options.origin).pathname.slice(
        '/api/auth'.length,
      );
      const allowed =
        request.method === 'GET'
          ? action === '/get-session'
          : [
              '/sign-in/username',
              '/sign-in/email',
              '/sign-out',
              '/sign-up/email',
            ].includes(action);
      if (!allowed) return reply.code(404).send({ error: '该认证入口不可用' });
      const signingOut = action === '/sign-out';
      if (signingOut) reply.header('cache-control', 'no-store');
      const response = await auth.handler(
        new Request(new URL(request.url, options.origin), {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      if (
        signingOut &&
        response.status < 400 &&
        !response.headers.has(logoutRevocationHeader)
      )
        return reply.code(503).send({ error: logoutUnavailableMessage });
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key === 'set-cookie' || (signingOut && key === 'cache-control'))
          return;
        reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length && (!signingOut || response.status < 400))
        reply.header('set-cookie', cookies);
      return reply.send(await response.text());
    },
  });
  app.register(async (child) => {
    workbench = await registerWorkbench(
      child,
      database.db,
      auth,
      options.nativeHost,
      options.origin,
      options.repositoryHome,
      options.nativeRuntimeRoot,
      options.nativeProfiles,
      modelEgress,
      policy,
      () => ownedWrite,
      checked,
      managedWork ? trackWork : undefined,
      fixture,
      isolatedWrite?.fleetCommands === true,
      sessionModelPilot,
      read,
      write,
    );
  });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const publicMessage = (error as FastifyError & { publicMessage?: string })
      .publicMessage;
    const status =
      error.statusCode &&
      ((error.statusCode >= 400 && error.statusCode < 500) ||
        error.statusCode === 503)
        ? error.statusCode
        : 500;
    return reply.code(status).send({
      error:
        status !== 500 && typeof publicMessage === 'string'
          ? publicMessage
          : status < 500
            ? '请求参数不正确'
            : '服务暂时不可用，请稍后重试',
    });
  });
  const closeFastify = app.close.bind(app);
  function stopRuntime() {
    return (stopping ??= (async () => {
      closing = true;
      ownedWrite?.stopAdmission();
      if (managedWork) {
        const results = await Promise.allSettled([
          workbench?.closeWorkflows(),
          closeFastify(),
        ]);
        await closeDatabase();
        if (results.some(({ status }) => status === 'rejected'))
          throw new Error('Project shutdown was not confirmed');
      } else await closeFastify();
      await releaseConfirmedOwner();
      return undefined;
    })());
  }
  if (ticket !== undefined) {
    function closeRuntime(): Promise<undefined>;
    function closeRuntime(listener: () => void): undefined;
    function closeRuntime(listener?: (error?: unknown) => void) {
      const result = stopRuntime();
      if (!listener) return result;
      void result.then(
        () => listener(),
        (error: unknown) => listener(error),
      );
      return undefined;
    }
    app.close = closeRuntime;
  }
  return Object.assign(app, { stopRuntime });
}
