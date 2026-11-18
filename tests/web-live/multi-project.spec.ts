import type { APIRequestContext } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '@rdws/server';
import { bodyHash, signGrant } from '@rdws/dsh/access';
import { Pool } from 'pg';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';
import { nativeReady } from '../helpers/native-ready.ts';

test('one login sends and reads in two isolated project runtimes', async ({
  page,
}) => {
  test.setTimeout(180_000);
  const project = 'team-' + randomUUID();
  const root = join(runtimeHome, 'testing-projects', randomUUID());
  const configuration = join(runtimeHome, 'runtime/dsh/project-poc');
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const temp = createServer();
  await new Promise<void>((resolve) => temp.listen(0, '127.0.0.1', resolve));
  const frontPort = (temp.address() as { port: number }).port;
  await new Promise<void>((resolve) => temp.close(() => resolve()));
  const origin = 'http://127.0.0.1:' + frontPort;
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    nativeRuntimeRoot: root,
    nativeProfiles: new Map([[project, configuration]]),
  });
  const ids: string[] = [];
  let frontend: { close(): Promise<void> } | undefined;
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const api = await app.listen({ port: 0, host: '127.0.0.1' });
    const resolver = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolver.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    const web = await createVite({
      root: consoleRoot,
      configFile: join(consoleRoot, 'vite.config.ts'),
      cacheDir: join(root, 'vite-cache'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port: frontPort,
        strictPort: true,
        proxy: { '/api': { target: api, ws: true } },
      },
    });
    frontend = web;
    await web.listen();
    await pool.query('insert into project(id,name) values ($1,$2)', [
      project,
      'T03 合成项目',
    ]);
    await pool.query(
      `insert into project_member(project_id,user_id,role)
      select $1,id,case username when 'manager' then 'requirement_manager' when 'pm' then 'project_admin' else 'developer' end
      from auth_user where username in ('lead','manager','pm')`,
      [project],
    );
    const leadId = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    ) as { username: string; password: string }[];
    await prepareSession(
      page.context(),
      origin,
      accounts.find((row) => row.username === 'manager')!,
    );
    const targets = [
      {
        projectId: 'poc',
        title: '隔离验证甲 ' + randomUUID(),
        marker: 'RDWS_PROJECT_ALPHA',
      },
      {
        projectId: project,
        title: '隔离验证乙 ' + randomUUID(),
        marker: 'RDWS_PROJECT_BRAVO',
      },
    ];
    for (const target of targets) {
      const response = await page.request.post(
        origin + '/api/projects/' + target.projectId + '/requirements',
        {
          headers: { origin },
          data: {
            commandId: randomUUID(),
            title: target.title,
            description: 'Synthetic two-project testcase',
            acceptance: 'Distinct DSH identities',
            leadId,
            participants: [],
          },
        },
      );
      expect(response.status()).toBe(200);
      ids.push((await response.json()).id);
    }
    await prepareSession(
      page.context(),
      origin,
      accounts.find((row) => row.username === 'lead')!,
    );
    const sessions: string[] = [];
    for (let i = 0; i < targets.length; i++) {
      const target = targets[i]!;
      if (!i)
        await page.goto(
          origin + '/?project=poc&requirement=' + ids[0] + '&view=chat',
        );
      else {
        await page
          .getByLabel('切换项目', { exact: true })
          .selectOption(target.projectId);
        await page
          .getByRole('button', { name: target.title, exact: true })
          .click();
        await page.getByRole('tab', { name: '对话', exact: true }).click();
      }
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      await page
        .getByLabel('消息', { exact: true })
        .fill('Reply only ' + target.marker + '. Do not use tools.');
      await page.getByRole('button', { name: '发送消息', exact: true }).click();
      await expect(
        page.locator('.message:not(.from-user)>div').last(),
      ).toContainText(target.marker, { timeout: 60_000 });
      await expect(page.locator('[data-live="true"]')).toHaveCount(0, {
        timeout: 20_000,
      });
      const catalog = await (
        await page.request.get(
          origin + '/api/requirements/' + ids[i] + '/sessions',
        )
      ).json();
      expect(catalog.sessions).toHaveLength(1);
      sessions.push(catalog.sessions[0].id);
      await page.getByRole('button', { name: '回放历史', exact: true }).click();
      await expect(
        page.getByRole('region', { name: '会话历史回放' }),
      ).toContainText(target.marker);
      const workspace = (
        await pool.query(
          'select native_workspace_id from requirement where id=$1',
          [ids[i]],
        )
      ).rows[0].native_workspace_id;
      expect(workspace).toBeTruthy();
      const data = await readdir(
        join(root, 'runtime/dsh/project-' + target.projectId, 'sessions'),
        { recursive: true },
      );
      expect(
        data.some((entry) => entry.split('/').includes(sessions[i]!)),
      ).toBe(true);
    }
    const alpha = await nativeReady(root),
      bravo = await nativeReady(root, project);
    expect(alpha.pid).not.toBe(bravo.pid);
    expect(alpha.port).not.toBe(bravo.port);
    expect(alpha.generation).not.toBe(bravo.generation);
    for (const [i, native] of [alpha, bravo].entries()) {
      const projectId = targets[i]!.projectId;
      const name =
        projectId === 'poc' ? 'dsh-bff-key' : 'dsh-bff-key-' + projectId;
      const signingKey = await readFile(join(root, 'secrets', name), 'utf8');
      const body = { requirementId: ids[i], sessionId: sessions[i] };
      const ticket = signGrant(signingKey, {
        aud: 'rdws:' + projectId,
        purpose: 'service',
        operation: 'session.inspect',
        bodyHash: bodyHash(body),
        hostGeneration: native.generation,
      });
      const proof = await fetch(
        'http://127.0.0.1:' + native.port + '/_rdws/session.inspect',
        {
          method: 'POST',
          headers: {
            'x-rdws-delegation': ticket,
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
        },
      );
      expect(proof.ok).toBe(true);
      const workspace = (
        await pool.query(
          'select native_workspace_id from requirement where id=$1',
          [ids[i]],
        )
      ).rows[0].native_workspace_id;
      expect(await proof.json()).toEqual({
        workspaceId: workspace,
        cwd: join(root, 'projects', projectId, 'demands', ids[i]!),
      });
    }

    const key = await readFile(join(root, 'secrets', 'dsh-bff-key'), 'utf8');
    const token = signGrant(key, {
      aud: 'rdws:poc',
      purpose: 'browser',
      hostGeneration: alpha.generation,
    });
    expect(
      (
        await fetch('http://127.0.0.1:' + bravo.port + '/_rdws/bootstrap', {
          headers: { 'x-rdws-delegation': token },
        })
      ).status,
    ).toBe(401);
    const oldToken = signGrant(key, {
      aud: 'rdws:poc',
      purpose: 'browser',
      hostGeneration: randomUUID(),
    });
    expect(
      (
        await fetch('http://127.0.0.1:' + alpha.port + '/_rdws/bootstrap', {
          headers: { 'x-rdws-delegation': oldToken },
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await page.request.get(
          origin +
            '/api/requirements/' +
            ids[0] +
            '/sessions/' +
            sessions[1] +
            '/history',
        )
      ).status(),
    ).toBe(403);
    await page.goto(
      origin + '/?project=' + project + '&requirement=' + ids[0] + '&view=chat',
    );
    await expect(
      page.getByText('无法在当前项目打开此需求，请核对项目与需求权限。'),
    ).toBeVisible();
    await page.getByLabel('切换项目', { exact: true }).selectOption('poc');
    await page
      .getByRole('button', { name: targets[0]!.title, exact: true })
      .click();
    await page.getByRole('tab', { name: '对话', exact: true }).click();
    await page
      .getByRole('button', { name: '会话 1 · 本人', exact: true })
      .click();
    await expect(page.getByTestId('transcript')).toContainText(
      targets[0]!.marker,
    );
    const sameAccount = await page.context().browser()!.newContext();
    const administrator = await page.context().browser()!.newContext();
    try {
      await prepareSession(
        sameAccount,
        origin,
        accounts.find((row) => row.username === 'lead')!,
      );
      await prepareSession(
        administrator,
        origin,
        accounts.find((row) => row.username === 'pm')!,
      );
      const targetKey = await readFile(
        join(root, 'secrets', 'dsh-bff-key-' + project),
        'utf8',
      );
      const nativeUrl = 'http://127.0.0.1:' + bravo.port + '/_rdws/bootstrap';
      const retained = await Promise.all(
        [page.context(), sameAccount].map(async (browserContext) => {
          const current = await (
            await browserContext.request.get(origin + '/api/auth/get-session')
          ).json();
          const ticket = signGrant(targetKey, {
            aud: 'rdws:' + project,
            purpose: 'browser',
            hostGeneration: bravo.generation,
            authSessionId: current.session.id,
            userId: current.user.id,
            requirementId: ids[1],
            readSessionIds: [sessions[1]!],
            ownSessionIds: [sessions[1]!],
          });
          expect(
            (
              await fetch(nativeUrl, {
                headers: { 'x-rdws-delegation': ticket },
              })
            ).status,
          ).toBe(200);
          return ticket;
        }),
      );
      const roles = (next: string[]) =>
        administrator.request.post(origin + '/api/management/commands', {
          headers: { origin },
          data: {
            kind: 'project.roles',
            commandId: randomUUID(),
            projectId: project,
            username: 'lead',
            roles: next,
          },
        });
      expect(await (await roles([])).json()).toMatchObject({
        changed: true,
        revocation: 'confirmed',
      });
      for (const ticket of retained)
        expect(
          (await fetch(nativeUrl, { headers: { 'x-rdws-delegation': ticket } }))
            .status,
        ).toBe(401);
      for (const browserContext of [page.context(), sameAccount]) {
        expect((await boot(browserContext.request, ids[1]!)).status()).toBe(
          403,
        );
        expect((await boot(browserContext.request, ids[0]!)).ok()).toBe(true);
      }
      expect((await roles(['developer'])).ok()).toBe(true);
      expect((await boot(page.request, ids[1]!)).ok()).toBe(true);
    } finally {
      await sameAccount.close();
      await administrator.close();
    }
    async function boot(request: APIRequestContext, id: string) {
      const identity = await (
        await request.get(origin + '/api/auth/get-session')
      ).json();
      return request.get(origin + '/api/dsh/' + id + '/bootstrap', {
        headers: { 'x-rdws-edit-session': identity.session.id },
      });
    }
    process.kill(bravo.pid, 'SIGTERM');
    await expect
      .poll(async () => (await boot(page.request, ids[1]!)).ok())
      .toBe(false);
    expect((await boot(page.request, ids[0]!)).ok()).toBe(true);
    expect(errors).toEqual([]);
  } finally {
    await frontend?.close();
    await app.close();
    for (const id of ids) {
      await pool.query(
        'delete from session_operation where requirement_id=$1',
        [id],
      );
      await pool.query('delete from native_session where requirement_id=$1', [
        id,
      ]);
      await pool.query(
        'delete from requirement_event where requirement_id=$1',
        [id],
      );
      await pool.query(
        'delete from requirement_participant where requirement_id=$1',
        [id],
      );
      await pool.query('delete from requirement where id=$1', [id]);
    }
    await pool.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await pool.query('delete from project where id=$1', [project]);
    await pool.end();
  }
});
