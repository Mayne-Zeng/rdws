import { randomBytes } from 'node:crypto';
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
}) {
  const modelEgress = resolveNativeModelEgress(
    process.env.RDWS_NATIVE_MODEL_EGRESS,
  );
  if (options.nativeHost && options.nativeHost.modelEgress !== modelEgress)
    throw new Error(
      'Native Host model egress does not match BFF configuration',
    );
  const ticket = options.authorityTicket;
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
  if (mediated) assertModelCarrierDiagnostics();
  if (
    ticket !== undefined &&
    (modelEgress === 'direct' || !/^[0-9a-f]{64}$/.test(ticket))
  )
    throw new Error('Invalid database authority startup ticket');
  const proof =
    ticket === undefined ? undefined : randomBytes(32).toString('hex');
  const database = connectDatabase(options.databaseUrl, proof);
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
  app.addHook('onReady', async () => {
    authority = await acquireAuthority(
      database.pool,
      modelEgress !== 'direct',
      ticket,
    );
    if (mediated && !authority)
      throw new Error('Mediated Native database ownership was not confirmed');
  });
  app.addHook('onClose', () => database.pool.end());
  app.addHook('onRequest', async (request, reply) => {
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
      await closeFastify();
      if (!authority || !proof) return undefined;
      if (app.server.listening)
        throw new Error('HTTP shutdown was not confirmed');
      const control = connectDatabase(options.databaseUrl, proof);
      try {
        await releaseAuthority(control.pool, authority);
      } finally {
        await control.pool.end();
      }
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
