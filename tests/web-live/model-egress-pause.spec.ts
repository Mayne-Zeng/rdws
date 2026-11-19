import { test, expect } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { createServer as reserveServer } from 'node:net';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { zstdDecompressSync } from 'node:zlib';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { buildApp } from '@rdws/server';
import { runtimeHome } from '../../scripts/env.mjs';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

async function freePort() {
  const reserved = reserveServer().listen(0, '127.0.0.1');
  await once(reserved, 'listening');
  const { port } = reserved.address() as { port: number };
  await new Promise<void>((resolve, reject) =>
    reserved.close((error) => (error ? reject(error) : resolve())),
  );
  return port;
}

test('macOS pause confines the real Native Host and the same browser can resume', async ({
  page,
}) => {
  test.skip(
    process.platform !== 'darwin',
    'The enforced pause is currently macOS-only',
  );
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-model-pause-'),
  );
  const config = join(root, 'configuration');
  const profile = join(config, 'profiles', 'rdws');
  const project = 'pause-' + randomUUID();
  const id = randomUUID(),
    poc = randomUUID();
  const port = await freePort(),
    api = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const backend = `http://127.0.0.1:${api}`;
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const supplierCalls: string[] = [];
  const supplier = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    supplierCalls.push(Buffer.concat(chunks).toString());
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const choice of [
      {
        index: 0,
        delta: { role: 'assistant', content: 'Supplier answered' },
        finish_reason: null,
      },
      { index: 0, delta: {}, finish_reason: 'stop' },
    ])
      response.write(
        `data: ${JSON.stringify({ id: randomUUID(), model: 'fixture-llm', object: 'chat.completion.chunk', created: 1, choices: [choice] })}\n\n`,
      );
    response.end('data: [DONE]\n\n');
  });
  supplier.listen(0, '127.0.0.1');
  await once(supplier, 'listening');
  const supplierPort = (supplier.address() as { port: number }).port;
  const modeKey = 'RDWS_NATIVE_MODEL_EGRESS';
  const oldMode = process.env[modeKey];
  const proxyKeys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  const oldProxies = new Map(
    proxyKeys.map((name) => [name, process.env[name]]),
  );
  const applications = new Set<ReturnType<typeof buildApp>>();
  let frontend: { close: () => Promise<void> } | undefined;
  let isolatedDatabase = false;
  const commands: string[] = [];
  const originalSend = WebSocket.prototype.send;
  const nativeFrames: string[] = [];
  const readiness = (key = project) =>
    join(root, 'runtime', 'instances', `project-${key}.ready.json`);

  async function boot(mode: 'direct' | 'paused', listening = true) {
    process.env[modeKey] = mode;
    const app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin,
      nativeRuntimeRoot: root,
      repositoryHome: join(root, 'unconfigured-repositories'),
      nativeProfiles: new Map([
        [project, config],
        ['poc', config],
      ]),
    });
    applications.add(app);
    if (listening) await app.listen({ host: '127.0.0.1', port: api });
    else await app.ready();
    return app;
  }
  async function stop(app: ReturnType<typeof buildApp>) {
    await app.close();
    applications.delete(app);
  }
  async function probe(key = project) {
    const ready = JSON.parse(await readFile(readiness(key), 'utf8'));
    const owner = JSON.parse(
      await readFile(readiness(key).replace('.ready.json', '.lock'), 'utf8'),
    );
    expect(owner.childPid).toBe(ready.pid);
    const response = await fetch(
      `http://127.0.0.1:${ready.port}/__fixture_model_egress`,
      { signal: AbortSignal.timeout(6500) },
    );
    expect(response.status).toBe(200);
    const observation = await response.json();
    expect(observation).toMatchObject({ pid: ready.pid, port: ready.port });
    return { ready, observation };
  }

  try {
    expect(
      (await pool.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolatedDatabase = true;
    const application = new Pool({
      connectionString: process.env.DATABASE_URL,
    });
    try {
      expect(
        (
          await application.query(
            'select current_database() db, session_user role',
          )
        ).rows[0],
      ).toEqual({ db: 'rdws_test', role: 'rdws_test_app' });
    } finally {
      await application.end();
    }
    for (const key of proxyKeys) delete process.env[key];
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: 'model-pause-fixture' },
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
                baseURL: `http://127.0.0.1:${supplierPort}/v1`,
                models: [{ id: 'fixture-llm' }],
                retryPolicy: { mode: 'normal', maxRetries: 0 },
              },
            },
          },
        },
        { id: 'session-title-llm', disabled: true },
        {
          insert: [
            {
              id: 'test-native-egress-probe',
              name: fileURLToPath(
                new URL(
                  '../fixtures/native-egress-paused.mjs',
                  import.meta.url,
                ),
              ),
              config: { port: supplierPort },
            },
          ],
        },
      ]),
      { mode: 0o600 },
    );

    const direct = await boot('direct');
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    ) as { username: string; password: string }[];
    async function login(username: string, remoteAddress: string) {
      const response = await direct.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        remoteAddress,
        payload: accounts.find((account) => account.username === username),
      });
      expect(response.statusCode).toBe(200);
      const cookies = response.cookies.map(({ name, value }) => ({
        name,
        value,
        url: origin,
      }));
      return {
        cookies,
        cookie: cookies.map(({ name, value }) => `${name}=${value}`).join('; '),
        user: response.json().user.id as string,
      };
    }
    const manager = await login('manager', '192.0.2.32');
    const reader = await login('lead', '192.0.2.33');
    const expired = await login('manager', '192.0.2.34');
    await pool.query('insert into project(id,name) values($1,$1)', [project]);
    await pool.query(
      "insert into project_member(project_id,user_id,role) values($1,$2,'requirement_manager'),($1,$3,'developer')",
      [project, manager.user, reader.user],
    );
    await pool.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Model pause fixture','','',$3,$3),($4,'poc','Default model pause fixture','','',$3,$3)",
      [id, project, manager.user, poc],
    );
    await pool.query(
      "insert into requirement_participant values($1,$2,'requirement_manager'),($1,$3,'developer'),($4,$2,'requirement_manager')",
      [id, manager.user, reader.user, poc],
    );

    const resolver = createRequire(
      new URL('../../apps/console/package.json', import.meta.url),
    );
    const { createServer: createVite } = await import(resolver.resolve('vite'));
    const consoleRoot = fileURLToPath(
      new URL('../../apps/console', import.meta.url),
    );
    const vite = await createVite({
      root: consoleRoot,
      configFile: join(consoleRoot, 'vite.config.ts'),
      logLevel: 'silent',
      server: {
        host: '127.0.0.1',
        port,
        strictPort: true,
        proxy: { '/api': { target: backend, ws: true } },
      },
    });
    frontend = vite;
    await vite.listen();
    await page.context().addCookies(manager.cookies);
    const nativePath = `/api/dsh/${id}/native/api/session`;
    const submissions: {
      requestId: string;
      sessionId: string;
      content: unknown;
      mode: string;
    }[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === nativePath + '/prompt')
        submissions.push(request.postDataJSON().payload.args.request);
    });
    await page.goto(
      `${origin}/?project=${project}&requirement=${id}&view=chat`,
    );
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    const input = page.getByLabel('消息', { exact: true });
    const send = page.getByRole('button', { name: '发送消息', exact: true });
    const banner = page.getByText(
      '模型发送已暂停。输入会保留，可在恢复后再次发送。',
      { exact: true },
    );
    await input.fill('Previously accepted fixture');
    await send.click();
    await expect(page.getByTestId('transcript')).toContainText(
      'Supplier answered',
    );
    await expect(input).toHaveValue('');
    await expect.poll(() => supplierCalls.length).toBe(1);
    const first = submissions[0]!;
    const directProbe = await probe();
    expect(directProbe.observation).toMatchObject({
      tcp: 'connected',
      finish: 'stop',
    });
    expect(supplierCalls).toHaveLength(2);

    const held = await boot('paused', false);
    const refused = await held.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: {
        cookie: manager.cookie,
        'x-rdws-edit-session': await observedLogin(held, manager.cookie),
      },
    });
    expect(refused.statusCode).toBe(500);
    expect(JSON.parse(await readFile(readiness(), 'utf8'))).toEqual(
      directProbe.ready,
    );
    await stop(held);
    await stop(direct);
    expect(() => process.kill(directProbe.ready.pid, 0)).toThrow(
      expect.objectContaining({ code: 'ESRCH' }),
    );
    const journals = join(
      root,
      'runtime',
      'dsh',
      'project-' + project,
      'sessions',
    );
    const entry = (await readdir(journals, { recursive: true })).find(
      (value) =>
        value.includes(first.sessionId + '/') &&
        /^session(?:\.v[1-9]\d*)?\.jsonl\.zstd$/.test(value.split('/').at(-1)!),
    );
    expect(entry).toBeDefined();
    const journal = join(journals, entry!);
    const beforePause = await readFile(journal);

    const paused = await boot('paused');
    process.env[modeKey] = 'direct';
    process.env.HTTP_PROXY = 'http://127.0.0.1:1';
    const pauseBinding = await bootstrapNative(paused, manager.cookie, id);
    await bootstrapNative(paused, manager.cookie, poc);
    const pausedProbe = await probe();
    expect(pausedProbe.ready.generation).not.toBe(directProbe.ready.generation);
    for (const result of [pausedProbe, await probe('poc')]) {
      expect(result.observation.tcp).toMatch(/^(EPERM|EACCES)$/);
      expect(result.observation).toMatchObject({
        finish: 'error',
        failure: expect.stringMatching(/EPERM|EACCES/),
        inheritedProxy: false,
      });
    }
    const bootState = await paused.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: {
        cookie: manager.cookie,
        'x-rdws-edit-session': await observedLogin(paused, manager.cookie),
      },
    });
    expect(bootState.json().modelEgressPaused).toBe(true);
    const history = await paused.inject({
      url: `/api/requirements/${id}/sessions/${first.sessionId}/history`,
      headers: { cookie: manager.cookie },
    });
    expect(history.statusCode).toBe(200);
    expect(history.body).toContain('Supplier answered');

    function call(
      app: typeof paused,
      binding: string,
      data: object,
      opts: { rpcId?: unknown; cookie?: string; action?: string } = {},
    ) {
      const action = opts.action ?? 'prompt';
      return app.inject({
        method: 'POST',
        url: `${nativePath}/${action}`,
        headers: {
          origin,
          cookie: opts.cookie ?? manager.cookie,
          'x-rdws-native-login': binding,
          'x-rdws-client-generation': randomUUID(),
        },
        payload: {
          type: 'client-request',
          rpcId: Object.hasOwn(opts, 'rpcId') ? opts.rpcId : randomUUID(),
          method: `session/${action}`,
          payload: { args: { request: data } },
        },
      });
    }
    const newKey = { ...first, requestId: randomUUID(), mode: 'steer' };
    for (const request of [first, newKey]) {
      const response = await call(paused, pauseBinding, request);
      expect(response.statusCode).toBe(503);
      expect(response.headers['x-rdws-model-egress']).toBe('paused');
      expect(response.headers['cache-control']).toBe('no-store');
    }
    const readerBinding = await bootstrapNative(paused, reader.cookie, id);
    const expiredBinding = await bootstrapNative(paused, expired.cookie, id);
    const expiredSession = await observedLogin(paused, expired.cookie);
    await pool.query(
      'update auth_session set expires_at=now() where id=$1 and user_id=$2',
      [expiredSession, manager.user],
    );
    for (const invalid of [
      await call(paused, pauseBinding, { ...first, requestId: '' }),
      await call(paused, pauseBinding, {
        ...first,
        requestId: 'x'.repeat(129),
      }),
      await call(paused, pauseBinding, first, { rpcId: 7 }),
      await call(paused, pauseBinding, first, { rpcId: undefined }),
      await call(paused, '0'.repeat(64), first),
      await call(paused, readerBinding, first, { cookie: reader.cookie }),
      await call(paused, expiredBinding, first, { cookie: expired.cookie }),
    ]) {
      expect([401, 403]).toContain(invalid.statusCode);
      expect(invalid.headers['x-rdws-model-egress']).toBeUndefined();
    }
    expect(
      (
        await call(
          paused,
          pauseBinding,
          { sessionId: first.sessionId },
          { action: 'cancel' },
        )
      ).statusCode,
    ).toBe(200);
    const writeId = randomUUID();
    commands.push(writeId);
    const wrote = await paused.inject({
      method: 'POST',
      url: `/api/requirements/${id}/details`,
      headers: {
        origin,
        cookie: manager.cookie,
        'x-rdws-edit-session': await observedLogin(paused, manager.cookie),
      },
      payload: {
        commandId: writeId,
        patch: { acceptance: 'Maintenance business write' },
      },
    });
    expect(wrote.statusCode, wrote.body).toBe(200);
    const detail = await paused.inject({
      url: `/api/requirements/${id}`,
      headers: { cookie: manager.cookie },
    });
    expect(detail.statusCode).toBe(200);
    expect(detail.json().requirement.acceptance).toBe(
      'Maintenance business write',
    );

    WebSocket.prototype.send = function (this: WebSocket, ...args: unknown[]) {
      if (
        this.url?.endsWith('/_rdws/remote.mux') &&
        typeof args[0] === 'string'
      )
        nativeFrames.push(JSON.parse(args[0]).endpoint);
      Reflect.apply(originalSend, this, args);
    };
    const ws = new WebSocket(
      `${backend.replace('http:', 'ws:')}/api/dsh/${id}/native/api/remote.mux?login=${pauseBinding}&generation=${randomUUID()}`,
      { headers: { origin, cookie: manager.cookie }, agent: false },
    );
    const streamId = randomUUID();
    const frames: Record<string, unknown>[] = [];
    ws.on('message', (message) => frames.push(JSON.parse(String(message))));
    let closeCode: number | undefined;
    ws.once('close', (code) => {
      closeCode = code;
    });
    try {
      await once(ws, 'open');
      ws.send(
        JSON.stringify({
          type: 'open',
          streamId,
          endpoint: 'session/follow',
          payload: {
            args: {
              request: {
                address: { kind: 'session', sessionId: first.sessionId },
                activate: true,
              },
            },
          },
        }),
      );
      await expect
        .poll(() =>
          JSON.stringify({
            hasSnapshot: frames.some(
              (frame) =>
                frame.type === 'item' &&
                frame.streamId === streamId &&
                (frame.value as { type?: string })?.type === 'snapshot',
            ),
            closeCode,
            receivedTypes: frames.map(({ type, error }) => ({ type, error })),
            forwarded: nativeFrames,
          }),
        )
        .toContain('"hasSnapshot":true');
      const closed = once(ws, 'close');
      ws.send(
        JSON.stringify({
          type: 'open',
          streamId: randomUUID(),
          endpoint: 'session/prompt',
          payload: { args: { request: newKey } },
        }),
      );
      expect((await closed)[0]).toBe(4001);
      expect(nativeFrames).toContain('session/follow');
      expect(nativeFrames).not.toContain('session/prompt');
    } finally {
      ws.terminate();
    }

    const draft = 'Draft from the same browser tab';
    await expect(banner).toHaveCount(0);
    await input.fill(draft);
    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === nativePath + '/prompt' &&
        response.status() === 503,
    );
    await send.click();
    expect((await rejected).headers()['x-rdws-model-egress']).toBe('paused');
    await expect(banner).toBeVisible();
    await expect(input).toHaveValue(draft);
    expect(supplierCalls).toHaveLength(2);
    expect(submissions).toHaveLength(2);
    await stop(paused);
    const afterPause = await readFile(journal);
    expect(afterPause.subarray(0, beforePause.length).equals(beforePause)).toBe(
      true,
    );
    const events: string[] = [];
    for (let consumed = 0; consumed < afterPause.length;) {
      const chunk = zstdDecompressSync(afterPause.subarray(consumed), {
        info: true,
      }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      expect(chunk.engine.bytesWritten).toBeGreaterThan(0);
      consumed += chunk.engine.bytesWritten;
      events.push(chunk.buffer.toString());
    }
    const pausedJournal = events.join('');
    expect(pausedJournal).not.toContain(newKey.requestId);
    expect(pausedJournal).not.toContain(submissions[1]!.requestId);
    expect(supplierCalls).toHaveLength(2);
    delete process.env.HTTP_PROXY;

    const resumed = await boot('direct');
    const resumedBinding = await bootstrapNative(resumed, manager.cookie, id);
    expect(
      (await call(resumed, resumedBinding, first)).json().result,
    ).toMatchObject({ ok: true, value: { accepted: true } });
    expect(supplierCalls).toHaveLength(2);
    expect(
      (await call(resumed, resumedBinding, newKey)).json().result,
    ).toMatchObject({ ok: true, value: { accepted: true } });
    await expect.poll(() => supplierCalls.length).toBe(3);
    await expect(input).toHaveValue(draft);
    expect(submissions).toHaveLength(2);
    await expect(send).toBeEnabled();
    await send.click();
    await expect(input).toHaveValue('');
    await expect(banner).toHaveCount(0);
    await expect.poll(() => supplierCalls.length).toBe(4);
    expect(supplierCalls.filter((body) => body.includes(draft))).toHaveLength(
      1,
    );
    expect(submissions).toHaveLength(3);
    expect(submissions[2]?.content).toEqual(submissions[1]?.content);
  } finally {
    WebSocket.prototype.send = originalSend;
    if (oldMode === undefined) delete process.env[modeKey];
    else process.env[modeKey] = oldMode;
    for (const [name, value] of oldProxies) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    try {
      const stopped = await Promise.allSettled([
        frontend?.close(),
        ...[...applications].map(stop),
      ]);
      if (isolatedDatabase) {
        for (const table of [
          'session_operation',
          'native_session',
          'requirement_event',
          'task',
          'requirement_participant',
        ])
          await pool.query(
            `delete from ${table} where requirement_id=any($1)`,
            [[id, poc]],
          );
        await pool.query(
          'delete from command_receipt where command_id=any($1)',
          [commands],
        );
        await pool.query('delete from requirement where id=any($1)', [
          [id, poc],
        ]);
        await pool.query('delete from project_member where project_id=$1', [
          project,
        ]);
        await pool.query('delete from project where id=$1', [project]);
      }
      expect(stopped.every((result) => result.status === 'fulfilled')).toBe(
        true,
      );
    } finally {
      await Promise.all([
        pool.end(),
        new Promise<void>((resolve) => {
          supplier.close(() => resolve());
          supplier.closeAllConnections();
        }),
      ]);
      await rm(root, { recursive: true, force: true });
    }
  }
});
