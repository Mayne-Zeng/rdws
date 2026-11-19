import { test, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import WebSocket, { WebSocketServer } from 'ws';
import { buildApp } from '@rdws/server';
import {
  bootstrapNative,
  fixtureBinding,
  observedLogin,
} from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { LEASE_MS } from '@rdws/dsh/access';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
loadEnvironment('test');
const pool = createTestPool('migration');
let manager: string;
let accounts: { username: string; password: string }[];
const ids: string[] = [];
const projects: string[] = [];
beforeAll(async () => {
  manager = (
    await pool.query('select id from auth_user where username=$1', ['manager'])
  ).rows[0].id;
  accounts = await readTestAccounts();
});
afterAll(async () => {
  for (const id of ids) {
    await pool.query('delete from native_session where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
  }
  for (const project of projects) {
    await pool.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await pool.query('delete from project where id=$1', [project]);
  }
  await pool.end();
});
async function fixture(project = 'poc') {
  const id = randomUUID();
  ids.push(id);
  await pool.query(
    'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
    [id, project, 'Race fixture', 'test', 'test', manager, 'w'],
  );
  await pool.query(
    'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
    [id, manager, 'requirement_manager'],
  );
  return id;
}
async function separateProject() {
  const project = 'login-' + randomUUID();
  await pool.query('insert into project(id,name) values($1,$2)', [
    project,
    'Login fixture',
  ]);
  projects.push(project);
  await pool.query(
    `insert into project_member(project_id,user_id,role)
     select $1,id,case when username='pm' then 'project_admin' else 'requirement_manager' end
     from auth_user where username in ('manager','pm')`,
    [project],
  );
  return project;
}
class ControlledHost extends NativeWebHost {
  workspaceGate?: Promise<void>;
  entered?: () => void;
  pendingFetch?: () => Promise<Response>;
  fetchSignal?: AbortSignal | null;
  issued = 0;
  prepared = 0;
  revoked = 0;
  revokeGate?: Promise<void>;
  revokeEntered?: () => void;
  constructor(project = 'poc') {
    super('/tmp/rdws-unstarted-test-host', undefined, project);
  }
  override async workspace() {
    this.prepared++;
    this.entered?.();
    await this.workspaceGate;
    return { workspaceId: 'w', cwd: '/unused' };
  }
  override ticket() {
    this.issued++;
    return 'synthetic-test-carrier';
  }
  override async fetch(
    _path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    this.fetchSignal = init.signal;
    return this.pendingFetch ? this.pendingFetch() : new Response('{}');
  }
  override async revoke() {
    this.revoked++;
    this.revokeEntered?.();
    await this.revokeGate;
    throw new Error('Controlled notification failure');
  }
  override async close() {}
}
function appFor(host: ControlledHost) {
  return buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin: process.env.RDWS_ORIGIN!,
    nativeHost: host,
  });
}
let loginClient = 0;
async function login(app: ReturnType<typeof buildApp>, username = 'manager') {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    remoteAddress: '192.0.2.' + ++loginClient,
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: accounts.find((account) => account.username === username),
  });
  expect(r.statusCode).toBe(200);
  return r.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
}

