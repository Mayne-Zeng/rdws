import Fastify, { type FastifyError } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { connectDatabase } from '@rdws/db';
import { Health } from '@rdws/contracts';
import { resolveNativeModelEgress } from '@rdws/dsh/web';
import { registerWorkbench } from './modules/workbench.ts';
import { createAuth } from './modules/auth.ts';
export function buildApp(options: {
  databaseUrl: string;
  secret: string;
  origin: string;
  nativeHost?: import('@rdws/dsh/web').NativeWebHost;
  repositoryHome?: string;
  nativeRuntimeRoot?: string;
  nativeProfiles?: ReadonlyMap<string, string>;
}) {
  const modelEgress = resolveNativeModelEgress(
    process.env.RDWS_NATIVE_MODEL_EGRESS,
  );
  if (options.nativeHost && options.nativeHost.modelEgress !== modelEgress)
    throw new Error(
      'Native Host model egress does not match BFF configuration',
    );
  const database = connectDatabase(options.databaseUrl);
  const auth = createAuth(database.db, options);
  let workbench: Awaited<ReturnType<typeof registerWorkbench>> | undefined;
  const app = Fastify({
    bodyLimit: 64 * 1024,
    logger: false,
  }).withTypeProvider<TypeBoxTypeProvider>();
  app.addHook('onClose', () => database.pool.end());
  app.addHook('onRequest', async (request, reply) => {
    if (request.method === 'POST' && request.headers.origin !== options.origin)
      return reply.code(403).send({ error: '请求来源不受信任' });
    if (
      request.method === 'POST' &&
      new URL(request.url, options.origin).pathname === '/api/auth/sign-out'
    ) {
      const confirmed = await workbench?.revokeRequest(request.headers);
      reply.header(
        'x-rdws-native-revocation',
        confirmed === false ? 'lease-expiry' : 'confirmed',
      );
    }
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
      const response = await auth.handler(
        new Request(new URL(request.url, options.origin), {
          method: request.method,
          headers,
          ...(request.body ? { body: JSON.stringify(request.body) } : {}),
        }),
      );
      reply.code(response.status);
      response.headers.forEach((value, key) => {
        if (key !== 'set-cookie') reply.header(key, value);
      });
      const cookies = response.headers.getSetCookie();
      if (cookies.length) reply.header('set-cookie', cookies);
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
  return app;
}
