import { nativeReady } from '../helpers/native-ready.ts';
import { bootstrapNative } from '../helpers/native-browser.ts';
import { test, expect } from '@playwright/test';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { signGrant } from '@rdws/dsh/access';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import WebSocket from 'ws';
import { runtimeHome } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
class LostNotification extends NativeWebHost {
  override async revoke() {
    throw new Error('Controlled transport outage');
  }
}
function opened(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers });
  return new Promise<WebSocket>((resolve, reject) => {
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}
function frame(ws: WebSocket) {
  return new Promise<void>((resolve) => ws.once('message', () => resolve()));
}
test('native notification outage stops BFF immediately and closes native at lease expiry', async () => {
  const root = join(runtimeHome, 'testing-fault');
  const host = new LostNotification(
    root,
    join(runtimeHome, 'runtime', 'dsh', 'project-poc'),
  );
  const origin = 'http://127.0.0.1:5317';
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    nativeHost: host,
  });
  const address = await app.listen({ host: '127.0.0.1', port: 0 });
  let bff: WebSocket | undefined;
  let direct: WebSocket | undefined;
  const pool = createTestPool('migration');
  try {
    const accounts = await readTestAccounts();
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: accounts.find((row) => row.username === 'manager'),
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies
      .map((item) => `${item.name}=${item.value}`)
      .join('; ');
    const actor = (
      await app.inject({ url: '/api/auth/get-session', headers: { cookie } })
    ).json();
    const lead = (
      await pool.query('select id from auth_user where username=$1', ['lead'])
    ).rows[0].id;
    const created = await app.inject({
      method: 'POST',
      url: '/api/projects/poc/requirements',
      headers: { cookie, origin },
      payload: {
        title: 'Native revoke outage ' + randomUUID(),
        description: '故障注入',
        acceptance: 'BFF立即停止并以原生租约关闭兜底',
        commandId: randomUUID(),
        leadId: lead,
        participantIds: [],
      },
    });
    expect(created.statusCode).toBe(200);
    const id = created.json().id;
    const createdSession = await app.inject({
      method: 'POST',
      url: `/api/requirements/${id}/sessions`,
      headers: { cookie, origin },
      payload: {},
    });
    expect(createdSession.statusCode).toBe(200);
    const sid = createdSession.json().sessionId;
    const binding = await bootstrapNative(app, cookie, id);
    bff = await opened(
      address.replace('http:', 'ws:') +
        `/api/dsh/${id}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
      { cookie, origin },
    );
    let pending = frame(bff);
    bff.send(
      JSON.stringify({
        type: 'open',
        streamId: 'bff',
        endpoint: 'remoteAccess/follow',
        payload: { args: {} },
      }),
    );
    await pending;
    const { port, generation: hostGeneration } = await nativeReady(root);
    const key = await readFile(join(root, 'secrets', 'dsh-bff-key'), 'utf8');
    const workspaceId = (
      await pool.query(
        'select native_workspace_id from requirement where id=$1',
        [id],
      )
    ).rows[0].native_workspace_id;
    const issued = Date.now();
    const ticket = signGrant(key, {
      aud: 'rdws:poc',
      hostGeneration,
      purpose: 'browser',
      userId: actor.user.id,
      authSessionId: actor.session.id,
      requirementId: id,
      workspaceId,
      readSessionIds: [sid],
      ownSessionIds: [sid],
    });
    direct = await opened(`ws://127.0.0.1:${port}/_rdws/remote.mux`, {
      'x-rdws-delegation': ticket,
    });
    pending = frame(direct);
    direct.send(
      JSON.stringify({
        type: 'open',
        streamId: 'native',
        endpoint: 'remoteAccess/follow',
        payload: { args: {} },
      }),
    );
    await pending;
    const bffClosed = new Promise<void>((resolve) =>
      bff!.once('close', () => resolve()),
    );
    const directClosed = new Promise<void>((resolve) =>
      direct!.once('close', () => resolve()),
    );
    const start = Date.now();
    const logout = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-out',
      headers: { cookie, origin },
      payload: {},
    });
    expect(logout.statusCode).toBe(200);
    expect(logout.headers['x-rdws-native-revocation']).toBe('lease-expiry');
    await bffClosed;
    expect(Date.now() - start).toBeLessThan(1500);
    expect(direct.readyState).toBe(WebSocket.OPEN);
    await directClosed;
    expect(Date.now() - issued).toBeLessThan(21500);
    expect(Date.now() - issued).toBeGreaterThan(18000);
    const replay = await fetch(`http://127.0.0.1:${port}/_rdws/bootstrap`, {
      headers: { 'x-rdws-delegation': ticket },
    });
    expect(replay.status).toBe(401);
  } finally {
    bff?.close();
    direct?.close();
    await app.close();
    await pool.end();
  }
});
