import { test, expect } from '@playwright/test';
import { bootstrapNative } from '../helpers/native-browser.ts';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
for (const failure of ['denied', 'timeout'] as const)
  test(
    'native context ' + failure + ' stops model and preserves retry text',
    async ({ page }) => {
      const reservation = createNetServer();
      await new Promise<void>((resolve) =>
        reservation.listen(0, '127.0.0.1', resolve),
      );
      const frontPort = (reservation.address() as { port: number }).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const origin = 'http://127.0.0.1:' + frontPort;
      let frontend: { close: () => Promise<void> } | undefined;
      let supplierHits = 0;
      const supplier = createServer((_req, res) => {
        supplierHits++;
        res.writeHead(500).end();
      });
      await new Promise<void>((resolve) =>
        supplier.listen(0, '127.0.0.1', resolve),
      );
      const port = (supplier.address() as { port: number }).port;
      class DeniedHost extends NativeWebHost {
        override configureContext() {
          super.configureContext(async (_body, _token, reply) => {
            if (failure === 'denied')
              throw new Error('Synthetic callback denial');
            await new Promise<void>((resolve) => setTimeout(resolve, 2600));
            reply({ snapshot: {}, digest: 'late-context-fixture' }, Infinity);
          });
        }
      }
      const root = await mkdtemp(
        join(await realpath(tmpdir()), 'rdws-context-failure-'),
      );
      const configuration = join(root, 'configuration');
      const native = new DeniedHost(root, configuration);
      const app = buildApp({
        databaseUrl: process.env.DATABASE_URL!,
        secret: process.env.BETTER_AUTH_SECRET!,
        origin: origin,
        nativeHost: native,
        repositoryHome: join(root, 'unconfigured-repositories'),
      });
      const pool = createTestPool('migration');
      try {
        const profile = join(configuration, 'profiles', 'rdws');
        await mkdir(profile, { recursive: true, mode: 0o700 });
        await writeFile(
          join(configuration, '.credentials.yaml'),
          JSON.stringify({
            version: 1,
            refs: { FIXTURE_MODEL: 'fixture-only' },
          }),
          { mode: 0o600 },
        );
        await writeFile(
          join(profile, 'cordis.patch.yml'),
          JSON.stringify([
            {
              id: 'llm-pi-ai',
              config: {
                providers: {
                  'rdws-glm': {
                    api: 'openai-completions',
                    apiKeyEnv: 'FIXTURE_MODEL',
                    baseURL: `http://127.0.0.1:${port}/v1`,
                    models: [{ id: 'fixture-context-model' }],
                  },
                },
              },
            },
            { id: 'session-title-llm', disabled: true },
          ]),
          { mode: 0o600 },
        );
        const backend = await app.listen({ host: '127.0.0.1', port: 0 });
        const resolver = createRequire(
          new URL('../../apps/console/package.json', import.meta.url),
        );
        const { createServer: createVite } = await import(
          resolver.resolve('vite')
        );
        const consoleRoot = fileURLToPath(
          new URL('../../apps/console', import.meta.url),
        );
        const vite = await createVite({
          root: consoleRoot,
          configFile: join(consoleRoot, 'vite.config.ts'),
          logLevel: 'silent',
          server: {
            host: '127.0.0.1',
            port: frontPort,
            strictPort: true,
            proxy: { '/api': { target: backend, ws: true } },
          },
        });
        frontend = vite;
        await vite.listen();
        const accounts = await readTestAccounts();
        const login = await app.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin: origin },
          payload: accounts.find((a) => a.username === 'lead'),
        });
        expect(login.statusCode).toBe(200);
        const cookie = login.cookies
            .map((c) => `${c.name}=${c.value}`)
            .join('; '),
          actor = login.json().user.id;
        const id = randomUUID();
        const title = 'Denied context ' + id;
        await pool.query(
          'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
          [id, 'poc', title, 'Synthetic', 'No model dispatch', actor],
        );
        await pool.query(
          'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
          [id, actor, 'developer'],
        );
        const created = await app.inject({
          method: 'POST',
          url: `/api/requirements/${id}/sessions`,
          headers: { cookie, origin: origin },
          payload: {},
        });
        expect(created.statusCode).toBe(200);
        const sid = created.json().sessionId;
        const binding = await bootstrapNative(app, cookie, id);
        const start = Date.now();
        const prompt = await app.inject({
          method: 'POST',
          url: `/api/dsh/${id}/native/api/session/prompt`,
          headers: {
            cookie,
            origin: origin,
            'x-rdws-client-generation': randomUUID(),
            'x-rdws-native-login': binding,
          },
          payload: {
            type: 'client-request',
            rpcId: randomUUID(),
            method: 'session/prompt',
            payload: {
              args: {
                request: {
                  sessionId: sid,
                  requestId: randomUUID(),
                  mode: 'queue',
                  content: [
                    {
                      type: 'text',
                      text: 'Reply with RDWS_DENIED_SHOULD_NOT_RUN.',
                    },
                  ],
                },
              },
            },
          },
        });
        expect(prompt.statusCode).toBe(200);
        async function evidence() {
          try {
            return (
              await readFile(
                join(root, 'runtime/context-evidence.jsonl'),
                'utf8',
              )
            )
              .trim()
              .split('\n')
              .map((s) => JSON.parse(s))
              .filter((r) => r.time >= start);
          } catch {
            return [];
          }
        }
        await expect
          .poll(
            async () =>
              (await evidence()).some(
                (r) => r.phase === 'rejected' && r.sessionId === sid,
              ),
            { timeout: 10000 },
          )
          .toBe(true);
        expect(
          (await evidence()).filter((r) => r.phase === 'model-call'),
        ).toHaveLength(0);
        const unauthorized = await app.inject({
          method: 'POST',
          url: '/internal/rdws/context',
          headers: { cookie, origin: origin },
          payload: { runId: randomUUID() },
        });
        expect(unauthorized.statusCode).toBe(404);
        await page.goto(origin);
        const account = accounts.find((a) => a.username === 'lead')!;
        await page.getByLabel('账号', { exact: true }).fill(account.username);
        await page.getByLabel('密码', { exact: true }).fill(account.password);
        await page.getByRole('button', { name: '登录', exact: true }).click();
        await page.getByRole('button', { name: title, exact: true }).click();
        await page.getByRole('tab', { name: '对话', exact: true }).click();
        await page
          .getByRole('button', { name: '会话 1 · 本人', exact: true })
          .click();
        const message = 'RDWS_CONTEXT_RETRY_PRESERVED';
        await page.getByLabel('消息', { exact: true }).fill(message);
        await page
          .getByRole('button', { name: '发送消息', exact: true })
          .click();
        await expect(
          page.getByText(/上下文获取失败|本轮未执行/).first(),
        ).toBeVisible({ timeout: 10000 });
        const input = page.getByLabel('消息', { exact: true });
        await expect(input).toHaveValue(message);
        await input.fill('');
        await expect(input).toHaveValue('');
        await page
          .getByRole('button', { name: '重新填入未执行消息', exact: true })
          .click();
        await expect(input).toHaveValue(message);
        expect(
          (await evidence()).filter((r) => r.phase === 'model-call'),
        ).toHaveLength(0);
        expect(supplierHits).toBe(0);
      } finally {
        try {
          await app.close();
        } finally {
          const closed = await Promise.allSettled([
            frontend?.close(),
            pool.end(),
            new Promise<void>((resolve, reject) => {
              supplier.close((error) => (error ? reject(error) : resolve()));
              supplier.closeAllConnections();
            }),
          ]);
          await rm(root, { recursive: true, force: true });
          expect(closed.every((result) => result.status === 'fulfilled')).toBe(
            true,
          );
        }
      }
    },
  );
