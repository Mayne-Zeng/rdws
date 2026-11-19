import { nativeReady } from '../helpers/native-ready.ts';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import WebSocket from 'ws';
import { signGrant } from '@rdws/dsh/access';
import { runtimeHome } from '@rdws/runtime-config';
let base: string;
let cookie: string;
let leadCookie: string;
let managerId: string;
let authSessionId: string;
let req1: string;
let req2: string;
let sid1: string;
let sid2: string;
let sidLead: string;
let workspace1: string;
let workspace2: string;
let port: number;
let key: string;
let pool: Pool;
async function send(path: string, init: RequestInit = {}, identity = cookie) {
  return fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      origin: base,
      ...(identity ? { cookie: identity } : {}),
      ...init.headers,
    },
  });
}
async function login(username: string) {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const response = await send(
    '/api/auth/sign-in/username',
    {
      method: 'POST',
      body: JSON.stringify(accounts.find((row) => row.username === username)),
    },
    '',
  );
  expect(response.status).toBe(200);
  return response.headers
    .getSetCookie()
    .map((row) => row.split(';')[0])
    .join('; ');
}
async function rpc(action: string, args: unknown, token: string) {
  const response = await fetch(`http://127.0.0.1:${port}/_rdws/api/${action}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-rdws-delegation': token },
    body: JSON.stringify({
      type: 'client-request',
      rpcId: randomUUID(),
      method: action,
      payload: { args },
    }),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) : undefined };
}
let hostGeneration: string;
function cap(purpose: 'browser' | 'create' = 'browser', lease = 20000) {
  return signGrant(
    key,
    {
      aud: 'rdws:poc',
      hostGeneration,
      purpose,
      userId: managerId,
      authSessionId,
      requirementId: req1,
      workspaceId: workspace1,
      cwd: 'unused',
      readSessionIds: [sid1, sidLead],
      ownSessionIds: [sid1],
    },
    Date.now(),
    lease,
  );
}
async function socket(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/_rdws/remote.mux`, {
    headers: { 'x-rdws-delegation': token },
  });
  await new Promise<void>((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  return ws;
}
function next(ws: WebSocket) {
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Native frame timeout')),
      10000,
    );
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}
test.beforeAll(async ({ baseURL }) => {
  base = baseURL!;
  pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  cookie = await login('manager');
  leadCookie = await login('lead');
  const actor = await (await send('/api/auth/get-session')).json();
  managerId = actor.user.id;
  authSessionId = actor.session.id;
  const lead = (
    await pool.query('select id from auth_user where username=$1', ['lead'])
  ).rows[0].id;
  for (let index = 0; index < 2; index++) {
    const created = await (
      await send('/api/projects/poc/requirements', {
        method: 'POST',
        body: JSON.stringify({
          title: 'Native isolation ' + randomUUID(),
          description: '权限实测',
          acceptance: '两道闸拒绝越权',
          commandId: randomUUID(),
          leadId: lead,
          participantIds: [],
        }),
      })
    ).json();
    const session = await (
      await send(`/api/requirements/${created.id}/sessions`, {
        method: 'POST',
        body: '{}',
      })
    ).json();
    if (index === 0) {
      req1 = created.id;
      sid1 = session.sessionId;
    } else {
      req2 = created.id;
      sid2 = session.sessionId;
    }
  }
  const leadSession = await (
    await send(
      `/api/requirements/${req1}/sessions`,
      { method: 'POST', body: '{}' },
      leadCookie,
    )
  ).json();
  sidLead = leadSession.sessionId;
  workspace1 = (
    await pool.query(
      'select native_workspace_id from requirement where id=$1',
      [req1],
    )
  ).rows[0].native_workspace_id;
  workspace2 = (
    await pool.query(
      'select native_workspace_id from requirement where id=$1',
      [req2],
    )
  ).rows[0].native_workspace_id;
  const root = join(runtimeHome, 'testing-web');
  key = await readFile(join(root, 'secrets', 'dsh-bff-key'), 'utf8');
  const ready = await nativeReady(root);
  port = ready.port;
  hostGeneration = ready.generation;
});
test.afterAll(async () => {
  await pool?.end();
});
test('BFF rejects anonymous, unassigned members, forged identity and default native paths', async () => {
  expect(
    (await send(`/api/requirements/${req1}/sessions`, {}, '')).status,
  ).toBe(401);
  const dev = await login('dev');
  expect(
    (await send(`/api/requirements/${req1}/sessions`, {}, dev)).status,
  ).toBe(403);
  expect(
    (
      await send(`/api/dsh/${req1}/bootstrap`, {
        headers: { 'x-rdws-delegation': 'forged' },
      })
    ).status,
  ).toBe(403);
  expect((await send(`/api/dsh/${req1}/native/connect`)).status).toBe(403);
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/_rdws/bootstrap`, {
        headers: { cookie },
      })
    ).status,
  ).toBe(401);
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/api/session/list`, {
        method: 'POST',
        headers: { cookie, 'content-type': 'application/json' },
        body: '{}',
      })
    ).status,
  ).toBe(401);
});
test('native Policy filters catalog and refuses foreign history, preset and create authority', async () => {
  const token = cap();
  const list = await rpc('session/list', { _request: {} }, token);
  expect(list.status).toBe(200);
  expect(list.body.result.ok).toBe(true);
  const items = list.body.result.value.items as { sessionId: string }[];
  expect(items.some((row) => row.sessionId === sid1)).toBe(true);
  expect(items.some((row) => row.sessionId === sid2)).toBe(false);
  const foreign = await rpc(
    'session/page',
    { request: { address: { kind: 'session', sessionId: sid2 } } },
    token,
  );
  expect(foreign.body.result.error.code).toBe('remote-access/denied');
  const browserCreate = await rpc(
    'session/create',
    { request: { workspaceId: workspace1 } },
    token,
  );
  expect(browserCreate.body.result.error.code).toBe('remote-access/denied');
  for (const request of [
    { workspaceId: workspace2 },
    { workspaceId: workspace1, agentPreset: 'unsafe' },
    { workspaceId: workspace1, sessionId: sid2 },
  ]) {
    const refused = await rpc('session/create', { request }, cap('create'));
    expect([200, 403]).toContain(refused.status);
    if (refused.status !== 403) {
      expect(refused.body.result.ok).toBe(false);
      expect(refused.body.result.error.code).toBe('remote-access/denied');
    }
  }
  const otherPrompt = await rpc(
    'session/prompt',
    {
      request: {
        requestId: randomUUID(),
        sessionId: sidLead,
        mode: 'queue',
        content: [{ type: 'text', text: 'not allowed' }],
      },
    },
    token,
  );
  expect(otherPrompt.body.result.error.code).toBe('remote-access/denied');
  const command = await rpc(
    'session/prompt',
    {
      request: {
        requestId: randomUUID(),
        sessionId: sid1,
        mode: 'queue',
        content: [{ type: 'text', text: '/permissions danger-full-access' }],
      },
    },
    token,
  );
  expect(command.body.result.error.code).toBe('remote-access/denied');
});
test('native mux proves non-owner identity and rejects foreign streams', async () => {
  const ws = await socket(cap());
  try {
    let pending = next(ws);
    ws.send(
      JSON.stringify({
        type: 'open',
        streamId: 'access',
        endpoint: 'remoteAccess/follow',
        payload: { args: {} },
      }),
    );
    const frame = await pending;
    expect((frame.value as { owner: boolean }).owner).toBe(false);
    pending = next(ws);
    ws.send(
      JSON.stringify({
        type: 'open',
        streamId: 'foreign',
        endpoint: 'session/follow',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId: sid2 },
              activate: true,
              assistantStream: true,
              maxMessages: 50,
              turnWindow: { minMessages: 5, minTurns: 1 },
            },
          },
        },
      }),
    );
    const denied = await pending;
    expect(denied.type).toBe('error');
    expect((denied.error as { code: string }).code).toBe(
      'remote-access/denied',
    );
  } finally {
    ws.close();
  }
});
test('native lease expiry actively closes an already open stream and rejects replay', async () => {
  const token = cap('browser', 1800);
  const ws = await socket(token);
  const closed = new Promise<void>((resolve) =>
    ws.once('close', () => resolve()),
  );
  const pending = next(ws);
  ws.send(
    JSON.stringify({
      type: 'open',
      streamId: 'lease',
      endpoint: 'remoteAccess/follow',
      payload: { args: {} },
    }),
  );
  await pending;
  await closed;
  const replay = await fetch(`http://127.0.0.1:${port}/_rdws/bootstrap`, {
    headers: { 'x-rdws-delegation': token },
  });
  expect(replay.status).toBe(401);
});
test('logout revokes native peers and blocks old tickets', async () => {
  const token = cap();
  const ws = await socket(token);
  const closed = new Promise<void>((resolve) =>
    ws.once('close', () => resolve()),
  );
  const pending = next(ws);
  ws.send(
    JSON.stringify({
      type: 'open',
      streamId: 'logout',
      endpoint: 'remoteAccess/follow',
      payload: { args: {} },
    }),
  );
  await pending;
  const logout = await send('/api/auth/sign-out', {
    method: 'POST',
    body: '{}',
  });
  expect(logout.status).toBe(200);
  expect(logout.headers.get('x-rdws-native-revocation')).toBe('confirmed');
  await closed;
  expect(
    (
      await fetch(`http://127.0.0.1:${port}/_rdws/bootstrap`, {
        headers: { 'x-rdws-delegation': token },
      })
    ).status,
  ).toBe(401);
});
