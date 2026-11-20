import { expect, test, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';

function releaseCommitGate() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  let entered = false;
  const connect = Pool.prototype.connect;
  Pool.prototype.connect = function (this: Pool, ...args: unknown[]) {
    const result = Reflect.apply(connect, this, args);
    if (args.length) return result;
    return result.then((client: PoolClient) => {
      const query = client.query;
      let releasing = false;
      client.query = ((...params: unknown[]) => {
        const input = params[0] as string | { text: string };
        const text = typeof input === 'string' ? input : input.text;
        if (
          text.startsWith('insert into "command_receipt"') &&
          Array.isArray(params[1]) &&
          params[1].includes('write.release')
        )
          releasing = true;
        const response = Reflect.apply(query, client, params);
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (text === 'commit' && releasing && !entered)
          return response.then(async (value: unknown) => {
            entered = true;
            await wait;
            return value;
          });
        return response;
      }) as typeof client.query;
      return client;
    });
  } as typeof connect;
  return {
    entered: () => entered,
    release() {
      Pool.prototype.connect = connect;
      open();
    },
  };
}

test.skip(
  process.platform !== 'darwin',
  'The managed write fixture uses macOS Seatbelt.',
);

test('two real fleet logins recover commands and hand over after physical stop', async ({
  browser,
}) => {
  process.env.RDWS_MODE = 'test';
  process.env.RDWS_NATIVE_MODEL_EGRESS = 'paused';
  const lab = await authorityDatabase();
  let source: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
  let app: ReturnType<typeof buildApp> | undefined;
  let web: { close(): Promise<void> } | undefined;
  let mirrors: RepositoryMirrors | undefined;
  let trees: DemandWorktrees | undefined;
  let releaseGate: ReturnType<typeof releaseCommitGate> | undefined;
  let closingGate: ReturnType<typeof releaseCommitGate> | undefined;
  let closing: Promise<unknown> | undefined;
  const projectId = 'poc';
  const demand = randomUUID();
  const owner = randomUUID();
  const successor = randomUUID();
  const aSession = randomUUID();
  const bSession = randomUUID();
  const viewerSession = randomUUID();
  const viewer = randomUUID();
  const ticket = randomBytes(32).toString('hex');
  const password = randomBytes(18).toString('hex');
  const commandPath = (sessionId: string) =>
    `/api/requirements/${demand}/sessions/${sessionId}/write-authority/commands`;
  const statusPath = `/api/requirements/${demand}/write-authority`;
  const originalStatus = async () =>
    (
      await lab.owner.query(
        'select generation,phase,native_session_id,run_id from requirement_write_lease where requirement_id=$1',
        [demand],
      )
    ).rows[0];
  const receiptCount = async () =>
    (
      await lab.owner.query(
        "select count(*)::int as n from command_receipt where scope=$1 and operation in ('write.acquire','write.release')",
        ['requirement:' + demand],
      )
    ).rows[0]?.n;

  try {
    source = await httpsGitFixture(projectId);
    const root = source.root;
    mirrors = new RepositoryMirrors(root);
    trees = new DemandWorktrees(root, mirrors);
    await writeFile(join(source.work, 'sample.txt'), 'baseline');
    await fixtureGit(['-C', source.work, 'add', '--', 'sample.txt']);
    await source.commit();
    await source.update();
    expect(
      await mirrors.sync(projectId, 'app', 'fixture', randomUUID(), (publish) =>
        publish(),
      ),
    ).toMatchObject({ status: 'succeeded' });
    const plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
      ...entry,
      branch: 'rdws/' + demand + '/' + entry.repositoryId,
      worktreePath: 'worktrees/' + entry.repositoryId,
      gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
    }));
    await trees.prepare(projectId, demand, plan);
    const checkout = await trees.executionScope(projectId, demand, plan, 'app');
    const sample = join(checkout.tree, 'sample.txt');
    await lab.owner.query(
      "insert into project(id,name) values ($1,'Synthetic fleet')",
      [projectId],
    );
    const passwordHash = await hashPassword(password);
    for (const [id, username, role] of [
      [owner, 'fleet_a', 'developer'],
      [successor, 'fleet_b', 'developer'],
      [viewer, 'fleet_viewer', 'tester'],
    ]) {
      await lab.owner.query(
        'insert into auth_user(id,name,username,email,active) values($1,$2,$2,$3,true)',
        [id, username, username + '@fixture.invalid'],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), id, passwordHash],
      );
      await lab.owner.query('insert into project_member values ($1,$2,$3)', [
        projectId,
        id,
        role,
      ]);
    }
    await lab.owner.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Fleet handover','','',$3,$3)",
      [demand, projectId, owner],
    );
    await lab.owner.query(
      "insert into requirement_participant values($1,$2,'developer'),($1,$3,'developer'),($1,$4,'tester')",
      [demand, owner, successor, viewer],
    );
    await lab.owner.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3),($4,$2,$5),($6,$2,$7)',
      [aSession, demand, owner, bSession, successor, viewerSession, viewer],
    );
    await lab.owner.query(
      "insert into task(id,requirement_id,title,assignee_id,created_by) values($1,$2,'Handover task',$3,$4)",
      [randomUUID(), demand, successor, owner],
    );
    await lab.owner.query(
      'insert into requirement_worktree_plan(requirement_id,repositories) values($1,$2::jsonb)',
      [demand, JSON.stringify(plan)],
    );
    await lab.owner.query(
      'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
      [createHash('sha256').update(ticket).digest('hex')],
    );

    const portProbe = createServer();
    await new Promise<void>((resolve) =>
      portProbe.listen(0, '127.0.0.1', resolve),
    );
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const origin = 'http://127.0.0.1:' + port;
    app = buildApp({
      databaseUrl: lab.databaseUrl,
      secret: lab.childEnv.BETTER_AUTH_SECRET!,
      origin,
      authorityTicket: ticket,
      repositoryHome: root,
      nativeRuntimeRoot: root,
      isolatedWrite: {
        gitPath: execFileSync('/usr/bin/which', ['git'], {
          encoding: 'utf8',
        }).trim(),
        fleetCommands: true,
      },
    });
    const api = await app.listen({ port: 0, host: '127.0.0.1' });
    const resolve = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolve.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    const frontend = await createVite({
      root: consoleRoot,
      configFile: join(consoleRoot, 'vite.config.ts'),
      cacheDir: join(root, 'vite-cache'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        proxy: { '/api': { target: api, ws: true } },
      },
    });
    web = frontend;
    await frontend.listen();
    const broker = app.getDecorator<() => OwnedWriteHandoff>(
      'isolatedWriteHandoff',
    )();
    function startLoop(
      scope: Parameters<OwnedWriteHandoff['execute']>[0],
      generation: string,
    ) {
      let pid = 0;
      const execution = broker.execute(
        scope,
        {
          generation,
          commandId: randomUUID(),
          repositoryId: 'app',
          request: {
            tool: 'shell',
            script: 'printf "%s\\n" "$$"; while :; do :; done',
          },
        },
        ({ stream, chunk }) => {
          if (stream === 'stdout') pid = Number(chunk.toString().trim());
        },
      );
      void execution.catch(() => {});
      return { execution, pid: () => pid };
    }
    const fleetUrl = '/?project=poc&view=fleet&requirement=' + demand;

    async function login(username: string) {
      const ctx = await browser.newContext({ baseURL: origin });
      const logged = await ctx.request.post('/api/auth/sign-in/username', {
        headers: { origin },
        data: { username, password },
      });
      expect(logged.status()).toBe(200);
      const { session } = await (
        await ctx.request.get('/api/auth/get-session')
      ).json();
      const page = await ctx.newPage();
      await page.goto(fleetUrl);
      await expect(
        page.getByRole('heading', { name: '编队', exact: true }),
      ).toBeVisible();
      return { ctx, page, loginId: session.id as string };
    }
    const a = await login('fleet_a');
    const b = await login('fleet_b');
    const tester = await login('fleet_viewer');
    const status = (side: typeof a) =>
      side.page.getByRole('status', { name: '写权状态' });
    const message = (side: typeof a) =>
      side.page.getByRole('status', { name: '写权操作结果' });
    const pendingButton = (side: typeof a) =>
      side.page.getByRole('button', { name: '核对原操作' });
    await expect(status(tester)).toHaveText('暂无写会话');
    await expect(
      tester.page.getByRole('button', { name: '设为写会话' }),
    ).toHaveCount(0);
    expect(
      (
        await tester.ctx.request.post(commandPath(viewerSession), {
          headers: { origin, 'x-rdws-edit-session': tester.loginId },
          data: { type: 'acquire', commandId: randomUUID() },
        })
      ).status(),
    ).toBe(403);
    await tester.ctx.close();
    const oldIdle = await (
      await a.ctx.request.get(statusPath, {
        headers: { 'x-rdws-edit-session': a.loginId },
      })
    ).json();
    expect(oldIdle.state).toBe('idle');

    await a.page.setViewportSize({ width: 390, height: 850 });
    const setWriter = a.page.getByRole('button', { name: '设为写会话' });
    await expect(setWriter).toBeVisible();
    expect((await setWriter.boundingBox())!.height).toBeGreaterThanOrEqual(40);
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    let lostAcquire: { commandId: string; generation: string } | undefined;
    await a.page.route(
      '**' + commandPath(aSession),
      async (route) => {
        const response = await route.fetch().catch(() => undefined);
        if (!response)
          throw new Error('Synthetic acquire did not reach the BFF');
        expect(response.status()).toBe(200);
        lostAcquire = await response.json();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await a.page.getByRole('button', { name: '设为写会话' }).click();
    await expect(message(a)).toContainText('未能完成确认');
    expect(lostAcquire?.generation).toEqual(expect.any(String));
    const originalCookies = await a.ctx.cookies();
    expect(
      (
        await a.ctx.request.post('/api/auth/sign-in/username', {
          headers: { origin },
          data: { username: 'fleet_a', password },
        })
      ).status(),
    ).toBe(200);
    const replacement = await (
      await a.ctx.request.get('/api/auth/get-session')
    ).json();
    expect(replacement.session.id).not.toBe(a.loginId);
    const replacementCookies = await a.ctx.cookies();
    await a.page.reload();
    await expect(status(a)).toHaveText('写权已占用');
    await expect(pendingButton(a)).toHaveCount(0);
    await expect(a.page.getByRole('button', { name: '释放写锁' })).toHaveCount(
      0,
    );
    expect(
      (
        await a.ctx.request.post(
          commandPath(aSession).replace('/commands', '/check'),
          {
            headers: { origin, 'x-rdws-edit-session': replacement.session.id },
            data: { type: 'acquire', commandId: lostAcquire!.commandId },
          },
        )
      ).status(),
    ).toBe(409);
    await a.ctx.clearCookies();
    await a.ctx.addCookies(originalCookies);
    await a.page.reload();
    await expect(pendingButton(a)).toBeVisible();
    let replyReady = false;
    let deliver!: () => void;
    const withheld = new Promise<void>((resolve) => {
      deliver = resolve;
    });
    await a.page.route(
      '**' + commandPath(aSession),
      async (route) => {
        const response = await route.fetch().catch(() => undefined);
        if (!response) throw new Error('Synthetic retry did not reach the BFF');
        expect(response.status()).toBe(200);
        replyReady = true;
        await withheld;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    let allowReads!: () => void;
    const waitReads = new Promise<void>((resolve) => {
      allowReads = resolve;
    });
    const pauseReads = async (route: Route) => {
      if (route.request().method() !== 'GET') return route.fallback();
      await waitReads;
      await route.continue().catch(() => {});
    };
    await a.page.route('**/api/**', pauseReads);
    try {
      await a.page.getByRole('button', { name: '重试原操作' }).click();
      await expect.poll(() => replyReady).toBe(true);
      await a.ctx.addCookies(replacementCookies);
      await expect(message(a)).toHaveText('原操作待核对。');
      const delivered = a.page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === commandPath(aSession),
      );
      const stateProbe = a.page.waitForRequest(
        (request) =>
          request.method() === 'GET' &&
          new URL(request.url()).pathname === statusPath,
      );
      deliver();
      const oldResponse = await delivered;
      expect(oldResponse.status()).toBe(200);
      await oldResponse.finished();
      await stateProbe;
      expect(
        await a.page.evaluate(
          (commandId) =>
            Object.values(sessionStorage).some(
              (value) => typeof value === 'string' && value.includes(commandId),
            ),
          lostAcquire!.commandId,
        ),
      ).toBe(true);
    } finally {
      deliver();
      allowReads();
    }
    await a.page.unroute('**/api/**', pauseReads);
    await expect(
      a.page.getByText('会话访问已变化，请重新读取会话列表。'),
    ).toBeVisible();
    expect(
      await a.page.evaluate(
        (commandId) =>
          Object.values(sessionStorage).some(
            (value) => typeof value === 'string' && value.includes(commandId),
          ),
        lostAcquire!.commandId,
      ),
    ).toBe(true);
    await a.ctx.clearCookies();
    await a.ctx.addCookies(originalCookies);
    await a.page.reload();
    await expect(pendingButton(a)).toBeVisible();
    const beforeCheck = await originalStatus();
    const beforeCount = await receiptCount();
    const requests: string[] = [];
    a.page.on('request', (request) =>
      requests.push(request.method() + ' ' + new URL(request.url()).pathname),
    );
    await pendingButton(a).click();
    await expect(message(a)).toContainText('原操作已核对');
    const receiptIndex = requests.indexOf(
      'POST ' + commandPath(aSession).replace('/commands', '/check'),
    );
    expect(receiptIndex).toBeGreaterThanOrEqual(0);
    expect(requests.slice(receiptIndex + 1)).toContain('GET ' + statusPath);
    expect(requests).not.toContain('POST ' + commandPath(aSession));
    expect(await originalStatus()).toEqual(beforeCheck);
    expect(await receiptCount()).toBe(beforeCount);
    const aScope = {
      who: { userId: owner, authSessionId: a.loginId },
      projectId,
      requirementId: demand,
      sessionId: aSession,
    };
    const running = startLoop(aScope, lostAcquire!.generation);
    await expect.poll(running.pid).toBeGreaterThan(1);
    const pid = running.pid();
    expect(process.kill(-pid, 0)).toBe(true);

    const version = await a.ctx.request.post(
      `/api/requirements/${demand}/commands`,
      {
        headers: { origin },
        data: {
          type: 'task.create',
          commandId: randomUUID(),
          task: { title: 'Change context', assigneeId: successor },
        },
      },
    );
    expect(version.status()).toBe(200);
    await a.page.reload();
    await expect(status(a)).toHaveText('写权状态待确认');
    const releaseButton = a.page.getByRole('button', { name: '释放写锁' });
    await expect(releaseButton).toBeVisible();
    await expect(b.page.getByRole('button', { name: '释放写锁' })).toHaveCount(
      0,
    );

    releaseGate = releaseCommitGate();
    let releaseBody:
      { type: string; commandId: string; generation: string } | undefined;
    await a.page.route(
      '**' + commandPath(aSession),
      async (route) => {
        releaseBody = route.request().postDataJSON();
        await route.fetch().catch(() => {});
        await route.abort('failed').catch(() => {});
      },
      { times: 1 },
    );
    await releaseButton.click();
    await expect.poll(releaseGate.entered).toBe(true);
    expect(await originalStatus()).toMatchObject({
      generation: lostAcquire!.generation,
      phase: 'draining',
      run_id: expect.any(String),
    });
    expect(process.kill(-pid, 0)).toBe(true);
    expect(
      (
        await b.ctx.request.post(commandPath(bSession), {
          headers: { origin, 'x-rdws-edit-session': b.loginId },
          data: { type: 'acquire', commandId: randomUUID() },
        })
      ).status(),
    ).toBe(409);
    await a.page.goto('about:blank');
    let respondWithOldIdle = true;
    await a.page.route('**' + statusPath, (route) =>
      respondWithOldIdle ? route.fulfill({ json: oldIdle }) : route.continue(),
    );
    await a.page.route(
      '**' + commandPath(aSession).replace('/commands', '/check'),
      async (route) => {
        const response = await route.fetch().catch(() => undefined);
        if (!response) throw new Error('Synthetic check did not reach the BFF');
        respondWithOldIdle = false;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    await a.page.goto(fleetUrl);
    await expect(status(a)).toHaveText('暂无写会话');
    await expect(pendingButton(a)).toBeVisible();
    await pendingButton(a).click();
    await expect(message(a)).toContainText('仍待确认');
    await expect(pendingButton(a)).toBeVisible();
    expect(process.kill(-pid, 0)).toBe(true);
    releaseGate.release();
    expect(await running.execution).toMatchObject({
      status: 'finished',
      result: { stop: 'confirmed' },
    });
    await expect
      .poll(originalStatus)
      .toMatchObject({ phase: 'released', run_id: null });
    await pendingButton(a).click();
    await expect(message(a)).toContainText('原操作已核对');

    const selected = b.page.getByRole('button', { name: '设为写会话' });
    await selected.click();
    await expect(status(b)).toContainText('本人会话');
    const next = await originalStatus();
    expect(next.generation).not.toBe(lostAcquire!.generation);
    expect(next.native_session_id).toBe(bSession);
    const bScope = {
      who: { userId: successor, authSessionId: b.loginId },
      projectId,
      requirementId: demand,
      sessionId: bSession,
    };
    expect(
      await broker.execute(bScope, {
        generation: next.generation,
        commandId: randomUUID(),
        repositoryId: 'app',
        request: {
          tool: 'file',
          operation: 'write',
          path: 'sample.txt',
          text: 'next writer',
        },
      }),
    ).toMatchObject({
      status: 'finished',
      result: { status: 'ok', stop: 'confirmed' },
    });
    expect(await readFile(sample, 'utf8')).toBe('next writer');
    const replay = await a.ctx.request.post(commandPath(aSession), {
      headers: { origin, 'x-rdws-edit-session': a.loginId },
      data: releaseBody,
    });
    expect(await replay.json()).toMatchObject({
      state: 'released',
      generation: lostAcquire!.generation,
    });
    expect(await originalStatus()).toMatchObject({
      generation: next.generation,
      phase: 'held',
    });

    await b.page.getByRole('button', { name: '释放写锁' }).click();
    await expect(message(b)).toHaveText('原写代已释放。');
    let expiredAcquire: { generation: string } | undefined;
    await b.page.route(
      '**' + commandPath(bSession),
      async (route) => {
        const response = await route.fetch().catch(() => undefined);
        if (!response)
          throw new Error('Synthetic historical acquire did not reach the BFF');
        expect(response.status()).toBe(200);
        expiredAcquire = await response.json();
        await route.abort('failed');
      },
      { times: 1 },
    );
    await b.page.getByRole('button', { name: '设为写会话' }).click();
    await expect(message(b)).toContainText('未能完成确认');
    expect(expiredAcquire?.generation).toEqual(expect.any(String));
    await broker.release(bScope, expiredAcquire!.generation, randomUUID());
    await pendingButton(b).click();
    await expect(message(b)).toContainText('原申请已记录，写代已结束');
    await expect(pendingButton(b)).toHaveCount(0);
    await b.page.getByRole('button', { name: '设为写会话' }).click();
    await expect(status(b)).toContainText('本人会话');
    const finalGrant = await originalStatus();
    const finalLoop = startLoop(bScope, finalGrant.generation);
    await expect.poll(finalLoop.pid).toBeGreaterThan(1);
    closingGate = releaseCommitGate();
    await b.page.getByRole('button', { name: '释放写锁' }).click();
    await expect.poll(closingGate.entered).toBe(true);
    expect(process.kill(-finalLoop.pid(), 0)).toBe(true);
    expect(await originalStatus()).toMatchObject({
      phase: 'draining',
      run_id: expect.any(String),
    });
    closing = app.close();
    void closing.catch(() => {});
    const databaseOwner = async () =>
      (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
    expect(await databaseOwner()).toEqual(expect.any(String));
    closingGate.release();
    await closing;
    expect(await finalLoop.execution).toMatchObject({
      status: 'finished',
      result: { stop: 'confirmed' },
    });
    expect(await databaseOwner()).toBeNull();
  } finally {
    releaseGate?.release();
    closingGate?.release();
    try {
      await web?.close();
      if (closing) await closing;
      else await app?.close();
    } finally {
      await trees?.close();
      await mirrors?.close();
      await source?.close();
      await lab.close();
    }
  }
});
