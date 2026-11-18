import Fastify, { type FastifyError } from 'fastify';
import { fromNodeHeaders } from 'better-auth/node';
import type { TypeBoxTypeProvider } from '@fastify/type-provider-typebox';
import { connectDatabase, schema } from '@rdws/db';
import { ApiError, Health, ProjectList } from '@rdws/contracts';
import { and, eq } from 'drizzle-orm';
import { registerWorkbench } from './modules/workbench.ts';
import { createAuth } from './modules/auth.ts';
export function buildApp(options: {
  databaseUrl: string;
  secret: string;
  origin: string;
  nativeHost?: import('@rdws/dsh/web').NativeWebHost;
  repositoryHome?: string;
}) {
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
      request.url.startsWith('/api/auth/sign-out')
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
  app.get(
    '/api/projects',
    { schema: { response: { 200: ProjectList, 401: ApiError } } },
    async (request, reply) => {
      const current = await auth.api.getSession({
        headers: fromNodeHeaders(request.headers),
      });
      if (!current) return reply.code(401).send({ error: '请先登录' });
      const [actor] = await database.db
        .select()
        .from(schema.user)
        .where(
          and(
            eq(schema.user.id, current.user.id),
            eq(schema.user.active, true),
          ),
        );
      if (!actor) return reply.code(401).send({ error: '账号已停用' });
      const rows = await database.db
        .select({
          id: schema.project.id,
          name: schema.project.name,
          role: schema.projectMember.role,
        })
        .from(schema.projectMember)
        .innerJoin(
          schema.project,
          eq(schema.project.id, schema.projectMember.projectId),
        )
        .where(eq(schema.projectMember.userId, actor.id));
      const projects = new Map<
        string,
        { id: string; name: string; roles: string[] }
      >();
      for (const row of rows) {
        const entry = projects.get(row.id) ?? {
          id: row.id,
          name: row.name,
          roles: [],
        };
        entry.roles.push(row.role);
        projects.set(row.id, entry);
      }
      return { projects: [...projects.values()] };
    },
  );
  app.register(async (child) => {
    workbench = await registerWorkbench(
      child,
      database.db,
      auth,
      options.nativeHost,
      options.origin,
      options.repositoryHome,
    );
  });
  app.setErrorHandler((error: FastifyError, _request, reply) => {
    const status =
      error.statusCode && error.statusCode >= 400 && error.statusCode < 500
        ? error.statusCode
        : 500;
    return reply.code(status).send({
      error:
        status < 500
          ? typeof (error as FastifyError & { publicMessage?: string })
              .publicMessage === 'string'
            ? (error as FastifyError & { publicMessage: string }).publicMessage
            : '请求参数不正确'
          : '服务暂时不可用，请稍后重试',
    });
  });
  return app;
}