test('the passive session observer checks its read routes before Native preparation', async () => {
  const host = new ControlledHost();
  const app = appFor(host);
  const application = createTestPool('application');
  const historyText = 'Fixture authorized history content';
  let began!: () => void;
  let release!: () => void;
  const reading = new Promise<void>((resolve) => (began = resolve));
  const resume = new Promise<void>((resolve) => (release = resolve));
  let hold = false;
  host.fetch = async (_path, _grant, init = {}) => {
    if (hold) {
      began();
      await resume;
    }
    return Response.json({
      type: 'server-response',
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: {
        ok: true,
        value: {
          cursor: 1,
          hasMore: false,
          records: [
            {
              type: 'event',
              event: {
                seq: 1,
                type: 'user/message',
                data: {
                  source: { kind: 'user' },
                  content: [{ type: 'text', text: historyText }],
                },
              },
            },
          ],
        },
      },
    });
  };
  try {
    const identitySql = 'select current_database() db, session_user role';
    expect((await pool.query(identitySql)).rows[0]).toEqual({
      db: 'rdws_test',
      role: 'rdws_test_migrator',
    });
    expect((await application.query(identitySql)).rows[0]).toEqual({
      db: 'rdws_test',
      role: 'rdws_test_app',
    });
    const id = await fixture();
    const sessionId = 'passive-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sessionId, id, manager],
    );
    const oldCookie = await login(app);
    const cookie = await login(app);
    const former = await observedLogin(app, oldCookie);
    const current = await observedLogin(app, cookie);
    const tester = await login(app, 'tester');
    const testerLogin = await observedLogin(app, tester);
    expect(former).not.toBe(current);
    const directory = `/api/requirements/${id}/sessions`;
    const history = `${directory}/${sessionId}/history`;
    for (const url of [directory, history]) {
      for (const headers of [
        { cookie, 'x-rdws-edit-session': former },
        { cookie, 'x-rdws-edit-session': [current, current] },
        { 'x-rdws-edit-session': current },
      ]) {
        const result = await app.inject({ url, headers });
        expect(result.statusCode).toBe(401);
        expect(result.headers['cache-control']).toBe('no-store');
      }
      for (const headers of [
        { cookie, 'x-rdws-untrusted-probe': 'test' },
        { cookie: tester, 'x-rdws-edit-session': testerLogin },
      ]) {
        const result = await app.inject({ url, headers });
        expect(result.statusCode).toBe(403);
        expect(result.headers['cache-control']).toBe('no-store');
      }
    }
    for (const url of [directory, history]) {
      const head = await app.inject({
        method: 'HEAD',
        url,
        headers: { cookie, 'x-rdws-edit-session': current },
      });
      expect(head.statusCode).toBe(403);
    }
    for (const headers of [
      { cookie },
      { cookie, 'x-rdws-edit-session': current },
    ]) {
      const result = await app.inject({ url: directory, headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.json().sessions).toMatchObject([
        { id: sessionId, own: true },
      ]);
    }
    const wrongRoute = await app.inject({
      method: 'POST',
      url: `/api/requirements/${id}/commands`,
      headers: {
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-edit-session': current,
      },
      payload: { commandId: randomUUID() },
    });
    expect(wrongRoute.statusCode).toBe(403);
    expect(wrongRoute.json().error).toBe('身份头不受信任');
    expect(host.prepared).toBe(0);
    for (const headers of [
      { cookie },
      { cookie, 'x-rdws-edit-session': current },
    ]) {
      const result = await app.inject({ url: history, headers });
      expect(result.statusCode).toBe(200);
      expect(result.headers['cache-control']).toBe('no-store');
      expect(result.body).toContain(historyText);
    }
    hold = true;
    const pending = app
      .inject({
        url: history,
        headers: { cookie, 'x-rdws-edit-session': current },
      })
      .then((response) => response);
    await reading;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    release();
    const lost = await pending;
    expect(lost.statusCode).toBe(401);
    expect(lost.headers['cache-control']).toBe('no-store');
    expect(lost.body).not.toContain(historyText);
  } finally {
    release();
    await app.close();
    await application.end();
  }
});

