import {
  expect,
  test,
  type BrowserContext,
  type Page,
  type WebSocketRoute,
} from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer as createHttps } from 'node:https';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { hashPassword } from 'better-auth/crypto';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { journal } from '../helpers/native-journal.ts';
import { nativeReady } from '../helpers/native-ready.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';

type Follow = {
  type: 'open';
  streamId: string;
  endpoint: 'session/follow';
  payload: {
    args: {
      request: {
        address: { kind: 'session'; sessionId: string };
        activate: boolean;
        assistantStream: boolean;
      };
    };
  };
};

function observeFollows(page: Page) {
  const opened: {
    frame: Follow;
    socket: string;
    closed: () => boolean;
    snapshot: boolean;
  }[] = [];
  page.on('websocket', (socket) => {
    if (!socket.url().includes('/api/remote.mux?')) return;
    socket.on('framesent', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const message = JSON.parse(payload) as Follow;
      if (message.type === 'open' && message.endpoint === 'session/follow')
        opened.push({
          frame: message,
          socket: socket.url(),
          closed: () => socket.isClosed(),
          snapshot: false,
        });
    });
    socket.on('framereceived', ({ payload }) => {
      if (typeof payload !== 'string') return;
      const message = JSON.parse(payload);
      if (
        message.type !== 'item' ||
        message.value?.type !== 'snapshot' ||
        message.value.assistantStream === undefined
      )
        return;
      const record = opened.find(
        ({ frame, socket: url }) =>
          url === socket.url() && frame.streamId === message.streamId,
      );
      if (record) record.snapshot = true;
    });
  });
  return opened;
}

async function probeMux(
  page: Page,
  endpoint: string,
  baseline: Follow | null,
  forbidden: Record<string, unknown>,
) {
  return page.evaluate(
    ({ endpoint, baseline, forbidden }) =>
      new Promise<{ opened: boolean; snapshot: boolean }>((resolve, reject) => {
        const url = new URL(endpoint);
        url.searchParams.set('generation', crypto.randomUUID());
        const streamId = crypto.randomUUID();
        const socket = new WebSocket(url);
        let opened = false;
        let snapshot = false;
        const timer = setTimeout(() => {
          reject(new Error('Fixture mux rejection did not close the socket'));
          socket.close();
        }, 4500);
        const sendForbidden = () =>
          socket.send(
            JSON.stringify({ ...forbidden, streamId: crypto.randomUUID() }),
          );
        socket.onopen = () => {
          opened = true;
          if (baseline) socket.send(JSON.stringify({ ...baseline, streamId }));
          else sendForbidden();
        };
        socket.onmessage = ({ data }) => {
          const message = JSON.parse(data);
          if (
            snapshot ||
            message.streamId !== streamId ||
            message.type !== 'item' ||
            message.value?.type !== 'snapshot'
          )
            return;
          snapshot = message.value.assistantStream !== undefined;
          if (snapshot) sendForbidden();
        };
        socket.onclose = () => {
          clearTimeout(timer);
          resolve({ opened, snapshot });
        };
      }),
    { endpoint, baseline, forbidden },
  );
}

test.skip(
  process.platform !== 'darwin',
  'The Native trial requires macOS Seatbelt.',
);

