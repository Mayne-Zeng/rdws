import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';

export const name = 'test-native-egress-paused';
export const inject = ['llm', 'webServer', 'credentials'];

export function apply(ctx, { port }) {
  ctx.effect(() =>
    ctx.webServer.register({
      kind: 'exact',
      path: '/__fixture_model_egress',
      auth: 'anonymous',
      async handler(_request, response) {
        const deadline = Date.now() + 2000;
        while (!(await ctx.credentials.resolve('FIXTURE_MODEL'))) {
          if (Date.now() >= deadline) {
            response.writeHead(503).end();
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        const tcp = await new Promise((resolve) => {
          const socket = createConnection({ host: '127.0.0.1', port });
          socket.once('connect', () => {
            socket.destroy();
            resolve('connected');
          });
          socket.once('error', (error) => resolve(error.code));
          socket.setTimeout(1500, () => {
            socket.destroy();
            resolve('timeout');
          });
        });
        let finish;
        for await (const chunk of ctx.llm.stream({
          provider: 'rdws-glm',
          model: 'fixture-llm',
          sessionId: 'model-egress-fixture',
          messages: [
            {
              id: randomUUID(),
              role: 'user',
              source: { kind: 'user' },
              content: [
                { type: 'text', text: 'Synthetic direct transport probe' },
              ],
            },
          ],
          signal: AbortSignal.timeout(3000),
        })) {
          if (chunk.type === 'finish') finish = chunk.reason;
        }
        response.setHeader('content-type', 'application/json');
        response.end(
          JSON.stringify({
            pid: process.pid,
            port: ctx.webServer.port,
            tcp,
            finish: finish?.kind,
            failure: finish?.failure?.message,
            inheritedProxy: [
              'HTTP_PROXY',
              'HTTPS_PROXY',
              'ALL_PROXY',
              'NO_PROXY',
            ].some((key) => Object.hasOwn(process.env, key)),
          }),
        );
      },
    }),
  );
}
