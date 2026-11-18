import { test, expect, beforeAll, afterAll } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
let manager: string;
let account: { username: string; password: string };
const ids: string[] = [];
beforeAll(async () => {
  manager = (
    await pool.query('select id from auth_user where username=$1', ['manager'])
  ).rows[0].id;
  account = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  ).find((row: { username: string }) => row.username === 'manager');
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
  await pool.end();
});
async function fixture() {
  const id = randomUUID();
  ids.push(id);
  await pool.query(
    'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
    [id, 'poc', 'Race fixture', 'test', 'test', manager, 'w'],
  );
  await pool.query(
    'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
    [id, manager, 'manager'],
  );
  return id;
}
class ControlledHost extends NativeWebHost {
  workspaceGate?: Promise<void>;
  entered?: () => void;
  pendingFetch?: () => Promise<Response>;
  fetchSignal?: AbortSignal | null;
  issued = 0;
  revoked = 0;
  revokeGate?: Promise<void>;
  revokeEntered?: () => void;
  constructor() {
    super('/tmp/rdws-unstarted-test-host');
  }
  override async workspace() {
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
async function login(app: ReturnType<typeof buildApp>) {
  const r = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: account,
  });
  expect(r.statusCode).toBe(200);
  return r.cookies.map((item) => `${item.name}=${item.value}`).join('; ');
}
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
    const pending = app.inject({
      url: `/api/dsh/${id}/bootstrap`,
      headers: { cookie },
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
    const pending = app.inject({
      method: 'POST',
      url: `/api/dsh/${id}/native/api/session/page`,
      headers: {
        cookie,
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-client-generation': randomUUID(),
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
      headers: { cookie },
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