test('the model pilot browser opens cold sessions without activation and receives a real HTTP prompt reply', async ({
  browser,
}) => {
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
  const currentMode = process.env.RDWS_MODE;
  const currentEgress = process.env.RDWS_NATIVE_MODEL_EGRESS;
  process.env.RDWS_MODE = 'test';
  process.env.RDWS_NATIVE_MODEL_EGRESS = 'mediated';
  const trust = getCACertificates('default');
  const contexts: BrowserContext[] = [];
  const project = 'poc',
    neighborProject = 'fixture-neighbor';
  const demand = randomUUID(),
    neighborDemand = randomUUID();
  const owner = randomUUID(),
    viewer = randomUUID();
  const provider = 'rdws-glm',
    firstModel = 'browser-pilot-a',
    selectedModel = 'browser-pilot-b';
  const password = randomBytes(18).toString('hex');
  const root = join(lab.root, 'native');
  const target = join(lab.root, 'target.json');
  const armed = join(lab.root, 'armed.json');
  const checkpoint = join(lab.root, 'checkpoint.json');
  const observed = join(lab.root, 'observed.jsonl');
  const nativeObserver = fileURLToPath(
    new URL('../fixtures/t13-passive-queue.mjs', import.meta.url),
  );
  const coldPromptText = 'Synthetic pending input from the first owner';
  const livePromptText = 'Synthetic Workbench SDK prompt';
  const replyPart = 'Synthetic reply in progress';
  const finalPart = ' and finished';
  const received: { model: string; wrotePrompt: boolean }[] = [];
  let tlsConnections = 0;
  let releaseDelayedSave: (() => void) | undefined;
  let releaseReply!: () => void;
  const replyGate = new Promise<void>((resolve) => {
    releaseReply = resolve;
  });
  let app: ReturnType<typeof buildApp> | undefined;
  let frontend: { close(): Promise<void> } | undefined;
  let supplier: ReturnType<typeof createHttps> | undefined;
  let cleanupFailure: PromiseRejectedResult | undefined;
  try {
    const keys = await modelTlsCertificate(lab.root);
    setDefaultCACertificates([...trust, keys.cert.toString()]);
    supplier = createHttps(
      { ...keys, minVersion: 'TLSv1.3', maxVersion: 'TLSv1.3' },
      async (request, response) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of request) chunks.push(Buffer.from(chunk));
          const body = Buffer.concat(chunks).toString();
          const { model } = JSON.parse(body) as { model: string };
          received.push({ model, wrotePrompt: body.includes(livePromptText) });
          const event = (delta: object, finish_reason: string | null) =>
            'data: ' +
            JSON.stringify({
              id: 'browser-pilot',
              object: 'chat.completion.chunk',
              created: 1,
              model,
              choices: [{ index: 0, delta, finish_reason }],
            }) +
            '\n\n';
          response.writeHead(200, { 'content-type': 'text/event-stream' });
          response.write(
            event({ role: 'assistant', content: replyPart }, null),
          );
          await replyGate;
          response.end(
            event({ content: finalPart }, null) +
              event({}, 'stop') +
              'data: [DONE]\n\n',
          );
        } catch {
          response.destroy();
        }
      },
    );
    supplier.on('connection', () => ++tlsConnections);
    supplier.listen(0, '127.0.0.1');
    await once(supplier, 'listening');
    const baseURL = `https://127.0.0.1:${(supplier.address() as { port: number }).port}/v1`;
    const portProbe = createServer();
    portProbe.listen(0, '127.0.0.1');
    await once(portProbe, 'listening');
    const port = (portProbe.address() as { port: number }).port;
    await new Promise<void>((resolve) => portProbe.close(() => resolve()));
    const origin = `http://127.0.0.1:${port}`;

    async function configure(projectId: string, maintenance: boolean) {
      const config = join(root, 'config/projects', projectId, 'dsh');
      const profile = join(config, 'profiles/rdws');
      await mkdir(profile, { recursive: true, mode: 0o700 });
      await writeFile(
        join(config, '.credentials.yaml'),
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
                  models: [{ id: firstModel }, { id: selectedModel }],
                  retryPolicy: { mode: 'normal', maxRetries: 0 },
                },
              },
            },
          },
          ...(projectId === project
            ? [
                {
                  insert: [
                    {
                      id: 'test-pilot-queue',
                      name: nativeObserver,
                      config: maintenance
                        ? {
                            target,
                            armed,
                            checkpoint,
                            observed: observed + '.old',
                          }
                        : { observed },
                    },
                  ],
                },
              ]
            : []),
        ]),
        { mode: 0o600 },
      );
    }
    await configure(project, true);
    await configure(neighborProject, false);
    await lab.owner.query(
      'insert into project(id,name) values($1,$2),($3,$4)',
      [project, 'Browser pilot', neighborProject, 'Neighbor project'],
    );
    for (const [id, username] of [
      [owner, 'pilot_browser_owner'],
      [viewer, 'pilot_browser_viewer'],
    ]) {
      await lab.owner.query(
        'insert into auth_user(id,name,email,username,active) values($1,$2,$3,$2,true)',
        [id, username, username + '@fixture.invalid'],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), id, await hashPassword(password)],
      );
    }
    await lab.owner.query(
      "insert into project_member values($1,$2,'developer'), ($1,$3,'tester'), ($4,$2,'developer')",
      [project, owner, viewer, neighborProject],
    );
    await lab.owner.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Pilot demand','','',$5,$5),($3,$4,'Neighbor demand','','',$5,$5)",
      [demand, project, neighborDemand, neighborProject, owner],
    );
    await lab.owner.query(
      "insert into requirement_participant values($1,$2,'developer'),($1,$3,'tester'),($4,$2,'developer')",
      [demand, owner, viewer, neighborDemand],
    );
    const {
      rows: [fixture],
    } = await lab.owner.query<{ name: string }>(
      "select current_setting('rdws.fixture_instance') as name",
    );
    async function start() {
      const ticket = randomBytes(32).toString('hex');
      const prepared = await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null and proof_digest is null and ticket_digest is null',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      expect(prepared.rowCount).toBe(1);
      const current = (app = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin,
        nativeRuntimeRoot: root,
        repositoryHome: root,
        authorityTicket: ticket,
        mainModelPolicy: {
          projectId: project,
          provider,
          model: firstModel,
          destination: baseURL + '/chat/completions',
        },
        sessionModelPilot: {
          alternateModel: selectedModel,
          databaseFixture: fixture!.name,
        },
      }));
      return {
        current,
        api: await current.listen({ host: '127.0.0.1', port: 0 }),
      };
    }
    async function login(username: string, transport: string) {
      const context = await browser.newContext({ baseURL: origin });
      contexts.push(context);
      const logged = await context.request.post(
        transport + '/api/auth/sign-in/username',
        { headers: { origin }, data: { username, password } },
      );
      expect(logged.status()).toBe(200);
      const { session } = (await (
        await context.request.get(transport + '/api/auth/get-session')
      ).json()) as { session: { id: string } };
      return {
        context,
        loginId: session.id,
        headers: { origin, 'x-rdws-edit-session': session.id },
      };
    }
    const old = await start();
    const prior = await login('pilot_browser_owner', old.api);
    const sessionsPath = `/api/requirements/${demand}/sessions`;
    const seeded = await prior.context.request.post(old.api + sessionsPath, {
      headers: prior.headers,
      data: { commandId: randomUUID() },
    });
    expect(seeded.status()).toBe(200);
    const { sessionId: coldSession } = (await seeded.json()) as {
      sessionId: string;
    };
    const oldRequest = randomUUID();
    await writeFile(
      target,
      JSON.stringify({ sessionId: coldSession, requestId: oldRequest }),
      { mode: 0o600 },
    );
    await expect
      .poll(async () => readFile(armed, 'utf8').catch(() => ''))
      .toContain(coldSession);
    const rootApi = `/api/dsh/${demand}`;
    const boot = await prior.context.request.get(
      old.api + rootApi + '/bootstrap',
      { headers: prior.headers },
    );
    expect(boot.status()).toBe(200);
    const oldBinding = (await boot.json()).loginBinding as string;
    const seed = await prior.context.request.post(
      old.api + rootApi + '/native/api/session/prompt',
      {
        headers: {
          origin,
          'x-rdws-native-login': oldBinding,
          'x-rdws-client-generation': randomUUID(),
        },
        data: {
          type: 'client-request',
          method: 'session/prompt',
          rpcId: randomUUID(),
          payload: {
            args: {
              request: {
                sessionId: coldSession,
                requestId: oldRequest,
                mode: 'queue',
                content: [{ type: 'text', text: coldPromptText }],
              },
            },
          },
        },
      },
    );
    expect(seed.status()).toBe(200);
    await expect
      .poll(async () => readFile(checkpoint, 'utf8').catch(() => ''))
      .toContain(coldSession);
    const priorJournal = await journal(root, coldSession);
    expect(priorJournal.events.some(({ type }) => type === 'turn/start')).toBe(
      false,
    );
    expect(
      priorJournal.events.some(
        ({ type, data }) =>
          type === 'agent/inbox/spliced' &&
          data.inserted?.some(
            ({ source }: { source?: { rpcId?: string } }) =>
              source?.rpcId === oldRequest,
          ),
      ),
    ).toBe(true);
    expect(tlsConnections).toBe(0);
    const previous = await nativeReady(root);
    const lock = JSON.parse(
      await readFile(join(root, 'runtime/instances/project-poc.lock'), 'utf8'),
    ) as { pid: number; childPid: number };
    expect(lock).toMatchObject({ pid: process.pid, childPid: previous.pid });
    expect(
      Number.isSafeInteger(previous.pid) &&
        previous.pid > 1 &&
        previous.pid !== process.pid,
    ).toBe(true);
    expect(
      Number(
        execFileSync('/bin/ps', ['-o', 'ppid=', '-p', String(previous.pid)], {
          encoding: 'utf8',
        }).trim(),
      ),
    ).toBe(process.pid);
    expect(await nativeReady(root)).toEqual(previous);
    expect(process.kill(previous.pid, 'SIGKILL')).toBe(true);
    await old.current.close();
    app = undefined;
    expect(() => process.kill(previous.pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    await configure(project, false);
    const live = await start();
    const resolve = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolve.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    const web = (frontend = await createVite({
      root: consoleRoot,
      configFile: join(consoleRoot, 'vite.config.ts'),
      cacheDir: join(root, 'vite-cache'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        proxy: { '/api': { target: live.api, ws: true } },
      },
    }));
    await web.listen();
    const current = await login('pilot_browser_owner', origin);
    const page = await current.context.newPage();
    page.setDefaultTimeout(8_000);
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    const follows = observeFollows(page);
    const routes: WebSocketRoute[] = [];
    await page.routeWebSocket(
      `**${rootApi}/native/api/remote.mux?*`,
      (socket) => {
        routes.push(socket);
        socket.connectToServer();
      },
    );
    const url = `/?project=${project}&view=chat&requirement=${demand}`;
    await page.goto(url);
    await page.getByRole('button', { name: /^会话 \d+ · 本人$/ }).click();
    const forSession = (sessionId: string) =>
      follows.filter(
        ({ frame }) =>
          frame.payload.args.request.address.sessionId === sessionId,
      );
    await expect.poll(() => forSession(coldSession).length).toBeGreaterThan(0);
    const opening = forSession(coldSession)[0]!;
    if (opening.frame.payload.args.request.activate) {
      await expect.poll(opening.closed).toBe(true);
      await expect(page.getByTestId('active-session-model')).toHaveCount(0);
      expect(tlsConnections).toBe(0);
    }
    expect(opening.frame.payload.args.request).toMatchObject({
      activate: false,
      assistantStream: true,
    });
    await expect.poll(() => opening.snapshot).toBe(true);
    await expect(page.getByTestId('active-session-model')).toBeVisible();
    expect(
      (await journal(root, coldSession)).bytes.equals(priorJournal.bytes),
    ).toBe(true);
    expect(tlsConnections).toBe(0);
    const readObservations = async () =>
      (await readFile(observed, 'utf8').catch(() => ''))
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as { type: string; sessionId: string });
    expect(
      (await readObservations()).filter(
        ({ sessionId }) => sessionId === coldSession,
      ),
    ).toEqual([]);
    const openingRoute = routes.at(-1)!;
    await openingRoute.close({ code: 1012, reason: 'Synthetic reconnect' });
    await expect
      .poll(() =>
        forSession(coldSession).some(({ socket }) => socket !== opening.socket),
      )
      .toBe(true);
    const reconnected = forSession(coldSession).find(
      ({ socket }) => socket !== opening.socket,
    )!;
    await expect.poll(() => reconnected.snapshot).toBe(true);
    expect(reconnected.frame.payload.args.request).toEqual(
      opening.frame.payload.args.request,
    );
    expect(new URL(reconnected.socket).searchParams.get('generation')).not.toBe(
      new URL(opening.socket).searchParams.get('generation'),
    );
    expect(new URL(reconnected.socket).searchParams.get('login')).toBe(
      new URL(opening.socket).searchParams.get('login'),
    );
    await expect(page.getByTestId('active-session-model')).toBeVisible();
    expect(
      (await journal(root, coldSession)).bytes.equals(priorJournal.bytes),
    ).toBe(true);
    expect(
      (await readObservations()).filter(
        ({ sessionId }) => sessionId === coldSession,
      ),
    ).toEqual([]);
    expect(tlsConnections).toBe(0);
    const createResponse = page.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname === sessionsPath,
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const created = await createResponse;
    expect(created.status()).toBe(200);
    const { sessionId } = (await created.json()) as { sessionId: string };
    expect(sessionId).not.toBe(coldSession);
    await expect.poll(() => forSession(sessionId).length).toBeGreaterThan(0);
    await expect(page.getByTestId('active-session-model')).toBeVisible();
    const modelPath = `${sessionsPath}/${sessionId}/model-selection`;
    await expect(
      page.getByRole('button', { name: '选择会话模型' }),
    ).toBeVisible();
    const composerText = page.getByLabel('消息', { exact: true });
    const sendButton = page.getByRole('button', {
      name: '发送消息',
      exact: true,
    });
    await composerText.fill(livePromptText);
    let delayedId = '';
    const delayedSave = new Promise<void>((resolve) => {
      releaseDelayedSave = resolve;
    });
    await page.route('**' + modelPath, async (route) => {
      const req = route.request();
      if (
        req.method() === 'POST' &&
        req.postDataJSON().model === firstModel &&
        !delayedId
      ) {
        delayedId = req.postDataJSON().commandId;
        await delayedSave;
      }
      await route.continue();
    });
    await page.getByRole('button', { name: '选择会话模型' }).click();
    const modelSelect = page.getByLabel('可用模型');
    await modelSelect.selectOption(JSON.stringify([provider, firstModel]));
    await page.getByRole('button', { name: '保存选择', exact: true }).click();
    await expect.poll(() => !!delayedId).toBe(true);
    await expect(sendButton).toBeDisabled();
    await page
      .locator('form.composer')
      .evaluate((element) => (element as HTMLFormElement).requestSubmit());
    expect(tlsConnections).toBe(0);
    await modelSelect.selectOption(JSON.stringify([provider, selectedModel]));
    const confirmation = page.waitForResponse(
      (r) =>
        r.url().endsWith(modelPath) &&
        r.request().method() === 'POST' &&
        r.request().postDataJSON().model === selectedModel,
    );
    await page.getByRole('button', { name: '明确改选并保存' }).click();
    const confirmed = await confirmation;
    expect(confirmed.status()).toBe(200);
    expect(confirmed.request().postDataJSON().supersedes).toEqual([delayedId]);
    const selection = (await confirmed.json()).selection;
    await expect(sendButton).toBeEnabled();
    const late = page.waitForResponse(
      (r) =>
        r.url().endsWith(modelPath) &&
        r.request().method() === 'POST' &&
        r.request().postDataJSON().commandId === delayedId,
    );
    releaseDelayedSave!();
    expect((await late).status()).toBe(409);
    await expect(composerText).toHaveValue(livePromptText);
    expect(
      (
        await current.context.request.get(modelPath, {
          headers: current.headers,
        })
      ).status(),
    ).toBe(200);
    expect(tlsConnections).toBe(0);
    await page.getByRole('button', { name: '发送消息', exact: true }).click();
    await expect(page.getByText(replyPart, { exact: true })).toBeVisible();
    expect(received).toEqual([{ model: selectedModel, wrotePrompt: true }]);
    releaseReply();
    await expect(
      page.getByText(replyPart + finalPart, { exact: true }),
    ).toBeVisible();
    await expect
      .poll(async () =>
        (
          await current.context.request.get(modelPath, {
            headers: current.headers,
          })
        ).json(),
      )
      .toEqual({ selection, firstWrite: 'submitted' });
    await expect
      .poll(async () =>
        (await readObservations())
          .filter((entry) => entry.sessionId === sessionId)
          .map(({ type }) => type),
      )
      .toEqual(['created', 'claimed']);
    expect(
      (await readObservations()).filter(
        (entry) => entry.sessionId === coldSession,
      ),
    ).toEqual([]);

    const reader = await login('pilot_browser_viewer', origin);
    const view = await reader.context.newPage();
    view.setDefaultTimeout(8000);
    const readerFollows = observeFollows(view);
    await view.setViewportSize({ width: 390, height: 860 });
    await view.emulateMedia({ colorScheme: 'dark' });
    await view.goto(url);
    const directory = await reader.context.request.get(sessionsPath, {
      headers: reader.headers,
    });
    expect(directory.status()).toBe(200);
    const { sessions } = (await directory.json()) as {
      sessions: { id: string }[];
    };
    const index = sessions.findIndex(({ id }) => id === sessionId);
    expect(index).toBeGreaterThanOrEqual(0);
    await view
      .getByRole('button', { name: `会话 ${index + 1}`, exact: true })
      .click();
    await expect(
      view.getByText(replyPart + finalPart, { exact: true }),
    ).toBeVisible();
    await expect(
      view.getByRole('button', { name: '发送消息', exact: true }),
    ).toHaveCount(0);
    expect(
      readerFollows.find(
        ({ frame }) =>
          frame.payload.args.request.address.sessionId === sessionId,
      )?.frame.payload.args.request.activate,
    ).toBe(false);
    await expect(view.locator('html')).toHaveAttribute('theme-mode', 'dark');
    expect(
      await view.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'light');

    await expect(
      view.getByRole('button', { name: '选择会话模型' }),
    ).toHaveCount(0);
    const neighborPage = await current.context.newPage();
    neighborPage.setDefaultTimeout(8000);
    const neighborFollows = observeFollows(neighborPage);
    await neighborPage.goto(
      `/?project=${neighborProject}&view=chat&requirement=${neighborDemand}`,
    );
    const neighborCreated = neighborPage.waitForResponse(
      (response) =>
        response.request().method() === 'POST' &&
        new URL(response.url()).pathname ===
          `/api/requirements/${neighborDemand}/sessions`,
    );
    await neighborPage
      .getByRole('button', { name: '新建会话', exact: true })
      .click();
    const neighborResponse = await neighborCreated;
    expect(neighborResponse.status()).toBe(200);
    const { sessionId: neighborSession } = (await neighborResponse.json()) as {
      sessionId: string;
    };
    await expect
      .poll(
        () =>
          neighborFollows.find(
            ({ frame }) =>
              frame.payload.args.request.address.sessionId === neighborSession,
          )?.frame.payload.args.request,
      )
      .toMatchObject({ activate: true, assistantStream: true });
    await expect(
      neighborPage.getByTestId('active-session-model'),
    ).toBeVisible();
    await neighborPage
      .getByLabel('消息', { exact: true })
      .fill('Synthetic ordinary draft');
    await expect(
      neighborPage.getByRole('button', { name: '发送消息', exact: true }),
    ).toBeEnabled();

    await expect(
      neighborPage.getByRole('button', { name: '选择会话模型' }),
    ).toHaveCount(0);
    const original = reconnected.frame.payload.args.request;
    const ordinary = structuredClone(
      neighborFollows.find(
        ({ frame }) =>
          frame.payload.args.request.address.sessionId === neighborSession,
      )!.frame,
    );
    ordinary.streamId = reconnected.frame.streamId;
    ordinary.payload.args.request.address.sessionId =
      original.address.sessionId;
    ordinary.payload.args.request.activate = false;
    expect(ordinary).toEqual(reconnected.frame);
    const activating = {
      ...reconnected.frame,
      payload: { args: { request: { ...original, activate: true } } },
    };
    const oldSocket = new URL(reconnected.socket);
    const nativeHeaders = {
      origin,
      'x-rdws-native-login': oldSocket.searchParams.get('login')!,
      'x-rdws-client-generation': oldSocket.searchParams.get('generation')!,
    };
    const directHttp = await current.context.request.post(
      rootApi + '/native/api/session/follow',
      {
        headers: nativeHeaders,
        data: {
          type: 'client-request',
          method: 'session/follow',
          rpcId: randomUUID(),
          payload: activating.payload,
        },
      },
    );
    expect(directHttp.status()).toBe(403);
    const stalePrompt = {
      sessionId: coldSession,
      requestId: randomUUID(),
      mode: 'queue',
      content: [{ type: 'text', text: 'Synthetic direct frame' }],
    };
    const unauthorized = {
      ...reconnected.frame,
      payload: {
        args: {
          request: {
            ...original,
            address: { kind: 'session', sessionId: neighborSession },
          },
        },
      },
    };
    const forbidden = {
      ...reconnected.frame,
      endpoint: 'session/prompt',
      payload: { args: { request: stalePrompt } },
    };
    for (const candidate of [activating, unauthorized, forbidden]) {
      expect(
        await probeMux(page, reconnected.socket, reconnected.frame, candidate),
      ).toEqual({ opened: true, snapshot: true });
    }
    await current.context.addCookies(await reader.context.cookies(origin));
    const switched = await current.context.request.get('/api/auth/get-session');
    expect((await switched.json()).session.id).toBe(reader.loginId);
    expect(
      await probeMux(page, reconnected.socket, null, reconnected.frame),
    ).toEqual({ opened: false, snapshot: false });
    const stale = await current.context.request.post(
      rootApi + '/native/api/session/prompt',
      {
        headers: nativeHeaders,
        data: {
          type: 'client-request',
          method: 'session/prompt',
          rpcId: randomUUID(),
          payload: forbidden.payload,
        },
      },
    );
    expect(stale.status()).toBe(401);
    expect(
      (
        await lab.owner.query(
          'select request_id from session_prompt_dispatch where native_session_id=$1',
          [coldSession],
        )
      ).rows,
    ).toEqual([{ request_id: oldRequest }]);
    expect(
      (await journal(root, coldSession)).bytes.equals(priorJournal.bytes),
    ).toBe(true);
    expect(
      (await readObservations()).filter(
        ({ sessionId }) => sessionId === coldSession,
      ),
    ).toEqual([]);
    expect(received).toHaveLength(1);
    expect(tlsConnections).toBe(1);
    const recovery = await login('pilot_browser_owner', origin);
    const ui = await recovery.context.newPage();
    ui.setDefaultTimeout(8000);
    const openSession = async (id: string) => {
      await ui.goto(url);
      const reply = await recovery.context.request.get(sessionsPath, {
        headers: recovery.headers,
      });
      const { sessions: directory } = (await reply.json()) as {
        sessions: { id: string; sourceSessionId?: string }[];
      };
      const offset = directory.findIndex((row) => row.id === id);
      expect(offset).toBeGreaterThanOrEqual(0);
      await ui
        .getByRole('button', {
          name:
            '会话 ' +
            (offset + 1) +
            ' · 本人' +
            (directory[offset]!.sourceSessionId ? ' · 派生' : ''),
          exact: true,
        })
        .click();
      await expect(ui.getByTestId('active-session-model')).toBeVisible();
    };
    await openSession(sessionId);
    await ui.setViewportSize({ width: 390, height: 850 });
    await ui.emulateMedia({ colorScheme: 'dark' });
    await expect(ui.locator('html')).toHaveAttribute('theme-mode', 'dark');
    const draft = ui.getByLabel('消息', { exact: true });
    const send = ui.getByRole('button', { name: '发送消息', exact: true });
    const pick = async (model: string) => {
      const trigger = ui.getByRole('button', { name: '选择会话模型' });
      if ((await trigger.getAttribute('aria-expanded')) !== 'true')
        await trigger.click();
      await ui
        .getByLabel('可用模型')
        .selectOption(JSON.stringify([provider, model]));
    };
    await draft.fill('Synthetic draft after a lost save');
    await pick(selectedModel);
    await ui.getByLabel('可用模型').press('Escape');
    await expect(
      ui.getByRole('button', { name: '选择会话模型' }),
    ).toBeFocused();
    await pick(selectedModel);
    let lostSaveId = '';
    let holdSavedReply = false;
    let delayedSuccessId = '';
    let releaseSuccess: (() => void) | undefined;
    await ui.route('**' + modelPath, async (route) => {
      if (route.request().method() === 'POST' && !lostSaveId) {
        lostSaveId = route.request().postDataJSON().commandId;
        const reply = await route.fetch();
        expect(reply.status()).toBe(200);
        return route.abort('failed');
      }
      if (route.request().method() === 'POST' && holdSavedReply) {
        holdSavedReply = false;
        const reply = await route.fetch();
        expect(reply.status()).toBe(200);
        delayedSuccessId = route.request().postDataJSON().commandId;
        await new Promise<void>((resolve) => {
          releaseSuccess = resolve;
        });
        return route.fulfill({ response: reply });
      }
      await route.continue();
    });
    await ui.getByRole('button', { name: '保存选择', exact: true }).click();
    await expect(
      ui.getByRole('button', { name: '按原键重试保存' }),
    ).toBeEnabled();
    await openSession(sessionId);
    await expect(draft).toHaveValue('Synthetic draft after a lost save');
    await expect(send).toBeDisabled();
    const ack = ui.waitForResponse(
      (r) => r.url().endsWith(modelPath) && r.request().method() === 'POST',
    );
    await ui.getByRole('button', { name: '按原键重试保存' }).click();
    expect((await ack).request().postDataJSON().commandId).toBe(lostSaveId);
    await expect(send).toBeEnabled();
    expect(received).toHaveLength(1);
    holdSavedReply = true;
    await pick(firstModel);
    await ui.getByRole('button', { name: '保存选择', exact: true }).click();
    try {
      await expect.poll(() => delayedSuccessId).not.toBe('');
      await pick(selectedModel);
      await ui.getByRole('button', { name: '明确改选并保存' }).click();
      await expect(send).toBeEnabled();
      const delayedSuccess = ui.waitForResponse(
        (r) =>
          r.url().endsWith(modelPath) &&
          r.request().method() === 'POST' &&
          r.request().postDataJSON().commandId === delayedSuccessId,
      );
      releaseSuccess!();
      expect((await delayedSuccess).status()).toBe(200);
      await expect(
        ui.getByText('已保存 ' + provider + ' / ' + selectedModel, {
          exact: false,
        }),
      ).toBeVisible();
      await expect(draft).toHaveValue('Synthetic draft after a lost save');
      expect(received).toHaveLength(1);
    } finally {
      releaseSuccess?.();
    }
    let nextFault:
      'accepted-lost' | 'not-arrived' | 'missing' | 'outage' | undefined;
    let catalogState: 'missing' | 'outage' | undefined;
    const posted: {
      requestId: string;
      content: unknown;
      clientTimeZone?: string;
    }[] = [];
    const originalFetch = NativeWebHost.prototype.fetch;
    NativeWebHost.prototype.fetch = async function (path, ...args) {
      const reply = await originalFetch.call(this, path, ...args);
      if (
        !catalogState ||
        path !== '/api/session/modelCatalog' ||
        this.projectId !== project
      )
        return reply;
      const envelope = await reply.json();
      const catalog = envelope.result.value;
      catalog.groups = catalog.groups.map(
        (g: { id: string; models: { id: string }[] }) =>
          g.id === provider
            ? { ...g, models: g.models.filter((m) => m.id !== selectedModel) }
            : g,
      );
      if (catalogState === 'outage')
        catalog.failures.push({
          id: provider,
          name: 'Fixture',
          message: 'Synthetic catalog outage',
        });
      return Response.json(envelope);
    };
    const promptRoute = rootApi + '/native/api/session/prompt';
    await ui.route('**' + promptRoute, async (route) => {
      const original = route.request().postDataJSON().payload.args.request;
      posted.push(original);
      const cause = nextFault;
      nextFault = undefined;
      if (cause === 'accepted-lost') {
        const reply = await route.fetch();
        expect(reply.status()).toBe(200);
        expect((await reply.json()).result.value.accepted).toBe(true);
        return route.abort('failed');
      }
      if (cause === 'not-arrived') return route.abort('failed');
      if (cause === 'missing' || cause === 'outage') catalogState = cause;
      await route.continue();
    });
    const rows = async (key: string) =>
      (
        await lab.owner.query(
          'select state from session_prompt_dispatch where native_session_id=$1 and request_id=$2',
          [sessionId, key],
        )
      ).rows;
    const check = ui.getByRole('button', { name: '核对原消息', exact: true });
    try {
      nextFault = 'accepted-lost';
      await draft.fill('Synthetic accepted message with lost response');
      await send.click();
      await expect(check).toBeEnabled();
      await expect.poll(() => received.length).toBe(2);
      await openSession(sessionId);
      await expect(draft).toHaveValue(
        'Synthetic accepted message with lost response',
      );
      await expect(send).toBeDisabled();
      await ui
        .locator('form.composer')
        .evaluate((el) => (el as HTMLFormElement).requestSubmit());
      await check.click();
      await expect(check).toHaveCount(0);
      expect(posted).toHaveLength(1);
      expect(await rows(posted[0]!.requestId)).toEqual([{ state: 'accepted' }]);
      expect(received).toHaveLength(2);
      nextFault = 'not-arrived';
      await draft.fill('Synthetic message originally not delivered');
      await send.click();
      await expect(check).toBeEnabled();
      await check.click();
      await expect(
        ui.getByText('原消息接纳状态尚待核对。', { exact: true }),
      ).toBeVisible();
      expect(posted).toHaveLength(2);
      expect(await rows(posted[1]!.requestId)).toEqual([]);
      expect(received).toHaveLength(2);
      await ui.getByRole('button', { name: '按原键继续提交原消息' }).click();
      await expect.poll(() => received.length).toBe(3);
      await expect(check).toHaveCount(0);
      expect(posted[2]).toEqual(posted[1]);
      expect(await rows(posted[1]!.requestId)).toEqual([{ state: 'accepted' }]);
      nextFault = 'missing';
      await draft.fill('Synthetic explicit reselect after healthy removal');
      const missingReply = ui.waitForResponse((r) =>
        r.url().endsWith(promptRoute),
      );
      await send.click();
      const refused = await missingReply;
      expect(refused.status()).toBe(409);
      expect(refused.headers()['x-rdws-unsent-prompt']).toBe(
        posted[3]!.requestId,
      );
      expect(await rows(posted[3]!.requestId)).toEqual([]);
      expect(
        (await journal(root, sessionId)).events.some(
          ({ type, data }) =>
            type === 'agent/inbox/spliced' &&
            data.inserted?.some(
              ({ source }: { source?: { rpcId?: string } }) =>
                source?.rpcId === posted[3]!.requestId,
            ),
        ),
      ).toBe(false);
      await expect(
        ui.getByText('已选模型当前不可用，请重新选择后发送。', { exact: true }),
      ).toBeVisible();
      await expect(send).toBeDisabled();
      await expect(draft).toHaveValue(
        'Synthetic explicit reselect after healthy removal',
      );
      await pick(firstModel);
      await ui.getByRole('button', { name: '保存选择', exact: true }).click();
      await expect(send).toBeEnabled();
      expect(received).toHaveLength(3);
      await send.click();
      await expect.poll(() => received.at(-1)?.model).toBe(firstModel);
      expect(received).toHaveLength(4);
      await expect(draft).toHaveValue('');
      catalogState = undefined;
      nextFault = 'outage';
      await draft.fill('Synthetic temporarily unavailable catalog');
      const outageReply = ui.waitForResponse((r) =>
        r.url().endsWith(promptRoute),
      );
      await send.click();
      const outage = await outageReply;
      expect(outage.status()).toBe(503);
      expect(outage.headers()['x-rdws-unsent-prompt']).toBeUndefined();
      await expect(check).toBeVisible();
      await expect(draft).toHaveValue(
        'Synthetic temporarily unavailable catalog',
      );
      expect(received).toHaveLength(4);
      expect(await rows(posted.at(-1)!.requestId)).toEqual([]);
      catalogState = undefined;
      await pick(firstModel);
      const sameValueSave = ui.waitForResponse(
        (r) => r.url().endsWith(modelPath) && r.request().method() === 'POST',
      );
      await ui.getByRole('button', { name: '保存选择', exact: true }).click();
      const parentSelection = (await (await sameValueSave).json()).selection;
      expect(parentSelection.model).toBe(firstModel);
      expect(
        await (
          await recovery.context.request.get(modelPath, {
            headers: recovery.headers,
          })
        ).json(),
      ).toEqual({ selection: parentSelection, firstWrite: null });
      const parentPosts = posted.length;
      const forkResponse = ui.waitForResponse(
        (r) => r.request().method() === 'POST' && r.url().endsWith('/fork'),
      );
      await ui
        .getByRole('button', { name: '派生当前会话', exact: true })
        .click();
      const forked = await forkResponse;
      expect(forked.status()).toBe(200);
      const childId = (await forked.json()).sessionId;
      await openSession(childId);
      await expect(
        ui
          .getByText('Synthetic explicit reselect after healthy removal', {
            exact: true,
          })
          .first(),
      ).toBeVisible();
      expect(posted).toHaveLength(parentPosts);
      expect(received).toHaveLength(4);
      await draft.fill('Synthetic first explicit child choice');
      await expect(send).toBeDisabled();
      await pick(firstModel);
      await ui.getByRole('button', { name: '保存选择', exact: true }).click();
      await expect(send).toBeEnabled();
      expect(received).toHaveLength(4);
      await send.click();
      await expect.poll(() => received.length).toBe(5);
      expect(received.at(-1)?.model).toBe(firstModel);
      expect(
        await ui.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(390);
    } finally {
      NativeWebHost.prototype.fetch = originalFetch;
    }
    expect(errors).toEqual([]);
  } finally {
    releaseDelayedSave?.();
    releaseReply();
    const browserCleanup = await Promise.allSettled(
      contexts.map((context) => context.close()),
    );
    const runtimeCleanup = await Promise.allSettled([
      Promise.resolve().then(() => frontend?.close()),
      Promise.resolve().then(() => app?.close()),
    ]);
    try {
      setDefaultCACertificates(trust);
      if (currentMode === undefined) delete process.env.RDWS_MODE;
      else process.env.RDWS_MODE = currentMode;
      if (currentEgress === undefined)
        delete process.env.RDWS_NATIVE_MODEL_EGRESS;
      else process.env.RDWS_NATIVE_MODEL_EGRESS = currentEgress;
      supplier?.closeAllConnections();
      if (supplier?.listening)
        await new Promise<void>((resolve) => supplier!.close(() => resolve()));
    } finally {
      if (runtimeCleanup.every(({ status }) => status === 'fulfilled'))
        await lab.close();
      else {
        console.warn(
          `Retaining unconfirmed model pilot fixture: ${basename(lab.root)}.`,
        );
        await Promise.allSettled([lab.owner.end(), lab.admin.end()]);
      }
    }
    const failed = [...browserCleanup, ...runtimeCleanup].find(
      ({ status }) => status === 'rejected',
    );
    if (failed?.status === 'rejected') cleanupFailure = failed;
  }
  if (cleanupFailure) throw cleanupFailure.reason;
});