class ObservedLoginHost extends ControlledHost {
  registered = 0;
  forwarded = 0;
  carriers: unknown[] = [];
  reconcile?: () => Promise<void>;
  override ticket() {
    return 'synthetic-test-carrier-' + ++this.issued;
  }
  override claims() {
    return {
      aud: this.audience,
      purpose: 'browser' as const,
      nonce: 'login-observation-fixture',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20_000,
    };
  }
  override async control(operation: string) {
    if (operation === 'run') this.registered++;
    if (operation === 'runs.active') {
      await this.reconcile?.();
      return { runIds: [] };
    }
    return { seen: true };
  }
  override async fetch(
    path: string,
    carrier: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    if (path === '/api/rdws/bootstrap') return Response.json({});
    this.carriers.push(carrier);
    this.forwarded++;
    return Response.json({
      type: 'server-response',
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: { ok: true, value: { accepted: true } },
    });
  }
}
const muxPath = (id: string) => `/api/dsh/${id}/native/api/remote.mux`;
function wireRequest(method: string, args: unknown) {
  return {
    type: 'client-request',
    rpcId: randomUUID(),
    method,
    payload: { args },
  };
}
function nativeQuery(binding: string, generation = randomUUID()) {
  return new URLSearchParams({ generation, login: binding }).toString();
}
function socketStatus(url: string, headers: Record<string, string>) {
  return new Promise<number>((resolve, reject) => {
    const client = new WebSocket(url, { headers });
    client.once('error', reject);
    client.once('open', () => {
      client.close();
      resolve(101);
    });
    client.once('unexpected-response', (request, response) => {
      response.resume();
      request.destroy();
      resolve(response.statusCode!);
    });
  });
}
function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

