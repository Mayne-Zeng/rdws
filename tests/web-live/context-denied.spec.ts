import { test, expect } from '@playwright/test';
import { createServer as createNetServer } from 'node:net';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { NativeWebHost } from '@rdws/dsh/web';
import { buildApp } from '@rdws/server';
import { runtimeHome } from '../../scripts/env.mjs';
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
      const denied = createServer((_req, res) => {
        if (failure === 'denied') {
          res.writeHead(403);
          res.end();
        } else
          setTimeout(() => {
            if (!res.destroyed) {
              res.writeHead(503);
              res.end();
            }
          }, 2600).unref();
      });
      await new Promise<void>((resolve) =>
        denied.listen(0, '127.0.0.1', resolve),
      );
      const port = (denied.address() as { port: number }).port;
      class DeniedHost extends NativeWebHost {
        override configureContext(_url: string, origin: string) {
          super.configureContext(`http://127.0.0.1:${port}/context`, origin);
        }
      }
      const root = join(runtimeHome, 'testing-context-' + failure);
      const native = new DeniedHost(
        root,
        join(runtimeHome, 'runtime/dsh/project-poc'),
      );
      const app = buildApp({
        databaseUrl: process.env.DATABASE_URL!,
        secret: process.env.BETTER_AUTH_SECRET!,
        origin: origin,
        nativeHost: native,
      });
      const pool = new Pool({
        connectionString: process.env.DATABASE_MIGRATION_URL,
      });
      try {
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
        const accounts = JSON.parse(
          await readFile(
            join(runtimeHome, 'secrets/test-accounts.json'),
            'utf8',
          ),
        ) as { username: string; password: string }[];
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
        const start = Date.now();
        const prompt = await app.inject({
          method: 'POST',
          url: `/api/dsh/${id}/native/api/session/prompt`,
          headers: {
            cookie,
            origin: origin,
            'x-rdws-client-generation': randomUUID(),
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
        expect(unauthorized.statusCode).toBe(403);
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
        await expect(page.getByLabel('消息', { exact: true })).toHaveValue(
          message,
        );
        await expect(
          page.getByRole('button', { name: '重新填入未执行消息', exact: true }),
        ).toBeVisible();
        expect(
          (await evidence()).filter((r) => r.phase === 'model-call'),
        ).toHaveLength(0);
        console.log(
          'Native context denial: model calls 0; callback denied; Web error and retry text preserved.',
        );
      } finally {
        await app.close();
        await frontend?.close();
        await pool.end();
        await new Promise<void>((resolve, reject) =>
          denied.close((e) => (e ? reject(e) : resolve())),
        );
      }
    },
  );
