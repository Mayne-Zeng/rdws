import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { createServer } from 'node:http';
import * as http from 'node:http';
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
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildApp } from '@rdws/server';
import { bootstrapNative } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { expect, test, vi } from 'vitest';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
import { DemandPresets } from '../../dsh/host/presets.ts';

loadEnvironment('test');

test('preset publication reconciles concurrent copies and rejects an abnormal destination promptly', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-preset-file-'),
  );
  const store = new DemandPresets(root, 'preset-fixture', []);
  const choice = { templateId: randomUUID(), revision: 1, capabilities: [] };
  try {
    const good = store.definition(randomUUID(), choice);
    await Promise.all([store.publish(good), store.publish(good)]);
    expect(await store.read(good.id, good.requirementId)).toEqual(good);

    const bad = store.definition(randomUUID(), choice);
    const path = join(
      root,
      'runtime',
      'presets',
      'project-preset-fixture',
      bad.id + '.json',
    );
    execFileSync('mkfifo', [path]);
    await expect(store.publish(bad)).rejects.toThrow(
      'Invalid path for preset synchronization',
    );
    expect(await store.read(good.id, good.requirementId)).toEqual(good);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 3000);

test('released capability versions stay scoped through binding changes, replay and Native restart', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-preset-session-'),
  );
  const db = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const project = 'preset-' + randomUUID();
  const demand = randomUUID(),
    template = randomUUID(),
    neighbor = randomUUID();
  const config = join(root, 'config', 'projects', project, 'dsh');
  const profile = join(config, 'profiles', 'rdws');
  const origin = process.env.RDWS_ORIGIN!;
  const calls: string[] = [];
  const contextMarker = 'Native proxy isolation context ' + randomUUID();
  const proxyHits = { request: 0, connect: 0, upgrade: 0 };
  let positiveProxyHits: typeof proxyHits | undefined;
  let restoreProxy: (() => void) | undefined;
  const proxy = createServer((_request, response) => {
    proxyHits.request++;
    response.writeHead(502).end();
  });
  proxy.on('connect', (_request, socket) => {
    proxyHits.connect++;
    socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
  });
  proxy.on('upgrade', (_request, socket) => {
    proxyHits.upgrade++;
    socket.destroy();
  });
  const provider = createServer(async (request, reply) => {
    if (request.url !== '/v1/chat/completions') {
      reply.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(Buffer.concat(chunks).toString());
    reply.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: 'Preset verification reply' }, null],
      [{}, 'stop'],
    ]) {
      reply.write(
        'data: ' +
          JSON.stringify({
            id: 'preset-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'preset-fixture',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    }
    reply.end('data: [DONE]\n\n');
  });
  const requestFile = join(root, 'probe-request.json');
  const responseFile = join(root, 'probe-response.json');
  const release = await Promise.all(
    (['plugin', 'skill', 'mcp'] as const).map(async (kind) => {
      const modulePath = fileURLToPath(
        new URL(
          '../fixtures/rdws-capability-' + kind + '.mjs',
          import.meta.url,
        ),
      );
      return {
        kind,
        reference: 'fixture/' + kind + '-' + project,
        revision: '1',
        modulePath,
        sha256: createHash('sha256')
          .update(await readFile(modulePath))
          .digest('hex'),
      };
    }),
  );
  const references = release.map(({ kind, reference, revision }) => ({
    kind,
    reference,
    revision,
  }));
  const moduleNames = release.map(({ modulePath, sha256 }) => {
    const url = pathToFileURL(modulePath);
    url.searchParams.set('rdws-release', sha256);
    return url.href;
  });
  const missing = {
    kind: 'plugin',
    reference: 'fixture/missing-' + project,
    revision: '1',
  };
  const mismatched = {
    kind: 'plugin' as const,
    reference: 'fixture/wrong-bytes-' + project,
    revision: '1',
  };
  const unavailableBytes = {
    ...mismatched,
    modulePath: release[0]!.modulePath,
    sha256: '0'.repeat(64),
  };
  const dependent = {
    kind: 'plugin' as const,
    reference: 'fixture/dependent-' + project,
    revision: '1',
  };
  const dependentModule = fileURLToPath(
    new URL('../fixtures/rdws-capability-dependent.mjs', import.meta.url),
  );
  const unsealed = {
    ...dependent,
    modulePath: dependentModule,
    sha256: createHash('sha256')
      .update(await readFile(dependentModule))
      .digest('hex'),
  };
  let preparationGate: (() => Promise<void>) | undefined;
  class FixtureHost extends NativeWebHost {
    override async preparePreset(
      ...args: Parameters<NativeWebHost['preparePreset']>
    ) {
      await preparationGate?.();
      return super.preparePreset(...args);
    }
  }
  let native: NativeWebHost;
  let app: ReturnType<typeof buildApp> | undefined;
  let cookie: string;
  let testDatabase = false;
  const create = (commandId = randomUUID(), requirementId = demand) =>
    app!.inject({
      method: 'POST',
      url: '/api/requirements/' + requirementId + '/sessions',
      headers: { origin, cookie },
      payload: { commandId },
    });
  async function inspect(sessionId: string, requirementId = demand) {
    return native.control('session.preset', { requirementId, sessionId });
  }
  async function probe(
    sessions: string[],
    select?: { sessionId: string; agentPreset: string },
  ) {
    const id = randomUUID();
    await writeFile(requestFile, JSON.stringify({ id, sessions, select }));
    return vi.waitFor(
      async () => {
        const report = JSON.parse(await readFile(responseFile, 'utf8'));
        expect(report.id).toBe(id);
        return report;
      },
      { timeout: 4500, interval: 60 },
    );
  }
  async function boot() {
    await app?.close();
    native = new FixtureHost(root, config, project, [
      ...release,
      unavailableBytes,
      unsealed,
    ]);
    app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin,
      nativeHost: native,
    });
    await app.listen({ host: '127.0.0.1', port: 0 });
  }
  try {
    const identity = await db.query(
      'select current_database() as name, current_user as role',
    );
    expect(identity.rows[0]).toEqual({
      name: 'rdws_test',
      role: 'rdws_test_migrator',
    });
    testDatabase = true;
    provider.listen(0, '127.0.0.1');
    await once(provider, 'listening');
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    ) as { username: string; password: string }[];
    const manager = accounts.find((row) => row.username === 'manager')!;
    const actor = (
      await db.query("select id from auth_user where username='manager'")
    ).rows[0].id;
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                baseURL:
                  'http://127.0.0.1:' +
                  (provider.address() as { port: number }).port +
                  '/v1',
                apiKeyEnv: 'PRESET_FIXTURE_MODEL',
                models: [{ id: 'preset-fixture' }],
              },
            },
          },
        },
        { id: 'session-title-llm', disabled: true },
        {
          insert: [
            {
              id: 'rdws-capability-observer',
              name: fileURLToPath(
                new URL(
                  '../fixtures/rdws-capability-observer.mjs',
                  import.meta.url,
                ),
              ),
              config: { request: requestFile, response: responseFile },
            },
          ],
        },
      ]),
    );
    await writeFile(
      join(config, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { PRESET_FIXTURE_MODEL: 'synthetic-value' },
      }),
      { mode: 0o600 },
    );
    await db.query('insert into project(id,name) values($1,$2)', [
      project,
      'Preset fixture',
    ]);
    await db.query(
      "insert into project_member(project_id,user_id,role) values($1,$2,'project_admin')",
      [project, actor],
    );
    await db.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Preset',$5,'test',$3,$3),($4,$2,'Neighbor','test','test',$3,$3)",
      [demand, project, actor, neighbor, contextMarker],
    );
    for (const entry of [...references, missing, mismatched, dependent])
      await db.query(
        'insert into capability_approval(kind,reference,revision,approved) values($1,$2,$3,true)',
        [entry.kind, entry.reference, entry.revision],
      );
    await db.query(
      "insert into capability_template_revision(template_id,revision,project_id,name,description,capabilities) values($1,1,$2,'First','',$3),($1,2,$2,'Next','',$4),($1,3,$2,'Missing','',$5),($1,4,$2,'Wrong bytes','',$6),($1,5,$2,'Unsealed','',$7)",
      [
        template,
        project,
        JSON.stringify(references),
        JSON.stringify([references[0]]),
        JSON.stringify([missing]),
        JSON.stringify([mismatched]),
        JSON.stringify([dependent]),
      ],
    );
    await db.query(
      'insert into requirement_capability_binding(requirement_id,project_id,template_id,revision) values($1,$2,$3,1)',
      [demand, project, template],
    );
    if (typeof http.setGlobalProxyFromEnv === 'function') {
      proxy.listen(0, '127.0.0.1');
      await once(proxy, 'listening');
      restoreProxy = http.setGlobalProxyFromEnv({
        HTTP_PROXY: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`,
        NO_PROXY: '',
      });
      const port = (provider.address() as { port: number }).port;
      const control = `http://127.0.0.1:${port}/proxy-positive-control`;
      const response = await fetch(control, {
        signal: AbortSignal.timeout(2000),
      }).catch(() => undefined);
      await response?.body?.cancel();
      expect(proxyHits.connect).toBeGreaterThan(0);
      const httpStatus = await new Promise<number | undefined>(
        (resolve, reject) => {
          http
            .get(control, { signal: AbortSignal.timeout(2000) }, (incoming) => {
              incoming.resume();
              incoming.once('end', () => resolve(incoming.statusCode));
              incoming.once('error', reject);
            })
            .once('error', reject);
        },
      );
      expect(httpStatus).toBe(502);
      expect(proxyHits.request).toBeGreaterThan(0);
      positiveProxyHits = { ...proxyHits };
    }
    await boot();
    const login = await app!.inject({
      method: 'POST',
      headers: { origin },
      payload: manager,
      url: '/api/auth/sign-in/username',
    });
    expect(login.statusCode).toBe(200);
    cookie = login.cookies
      .map(({ name, value }) => name + '=' + value)
      .join('; ');
    const loginState = await app!.inject({
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    expect(loginState.statusCode).toBe(200);
    const authSessionId = loginState.json().session.id as string;
    const bind = async (revision: number) => {
      const response = await app!.inject({
        method: 'POST',
        payload: { commandId: randomUUID(), templateId: template, revision },
        url: '/api/requirements/' + demand + '/capability-template',
        headers: { origin, cookie, 'x-rdws-edit-session': authSessionId },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'saved' });
    };
    const command = randomUUID();
    const first = await create(command);
    expect(first.statusCode).toBe(200);
    const session1 = first.json().sessionId as string;
    const original = await inspect(session1);
    expect(original.agentPreset).toMatch(/^rdws-demand-v1-[0-9a-f]{64}$/);
    const sameBoundRelease = await create();
    expect(sameBoundRelease.statusCode).toBe(200);
    expect((await inspect(sameBoundRelease.json().sessionId)).agentPreset).toBe(
      original.agentPreset,
    );

    const near = await create(randomUUID(), neighbor);
    expect(near.statusCode).toBe(200);
    const nearSession = near.json().sessionId as string;
    const nearIdentity = await inspect(nearSession, neighbor);
    expect(nearIdentity.agentPreset).not.toMatch(/^rdws-demand-v1-/);
    await bind(2);
    expect((await create(command)).json()).toMatchObject({
      status: 'mapped',
      sessionId: session1,
    });
    const next = await create();
    expect(next.statusCode).toBe(200);
    const session2 = next.json().sessionId as string;
    const replacement = await inspect(session2);
    expect(replacement.agentPreset).toMatch(/^rdws-demand-v1-[0-9a-f]{64}$/);
    expect(replacement.agentPreset).not.toBe(original.agentPreset);
    expect(await inspect(session1)).toEqual(original);
    const observed = await probe([session1, session2, nearSession]);
    expect(observed.values[0]).toMatchObject({
      sessionId: session1,
      names: expect.arrayContaining(moduleNames),
      skills: expect.arrayContaining(['rdws-review-example']),
      offlineMcp: {
        name: 'rdws-offline-mcp-fixture',
        protocol: 'mcp',
        transport: null,
      },
      tools: [],
      flushed: true,
    });
    expect(observed.values[1]).toMatchObject({
      sessionId: session2,
      names: [moduleNames[0]],
      tools: [],
      flushed: true,
    });
    for (const value of observed.values.slice(1)) {
      expect(value.skills).not.toContain('rdws-review-example');
      expect(value.offlineMcp).toBeNull();
    }

    const mismatchedScope = await native!.fetch(
      '/api/session/create',
      {
        purpose: 'create',
        userId: actor,
        authSessionId,
        requirementId: neighbor,
        cwd: String(nearIdentity.cwd),
        workspaceId: String(nearIdentity.workspaceId),
        agentPreset: String(original.agentPreset),
      },
      {
        method: 'POST',
        body: JSON.stringify({
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session/create',
          payload: {
            args: {
              request: {
                workspaceId: nearIdentity.workspaceId,
                agentPreset: original.agentPreset,
              },
            },
          },
        }),
      },
    );
    expect(mismatchedScope.status).toBe(403);

    const binding = await bootstrapNative(app!, cookie, demand);
    function sendPrompt(sessionId: string) {
      return app!.inject({
        method: 'POST',
        url: '/api/dsh/' + demand + '/native/api/session/prompt',
        headers: {
          origin,
          cookie,
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
                sessionId,
                requestId: randomUUID(),
                mode: 'queue',
                content: [{ type: 'text', text: 'Verify the bounded preset' }],
              },
            },
          },
        },
      });
    }
    async function closeTurn(sessionId: string) {
      const before = calls.length;
      const prompt = await sendPrompt(sessionId);
      expect(prompt.json().result).toMatchObject({
        ok: true,
        value: { accepted: true },
      });
      await vi.waitFor(
        async () => {
          const history = await app!.inject({
            url:
              '/api/requirements/' +
              demand +
              '/sessions/' +
              sessionId +
              '/history',
            headers: { cookie },
          });
          expect(history.json().events).toEqual(
            expect.arrayContaining([
              expect.objectContaining({ text: 'Preset verification reply' }),
              expect.objectContaining({ type: 'turn/end' }),
            ]),
          );
          expect(calls.length).toBeGreaterThan(before);
        },
        { timeout: 6500, interval: 100 },
      );
    }
    function fork(source: string, commandId = randomUUID()) {
      return app!.inject({
        method: 'POST',
        url: '/api/requirements/' + demand + '/sessions/' + source + '/fork',
        headers: { origin, cookie },
        payload: { commandId },
      });
    }
    async function follow(sessionId: string) {
      const { port } = app!.server.address() as { port: number };
      const client = new WebSocket(
        'ws://127.0.0.1:' +
          port +
          '/api/dsh/' +
          demand +
          `/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
        { headers: { origin, cookie }, agent: false },
      );
      const streamId = randomUUID();
      let item: unknown;
      client.on('message', (bytes) => {
        const frame = JSON.parse(String(bytes));
        if (
          frame.streamId === streamId &&
          frame.type === 'item' &&
          frame.value?.type === 'snapshot'
        )
          item = frame.value;
      });
      try {
        await once(client, 'open');
        client.send(
          JSON.stringify({
            type: 'open',
            streamId,
            endpoint: 'session/follow',
            payload: {
              args: {
                request: {
                  address: { kind: 'session', sessionId },
                  activate: true,
                },
              },
            },
          }),
        );
        await vi.waitFor(
          () => expect(item).toMatchObject({ type: 'snapshot' }),
          { timeout: 4500 },
        );
      } finally {
        client.close();
      }
    }
    await closeTurn(session1);
    const locked = await probe([session1], {
      sessionId: session1,
      agentPreset: String(replacement.agentPreset),
    });
    expect(locked.values[0].selectionError).toBe('agent-preset/locked');
    const child = await fork(session1);
    expect(child.statusCode).toBe(200);
    expect((await inspect(child.json().sessionId)).agentPreset).toBe(
      original.agentPreset,
    );

    await bind(1);
    const selectedSource = sameBoundRelease.json().sessionId as string;
    const selected = await probe([selectedSource], {
      sessionId: selectedSource,
      agentPreset: String(replacement.agentPreset),
    });
    expect(selected.values[0].headerPreset).toBe(original.agentPreset);
    expect((await inspect(selectedSource)).agentPreset).toBe(
      replacement.agentPreset,
    );
    await closeTurn(selectedSource);
    const selectedChild = await fork(selectedSource);
    expect(selectedChild.statusCode).toBe(200);
    expect((await inspect(selectedChild.json().sessionId)).agentPreset).toBe(
      replacement.agentPreset,
    );
    expect(calls.length).toBe(2);
    for (const call of calls) {
      expect(call).toContain(contextMarker);
      const { tools } = JSON.parse(call);
      expect(tools ?? []).toEqual([]);
    }
    let entered!: () => void, unblock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      unblock = resolve;
    });
    preparationGate = async () => {
      entered();
      await gate;
      throw new Error('Fixture stopped while preparing first release');
    };
    const raceKey = randomUUID(),
      stale = create(raceKey);
    await blocked;
    try {
      await bind(2);
    } finally {
      preparationGate = undefined;
      unblock();
    }
    expect((await stale).json()).toMatchObject({
      commandId: raceKey,
      status: 'reserved',
    });
    const continued = await create(raceKey);
    expect(continued.statusCode).toBe(200);
    expect((await inspect(continued.json().sessionId)).agentPreset).toBe(
      replacement.agentPreset,
    );
    const shortLogin = await app!.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: '192.0.2.43',
      headers: { origin },
      payload: manager,
    });
    expect(shortLogin.statusCode).toBe(200);
    const shortCookie = shortLogin.cookies
      .map(({ name, value }) => name + '=' + value)
      .join('; ');
    const shortSession = await app!.inject({
      url: '/api/auth/get-session',
      headers: { cookie: shortCookie },
    });
    let waitingForExpiry!: () => void, continueAfterExpiry!: () => void;
    const beforeExpiry = new Promise<void>((resolve) => {
      waitingForExpiry = resolve;
    });
    const afterExpiry = new Promise<void>((resolve) => {
      continueAfterExpiry = resolve;
    });
    preparationGate = async () => {
      waitingForExpiry();
      await afterExpiry;
    };
    const expiredKey = randomUUID();
    const expired = app!.inject({
      method: 'POST',
      url: '/api/requirements/' + demand + '/sessions',
      headers: { origin, cookie: shortCookie },
      payload: { commandId: expiredKey },
    });
    await beforeExpiry;
    try {
      await db.query(
        "update auth_session set expires_at=now()-interval '1 second' where id=$1",
        [shortSession.json().session.id],
      );
    } finally {
      preparationGate = undefined;
      continueAfterExpiry();
    }
    expect((await expired).statusCode).toBe(401);
    const untouched = await db.query(
      'select status, native_session_id from session_operation where command_id=$1',
      [expiredKey],
    );
    expect(untouched.rows).toEqual([
      { status: 'reserved', native_session_id: null },
    ]);

    await bind(3);
    const missingKey = randomUUID();
    const unavailable = await create(missingKey);
    expect(unavailable.statusCode).toBe(409);
    expect(unavailable.json()).toMatchObject({
      commandId: missingKey,
      status: 'rejected',
      error: expect.stringContaining('未能装载'),
    });
    expect((await create(missingKey)).json()).toEqual(unavailable.json());
    await bind(4);
    expect((await create()).json()).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('未能装载'),
    });
    await bind(5);
    expect((await create()).json()).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('未能装载'),
    });
    await bind(1);
    let waiting!: () => void, continuePrepare!: () => void;
    const enteredBeforeStop = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const finishAfterStop = new Promise<void>((resolve) => {
      continuePrepare = resolve;
    });
    preparationGate = async () => {
      waiting();
      await finishAfterStop;
    };
    const stoppingApproval = create();
    await enteredBeforeStop;
    try {
      await db.query(
        'update capability_approval set approved=false where reference=$1',
        [references[2]!.reference],
      );
    } finally {
      preparationGate = undefined;
      continuePrepare();
    }
    expect((await stoppingApproval).json()).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('审核已失效'),
    });
    expect((await fork(session1)).json()).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('审核已失效'),
    });
    await boot();
    await closeTurn(session1);
    await follow(session2);
    expect(await inspect(session1)).toEqual(original);
    expect(await inspect(session2)).toEqual(replacement);
    expect((await probe([session1, session2, nearSession])).values).toEqual(
      observed.values,
    );

    await bind(2);
    vi.stubEnv('RDWS_PAUSE_PRESET_CREATION', '1');
    await boot();
    expect((await create()).json()).toMatchObject({
      status: 'rejected',
      error: expect.stringContaining('当前暂停'),
    });
    expect((await create(command)).json()).toMatchObject({
      status: 'mapped',
      sessionId: session1,
    });
    expect((await create(randomUUID(), neighbor)).statusCode).toBe(200);
    await closeTurn(session1);
    await closeTurn(session2);
    expect((await probe([session1, session2, nearSession])).values).toEqual(
      observed.values,
    );
    vi.unstubAllEnvs();

    await app!.close();
    app = undefined;
    const frozen = join(
      root,
      'runtime',
      'presets',
      'project-' + project,
      original.agentPreset + '.json',
    );
    await writeFile(frozen, '{}');
    await boot();
    const passive = await app!.inject({
      url: '/api/requirements/' + demand + '/sessions/' + session1 + '/history',
      headers: { cookie },
    });
    expect(passive.statusCode).toBe(200);
    expect((await sendPrompt(session1)).statusCode).toBe(503);
    await closeTurn(session2);
    expect((await probe([session1, session2])).values).toEqual([
      { sessionId: session1, error: expect.any(String) },
      observed.values[1],
    ]);
    if (positiveProxyHits) expect(proxyHits).toEqual(positiveProxyHits);
  } finally {
    vi.unstubAllEnvs();
    restoreProxy?.();
    await app?.close();
    if (proxy.listening)
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    await new Promise<void>((resolve) => provider.close(() => resolve()));
    if (testDatabase) {
      await db.query(
        'delete from session_operation where requirement_id=any($1)',
        [[demand, neighbor]],
      );
      await db.query(
        'delete from native_session where requirement_id=any($1)',
        [[demand, neighbor]],
      );
      await db.query(
        'delete from requirement_capability_binding where project_id=$1',
        [project],
      );
      await db.query(
        'delete from capability_template_revision where project_id=$1',
        [project],
      );
      for (const entry of [...references, missing, mismatched, dependent])
        await db.query('delete from capability_approval where reference=$1', [
          entry.reference,
        ]);
      await db.query('delete from requirement where id=any($1)', [
        [demand, neighbor],
      ]);
      await db.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await db.query('delete from project where id=$1', [project]);
    }
    await db.end();
    await rm(root, { recursive: true, force: true });
  }
}, 45_000);