test('Native carriers enforce the bootstrap login and keep same-login leases across reconnects', async () => {
  const host = new ObservedLoginHost();
  const app = appFor(host);
  const origin = process.env.RDWS_ORIGIN!;
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  host.socketUrl = () =>
    `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`;
  let browser: WebSocket | undefined;
  let restarted: ReturnType<typeof buildApp> | undefined;
  try {
    const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(
      'http:',
      'ws:',
    );
    const id = await fixture();
    const otherDemand = await fixture();
    const otherProject = await fixture(await separateProject());
    const first = await login(app);
    const current = await login(app);
    const teammate = await login(app, 'pm');
    const oldLogin = await observedLogin(app, first);
    const bootstrapHeaders = { cookie: first, 'x-rdws-edit-session': oldLogin };
    for (const headers of [
      { cookie: first },
      { ...bootstrapHeaders, cookie: current },
      {
        ...bootstrapHeaders,
        'x-rdws-edit-session': oldLogin + ', ' + oldLogin,
      },
    ]) {
      const deny = await app.inject({
        url: `/api/dsh/${id}/bootstrap`,
        headers,
      });
      expect(deny.statusCode).toBe(401);
      expect(deny.headers['cache-control']).toBe('no-store');
    }
    expect(host.prepared).toBe(0);
    const boot = await app.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: bootstrapHeaders,
    });
    expect(boot.statusCode).toBe(200);
    expect(boot.headers['cache-control']).toBe('no-store');
    const { loginBinding: firstBinding } = boot.json<{
      loginBinding: string;
    }>();
    expect(firstBinding).toMatch(/^[a-f0-9]{64}$/);
    const currentBinding = await bootstrapNative(app, current, id);
    const teammateBinding = await bootstrapNative(app, teammate, id);
    expect(new Set([firstBinding, currentBinding, teammateBinding]).size).toBe(
      3,
    );
    expect(await bootstrapNative(app, first, otherDemand)).not.toBe(
      firstBinding,
    );
    const prepared = host.prepared;
    const generation = randomUUID();
    const transportHeaders = {
      'x-rdws-native-login': firstBinding,
      'x-rdws-client-generation': generation,
    };
    const rpc = (
      cookie: string,
      headers: Record<string, string>,
      demand = id,
      query = '',
    ) =>
      app.inject({
        method: 'POST',
        url: `/api/dsh/${demand}/native/api/session/list${query}`,
        headers: { cookie, origin, ...headers },
        payload: wireRequest('session/list', {}),
      });
    for (const cookie of [current, teammate, ''])
      expect((await rpc(cookie, transportHeaders)).statusCode).toBe(401);
    expect(
      (
        await rpc(first, {
          ...transportHeaders,
          'x-rdws-native-login': currentBinding,
        })
      ).statusCode,
    ).toBe(401);
    expect((await rpc(first, transportHeaders, otherDemand)).statusCode).toBe(
      401,
    );
    expect((await rpc(first, transportHeaders, otherProject)).statusCode).toBe(
      401,
    );
    expect(
      (await rpc(first, { 'x-rdws-client-generation': generation })).statusCode,
    ).toBe(401);
    expect(
      (await rpc(first, transportHeaders, id, '?login=' + firstBinding))
        .statusCode,
    ).toBe(400);
    expect(
      (
        await rpc(first, {
          ...transportHeaders,
          'x-rdws-native-login': firstBinding + ', ' + firstBinding,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await rpc(first, {
          ...transportHeaders,
          'x-rdws-client-generation': '0'.repeat(36),
        })
      ).statusCode,
    ).toBe(400);
    const url = address + muxPath(id);
    const query = nativeQuery(firstBinding, generation);
    for (const cookie of [current, teammate])
      expect(await socketStatus(url + '?' + query, { cookie, origin })).toBe(
        401,
      );
    expect(await socketStatus(url + '?' + query, { origin })).toBe(403);
    expect(
      await socketStatus(url + '?generation=' + generation, {
        cookie: first,
        origin,
      }),
    ).toBe(401);
    expect(
      await socketStatus(url + '?' + query + '&login=' + firstBinding, {
        cookie: first,
        origin,
      }),
    ).toBe(400);
    expect(
      await socketStatus(url + '?' + query + '&generation=' + randomUUID(), {
        cookie: first,
        origin,
      }),
    ).toBe(400);
    expect(
      await socketStatus(url + '?' + query, {
        cookie: first,
        origin,
        ...transportHeaders,
      }),
    ).toBe(403);
    expect(
      await socketStatus(url + '?' + query, {
        cookie: first,
        origin: 'https://wrong.invalid',
      }),
    ).toBe(403);
    expect(host.prepared).toBe(prepared);
    expect(host.issued).toBe(0);
    expect(host.forwarded).toBe(0);
    expect(upstream.clients.size).toBe(0);
    const connected = once(upstream, 'connection');
    browser = new WebSocket(url + '?' + query, {
      headers: { cookie: first, origin },
    });
    const [firstRead, [, request]] = await Promise.all([
      rpc(first, transportHeaders),
      connected,
      once(browser, 'open'),
    ]);
    expect(firstRead.statusCode).toBe(200);
    expect(host.issued).toBe(1);
    expect(request.headers['x-rdws-delegation']).toBe(host.carriers[0]);
    const rotated = {
      ...transportHeaders,
      'x-rdws-client-generation': randomUUID(),
    };
    expect((await rpc(first, rotated)).statusCode).toBe(200);
    expect(host.issued).toBe(2);
    expect(host.carriers[1]).not.toBe(host.carriers[0]);
    const afterExpiry = Date.now() + LEASE_MS;
    const clock = vi.spyOn(Date, 'now').mockReturnValue(afterExpiry);
    try {
      expect((await rpc(first, rotated)).statusCode).toBe(409);
      expect((await rpc(first, rotated)).statusCode).toBe(409);
      expect(host.issued).toBe(2);
      expect(
        (
          await rpc(first, {
            ...transportHeaders,
            'x-rdws-client-generation': randomUUID(),
          })
        ).statusCode,
      ).toBe(200);
      expect(host.issued).toBe(3);
    } finally {
      clock.mockRestore();
    }
    const disconnected = once(browser, 'close');
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: { origin, cookie: first },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    expect((await disconnected)[0]).toBe(4001);
    expect((await rpc(first, rotated)).statusCode).toBe(401);
    expect(
      await socketStatus(url + '?' + query, { cookie: first, origin }),
    ).toBe(403);
    await app.close();
    const replacementHost = new ObservedLoginHost();
    restarted = appFor(replacementHost);
    const valid = {
      method: 'POST' as const,
      url: `/api/dsh/${id}/native/api/session/list`,
      headers: {
        cookie: current,
        origin,
        ...rotated,
        'x-rdws-native-login': currentBinding,
      },
      payload: wireRequest('session/list', {}),
    };
    expect((await restarted.inject(valid)).statusCode).toBe(200);
    expect(await bootstrapNative(restarted, current, id)).toBe(currentBinding);
    expect(
      (
        await restarted.inject({
          ...valid,
          headers: { ...valid.headers, 'x-rdws-native-login': firstBinding },
        })
      ).statusCode,
    ).toBe(401);
    expect(replacementHost.issued).toBe(1);
  } finally {
    browser?.terminate();
    await restarted?.close();
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
  }
});

