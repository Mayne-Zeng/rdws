import { expect, test, type Page, type Route } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, join, relative } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import {
  NativeFixtureToolJob,
  type FixtureToolArm,
} from '../../apps/server/src/modules/native-fixture-tool-job.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { journal } from '../helpers/native-journal.ts';
import { nativeReady } from '../helpers/native-ready.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

function releaseCommitGate(operation = 'write.release') {
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
          params[1].includes(operation)
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

async function fingerprint(root: string) {
  const entries = await readdir(root, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((file) => file.isFile())
    .map((file) => join(file.parentPath, file.name))
    .sort();
  const digest = createHash('sha256');
  for (const file of files) {
    digest.update(relative(root, file)).update('\0');
    digest.update(
      createHash('sha256')
        .update(await readFile(file))
        .digest(),
    );
  }
  return digest.digest('hex');
}

test('fleet handoff, fork and recovered sessions earn scoped write grants', async ({
  browser,
}, testInfo) => {
  process.env.RDWS_MODE = 'test';
  process.env.RDWS_NATIVE_MODEL_EGRESS = 'mediated';
  const dockerContext = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'],
    { encoding: 'utf8' },
  ).trim();
  const lab = await authorityDatabase(
    process.env.DOCKER_CONTEXT
      ? dockerContext
      : process.env.DOCKER_HOST || dockerContext,
  );
  const originalCAs = getCACertificates('default');
  let supplier: ReturnType<typeof createHttpsServer> | undefined;
  let source: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
  let gitPrepared = false;
  let app: ReturnType<typeof buildApp> | undefined;
  let web: { close(): Promise<void> } | undefined;
  let mirrors: RepositoryMirrors | undefined;
  let trees: DemandWorktrees | undefined;
  let releaseGate: ReturnType<typeof releaseCommitGate> | undefined;
  let closingGate: ReturnType<typeof releaseCommitGate> | undefined;
  let closing: Promise<unknown> | undefined;
  let closingWeb: Promise<unknown> | undefined;
  let nativePid: number | undefined;
  let databaseFixture: string | undefined;
  const executionGroups = new Set<number>();
  const projectId = 'poc';
  const demand = randomUUID();
  const owner = randomUUID();
  const successor = randomUUID();
  const viewer = randomUUID();
  const handoffTask = randomUUID();
  const ticket = randomBytes(32).toString('hex');
  const password = randomBytes(18).toString('hex');
  const provider = 'rdws-glm';
  const model = 'browser-fleet-fixture';
  const callId = 'rdws-browser-fleet-tool';
  const reply = 'Native handoff fixture finished';
  const text = 'Synthetic browser prompt after the writer handoff';
  const warmText = 'Synthetic text before restarting the original session';
  const warmReply = 'Native text-only baseline finished';
  const recoveredText =
    'Synthetic browser prompt in the recovered original session';
  const recoveredCallId = 'rdws-browser-fleet-recovery-tool';
  const recoveredReply = 'Native recovery fixture finished';
  let supplierRequests = 0;
  let warmRequests = 0;
  const received: {
    model?: string;
    tools?: unknown[];
    messages: { role: string; tool_call_id?: string; content?: unknown }[];
  }[] = [];
  function userText(body: (typeof received)[number]) {
    return body.messages
      .filter(({ role }) => role === 'user')
      .flatMap(({ content }) =>
        Array.isArray(content)
          ? content.map((value: { text?: unknown }) => value.text)
          : [content],
      )
      .filter((value): value is string => typeof value === 'string');
  }
  const control = NativeFixtureToolJob.prototype.control;
  const controls: {
    operation: string;
    commandId: string;
    sessionId: unknown;
    requestId: unknown;
    callId: unknown;
    callSeq: unknown;
    state?: string;
  }[] = [];
  NativeFixtureToolJob.prototype.control = async function (
    operation,
    input,
    canRead,
  ) {
    const result = await control.call(this, operation, input, canRead);
    controls.push({
      operation,
      commandId: this.commandId,
      sessionId: input.sessionId,
      requestId: input.requestId,
      callId: input.toolCallId,
      callSeq: input.toolCallSeq,
      state: 'state' in result ? result.state : undefined,
    });
    return result;
  };
  const commandPath = (sessionId: string) =>
    `/api/requirements/${demand}/sessions/${sessionId}/write-authority/commands`;
  const statusPath = `/api/requirements/${demand}/write-authority`;
  const originalStatus = async () =>
    (
      await lab.owner.query(
        'select generation,phase,native_session_id,run_id,owner_id,auth_session_id,context_version from requirement_write_lease where requirement_id=$1',
        [demand],
      )
    ).rows[0];
  const receiptCount = async () =>
    (
      await lab.owner.query(
        "select count(*)::int as n from command_receipt where scope=$1 and operation in ('write.acquire','write.takeover','write.release')",
        ['requirement:' + demand],
      )
    ).rows[0]?.n;
  const databaseOwner = async () =>
    (
      await lab.owner.query(
        'select generation from rdws_authority.owner where singleton',
      )
    ).rows[0]?.generation;
  async function verifyStopped(root?: string) {
    for (const pid of executionGroups)
      expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/);
    if (nativePid) expect(() => process.kill(nativePid!, 0)).toThrow(/ESRCH/);
    if (root)
      for (const suffix of ['lock', 'ready.json'])
        await expect(
          lstat(
            join(
              root,
              'runtime',
              'instances',
              `project-${projectId}.${suffix}`,
            ),
          ),
        ).rejects.toMatchObject({ code: 'ENOENT' });
    const lease = await originalStatus();
    if (lease) expect(lease).toMatchObject({ phase: 'released', run_id: null });
    expect(await databaseOwner()).toBeNull();
  }

  try {
    databaseFixture = (
      await lab.owner.query<{ name: string }>(
        "select current_setting('rdws.fixture_instance') as name",
      )
    ).rows[0]?.name;
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
    gitPrepared = true;
    const sample = join(checkout.tree, 'sample.txt');
    const sources = join(root, 'projects', projectId, 'sources');
    const sourcesBefore = await fingerprint(sources);
    const keys = await modelTlsCertificate(lab.root);
    setDefaultCACertificates([...originalCAs, keys.cert.toString()]);
    supplier = createHttpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
        supplierRequests++;
        try {
          if (
            request.method !== 'POST' ||
            request.url !== '/v1/chat/completions'
          ) {
            response.writeHead(404).end();
            return;
          }
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(chunk);
          const body = JSON.parse(
            Buffer.concat(chunks).toString(),
          ) as (typeof received)[number];
          const index = received.length;
          const parts = userText(body);
          const warm =
            parts.includes(warmText) && !parts.includes(recoveredText);
          if (warm) warmRequests++;
          else received.push(body);
          const recovery = index >= 2;
          const invoke = !warm && (index === 0 || index === 2);
          const invocationId = recovery ? recoveredCallId : callId;
          if (
            (warm
              ? index !== 2 || warmRequests !== 1
              : index > 3 ||
                !parts.includes(recovery ? recoveredText : text)) ||
            (body.tools?.length ?? 0) !== (invoke ? 1 : 0) ||
            (!warm &&
              !invoke &&
              !body.messages.some(
                ({ role, tool_call_id }) =>
                  role === 'tool' && tool_call_id === invocationId,
              ))
          ) {
            response.writeHead(400).end();
            return;
          }
          const delta = invoke
            ? {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: invocationId,
                    type: 'function',
                    function: { name: 'rdws_authority_probe', arguments: '{}' },
                  },
                ],
              }
            : {
                role: 'assistant',
                content: warm ? warmReply : recovery ? recoveredReply : reply,
              };
          const frame = {
            id: 'fleet-handoff-synthetic',
            object: 'chat.completion.chunk',
            created: 1,
            model,
          };
          response.writeHead(200, { 'content-type': 'text/event-stream' }).end(
            [
              { index: 0, delta, finish_reason: null },
              {
                index: 0,
                delta: {},
                finish_reason: invoke ? 'tool_calls' : 'stop',
              },
            ]
              .map(
                (choice) =>
                  'data: ' +
                  JSON.stringify({ ...frame, choices: [choice] }) +
                  '\n\n',
              )
              .join('') + 'data: [DONE]\n\n',
          );
        } catch {
          response.destroy();
        }
      },
    );
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const baseURL =
      'https://127.0.0.1:' +
      (supplier.address() as { port: number }).port +
      '/v1';
    const configuration = join(root, 'config', 'projects', projectId, 'dsh');
    const profile = join(configuration, 'profiles', 'rdws');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: randomBytes(24).toString('hex') },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        { id: 'session-title-llm', disabled: true },
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              [provider]: {
                api: 'openai-completions',
                baseURL,
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: model }],
                retryPolicy: { mode: 'normal', maxRetries: 0 },
              },
            },
          },
        },
      ]),
      { mode: 0o600 },
    );
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
      "insert into task(id,requirement_id,title,assignee_id,created_by) values($1,$2,'Handover task',$3,$4)",
      [handoffTask, demand, successor, owner],
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
    const appConfig: Parameters<typeof buildApp>[0] = {
      databaseUrl: lab.databaseUrl,
      secret: lab.childEnv.BETTER_AUTH_SECRET!,
      origin,
      repositoryHome: root,
      nativeRuntimeRoot: root,
      mainModelPolicy: {
        projectId,
        provider,
        model,
        destination: baseURL + '/chat/completions',
      },
      isolatedWrite: {
        gitPath: execFileSync('/usr/bin/which', ['git'], {
          encoding: 'utf8',
        }).trim(),
        fleetCommands: true,
        fixtureTool: true,
      },
    };
    app = buildApp({ ...appConfig, authorityTicket: ticket });
    const api = await app.listen({ port: 0, host: '127.0.0.1' });
    const resolve = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolve.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    async function startWeb(target: string) {
      const frontend = await createVite({
        root: consoleRoot,
        configFile: join(consoleRoot, 'vite.config.ts'),
        cacheDir: join(root, 'vite-cache'),
        logLevel: 'silent',
        server: {
          host: '127.0.0.1',
          port,
          strictPort: true,
          proxy: { '/api': { target, ws: true } },
        },
      });
      web = frontend;
      await frontend.listen();
      return frontend;
    }
    const originalWeb = await startWeb(api);
    const broker = app.getDecorator<() => OwnedWriteHandoff>(
      'isolatedWriteHandoff',
    )();
    const arm = app.getDecorator<
      (input: Omit<FixtureToolArm, 'broker'>) => void
    >('armIsolatedNativeTool');
    function startLoop(
      scope: Parameters<OwnedWriteHandoff['execute']>[0],
      generation: string,
      activeBroker = broker,
    ) {
      let pid = 0;
      const execution = activeBroker.execute(
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
    const chatUrl = '/?project=poc&view=chat&requirement=' + demand;

    async function signIn(username: string) {
      const ctx = await browser.newContext({ baseURL: origin });
      const logged = await ctx.request.post('/api/auth/sign-in/username', {
        headers: { origin },
        data: { username, password },
      });
      expect(logged.status()).toBe(200);
      const { session, user } = await (
        await ctx.request.get('/api/auth/get-session')
      ).json();
      return { ctx, loginId: session.id as string, userId: user.id as string };
    }
    async function login(username: string) {
      const { ctx, loginId, userId } = await signIn(username);
      const page = await ctx.newPage();
      page.setDefaultTimeout(15000);
      await page.goto(chatUrl);
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/requirements/${demand}/sessions`,
      );
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      const mapped = await created;
      expect(mapped.status()).toBe(200);
      const { sessionId } = (await mapped.json()) as { sessionId: string };
      expect(sessionId).toBeTruthy();
      expect(
        (
          await lab.owner.query(
            'select requirement_id, owner_id from native_session where id=$1',
            [sessionId],
          )
        ).rows,
      ).toEqual([{ requirement_id: demand, owner_id: userId }]);
      await expect(
        page.getByRole('button', { name: /^会话 \d+ · 本人$/ }),
      ).toHaveAttribute('aria-current', 'true');
      await expect(
        page.getByRole('button', { name: '派生当前会话', exact: true }),
      ).toBeEnabled();
      await page.getByRole('tab', { name: '编队', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: '编队', exact: true }),
      ).toBeVisible();
      return { ctx, page, loginId, sessionId };
    }
    const a = await login('fleet_a');
    const b = await login('fleet_b');
    const tester = await login('fleet_viewer');
    const { sessionId: aSession } = a;
    const { sessionId: bSession } = b;
    const { sessionId: viewerSession } = tester;
    const status = (side: typeof a) =>
      side.page.getByRole('status', { name: '写权状态' });
    const message = (side: typeof a) =>
      side.page.getByRole('status', { name: '写权操作结果' });
    const pendingButton = (side: typeof a) =>
      side.page.getByRole('button', { name: '核对原操作' });
    await expect(status(tester)).toHaveText('暂无写会话');
    await expect(
      tester.page.getByRole('button', { name: '设为可写会话' }),
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
    const setWriter = a.page.getByRole('button', { name: '设为可写会话' });
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
    await a.page.getByRole('button', { name: '设为可写会话' }).click();
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
            data: { type: 'takeover', commandId: lostAcquire!.commandId },
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
    await expect(message(a)).toHaveText('已设为可写会话。');
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
    executionGroups.add(pid);
    expect(process.kill(-pid, 0)).toBe(true);

    const version = await a.ctx.request.post(
      `/api/requirements/${demand}/commands`,
      {
        headers: { origin },
        data: {
          type: 'task.create',
          commandId: randomUUID(),
          task: { title: 'Change context', assigneeId: owner },
        },
      },
    );
    expect(version.status()).toBe(200);
    const { taskId: otherTask } = (await version.json()) as { taskId: string };
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
    expect(() => process.kill(-pid, 0)).toThrow(/ESRCH/);
    await expect
      .poll(originalStatus)
      .toMatchObject({ phase: 'released', run_id: null });
    await pendingButton(a).click();
    await expect(message(a)).toContainText('原操作已核对');

    const selected = b.page.getByRole('button', { name: '设为可写会话' });
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
    const promptPath = `/api/dsh/${demand}/native/api/session/prompt`;
    async function submitPrompt(page: Page, message: string) {
      await page.getByLabel('消息', { exact: true }).fill(message);
      const [submitted] = await Promise.all([
        page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            new URL(response.url()).pathname === promptPath,
        ),
        page.getByRole('button', { name: '发送消息', exact: true }).click(),
      ]);
      expect(submitted.status()).toBe(200);
      expect((await submitted.json()).result).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
    }
    let requestId: string | undefined;
    await b.page.route(
      '**' + promptPath,
      async (route) => {
        const input = route.request().postDataJSON().payload.args.request as {
          sessionId: string;
          requestId: string;
          content: unknown;
        };
        expect(input).toMatchObject({
          sessionId: bSession,
          requestId: expect.any(String),
          content: [{ type: 'text', text }],
        });
        const current = await originalStatus();
        expect(current).toMatchObject({
          generation: next.generation,
          phase: 'held',
          owner_id: successor,
          auth_session_id: b.loginId,
          native_session_id: bSession,
          run_id: null,
          context_version: next.context_version,
        });
        requestId = input.requestId;
        arm({
          scope: bScope,
          requestId,
          grant: {
            generation: current.generation,
            contextVersion: current.context_version,
          },
        });
        await route.continue();
      },
      { times: 1 },
    );
    await b.page.getByRole('tab', { name: '对话', exact: true }).click();
    await b.page
      .getByRole('navigation', { name: '需求会话列表' })
      .getByRole('button', { name: /^会话 \d+ · 本人$/ })
      .click();
    await b.page.getByLabel('消息', { exact: true }).fill(text);
    const submitted = b.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === promptPath,
    );
    await b.page.getByRole('button', { name: '发送消息', exact: true }).click();
    const promptResponse = await submitted;
    expect(promptResponse.status()).toBe(200);
    expect((await promptResponse.json()).result).toMatchObject({
      ok: true,
      value: { accepted: true },
    });
    await expect(b.page.getByText(reply, { exact: true })).toBeVisible();
    expect(requestId).toEqual(expect.any(String));
    expect(received).toHaveLength(2);
    expect(received[0]).toMatchObject({
      model,
      tools: [{ type: 'function', function: { name: 'rdws_authority_probe' } }],
    });
    expect(received[1]?.model).toBe(model);
    expect(received[1]?.tools ?? []).toEqual([]);
    expect(received[1]?.messages.filter(({ role }) => role === 'tool')).toEqual(
      [
        {
          role: 'tool',
          tool_call_id: callId,
          content: 'RDWS fixture worktree state: ok',
        },
      ],
    );
    const begins = controls.filter(({ operation }) => operation === 'begin');
    expect(begins).toEqual([
      expect.objectContaining({
        sessionId: bSession,
        requestId,
        callId,
        callSeq: expect.any(Number),
      }),
    ]);
    const begun = begins[0]!;
    expect(controls).toContainEqual(
      expect.objectContaining({
        operation: 'status',
        commandId: begun.commandId,
        sessionId: bSession,
        requestId,
        callId,
        state: 'ok',
      }),
    );
    const writes = await lab.owner.query(
      "select command_id, result from command_receipt where scope=$1 and actor_id=$2 and operation='write.execute'",
      ['requirement:' + demand, successor],
    );
    expect(writes.rows).toEqual([
      {
        command_id: begun.commandId,
        result: expect.objectContaining({
          status: 'finished',
          result: {
            status: 'ok',
            stop: 'confirmed',
            marker: 'released',
            exitCode: 0,
          },
        }),
      },
    ]);
    expect(await readFile(sample, 'utf8')).toBe('baseline|workbench-tool');

    const forkPath = `/api/requirements/${demand}/sessions/${encodeURIComponent(bSession)}/fork`;
    await expect
      .poll(async () => {
        const log = await journal(root, bSession).catch(() => undefined);
        return log?.events.some(
          ({ type, data }) =>
            type === 'turn/end' && data.reason.kind === 'completed',
        );
      })
      .toBe(true);
    const foreignFork = randomUUID();
    const deniedFork = await a.ctx.request.post(forkPath, {
      headers: { origin, 'x-rdws-edit-session': a.loginId },
      data: { commandId: foreignFork },
    });
    expect(deniedFork.status()).toBe(403);
    expect(await deniedFork.json()).toEqual({
      error: '只能派生本人在当前需求中的会话',
    });
    expect(
      (
        await lab.owner.query(
          'select id from session_operation where command_id=$1',
          [foreignFork],
        )
      ).rowCount,
    ).toBe(0);

    const forkAction = b.page.getByRole('button', {
      name: '派生当前会话',
      exact: true,
    });
    await expect(forkAction).toBeEnabled();
    const [forkResponse] = await Promise.all([
      b.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === forkPath,
      ),
      forkAction.click(),
    ]);
    expect(forkResponse.status()).toBe(200);
    const { sessionId: forkSession } = (await forkResponse.json()) as {
      sessionId: string;
    };
    expect(forkSession).toEqual(expect.any(String));
    expect(forkSession).not.toBe(bSession);
    await expect(
      b.page.getByRole('button', { name: /^会话 \d+ · 本人 · 派生$/ }),
    ).toHaveAttribute('aria-current', 'true');
    const {
      rows: [forkMapping],
    } = await lab.owner.query(
      'select requirement_id, owner_id, source_session_id, source_through_seq from native_session where id=$1',
      [forkSession],
    );
    expect(forkMapping).toMatchObject({
      requirement_id: demand,
      owner_id: successor,
      source_session_id: bSession,
      source_through_seq: expect.any(Number),
    });
    const cut = forkMapping.source_through_seq;
    const sourcePrefix = (await journal(root, bSession)).events.filter(
      ({ seq }) => seq <= cut,
    );
    expect(sourcePrefix.at(-1)?.seq).toBe(cut);
    expect(sourcePrefix).toContainEqual(
      expect.objectContaining({
        type: 'turn/end',
        data: expect.objectContaining({ reason: { kind: 'completed' } }),
      }),
    );
    await expect
      .poll(async () =>
        (
          await journal(root, forkSession).catch(() => undefined)
        )?.events.filter(({ seq }) => seq <= cut),
      )
      .toEqual(sourcePrefix);

    const forkScope = { ...bScope, sessionId: forkSession };
    const sourceHeld = await originalStatus();
    expect(sourceHeld).toMatchObject({
      generation: next.generation,
      phase: 'held',
      native_session_id: bSession,
      run_id: null,
    });
    const oldExecution = randomUUID();
    await expect(
      broker.execute(forkScope, {
        generation: next.generation,
        commandId: oldExecution,
        repositoryId: 'app',
        request: {
          tool: 'shell',
          script: "printf '|workbench-tool' >> sample.txt",
        },
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      (
        await lab.owner.query(
          'select command_id from command_receipt where command_id=$1',
          [oldExecution],
        )
      ).rowCount,
    ).toBe(0);
    expect(await readFile(sample, 'utf8')).toBe('baseline|workbench-tool');
    const forkReceipts = await receiptCount();
    const conflictingFork = await b.ctx.request.post(commandPath(forkSession), {
      headers: { origin, 'x-rdws-edit-session': b.loginId },
      data: { type: 'acquire', commandId: randomUUID() },
    });
    expect(conflictingFork.status()).toBe(409);
    expect(await receiptCount()).toBe(forkReceipts);
    expect(await originalStatus()).toEqual(sourceHeld);

    await b.page.getByRole('tab', { name: '编队', exact: true }).click();
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
    const applicant = b.page.getByRole('combobox', { name: '申请写权的会话' });
    await applicant.selectOption(bSession);
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
    await b.page.getByRole('button', { name: '设为可写会话' }).click();
    await expect(message(b)).toContainText('未能完成确认');
    expect(expiredAcquire?.generation).toEqual(expect.any(String));
    await broker.release(bScope, expiredAcquire!.generation, randomUUID());
    await pendingButton(b).click();
    await expect(message(b)).toHaveText('原接手已确认，请查看当前写权状态。');
    await expect(pendingButton(b)).toHaveCount(0);

    const releasedSource = await originalStatus();
    expect(releasedSource).toMatchObject({
      generation: expiredAcquire!.generation,
      phase: 'released',
      native_session_id: bSession,
      run_id: null,
    });
    async function reassign(assigneeId: string, taskId: string = handoffTask) {
      const response = await a.ctx.request.post(
        `/api/requirements/${demand}/commands`,
        {
          headers: { origin },
          data: {
            type: 'task.update',
            commandId: randomUUID(),
            taskId,
            patch: { assigneeId },
          },
        },
      );
      expect(response.status()).toBe(200);
      const result = await response.json();
      expect(result).toMatchObject({
        taskId,
        changed: true,
        contextVersion: expect.any(Number),
      });
      return result.contextVersion as number;
    }
    const withoutAssignment = await reassign(owner);
    const readOnly = await b.ctx.request.get(statusPath, {
      headers: { 'x-rdws-edit-session': b.loginId },
    });
    expect(readOnly.status()).toBe(200);
    expect(await readOnly.json()).toEqual({
      state: 'idle',
      actionsEnabled: true,
      canAcquire: true,
      canTakeover: true,
    });
    expect(await originalStatus()).toEqual(releasedSource);
    await b.page.reload();
    await expect(status(b)).toHaveText('暂无写会话');
    await expect(applicant).toBeVisible();

    const refreshed = await reassign(successor);
    expect(refreshed).toBeGreaterThan(withoutAssignment);
    expect(refreshed).toBeGreaterThan(next.context_version);
    expect(
      (
        await lab.owner.query(
          'select context_version from requirement where id=$1',
          [demand],
        )
      ).rows,
    ).toEqual([{ context_version: refreshed }]);
    await b.page.getByRole('tab', { name: '对话', exact: true }).click();
    const [createdForRecovery] = await Promise.all([
      b.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            `/api/requirements/${demand}/sessions`,
      ),
      b.page.getByRole('button', { name: '新建会话', exact: true }).click(),
    ]);
    expect(createdForRecovery.status()).toBe(200);
    const { sessionId: recoverySession } =
      (await createdForRecovery.json()) as { sessionId: string };
    expect(recoverySession).toEqual(expect.any(String));
    expect([bSession, forkSession]).not.toContain(recoverySession);
    const ownOriginals = b.page
      .getByRole('navigation', { name: '需求会话列表' })
      .getByRole('button', { name: /^会话 \d+ · 本人$/ });
    await expect(ownOriginals).toHaveCount(2);
    const warmSession = ownOriginals.last();
    await expect(warmSession).toHaveAttribute('aria-current', 'true');
    const recoveredSessionLabel = (await warmSession.innerText()).trim();
    await submitPrompt(b.page, warmText);
    await expect(b.page.getByTestId('transcript')).toContainText(warmReply);
    await expect
      .poll(async () =>
        (await journal(root, recoverySession)).events.some(
          ({ type, data }) =>
            type === 'turn/end' && data.reason.kind === 'completed',
        ),
      )
      .toBe(true);
    expect(warmRequests).toBe(1);
    expect(supplierRequests).toBe(3);

    await b.page.getByRole('tab', { name: '编队', exact: true }).click();
    await applicant.selectOption(recoverySession);
    const [warmAcquired] = await Promise.all([
      b.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === commandPath(recoverySession),
      ),
      b.page.getByRole('button', { name: '设为可写会话' }).click(),
    ]);
    expect(warmAcquired.status()).toBe(200);
    const warmGrant = await warmAcquired.json();
    expect(warmGrant).toMatchObject({
      state: 'acquired',
      generation: expect.any(String),
      commandId: expect.any(String),
    });
    expect(await originalStatus()).toMatchObject({
      generation: warmGrant.generation,
      phase: 'held',
      native_session_id: recoverySession,
      auth_session_id: b.loginId,
      context_version: refreshed,
    });
    const warmAction = randomUUID();
    const warmProofPath = 'before-resume.txt';
    const warmProofText = 'Isolated write before session recovery';
    expect(
      await broker.execute(
        { ...bScope, sessionId: recoverySession },
        {
          commandId: warmAction,
          generation: warmGrant.generation,
          repositoryId: 'app',
          request: {
            tool: 'file',
            operation: 'write',
            path: warmProofPath,
            text: warmProofText,
          },
        },
      ),
    ).toMatchObject({
      status: 'finished',
      result: { status: 'ok', stop: 'confirmed' },
    });
    expect(await readFile(join(checkout.tree, warmProofPath), 'utf8')).toBe(
      warmProofText,
    );
    await b.page.getByRole('button', { name: '释放写锁' }).click();
    await expect.poll(originalStatus).toMatchObject({
      generation: warmGrant.generation,
      phase: 'released',
      native_session_id: recoverySession,
      run_id: null,
    });
    await expect(message(b)).toHaveText('原写代已释放。');

    await b.page.reload();
    await expect(applicant).toBeVisible();
    await applicant.selectOption(forkSession);
    await expect(applicant).toHaveValue(forkSession);
    for (const [width, colorScheme] of [
      [1440, 'dark'],
      [390, 'light'],
    ] as const) {
      await b.page.setViewportSize({ width, height: 900 });
      await b.page.emulateMedia({ colorScheme });
      await expect(b.page.locator('html')).toHaveAttribute(
        'theme-mode',
        colorScheme,
      );
      await applicant.focus();
      await expect(applicant).toBeFocused();
      expect(
        await b.page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await b.page.locator('.workspace-main').screenshot({
        path: testInfo.outputPath(`fork-${colorScheme}-${width}.png`),
        animations: 'disabled',
      });
    }
    const granted = b.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === commandPath(forkSession),
    );
    await b.page.getByRole('button', { name: '设为可写会话' }).click();
    const grantResponse = await granted;
    expect(grantResponse.status()).toBe(200);
    const { generation: forkGeneration } = await grantResponse.json();
    expect(forkGeneration).not.toBe(next.generation);
    expect(forkGeneration).not.toBe(releasedSource.generation);
    await expect(status(b)).toContainText('本人会话');
    const finalGrant = await originalStatus();
    expect(finalGrant).toMatchObject({
      generation: forkGeneration,
      owner_id: successor,
      auth_session_id: b.loginId,
      native_session_id: forkSession,
      context_version: refreshed,
      phase: 'held',
      run_id: null,
    });
    const newExecution = randomUUID();
    expect(
      await broker.execute(forkScope, {
        generation: forkGeneration,
        commandId: newExecution,
        repositoryId: 'app',
        request: {
          tool: 'shell',
          script: "printf '|fork-write' >> sample.txt",
        },
      }),
    ).toMatchObject({
      status: 'finished',
      result: { status: 'ok', stop: 'confirmed' },
    });
    expect(
      (
        await lab.owner.query(
          "select result from command_receipt where operation='write.execute' and command_id=$1 and actor_id=$2 and scope=$3",
          [newExecution, successor, 'requirement:' + demand],
        )
      ).rows,
    ).toEqual([
      {
        result: expect.objectContaining({
          status: 'finished',
          result: expect.objectContaining({ status: 'ok', stop: 'confirmed' }),
        }),
      },
    ]);
    expect(await readFile(sample, 'utf8')).toBe(
      'baseline|workbench-tool|fork-write',
    );
    const finalLoop = startLoop(forkScope, forkGeneration);
    await expect.poll(finalLoop.pid).toBeGreaterThan(1);
    executionGroups.add(finalLoop.pid());
    closingGate = releaseCommitGate();
    await b.page.getByRole('button', { name: '释放写锁' }).click();
    await expect.poll(closingGate.entered).toBe(true);
    expect(process.kill(-finalLoop.pid(), 0)).toBe(true);
    expect(await originalStatus()).toMatchObject({
      phase: 'draining',
      run_id: expect.any(String),
    });
    const oldNative = await nativeReady(root, projectId);
    expect(oldNative.pid).toBeGreaterThan(1);
    nativePid = oldNative.pid;
    expect(process.kill(oldNative.pid, 0)).toBe(true);
    await Promise.all([a.page.goto('about:blank'), b.page.goto('about:blank')]);
    const stopOriginalWeb = Promise.resolve(originalWeb.close());
    closingWeb = stopOriginalWeb;
    void stopOriginalWeb.catch(() => {});
    await expect.poll(() => originalWeb.httpServer?.listening).toBe(false);
    expect(process.kill(-finalLoop.pid(), 0)).toBe(true);
    expect(await originalStatus()).toMatchObject({
      phase: 'draining',
      run_id: expect.any(String),
    });
    closing = app.close();
    void closing.catch(() => {});
    const originalOwner = await databaseOwner();
    expect(originalOwner).toEqual(expect.any(String));
    closingGate.release();
    await closing;
    await stopOriginalWeb;
    expect(await finalLoop.execution).toMatchObject({
      status: 'finished',
      result: { stop: 'confirmed' },
    });
    await verifyStopped(root);
    expect(await originalStatus()).toMatchObject({
      generation: forkGeneration,
      phase: 'released',
      native_session_id: forkSession,
      run_id: null,
    });
    nativePid = undefined;
    executionGroups.clear();
    closing = undefined;
    closingWeb = undefined;
    app = undefined;
    web = undefined;
    expect(received).toHaveLength(2);
    expect(await fingerprint(sources)).toBe(sourcesBefore);
    expect(await readFile(sample, 'utf8')).toBe(
      'baseline|workbench-tool|fork-write',
    );
    const saved = await journal(root, bSession);
    const { events } = saved;
    const inserted = events
      .filter((event) => event.type === 'agent/inbox/spliced')
      .flatMap((event) => event.data.inserted ?? [])
      .filter((message) => message.source?.rpcId === requestId);
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.source?.principal?.userId).toBe(successor);
    const calls = events.filter((event) => event.type === 'tool/call');
    const results = events.filter((event) => event.type === 'tool/result');
    expect(calls).toEqual([
      expect.objectContaining({
        seq: begun.callSeq,
        data: expect.objectContaining({ callId, turn: 1, step: 1 }),
      }),
    ]);
    expect(results).toEqual([
      expect.objectContaining({
        sourceEventSeqs: [begun.callSeq],
        data: expect.objectContaining({
          turn: 1,
          step: 1,
          message: expect.objectContaining({ toolCallId: callId }),
        }),
      }),
    ]);
    const readEvidence = async (selectedSession = bSession) =>
      (await readFile(join(root, 'runtime', 'context-evidence.jsonl'), 'utf8'))
        .trim()
        .split('\n')
        .map(
          (line) =>
            JSON.parse(line) as {
              sessionId: string;
              phase: string;
              contextVersion: number;
              contentHash: string;
              turn: number;
              step: number;
            },
        )
        .filter(
          ({ sessionId, phase }) =>
            sessionId === selectedSession && phase === 'request',
        );
    const evidence = await readEvidence();
    expect(
      evidence.map(({ turn, step, contextVersion }) => ({
        turn,
        step,
        contextVersion,
      })),
    ).toEqual([
      { turn: 1, step: 1, contextVersion: next.context_version },
      { turn: 1, step: 2, contextVersion: next.context_version },
    ]);
    for (const [index, proof] of evidence.entries()) {
      expect(
        userText(received[index]!).some(
          (part) =>
            createHash('sha256').update(part).digest('hex') ===
            proof.contentHash,
        ),
      ).toBe(true);
    }
    expect(events.find((event) => event.type === 'turn/end')).toMatchObject({
      data: { reason: { kind: 'completed' } },
    });

    const writeReceipts = async () =>
      (
        await lab.owner.query(
          "select actor_id, operation, command_id, result from command_receipt where scope=$1 and operation in ('write.acquire','write.takeover','write.release','write.execute') order by operation,command_id",
          ['requirement:' + demand],
        )
      ).rows;
    const releasedLease = await originalStatus();
    const originalReceipts = await writeReceipts();
    const originalCommand = originalReceipts.find(
      ({ actor_id, operation, result }) =>
        actor_id === successor &&
        operation === 'write.takeover' &&
        result?.generation === warmGrant.generation,
    );
    expect(originalCommand?.command_id).toBe(warmGrant.commandId);
    expect(originalReceipts).toContainEqual(
      expect.objectContaining({
        actor_id: successor,
        operation: 'write.execute',
        command_id: warmAction,
        result: expect.objectContaining({
          status: 'finished',
          result: expect.objectContaining({ status: 'ok', stop: 'confirmed' }),
        }),
      }),
    );
    const warmSaved = await journal(root, recoverySession);
    expect(warmSaved.header.id).toBe(recoverySession);
    expect(
      warmSaved.events.some(
        ({ type }) => type === 'tool/call' || type === 'tool/result',
      ),
    ).toBe(false);
    const warmEvidence = await readEvidence(recoverySession);
    expect(warmEvidence).toEqual([
      expect.objectContaining({ contextVersion: refreshed, turn: 1, step: 1 }),
    ]);
    const restartTicket = randomBytes(32).toString('hex');
    expect(
      (
        await lab.owner.query(
          'update rdws_authority.owner set ticket_digest=$1 where singleton and managed and generation is null and proof_digest is null and ticket_digest is null',
          [createHash('sha256').update(restartTicket).digest('hex')],
        )
      ).rowCount,
    ).toBe(1);
    const recoveredApp = buildApp({
      ...appConfig,
      authorityTicket: restartTicket,
    });
    app = recoveredApp;
    const recoveredApi = await recoveredApp.listen({
      host: '127.0.0.1',
      port: 0,
    });
    expect(recoveredApi).not.toBe(api);
    const recoveredWeb = await startWeb(recoveredApi);
    expect(await databaseOwner()).toEqual(expect.any(String));
    expect(await databaseOwner()).not.toBe(originalOwner);
    expect(
      (
        await lab.owner.query(
          'select ticket_digest is null as spent from rdws_authority.owner where singleton',
        )
      ).rows,
    ).toEqual([{ spent: true }]);

    const revoked = await browser.newContext({ baseURL: origin });
    try {
      await revoked.addCookies(await b.ctx.cookies(origin));
      const beforeLogout = await revoked.request.get(statusPath, {
        headers: { 'x-rdws-edit-session': b.loginId },
      });
      expect(beforeLogout.status()).toBe(200);
      expect(await beforeLogout.json()).toMatchObject({
        state: 'idle',
        canAcquire: true,
      });
      const loggedOut = await b.ctx.request.post('/api/auth/sign-out', {
        headers: { origin },
        data: {},
      });
      expect(loggedOut.status()).toBe(200);
      expect(
        (
          await lab.owner.query('select id from auth_session where id=$1', [
            b.loginId,
          ])
        ).rowCount,
      ).toBe(0);
      const deniedOldLogin = await revoked.request.post(
        commandPath(recoverySession),
        {
          headers: { origin, 'x-rdws-edit-session': b.loginId },
          data: { type: 'acquire', commandId: randomUUID() },
        },
      );
      expect(deniedOldLogin.status()).toBe(401);
      expect(await deniedOldLogin.json()).toEqual({ error: '请先登录' });
    } finally {
      await revoked.close();
    }
    const identity = await signIn('fleet_b');
    expect(identity.userId).toBe(successor);
    expect(identity.loginId).not.toBe(b.loginId);
    const resumedPage = await identity.ctx.newPage();
    resumedPage.setDefaultTimeout(15000);
    const resumed = {
      ...identity,
      page: resumedPage,
      sessionId: recoverySession,
    };
    const originalSession = resumedPage
      .getByRole('navigation', { name: '需求会话列表' })
      .getByRole('button', { name: recoveredSessionLabel, exact: true });
    await resumedPage.goto(chatUrl);
    await originalSession.click();
    const transcript = resumedPage.getByTestId('transcript');
    await expect(transcript).toContainText(warmText);
    await expect(transcript).toContainText(warmReply);
    const replacementNative = await nativeReady(root, projectId);
    expect(replacementNative.pid).toBeGreaterThan(1);
    nativePid = replacementNative.pid;
    expect(replacementNative.generation).not.toBe(oldNative.generation);
    expect(replacementNative.pid).not.toBe(oldNative.pid);
    expect(process.kill(replacementNative.pid, 0)).toBe(true);
    expect(
      (
        await lab.owner.query(
          'select requirement_id, owner_id, source_session_id from native_session where id=$1',
          [recoverySession],
        )
      ).rows,
    ).toEqual([
      { requirement_id: demand, owner_id: successor, source_session_id: null },
    ]);
    const resumedHistory = await journal(root, recoverySession);
    expect(resumedHistory.header.id).toBe(warmSaved.header.id);
    expect(resumedHistory.events.slice(0, warmSaved.events.length)).toEqual(
      warmSaved.events,
    );
    expect(received).toHaveLength(2);
    expect(supplierRequests).toBe(3);
    const recoveryHeaders = { origin, 'x-rdws-edit-session': identity.loginId };
    const replayedAcquire = await identity.ctx.request.post(
      commandPath(recoverySession),
      {
        headers: recoveryHeaders,
        data: { type: 'takeover', commandId: originalCommand!.command_id },
      },
    );
    expect(replayedAcquire.status()).toBe(409);
    expect(await originalStatus()).toEqual(releasedLease);
    expect(await writeReceipts()).toEqual(originalReceipts);

    const revokedAssignment = await reassign(owner);
    await resumedPage.reload();
    await originalSession.click();
    await expect(transcript).toContainText(warmText);
    await expect(transcript).toContainText(warmReply);
    expect(supplierRequests).toBe(3);
    await resumedPage.getByRole('tab', { name: '编队', exact: true }).click();
    await expect(status(resumed)).toHaveText('暂无写会话');
    await expect(
      resumedPage.getByRole('button', { name: '设为可写会话' }),
    ).toBeEnabled();
    expect(await originalStatus()).toEqual(releasedLease);
    expect(await writeReceipts()).toEqual(originalReceipts);
    await resumedPage.locator('.workspace-main').screenshot({
      path: testInfo.outputPath('resume-no-assignment.png'),
      animations: 'disabled',
    });
    const stageChange = await a.ctx.request.post(
      `/api/requirements/${demand}/commands`,
      {
        headers: { origin },
        data: {
          type: 'requirement.stage',
          stage: 'testing',
          commandId: randomUUID(),
        },
      },
    );
    expect(stageChange.status()).toBe(200);
    const stageReceipt = await stageChange.json();
    expect(stageReceipt).toMatchObject({
      changed: true,
      contextVersion: expect.any(Number),
    });
    expect(stageReceipt.contextVersion).toBeGreaterThan(revokedAssignment);
    const recoveredVersion = await reassign(successor, otherTask);
    expect(recoveredVersion).toBeGreaterThan(stageReceipt.contextVersion);
    expect(recoveredVersion).toBeGreaterThan(refreshed);
    expect(
      (
        await lab.owner.query(
          'select context_version,stage from requirement where id=$1',
          [demand],
        )
      ).rows,
    ).toEqual([{ context_version: recoveredVersion, stage: 'testing' }]);
    expect(
      (
        await lab.owner.query(
          'select id,assignee_id from task where id=any($1::text[])',
          [[handoffTask, otherTask]],
        )
      ).rows,
    ).toEqual(
      expect.arrayContaining([
        { id: handoffTask, assignee_id: owner },
        { id: otherTask, assignee_id: successor },
      ]),
    );
    await resumedPage.reload();
    const recoveredApplicant = resumedPage.getByRole('combobox', {
      name: '申请写权的会话',
    });
    await recoveredApplicant.selectOption(recoverySession);
    await expect(recoveredApplicant).toHaveValue(recoverySession);
    await expect(status(resumed)).toHaveText('暂无写会话');
    const [assigned] = await Promise.all([
      resumedPage.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === commandPath(recoverySession),
      ),
      resumedPage.getByRole('button', { name: '设为可写会话' }).click(),
    ]);
    expect(assigned.status()).toBe(200);
    expect(assigned.request().headers()['x-rdws-edit-session']).toBe(
      identity.loginId,
    );
    const newGrant = await assigned.json();
    expect(newGrant.state).toBe('acquired');
    expect(newGrant.generation).not.toBe(warmGrant.generation);
    expect(newGrant.generation).not.toBe(forkGeneration);
    await expect(message(resumed)).toHaveText('已设为可写会话。');
    const current = await originalStatus();
    expect(current).toMatchObject({
      generation: newGrant.generation,
      phase: 'held',
      auth_session_id: identity.loginId,
      native_session_id: recoverySession,
      owner_id: successor,
      context_version: recoveredVersion,
      run_id: null,
    });
    const armRecovered = recoveredApp.getDecorator<
      (input: Omit<FixtureToolArm, 'broker'>) => void
    >('armIsolatedNativeTool');
    const recoveredScope = {
      ...bScope,
      sessionId: recoverySession,
      who: { userId: successor, authSessionId: identity.loginId },
    };
    let recoveredRequest: string | undefined;
    await resumedPage.route(
      '**' + promptPath,
      async (route) => {
        const { sessionId, requestId, content } = route.request().postDataJSON()
          .payload.args.request;
        expect(sessionId).toBe(recoverySession);
        expect(requestId).toEqual(expect.any(String));
        expect(content).toEqual([{ type: 'text', text: recoveredText }]);
        recoveredRequest = requestId;
        expect(() =>
          armRecovered({
            scope: recoveredScope,
            requestId,
            grant: {
              generation: current.generation,
              contextVersion: refreshed,
            },
          }),
        ).toThrow('当前会话没有可用的写入资格');
        armRecovered({
          scope: recoveredScope,
          requestId,
          grant: {
            generation: current.generation,
            contextVersion: recoveredVersion,
          },
        });
        await route.continue();
      },
      { times: 1 },
    );
    await resumedPage.getByRole('tab', { name: '对话', exact: true }).click();
    await originalSession.click();
    await expect(transcript).toContainText(warmReply);
    const promptBox = resumedPage.getByLabel('消息', { exact: true });
    await submitPrompt(resumedPage, recoveredText);
    await expect(transcript).toContainText(recoveredReply);
    expect(received).toHaveLength(4);
    expect(supplierRequests).toBe(5);
    expect(userText(received[2]!)).toContain(warmText);
    expect(
      received[2]!.messages.some(
        ({ role, content }) =>
          role === 'assistant' &&
          (content === warmReply ||
            (Array.isArray(content) &&
              content.some((part) => part.text === warmReply))),
      ),
    ).toBe(true);
    expect(received[2]?.tools).toEqual([
      expect.objectContaining({
        type: 'function',
        function: expect.objectContaining({ name: 'rdws_authority_probe' }),
      }),
    ]);
    expect(received[3]?.tools ?? []).toEqual([]);
    expect(
      received[3]?.messages.filter(
        ({ role, tool_call_id }) =>
          role === 'tool' && tool_call_id === recoveredCallId,
      ),
    ).toEqual([
      {
        role: 'tool',
        tool_call_id: recoveredCallId,
        content: 'RDWS fixture worktree state: ok',
      },
    ]);
    const recoveredBegins = controls.filter(
      ({ operation, requestId }) =>
        operation === 'begin' && requestId === recoveredRequest,
    );
    expect(recoveredBegins).toEqual([
      expect.objectContaining({
        sessionId: recoverySession,
        requestId: recoveredRequest,
        callId: recoveredCallId,
        callSeq: expect.any(Number),
      }),
    ]);
    const newBegin = recoveredBegins[0]!;
    expect(controls).toContainEqual(
      expect.objectContaining({
        operation: 'status',
        commandId: newBegin.commandId,
        requestId: recoveredRequest,
        callId: recoveredCallId,
        state: 'ok',
      }),
    );
    expect(newBegin.commandId).not.toBe(begun.commandId);
    const newReceipts = (await writeReceipts()).filter(
      ({ command_id }) => command_id === newBegin.commandId,
    );
    expect(newReceipts).toEqual([
      expect.objectContaining({
        actor_id: successor,
        operation: 'write.execute',
        result: expect.objectContaining({
          status: 'finished',
          result: expect.objectContaining({
            status: 'ok',
            stop: 'confirmed',
            marker: 'released',
          }),
        }),
      }),
    ]);
    const finalText = 'baseline|workbench-tool|fork-write|workbench-tool';
    expect(await readFile(sample, 'utf8')).toBe(finalText);
    for (const [width, colorScheme] of [
      [1440, 'dark'],
      [390, 'light'],
    ] as const) {
      await resumedPage.setViewportSize({ width, height: 900 });
      await resumedPage.emulateMedia({ colorScheme });
      await expect(resumedPage.locator('html')).toHaveAttribute(
        'theme-mode',
        colorScheme,
      );
      await promptBox.focus();
      await expect(promptBox).toBeFocused();
      await transcript
        .getByText(recoveredReply, { exact: true })
        .scrollIntoViewIfNeeded();
      expect(
        await resumedPage.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      await resumedPage.locator('.workspace-main').screenshot({
        path: testInfo.outputPath(`resume-${colorScheme}-${width}.png`),
        animations: 'disabled',
      });
    }
    await expect
      .poll(async () =>
        (await journal(root, recoverySession)).events
          .slice(warmSaved.events.length)
          .some(
            ({ type, data }) =>
              type === 'turn/end' &&
              data.turn === 2 &&
              data.reason.kind === 'completed',
          ),
      )
      .toBe(true);
    const finalJournal = await journal(root, recoverySession);
    expect(finalJournal.events.slice(0, warmSaved.events.length)).toEqual(
      warmSaved.events,
    );
    const appended = finalJournal.events.slice(warmSaved.events.length);
    const resumedTurns = appended.filter(({ type }) => type === 'turn/end');
    expect(resumedTurns).toEqual([
      expect.objectContaining({
        data: expect.objectContaining({
          turn: 2,
          reason: { kind: 'completed' },
        }),
      }),
    ]);
    const newInbox = appended
      .filter(({ type }) => type === 'agent/inbox/spliced')
      .flatMap(({ data }) => data.inserted ?? [])
      .filter(({ source }) => source?.rpcId === recoveredRequest);
    expect(newInbox).toEqual([
      expect.objectContaining({
        source: expect.objectContaining({
          principal: expect.objectContaining({ userId: successor }),
        }),
      }),
    ]);
    const resumedCall = appended.find(
      ({ type, seq }) => type === 'tool/call' && seq === newBegin.callSeq,
    );
    expect(resumedCall).toMatchObject({
      data: { callId: recoveredCallId, turn: 2, step: 1 },
    });
    expect(appended.filter(({ type }) => type === 'tool/result')).toEqual([
      expect.objectContaining({
        sourceEventSeqs: [newBegin.callSeq],
        data: expect.objectContaining({
          message: expect.objectContaining({ toolCallId: recoveredCallId }),
        }),
      }),
    ]);
    const newEvidence = (await readEvidence(recoverySession)).slice(
      warmEvidence.length,
    );
    expect(
      newEvidence.map(({ contextVersion, turn, step }) => ({
        contextVersion,
        turn,
        step,
      })),
    ).toEqual([
      { contextVersion: recoveredVersion, turn: 2, step: 1 },
      { contextVersion: recoveredVersion, turn: 2, step: 2 },
    ]);
    for (const [index, item] of newEvidence.entries()) {
      const note = userText(received[index + 2]!).find(
        (part) =>
          createHash('sha256').update(part).digest('hex') === item.contentHash,
      );
      expect(note).toEqual(expect.any(String));
      const snapshot = JSON.parse(note!.slice(note!.indexOf('\n') + 1));
      expect(snapshot).toMatchObject({
        requirementId: demand,
        contextVersion: recoveredVersion,
        stage: 'testing',
        tasks: expect.arrayContaining([
          expect.objectContaining({ id: handoffTask, assigneeId: owner }),
          expect.objectContaining({ id: otherTask, assigneeId: successor }),
        ]),
      });
    }

    await resumedPage.getByRole('tab', { name: '编队', exact: true }).click();
    const currentBroker = recoveredApp.getDecorator<() => OwnedWriteHandoff>(
      'isolatedWriteHandoff',
    )();
    const incumbent = startLoop(
      recoveredScope,
      current.generation,
      currentBroker,
    );
    await expect.poll(incumbent.pid).toBeGreaterThan(1);
    executionGroups.add(incumbent.pid());
    await a.page.goto(fleetUrl);
    await a.page.emulateMedia({ colorScheme: 'dark' });
    await expect(status(a)).toHaveText('写权已占用');
    await a.page
      .getByRole('combobox', { name: '申请写权的会话' })
      .selectOption(aSession);
    const takeover = a.page.getByRole('button', { name: '设为可写会话' });
    await expect(takeover).toBeEnabled();
    releaseGate = releaseCommitGate('write.takeover');
    try {
      await takeover.click();
      await expect.poll(releaseGate.entered).toBe(true);
      expect(process.kill(-incumbent.pid(), 0)).toBe(true);
      expect(await originalStatus()).toMatchObject({
        generation: current.generation,
        phase: 'draining',
        run_id: expect.any(String),
      });
      await expect(
        a.page.getByRole('button', { name: '重试原操作' }),
      ).toBeDisabled();
      const competing = await identity.ctx.request.post(
        commandPath(forkSession),
        {
          headers: recoveryHeaders,
          data: { type: 'takeover', commandId: randomUUID() },
        },
      );
      expect(competing.status()).toBe(409);
    } finally {
      releaseGate.release();
    }
    expect(await incumbent.execution).toMatchObject({
      status: 'finished',
      result: { stop: 'confirmed' },
    });
    expect(() => process.kill(-incumbent.pid(), 0)).toThrow(/ESRCH/);
    await expect(message(a)).toHaveText('已设为可写会话。');
    const taken = await originalStatus();
    expect(taken).toMatchObject({
      phase: 'held',
      native_session_id: aSession,
      auth_session_id: a.loginId,
      run_id: null,
    });
    expect(taken.generation).not.toBe(current.generation);
    const writeAfterTakeover = {
      repositoryId: 'app',
      request: {
        tool: 'file' as const,
        operation: 'write' as const,
        path: 'after-takeover.txt',
        text: 'Written by the new owner',
      },
    };
    await expect(
      currentBroker.execute(recoveredScope, {
        ...writeAfterTakeover,
        generation: current.generation,
        commandId: randomUUID(),
      }),
    ).rejects.toMatchObject({ statusCode: 409 });
    expect(
      await currentBroker.execute(aScope, {
        ...writeAfterTakeover,
        generation: taken.generation,
        commandId: randomUUID(),
      }),
    ).toMatchObject({
      status: 'finished',
      result: { status: 'ok', stop: 'confirmed' },
    });
    expect(
      await readFile(join(checkout.tree, 'after-takeover.txt'), 'utf8'),
    ).toBe('Written by the new owner');
    await expect(a.page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await a.page.locator('.workspace-main').screenshot({
      path: testInfo.outputPath('takeover-dark-390.png'),
      animations: 'disabled',
    });

    await resumedPage.reload();
    await expect(status(resumed)).toHaveText('写权已占用');
    await resumedPage
      .getByRole('combobox', { name: '申请写权的会话' })
      .selectOption(recoverySession);
    let deliverHistorical!: () => void;
    const historicalGate = new Promise<void>((resolve) => {
      deliverHistorical = resolve;
    });
    let receiptWaiting = false;
    await resumedPage.route(
      '**' + commandPath(recoverySession),
      async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        receiptWaiting = true;
        await historicalGate;
        await route.fulfill({ response });
      },
      { times: 1 },
    );
    try {
      await resumedPage.getByRole('button', { name: '设为可写会话' }).click();
      await expect.poll(() => receiptWaiting).toBe(true);
      await expect.poll(originalStatus).toMatchObject({
        phase: 'held',
        native_session_id: recoverySession,
        auth_session_id: identity.loginId,
      });
      await a.page.reload();
      await expect(status(a)).toHaveText('写权已占用');
      await takeover.click();
      await expect(message(a)).toHaveText('已设为可写会话。');
    } finally {
      deliverHistorical();
    }
    await expect(message(resumed)).toHaveText(
      '原接手已确认，请查看当前写权状态。',
    );
    await expect(pendingButton(resumed)).toHaveCount(0);
    const readableHistory = resumedPage
      .getByRole('button', { name: /^回放会话 \d+$/ })
      .first();
    for (const [code, error, hint] of [
      [403, '当前开发角色没有写入资格', '当前会话没有接手资格，可核对原操作。'],
      [401, '登录已变化，请刷新后重试', '当前写权已变化，可核对原操作。'],
    ] as const) {
      await resumedPage.route(
        '**' + commandPath(recoverySession),
        (route) => route.fulfill({ status: code, json: { error } }),
        { times: 1 },
      );
      await resumedPage.getByRole('button', { name: '设为可写会话' }).click();
      await expect(message(resumed)).toHaveText(hint);
      await readableHistory.click();
      await expect(readableHistory).toHaveAttribute('aria-expanded', 'true');
      await readableHistory.click();
      await pendingButton(resumed).click();
      await expect(message(resumed)).toContainText('尚未读到原回执');
      await resumedPage.getByRole('button', { name: '放下本地记录' }).click();
      await expect(pendingButton(resumed)).toHaveCount(0);
    }
    const latestHolder = await originalStatus();
    expect(latestHolder).toMatchObject({
      phase: 'held',
      native_session_id: aSession,
      auth_session_id: a.loginId,
    });
    expect(latestHolder.generation).not.toBe(taken.generation);
    await a.page.getByRole('button', { name: '释放写锁' }).click();
    await expect(message(a)).toHaveText('原写代已释放。');
    expect(await originalStatus()).toMatchObject({
      phase: 'released',
      generation: latestHolder.generation,
      run_id: null,
    });
    await resumedPage.goto('about:blank');
    await a.page.goto('about:blank');
    const stopRecoveredWeb = Promise.resolve(recoveredWeb.close());
    closingWeb = stopRecoveredWeb;
    void stopRecoveredWeb.catch(() => {});
    await expect.poll(() => recoveredWeb.httpServer?.listening).toBe(false);
    closing = recoveredApp.close();
    void closing.catch(() => {});
    await stopRecoveredWeb;
    await closing;
    await verifyStopped(root);
    closing = undefined;
    closingWeb = undefined;
    app = undefined;
    web = undefined;
    nativePid = undefined;
    expect(await fingerprint(sources)).toBe(sourcesBefore);
    expect(await readFile(sample, 'utf8')).toBe(finalText);
    expect(await readFile(join(checkout.tree, warmProofPath), 'utf8')).toBe(
      warmProofText,
    );
    expect(
      (await journal(root, bSession)).events.slice(0, events.length),
    ).toEqual(events);
    expect(received).toHaveLength(4);
    expect(supplierRequests).toBe(5);
  } finally {
    releaseGate?.release();
    closingGate?.release();
    let runtimeStopped = false;
    try {
      await Promise.allSettled(
        browser.contexts().map((context) => context.close()),
      );
      try {
        await (closingWeb ?? web?.close());
      } finally {
        await (closing ?? app?.close());
      }
      await verifyStopped(source?.root);
      runtimeStopped = true;
    } finally {
      NativeFixtureToolJob.prototype.control = control;
      setDefaultCACertificates(originalCAs);
      try {
        const listener = supplier;
        await Promise.allSettled([
          listener &&
            new Promise<void>((resolve) => {
              listener.close(() => resolve());
              listener.closeAllConnections();
            }),
          trees?.close(),
          mirrors?.close(),
        ]).then((outcomes) => {
          const failed = outcomes.find(
            (outcome) => outcome.status === 'rejected',
          );
          if (failed) throw failed.reason;
        });
      } finally {
        try {
          if ((!gitPrepared && source) || !runtimeStopped)
            console.warn(
              `Retaining unconfirmed fixtures: ${databaseFixture ?? basename(lab.root)} / ${source ? basename(source.root) : 'no Git fixture'}.`,
            );
          await source?.close({
            preserveRoot: !runtimeStopped || !gitPrepared,
          });
        } finally {
          if (runtimeStopped) await lab.close();
          else await Promise.allSettled([lab.owner.end(), lab.admin.end()]);
        }
      }
    }
  }
});
