import { expect, test, type Page } from '@playwright/test';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { createServer as createHttpsServer } from 'node:https';
import { createRequire } from 'node:module';
import { connect, createServer } from 'node:net';
import { join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

// §11.20.27 B segment, the two-developer red-to-green journey of §11.20.20
// in the real Workbench (managed Chromium): A sets the own session writable
// in the fleet, sends the Prompt, the model writes a failing test, runs the
// registered command (red), reads on, fixes the implementation, reruns
// (green) and queries Git; B reads the latest files with the own session,
// takes over in the fleet, and A's old session then loses every write tool
// call. Screenshots of the busy, refused, dark and narrow states go to the
// ignored test-results directory.
test.skip(
  process.platform !== 'darwin',
  'The managed write fixture uses macOS Seatbelt.',
);

type Call = { name: string; args: Record<string, unknown> };
const canary = 'canary-env-value-7f3a';
const testFile = `import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
import { sum } from './sum.mjs';
const home = readFileSync('home-path.txt', 'utf8').trim();
const size = existsSync('output-size.txt')
  ? readFileSync('output-size.txt', 'utf8').trim()
  : '';
test('sum adds', () => {
  console.log('tree=' + process.cwd());
  console.log('home=' + home);
  console.log('password=hunter2');
  try { readFileSync('.env'); console.log('env-read-allowed'); } catch { console.log('env-read-denied'); }
  assert.equal(sum(2, 3), 5);
});
test('long output', () => {
  // The heartbeat and the long wait of the busy state (W13).
  if (size === 'sleep') writeFileSync('heartbeat', String(process.pid) + '\\n');
  if (size === 'sleep') { const end = Date.now() + 30000; while (Date.now() < end) {} }
  for (let i = 0; i < 20; i++) console.log('line-' + String(i).padStart(6, '0') + '-' + 'x'.repeat(982));
});
`;
const write = (file_path: string, content: string): Call => ({
  name: 'write',
  args: { file_path, content },
});
const edit = (old_string: string, new_string: string): Call => ({
  name: 'edit',
  args: { file_path: 'sum.mjs', old_string, new_string },
});
const bash = (): Call => ({
  name: 'bash',
  args: { command: 'node sum.test.mjs', description: 'Run the sum test' },
});
const git = (operation: 'status' | 'diff'): Call => ({
  name: 'git',
  args: { operation },
});
const read = (file_path: string, args: Record<string, number> = {}): Call => ({
  name: 'read',
  args: { file_path, ...args },
});
const finished = 'Write tools journey finished';

test('two developers go from red to green with the write tools in the Workbench', async ({
  browser,
}, testInfo) => {
  test.setTimeout(300_000);
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
  const ownContainer = lab.containerName;
  const originalCAs = getCACertificates('default');
  let supplier: ReturnType<typeof createHttpsServer> | undefined;
  let proxy: ReturnType<typeof createServer> | undefined;
  let source: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
  let gitPrepared = false;
  let app: ReturnType<typeof buildApp> | undefined;
  let web: { listen(): Promise<unknown>; close(): Promise<void> } | undefined;
  let mirrors: RepositoryMirrors | undefined;
  let trees: DemandWorktrees | undefined;
  let observer: Pool | undefined;
  let stopped = false;
  const sockets = new Set<import('node:net').Socket>();
  const children = (): string[] => {
    const listing = spawnSync('/bin/ps', ['-axo', 'pid=,ppid=,command='], {
      encoding: 'utf8',
    });
    return (
      listing.stdout
        .split('\n')
        .map((row) => row.trim().split(/\s+/))
        // The managed Chromium belongs to the Playwright fixture, which
        // closes it after the test; everything else this run spawned is
        // listed (the Host and its helpers).
        .filter(
          ([pid, ppid, ...command]) =>
            ppid === String(process.pid) &&
            pid !== String(listing.pid) &&
            !command.join(' ').includes('ms-playwright'),
        )
        .map(([pid]) => pid!)
    );
  };
  const projectId = 'poc';
  const provider = 'rdws-glm';
  const model = 'write-tools-journey';
  const demand = randomUUID();
  const devA = randomUUID();
  const devB = randomUUID();
  const ticket = randomBytes(32).toString('hex');
  const password = randomBytes(18).toString('hex');
  const wrong = 'export const sum = (a, b) => a - b;\n';
  const right = 'export const sum = (a, b) => a + b;\n';
  const shots = async (page: Page, name: string) => {
    await page
      .locator('.workspace-main')
      .screenshot({ path: testInfo.outputPath(name + '.png') });
  };
  let primary: unknown;
  try {
    source = await httpsGitFixture(projectId);
    const root = source.root;
    mirrors = new RepositoryMirrors(root);
    trees = new DemandWorktrees(root, mirrors);
    const files: Record<string, string> = {
      'package.json': JSON.stringify({
        name: 'write-tools-journey',
        scripts: { test: 'node sum.test.mjs' },
      }),
      'sum.mjs': wrong,
      'sample.txt': 'frozen baseline\n',
      '.env': 'SECRET=' + canary + '\n',
      'home-path.txt': process.env.HOME! + '\n',
    };
    for (const [name, text] of Object.entries(files))
      await writeFile(join(source.work, name), text);
    await fixtureGit(['-C', source.work, 'add', '--', ...Object.keys(files)]);
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
    const treeDir = (await trees.executionScope(projectId, demand, plan, 'app'))
      .tree;
    gitPrepared = true;
    const keys = await modelTlsCertificate(lab.root);
    setDefaultCACertificates([...originalCAs, keys.cert.toString()]);
    const received: {
      messages: {
        role: string;
        tool_call_id?: string;
        content: unknown;
        tool_calls?: { function: { name: string; arguments: string } }[];
      }[];
      tools?: { function: { name: string } }[];
    }[] = [];
    const scripts = new Map<string, Call[]>();
    const results = new Map<string, string[]>();
    const lastSpill = new Map<string, string>();
    const call = (step: Call, index: number) => ({
      role: 'assistant',
      tool_calls: [
        {
          index: 0,
          id: 'call-' + index + '-' + step.name,
          type: 'function',
          function: { name: step.name, arguments: JSON.stringify(step.args) },
        },
      ],
    });
    supplier = createHttpsServer(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      (request, response) => {
        void (async () => {
          try {
            const chunks: Buffer[] = [];
            for await (const chunk of request) chunks.push(Buffer.from(chunk));
            if (request.url === '/v1/read-loopback')
              return response.end('write-tools-journey-ok');
            const body = JSON.parse(
              Buffer.concat(chunks).toString(),
            ) as (typeof received)[number];
            received.push(body);
            const sessionId = [...scripts.keys()].find((key) =>
              body.messages.some(
                ({ role, content }) =>
                  role === 'user' &&
                  typeof content === 'string' &&
                  content.startsWith(key + ':'),
              ),
            );
            if (!sessionId) return response.writeHead(400).end();
            const toolMessages = body.messages.filter(
              ({ role }) => role === 'tool',
            );
            const lastText = toolMessages.length
              ? String(toolMessages.at(-1)!.content)
              : '';
            const record = results.get(sessionId)!;
            record.push(lastText);
            const queue = scripts.get(sessionId)!;
            const spill =
              /\[output truncated; full output: (\.rdws-read\/[0-9a-f-]+)\]/.exec(
                lastText,
              );
            const offset = /Use offset=(\d+)/.exec(lastText);
            if (spill) lastSpill.set(sessionId, spill[1]!);
            let delta;
            if (
              toolMessages.length &&
              (spill || offset) &&
              lastSpill.get(sessionId)
            )
              delta = call(
                read(
                  lastSpill.get(sessionId)!,
                  offset ? { offset: Number(offset[1]) } : {},
                ),
                toolMessages.length,
              );
            else {
              const step = queue.shift();
              delta = step
                ? call(step, toolMessages.length)
                : { role: 'assistant', content: finished };
            }
            const frame = {
              id: 'write-tools-journey',
              object: 'chat.completion.chunk',
              created: 1,
              model,
            };
            const choices = [
              { index: 0, delta, finish_reason: null },
              {
                index: 0,
                delta: {},
                finish_reason: 'tool_calls' in delta ? 'tool_calls' : 'stop',
              },
            ];
            response
              .writeHead(200, { 'content-type': 'text/event-stream' })
              .end(
                choices
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
        })();
      },
    );
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    proxy = createServer((client) => {
      const upstream = connect(
        (supplier!.address() as { port: number }).port,
        '127.0.0.1',
      );
      sockets.add(client).add(upstream);
      client.on('error', () => upstream.destroy());
      upstream.on('error', () => client.destroy());
      client.pipe(upstream).pipe(client);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const baseURL =
      'https://127.0.0.1:' + (proxy.address() as { port: number }).port + '/v1';
    observer = new Pool({ connectionString: lab.databaseUrl });
    observer.on('error', () => {});
    const configuration = join(root, 'config', 'projects', projectId, 'dsh');
    const profile = join(configuration, 'profiles', 'rdws');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({ version: 1, refs: { WRITE_JOURNEY: 'synthetic-only' } }),
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
                apiKeyEnv: 'WRITE_JOURNEY',
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
      "insert into project(id,name) values('poc','Write tools journey')",
    );
    for (const [id, name] of [
      [devA, 'dev_a'],
      [devB, 'dev_b'],
    ]) {
      await lab.owner.query(
        'insert into auth_user(id,name,email,username,active,platform_admin) values($1,$2,$3,$4,true,false)',
        [id, name, name + '@fixture.invalid', name],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), id, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [id],
      );
    }
    await lab.owner.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Write tools journey','','',$2,$2)",
      [demand, devA],
    );
    for (const id of [devA, devB])
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [demand, id],
      );
    await lab.owner.query(
      'insert into requirement_worktree_plan values ($1,$2)',
      [demand, JSON.stringify(plan)],
    );
    await lab.owner.query(
      'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
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
      origin,
      secret: lab.childEnv.BETTER_AUTH_SECRET!,
      authorityTicket: ticket,
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
        supervisedExecution: true,
        readSnapshots: true,
        readTool: {
          window: {
            destination: baseURL + '/read-loopback',
            ca: keys.cert.toString('utf8'),
            header: 'write-tools-journey',
          },
          repositoryId: 'app',
        },
        writeTools: { repositoryId: 'app', shellGit: true },
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
    web = await createVite({
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
    await web!.listen();
    const armRead = app.getDecorator<
      (input: { scope: object; requestId: string }) => void
    >('armIsolatedReadTool');
    const armWrite = app.getDecorator<
      (input: {
        scope: object;
        requestId: string;
        repositoryId: string;
      }) => void
    >('armIsolatedWriteTools');
    const broker = app.getDecorator<
      () => import('../../apps/server/src/modules/workbench-write-authority.ts').OwnedWriteHandoff
    >('isolatedWriteHandoff')()!;
    const executions: { tool: string; status: string }[] = [];
    const execute = broker.execute;
    broker.execute = ((...args: Parameters<typeof execute>) =>
      execute.apply(broker, args).then((receipt) => {
        if (receipt.status === 'finished')
          executions.push({
            tool: args[1].request.tool,
            status: receipt.result.status,
          });
        return receipt;
      })) as typeof execute;
    const lease = async () =>
      (
        await observer!.query(
          'select generation,phase,native_session_id,owner_id from requirement_write_lease where requirement_id=$1',
          [demand],
        )
      ).rows[0] as
        | {
            generation: string;
            phase: string;
            native_session_id: string;
            owner_id: string;
          }
        | undefined;
    const status = (page: Page) =>
      page.getByRole('status', { name: '写权状态' });
    const message = (page: Page) =>
      page.getByRole('status', { name: '写权操作结果' });
    const chatUrl = '/?project=poc&view=chat&requirement=' + demand;
    const promptPath = '/api/dsh/' + demand + '/native/api/session/prompt';
    async function login(username: string) {
      const ctx = await browser.newContext({ baseURL: origin });
      // The sign-in rate limit (ten per minute and client address) is kept
      // in memory per process and the browser files share one worker: when
      // earlier files spent the budget, wait for the window and retry.
      let logged = await ctx.request.post('/api/auth/sign-in/username', {
        headers: { origin },
        data: { username, password },
      });
      for (
        let attempt = 0;
        logged.status() === 429 && attempt < 25;
        attempt++
      ) {
        await delay(3000);
        logged = await ctx.request.post('/api/auth/sign-in/username', {
          headers: { origin },
          data: { username, password },
        });
      }
      expect(logged.status()).toBe(200);
      const { session } = await (
        await ctx.request.get('/api/auth/get-session')
      ).json();
      const page = await ctx.newPage();
      page.setDefaultTimeout(20000);
      await page.goto(chatUrl);
      const created = page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname ===
            '/api/requirements/' + demand + '/sessions',
      );
      await page.getByRole('button', { name: '新建会话', exact: true }).click();
      const mapped = await created;
      if (mapped.status() !== 200)
        process.stderr.write(
          'SESSION CREATE ' +
            mapped.status() +
            ' ' +
            (await mapped.text()).slice(0, 400) +
            '\n',
        );
      expect(mapped.status()).toBe(200);
      const { sessionId } = (await mapped.json()) as { sessionId: string };
      await expect(
        page.getByRole('button', { name: /^会话 \d+ · 本人$/ }),
      ).toHaveAttribute('aria-current', 'true');
      return { ctx, page, loginId: session.id as string, sessionId };
    }
    // The Prompt is armed for its request key before it reaches the Host.
    async function send(
      side: { page: Page; loginId: string; sessionId: string },
      userId: string,
      script: Call[],
      withWrite: boolean,
      during?: () => Promise<void>,
    ) {
      scripts.set(side.sessionId, [...script]);
      results.set(side.sessionId, []);
      let requestId: string | undefined;
      await side.page.route(
        '**' + promptPath,
        async (route) => {
          const input = route.request().postDataJSON().payload.args.request as {
            requestId: string;
          };
          requestId = input.requestId;
          const scope = {
            who: { userId, authSessionId: side.loginId },
            projectId,
            requirementId: demand,
            sessionId: side.sessionId,
          };
          armRead({ scope, requestId: input.requestId });
          if (withWrite)
            armWrite({
              scope,
              requestId: input.requestId,
              repositoryId: 'app',
            });
          await route.continue();
        },
        { times: 1 },
      );
      await side.page.getByRole('tab', { name: '对话', exact: true }).click();
      await side.page
        .getByRole('navigation', { name: '需求会话列表' })
        .getByRole('button', { name: /^会话 \d+ · 本人$/ })
        .click();
      await side.page
        .getByLabel('消息', { exact: true })
        .fill(side.sessionId + ': run the script');
      const submitted = side.page.waitForResponse(
        (response) =>
          response.request().method() === 'POST' &&
          new URL(response.url()).pathname === promptPath,
      );
      await side.page
        .getByRole('button', { name: '发送消息', exact: true })
        .click();
      const response = await submitted;
      expect(response.status()).toBe(200);
      expect((await response.json()).result).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
      expect(requestId).toEqual(expect.any(String));
      // The run is over when its own reply is there: the finished line
      // appears once more than before the Prompt (a session may carry the
      // same line from an earlier run).
      const replies = side.page.getByText(finished, { exact: true });
      const seen = await replies.count();
      const before = received.length;
      if (during) await during();
      await expect(replies).toHaveCount(seen + 1, { timeout: 120000 });
      // The supplier served this run's steps: at least its first request.
      expect(received.length).toBeGreaterThan(before);
      return {
        requestId: requestId!,
        results: results.get(side.sessionId)!.slice(1),
        requests: received.length - before,
      };
    }
    // (1) A sets the own session writable in the fleet.
    const a = await login('dev_a');
    await a.page.getByRole('tab', { name: '编队', exact: true }).click();
    await expect(status(a.page)).toHaveText('暂无写会话');
    await a.page.getByRole('button', { name: '设为可写会话' }).click();
    await expect(message(a.page)).toContainText('已设为可写会话');
    await expect(status(a.page)).toContainText('写权已占用');
    await expect
      .poll(() => lease(), { timeout: 5000 })
      .toMatchObject({
        phase: 'held',
        native_session_id: a.sessionId,
        owner_id: devA,
      });
    const generationA = (await lease())!.generation;
    // (2)–(6) A's red-to-green journey through the Workbench Prompt.
    const journeyA = [
      write('sum.test.mjs', testFile),
      bash(),
      edit('a - b', 'a + b'),
      bash(),
      git('status'),
    ];
    const before = received.length;
    scripts.set(a.sessionId, [...journeyA]);
    results.set(a.sessionId, []);
    let requestIdA: string | undefined;
    await a.page.route(
      '**' + promptPath,
      async (route) => {
        const input = route.request().postDataJSON().payload.args.request as {
          requestId: string;
        };
        requestIdA = input.requestId;
        const scope = {
          who: { userId: devA, authSessionId: a.loginId },
          projectId,
          requirementId: demand,
          sessionId: a.sessionId,
        };
        armRead({ scope, requestId: input.requestId });
        armWrite({ scope, requestId: input.requestId, repositoryId: 'app' });
        await route.continue();
      },
      { times: 1 },
    );
    await a.page.getByRole('tab', { name: '对话', exact: true }).click();
    await a.page
      .getByRole('navigation', { name: '需求会话列表' })
      .getByRole('button', { name: /^会话 \d+ · 本人$/ })
      .click();
    await a.page
      .getByLabel('消息', { exact: true })
      .fill(a.sessionId + ': run the script');
    const submittedA = a.page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === promptPath,
    );
    await a.page.getByRole('button', { name: '发送消息', exact: true }).click();
    expect((await submittedA).status()).toBe(200);
    expect(requestIdA).toEqual(expect.any(String));
    // Busy: the command is running in the supervised process.
    await expect
      .poll(() => received.length, { timeout: 20000 })
      .toBeGreaterThan(before + 1);
    await shots(a.page, 'busy');
    await expect(a.page.getByText(finished, { exact: true })).toBeVisible({
      timeout: 120000,
    });
    await shots(a.page, 'green');
    const resultsA = results.get(a.sessionId)!.slice(1);
    const bodiesA = received.slice(before);
    for (const body of bodiesA)
      expect(body.tools?.map(({ function: spec }) => spec.name)).toEqual([
        'bash',
        'edit',
        'git',
        'read',
        'write',
      ]);
    const bashA = resultsA.filter((r) => r.includes('tree=.'));
    expect(bashA.length).toBe(2);
    expect(bashA[0]).toContain('[exit code: 1]');
    // The TAP report follows the console lines, so the failure details and
    // the pass line are in the continuation the model read.
    expect((resultsA[1] ?? '') + (resultsA[2] ?? '')).toContain('not ok 1');
    expect(bashA[1]).not.toContain('[exit code:');
    expect((resultsA[4] ?? '') + (resultsA[5] ?? '')).toContain(
      'ok 1 - sum adds',
    );
    expect(resultsA.at(-1)).toContain('?? sum.test.mjs');
    expect(await readFile(join(treeDir, 'sum.mjs'), 'utf8')).toBe(right);
    expect(executions.map(({ tool, status }) => tool + ':' + status)).toEqual([
      'file:ok',
      'test:failed',
      'file:ok',
      'test:ok',
      'git:ok',
    ]);
    // W18: every tool result the supplier received (the Shell and Git
    // outputs and the read continuations) is scanned by prefix bytes.
    const toolTexts = bodiesA.flatMap((body) =>
      body.messages
        .filter(({ role }) => role === 'tool')
        .map(({ content }) => String(content)),
    );
    expect(toolTexts.length).toBeGreaterThan(5);
    for (const text of toolTexts)
      for (const secret of [
        treeDir,
        root,
        process.env.HOME!,
        process.execPath,
        'hunter2',
        canary,
      ]) {
        const at = text.indexOf(secret);
        expect(
          at,
          'leaked: ' +
            secret +
            (at < 0
              ? ''
              : ' >>> ' + text.slice(Math.max(0, at - 200), at + 100)),
        ).toBe(-1);
      }
    for (const text of bashA) {
      expect(text).toContain('tree=.');
      expect(text).toContain('home=<home>');
      expect(text).toContain('password=[redacted]');
      expect(text).toContain('env-read-denied');
    }
    // Dark theme and the 390px narrow screen of the same state.
    await a.page.emulateMedia({ colorScheme: 'dark' });
    await a.page.setViewportSize({ width: 390, height: 850 });
    await shots(a.page, 'green-dark-narrow');
    expect(
      await a.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await a.page.emulateMedia({ colorScheme: 'light' });
    await a.page.setViewportSize({ width: 1280, height: 800 });
    // (7) B reads the latest files with the own session.
    const b = await login('dev_b');
    const runB = await send(
      b,
      devB,
      [read('sum.mjs'), read('sum.test.mjs')],
      false,
    );
    expect(runB.results[0]).toContain(right.split('\n')[0]!);
    expect(runB.results[1]).toContain("import { sum } from './sum.mjs'");
    // (8) Busy: A starts a long command and B takes over while it runs.
    // The fleet of B shows the draining in progress (the command buttons
    // stay busy while the old session is verified stopped) and A's write
    // command is still running; that is the W13 busy state.
    await a.page.getByRole('tab', { name: '对话', exact: true }).click();
    const busyBefore = executions.length;
    const receivedBefore = received.length;
    const runBusy = send(
      a,
      devA,
      [write('output-size.txt', 'sleep'), bash()],
      true,
      async () => {
        // Wait until the supplier served this run's write result and issued
        // the Shell call, then until that write is a finished execution:
        // the command is running by then.
        await expect
          .poll(
            () =>
              received
                .slice(receivedBefore)
                .some((body) =>
                  body.messages.some(
                    ({ role, content }) =>
                      role === 'tool' &&
                      /Created file|Updated file/.test(String(content)),
                  ),
                ),
            { timeout: 20000 },
          )
          .toBe(true);
        await expect
          .poll(() => executions.length, { timeout: 10000 })
          .toBe(busyBefore + 1);
        await b.page.getByRole('tab', { name: '编队', exact: true }).click();
        const takeover = b.page.getByRole('button', {
          name: '设为可写会话',
        });
        // The takeover reply is held back for a moment so the busy state is
        // observable: the command is in flight (the server drains A's
        // running command meanwhile) and the fleet shows the pending
        // command with its buttons disabled.
        // The process is running (its heartbeat) when the takeover starts.
        await expect
          .poll(
            () =>
              stat(join(treeDir, 'heartbeat')).then(
                (value) => value.isFile(),
                () => false,
              ),
            { timeout: 10000 },
          )
          .toBe(true);
        // The takeover reply is held back for a moment so the busy state is
        // observable: the command is in flight, the server drains A's
        // running command meanwhile, and the fleet keeps the takeover button
        // busy for the whole time.
        // The takeover is in flight with the command running (the heartbeat
        // above). The reply comes back as a pending command while the drain
        // settles; the fleet then shows the pending command in place of the
        // takeover button.
        await takeover.click();
        await expect(takeover).toHaveCount(0, { timeout: 5000 });
        const draining = {
          message: await message(b.page)
            .textContent()
            .catch(() => ''),
          lease: await lease(),
          executions: executions.slice(busyBefore),
        };
        (await import('node:fs/promises')).writeFile(
          testInfo.outputPath('draining.txt'),
          JSON.stringify(draining, null, 1),
        );
        await shots(b.page, 'busy-draining');
        // While the drain is in progress the fleet shows the pending
        // command (the takeover button is gone), the lease has not changed
        // hands yet, and A's command is still running: the W13 busy state.
        // The command was running when the takeover started (heartbeat) and
        // the drain is what stopped it: at most that one command ended by
        // now, and the lease is still settling or has just changed hands.
        expect(draining.executions.length).toBeLessThanOrEqual(2);
        expect(draining.lease?.phase).toMatch(/^(held|draining)$/);
      },
    );
    await expect
      .poll(() => lease(), { timeout: 20000 })
      .toMatchObject({
        phase: 'held',
        native_session_id: b.sessionId,
        owner_id: devB,
      });
    expect((await lease())!.generation).not.toBe(generationA);
    await expect(message(b.page)).toContainText('已设为可写会话', {
      timeout: 15000,
    });
    await expect(status(b.page)).toContainText('写权已占用');
    const busy = await runBusy;
    // The running command was stopped by the drain, not by its own deadline.
    expect(busy.results.at(-1)).toContain(
      '[cancelled; the process was terminated]',
    );
    expect(busy.results.at(-1)).not.toContain('[timed out');
    expect(executions.length).toBe(busyBefore + 2);
    // (9) A's old session: every write tool call is refused. The session
    // keeps its history, the model answers, and the three calls fail.
    await a.page.getByRole('tab', { name: '编队', exact: true }).click();
    await a.page.reload();
    await expect(status(a.page)).toContainText('写权已占用');
    await expect(a.page.getByRole('button', { name: '释放写锁' })).toHaveCount(
      0,
    );
    await shots(a.page, 'rejected-fleet');
    const beforeA2 = executions.length;
    const runA2 = await send(
      a,
      devA,
      [write('late.txt', 'late'), bash(), git('status')],
      false,
    );
    // A new reply followed the second Prompt, and the supplier served the
    // run: three tool results, each a refusal.
    expect(runA2.requests).toBeGreaterThanOrEqual(4);
    expect(runA2.results).toHaveLength(3);
    for (const text of runA2.results) {
      expect(text).not.toContain('Created file');
      expect(text).not.toContain('exit code');
      expect(text).not.toContain('diff --git');
    }
    expect(
      await readFile(join(treeDir, 'late.txt'), 'utf8').catch(() => undefined),
    ).toBeUndefined();
    expect(await readFile(join(treeDir, 'sum.mjs'), 'utf8')).toBe(right);
    expect(executions.length).toBe(beforeA2);
    await a.page.getByRole('tab', { name: '对话', exact: true }).click();
    await expect(a.page.getByText(finished, { exact: true })).toHaveCount(3);
    // The screenshot shows the new reply: the last reply is scrolled into
    // view first.
    await a.page
      .getByText(finished, { exact: true })
      .last()
      .scrollIntoViewIfNeeded();
    await shots(a.page, 'rejected-chat');
    await b.page.getByRole('button', { name: '释放写锁' }).click();
    await expect
      .poll(() => lease(), { timeout: 15000 })
      .toMatchObject({ phase: 'released' });
    await a.ctx.close();
    await b.ctx.close();
    await Promise.all([app!.close(), web!.close()]);
    app = undefined;
    web = undefined;
    stopped = true;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    if (primary !== undefined)
      process.stderr.write(
        'PRIMARY FAILURE: ' + String(primary).slice(0, 1500) + '\n',
      );
    for (const socket of sockets) socket.destroy();
    supplier?.closeAllConnections();
    // Every closer is bounded: a close that does not finish (a run still
    // draining under supervision) must not keep the one-shot database of
    // this run from being removed.
    const within = (closing: Promise<unknown> | undefined, ms: number) =>
      closing
        ? Promise.race([
            closing.catch(() => {}),
            new Promise((resolve) => setTimeout(resolve, ms)),
          ])
        : undefined;
    await Promise.all(
      [
        within(
          supplier
            ? new Promise<void>((resolve) => supplier!.close(() => resolve()))
            : undefined,
          20000,
        ),
        within(
          proxy
            ? new Promise<void>((resolve) => proxy!.close(() => resolve()))
            : undefined,
          20000,
        ),
        within(observer?.end(), 20000),
        within(app?.close(), 30000),
        within(web?.close(), 20000),
        within(trees?.close(), 20000),
        within(mirrors?.close(), 20000),
      ].filter(Boolean),
    );
    try {
      await source?.close({ preserveRoot: !gitPrepared || !stopped });
    } finally {
      // The one-shot database of this run never outlives it, whatever the
      // outcome was.
      await lab.close();
    }
    for (let attempt = 0; attempt < 60 && children().length; attempt++)
      await delay(250);
    if (primary === undefined && children().length)
      process.stderr.write(
        'LEFTOVER: ' +
          spawnSync(
            '/bin/ps',
            ['-o', 'pid=,ppid=,etime=,command=', '-p', children().join(' ')],
            { encoding: 'utf8' },
          ).stdout +
          '\n',
      );
    if (primary === undefined) expect(children()).toEqual([]);
    expect(
      execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
        encoding: 'utf8',
      }),
    ).not.toContain(ownContainer);
    console.log(
      'residue after the run:',
      JSON.stringify({ container: ownContainer, children: children() }),
    );
  }
});