test('an unbound old browser transport cannot send with a replacement Cookie even for the same account', async () => {
  const host = new ObservedLoginHost();
  const app = appFor(host);
  const origin = process.env.RDWS_ORIGIN!;
  try {
    const id = await fixture();
    const sessionId = 'session-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sessionId, id, manager],
    );
    const oldCookie = await login(app);
    const generation = randomUUID();
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie: oldCookie, origin },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    const cookie = await login(app);
    expect(cookie).not.toBe(oldCookie);
    const response = await app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/session/prompt`,
      headers: { cookie, origin, 'x-rdws-client-generation': generation },
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
              content: [{ type: 'text', text: 'A stale browser draft' }],
            },
          },
        },
      },
    });
    expect(host.registered).toBe(0);
    expect(host.forwarded).toBe(0);
    expect(response.statusCode).toBe(401);
  } finally {
    await app.close();
  }
});

test('revocation and regrant cannot restart a pending handshake or admit a pending prompt', async () => {
  const project = await separateProject();
  const host = new ObservedLoginHost(project);
  const app = appFor(host);
  const origin = process.env.RDWS_ORIGIN!;
  const upgradeEntered = latch(),
    upgradeResume = latch();
  const reconcileEntered = latch(),
    reconcileResume = latch();
  const id = await fixture(project);
  const firstGeneration = randomUUID();
  app.addHook('preHandler', async (request) => {
    const url = new URL(request.url, origin);
    if (
      url.pathname === muxPath(id) &&
      url.searchParams.get('generation') === firstGeneration
    ) {
      upgradeEntered.open();
      await upgradeResume.wait;
    }
  });
  let browser: WebSocket | undefined;
  let pending: Promise<unknown> | undefined;
  try {
    const address = (await app.listen({ host: '127.0.0.1', port: 0 })).replace(
      'http:',
      'ws:',
    );
    const cookie = await login(app);
    const administrator = await login(app, 'pm');
    const binding = await bootstrapNative(app, cookie, id);
    const sessionId = 'epoch-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sessionId, id, manager],
    );
    async function setRoles(roles: string[]) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/management/commands',
        headers: { cookie: administrator, origin },
        payload: {
          commandId: randomUUID(),
          kind: 'project.roles',
          username: 'manager',
          projectId: project,
          roles,
        },
      });
      expect(result.statusCode).toBe(200);
      expect(result.json().changed).toBe(true);
    }
    browser = new WebSocket(
      address + muxPath(id) + '?' + nativeQuery(binding, firstGeneration),
      {
        headers: { cookie, origin },
      },
    );
    const disconnected = once(browser, 'close');
    await upgradeEntered.wait;
    await setRoles([]);
    await setRoles(['requirement_manager']);
    const preparations = host.prepared;
    upgradeResume.open();
    expect((await disconnected)[0]).toBe(4001);
    expect(host.prepared).toBe(preparations);
    expect(host.issued).toBe(0);
    function send() {
      return app.inject({
        method: 'POST',
        url: `/api/dsh/${id}/native/api/session/prompt`,
        headers: {
          cookie,
          origin,
          'x-rdws-native-login': binding,
          'x-rdws-client-generation': randomUUID(),
        },
        payload: wireRequest('session/prompt', {
          request: {
            sessionId,
            requestId: randomUUID(),
            mode: 'queue',
            content: [{ type: 'text', text: 'Synthetic pending prompt' }],
          },
        }),
      });
    }
    expect((await send()).statusCode).toBe(200);
    expect(host.registered).toBe(1);
    host.reconcile = async () => {
      reconcileEntered.open();
      await reconcileResume.wait;
    };
    const prompt = send().then((response) => response);
    pending = prompt;
    await reconcileEntered.wait;
    await setRoles([]);
    await setRoles(['requirement_manager']);
    reconcileResume.open();
    expect((await prompt).statusCode).toBe(401);
    expect(host.registered).toBe(1);
    expect(host.forwarded).toBe(1);
    expect((await send()).statusCode).toBe(200);
    expect(host.registered).toBe(2);
  } finally {
    upgradeResume.open();
    reconcileResume.open();
    await pending;
    browser?.terminate();
    await app.close();
  }
});

test('logout during delayed workspace preparation cannot issue a new native grant', async () => {
  const host = new ControlledHost();
  let release = () => {};
  let entered = () => {};
  const ready = new Promise<void>((resolve) => (entered = resolve));
  host.workspaceGate = new Promise<void>((resolve) => (release = resolve));
  host.entered = entered;
  const app = appFor(host);
  await app.ready();
  try {
    const id = await fixture();
    const cookie = await login(app);
    const observed = await observedLogin(app, cookie);
    const pending = app.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: { cookie, 'x-rdws-edit-session': observed },
    });
    await ready;
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    release();
    expect((await pending).statusCode).toBe(401);
    expect(host.issued).toBe(0);
  } finally {
    release();
    await app.close();
  }
});
test('wrong-origin logout has no effect; failed native revocation still aborts stale HTTP output', async () => {
  const host = new ControlledHost();
  let release = () => {};
  let entered = () => {};
  const ready = new Promise<void>((resolve) => (entered = resolve));
  host.pendingFetch = () => {
    entered();
    return new Promise<Response>((resolve) => {
      release = () => resolve(new Response('stale-fixture-output'));
    });
  };
  const app = appFor(host);
  await app.ready();
  try {
    const id = await fixture();
    const sid = 'race-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sid, id, manager],
    );
    const cookie = await login(app);
    const binding = await fixtureBinding(app, cookie, 'poc', id);
    const pending = app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/session/page`,
      headers: {
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-client-generation': randomUUID(),
        'x-rdws-native-login': binding,
      },
      payload: {
        type: 'client-request',
        rpcId: 'race',
        method: 'session/page',
        payload: {
          args: { request: { address: { kind: 'session', sessionId: sid } } },
        },
      },
    });
    await ready;
    const bad = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: 'https://wrong.invalid' },
      payload: {},
    });
    expect(bad.statusCode).toBe(403);
    expect(host.revoked).toBe(0);
    expect(host.fetchSignal?.aborted).toBe(false);
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      payload: {},
    });
    expect(logout.headers['x-rdws-native-revocation']).toBe('lease-expiry');
    expect(host.fetchSignal?.aborted).toBe(true);
    release();
    const response = await pending;
    expect(response.statusCode).toBe(401);
    expect(response.body.includes('stale-fixture-output')).toBe(false);
  } finally {
    release();
    await app.close();
  }
});

test('new admissions are denied while logout waits for native notification', async () => {
  const host = new ControlledHost();
  let release = () => {};
  let entered = () => {};
  const ready = new Promise<void>((resolve) => (entered = resolve));
  host.revokeGate = new Promise<void>((resolve) => (release = resolve));
  host.revokeEntered = entered;
  const app = appFor(host);
  await app.ready();
  try {
    const id = await fixture();
    const cookie = await login(app);
    const observed = await observedLogin(app, cookie);
    const logout = app
      .inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: { cookie, origin: process.env.RDWS_ORIGIN! },
        payload: {},
      })
      .then((value) => value);
    await ready;
    const during = await app.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: { cookie, 'x-rdws-edit-session': observed },
    });
    expect(during.statusCode).toBe(401);
    expect(host.issued).toBe(0);
    release();
    expect((await logout).statusCode).toBe(200);
  } finally {
    release();
    await app.close();
  }
});
