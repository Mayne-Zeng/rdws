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
import type {
  FixtureToolArm,
  FixtureToolAssembly,
} from './modules/native-fixture-tool-job.ts';
import {
  createOwnedWriteHandoff,
  validateWriteHandoffDatabase,
} from './modules/write-handoff.ts';
import { checkedWriteTransaction } from './modules/checked-write-transaction.ts';
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
  isolatedWrite?: { gitPath: string; fixtureTool?: true };
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
  if (
    isolatedWrite &&
    (process.env.RDWS_MODE !== 'test' ||
      process.platform !== 'darwin' ||
      !ticket ||
      modelEgress !== (fixtureTool ? 'mediated' : 'paused') ||
      options.nativeHost ||
      !isAbsolute(isolatedWrite.gitPath))
  )
    throw new Error('Isolated write handoff requires a managed macOS test BFF');
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
  if (
    fixtureTool &&
    (!policy ||
      policy.firstMessageTitle ||
      new URL(policy.destination).hostname !== '127.0.0.1')
  )
    throw new Error('Isolated tool probe requires a loopback model supplier');
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
    isolatedWrite ? 3_000 : undefined,
    !!isolatedWrite,
  );
  let ownedWrite: ReturnType<typeof createOwnedWriteHandoff> | undefined;
  const fixture: FixtureToolAssembly | undefined = fixtureTool ? {} : undefined;
  let workbench: Awaited<ReturnType<typeof registerWorkbench>> | undefined;
  const auth = createAuth(database.db, {
    secret: options.secret,
    origin: options.origin,
    onLogout: async (id) => workbench?.closeLogin(id) ?? false,
  });
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
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
  const checked = isolatedWrite
    ? checkedWriteTransaction(database.pool)
    : undefined;
  if (isolatedWrite)
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
  app.addHook('onReady', async () => {
    try {
      const prepared = workbench;
      if (isolatedWrite) {
        if (closing) throw new Error('Write handoff closed during startup');
        if (!prepared)
          throw new Error('Write handoff workbench could not be assembled');
        await validateWriteHandoffDatabase(database);
      }
      authority = await acquireAuthority(
        database.pool,
        modelEgress !== 'direct',
        ticket,
      );
      if ((mediated || isolatedWrite) && !authority)
        throw new Error('Mediated Native database ownership was not confirmed');
      if (isolatedWrite && closing)
        throw new Error('Write handoff closed during startup');
      if (isolatedWrite && prepared && authority)
        ownedWrite = createOwnedWriteHandoff(
          database,
          authority,
          prepared.writeWorktrees,
          isolatedWrite.gitPath,
          undefined,
          prepared.writeLoginClosed,
        );
    } catch (error) {
      if (isolatedWrite) {
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
  if (!isolatedWrite) app.addHook('onClose', closeDatabase);
  app.addHook('onRequest', async (request, reply) => {
    if (isolatedWrite && closing)
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
      isolatedWrite ? trackWork : undefined,
      fixture,
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
      if (isolatedWrite) {
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
