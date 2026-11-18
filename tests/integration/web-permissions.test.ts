import { beforeAll, afterAll, test, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildApp } from '@rdws/server';
import {
  signGrant,
  verifyGrant,
  actionAllowed,
  resourceRoles,
  type Grant,
} from '@rdws/dsh/access';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
});
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
let accounts: { username: string; password: string }[];
const ids: string[] = [];
beforeAll(async () => {
  accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  );
  await app.ready();
});
afterAll(async () => {
  for (const id of ids) {
    await pool.query('delete from requirement_event where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
  }
  await app.close();
  await pool.end();
});
async function login(username: string) {
  const result = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: accounts.find((row) => row.username === username),
  });
  expect(result.statusCode).toBe(200);
  return result.cookies
    .map((cookie) => `${cookie.name}=${cookie.value}`)
    .join('; ');
}
test('scope tickets reject tampering, wrong audience and expiry', () => {
  const key = randomUUID();
  const token = signGrant(
    key,
    { aud: 'test', purpose: 'browser', userId: 'u' },
    1000,
    2000,
  );
  expect(Boolean(verifyGrant(key, token, 'test', 1100))).toBe(true);
  expect(verifyGrant(key, token + 'x', 'test', 1100)).toBeUndefined();
  expect(verifyGrant(key, token, 'other', 1100)).toBeUndefined();
  expect(verifyGrant(key, token, 'test', 3000)).toBeUndefined();
});
test('creation has a separate capability tied to exactly one workspace', () => {
  const cap: Grant = {
    aud: 'test',
    purpose: 'create',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'x',
    workspaceId: 'w',
  };
  expect(
    actionAllowed(cap, 'session/create', { request: { workspaceId: 'w' } }),
  ).toBe(true);
  for (const request of [
    { workspaceId: 'other' },
    { workspaceId: 'w', agentPreset: 'unsafe' },
    { workspaceId: 'w', sessionId: 'other' },
    { workspaceId: 'w', cwd: '/other' },
  ])
    expect(actionAllowed(cap, 'session/create', { request })).toBe(false);
  expect(
    actionAllowed({ ...cap, purpose: 'browser' }, 'session/create', {
      request: { workspaceId: 'w' },
    }),
  ).toBe(false);
  expect(resourceRoles(cap)[0]?.resource).toEqual({
    kind: 'workspace',
    id: 'w',
  });
});
test('readable conversations do not imply prompt or file permissions', () => {
  const cap: Grant = {
    aud: 'test',
    purpose: 'browser',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'x',
    readSessionIds: ['s'],
    ownSessionIds: [],
  };
  expect(
    actionAllowed(cap, 'session/page', {
      request: { address: { kind: 'session', sessionId: 's' } },
    }),
  ).toBe(true);
  expect(
    actionAllowed(cap, 'session/prompt', {
      request: {
        sessionId: 's',
        mode: 'queue',
        content: [{ type: 'text', text: 'hello' }],
      },
    }),
  ).toBe(false);
  expect(
    actionAllowed(cap, 'session/page', {
      request: { address: { kind: 'subagent', childSessionId: 's' } },
    }),
  ).toBe(false);
  expect(
    actionAllowed(cap, 'session/attachment', { request: { sessionId: 's' } }),
  ).toBe(false);
});
test('BFF requirement creation and reads honor project roles and participation', async () => {
  const manager = await login('manager');
  const lead = (
    await pool.query('select id from auth_user where username=$1', ['lead'])
  ).rows[0].id;
  const created = await app.inject({
    method: 'POST',
    url: '/api/projects/poc/requirements',
    headers: { cookie: manager, origin: process.env.RDWS_ORIGIN! },
    payload: {
      commandId: randomUUID(),
      title: 'Permission fixture',
      description: 'test',
      acceptance: 'test',
      leadId: lead,
      participantIds: [],
    },
  });
  expect(created.statusCode).toBe(200);
  const id = created.json().id;
  ids.push(id);
  expect(
    (await app.inject(`/api/requirements/${id}/sessions`)).statusCode,
  ).toBe(401);
  const developer = await login('dev');
  expect(
    (
      await app.inject({
        url: `/api/requirements/${id}/sessions`,
        headers: { cookie: developer },
      })
    ).statusCode,
  ).toBe(403);
  const assigned = await login('lead');
  expect(
    (
      await app.inject({
        url: `/api/requirements/${id}/sessions`,
        headers: { cookie: assigned },
      })
    ).statusCode,
  ).toBe(200);
  const forged = await app.inject({
    url: '/api/projects/poc/requirements',
    headers: { cookie: manager, 'x-rdws-delegation': 'forged' },
  });
  expect(forged.statusCode).toBe(403);
  const bad = await app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/sessions`,
    headers: { cookie: manager, origin: process.env.RDWS_ORIGIN! },
    payload: { agentPreset: 'unsafe' },
  });
  expect(bad.statusCode).toBe(400);
});

test('native mux frames are parsed once and half-close carries no uplink data', async () => {
  const { authorizeStreamFrame } = await import('@rdws/dsh/wire');
  const grant: Grant = {
    aud: 'test',
    purpose: 'browser',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'n',
  };
  const opened = new Set<string>();
  expect(
    authorizeStreamFrame(
      JSON.stringify({
        type: 'open',
        streamId: 's',
        endpoint: '$events',
        payload: { args: {} },
      }),
      grant,
      opened,
    ).type,
  ).toBe('open');
  expect(
    authorizeStreamFrame(
      JSON.stringify({ type: 'end', streamId: 's' }),
      grant,
      opened,
    ).type,
  ).toBe('end');
  expect(() =>
    authorizeStreamFrame(
      JSON.stringify({ type: 'item', streamId: 's', value: {} }),
      grant,
      opened,
    ),
  ).toThrow();
});

test('native prompt accepts its documented timezone while rejecting extra control fields', () => {
  const cap: Grant = {
    aud: 'test',
    purpose: 'browser',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'n',
    readSessionIds: ['s'],
    ownSessionIds: ['s'],
  };
  const request = {
    sessionId: 's',
    mode: 'queue',
    requestId: 'r',
    clientTimeZone: 'Asia/Shanghai',
    content: [{ type: 'text', text: 'hello' }],
  };
  expect(actionAllowed(cap, 'session/prompt', { request })).toBe(true);
  expect(
    actionAllowed(cap, 'session/prompt', {
      request: { ...request, content: [{ type: 'text', text: '   ' }] },
    }),
  ).toBe(false);
  expect(
    actionAllowed(cap, 'session/prompt', {
      request: { ...request, agentPreset: 'unsafe' },
    }),
  ).toBe(false);
});

test('native follow may opt into live assistant frames only for readable sessions', () => {
  const cap: Grant = {
    aud: 'test',
    purpose: 'browser',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'n',
    readSessionIds: ['s'],
    ownSessionIds: [],
  };
  expect(
    actionAllowed(cap, 'session/follow', {
      request: {
        address: { kind: 'session', sessionId: 's' },
        assistantStream: true,
      },
    }),
  ).toBe(true);
  expect(
    actionAllowed(cap, 'session/follow', {
      request: {
        address: { kind: 'session', sessionId: 'other' },
        assistantStream: true,
      },
    }),
  ).toBe(false);
});

test('participation and platform administration cannot bypass project membership', async () => {
  const projectId = 'scope-' + randomUUID();
  const id = randomUUID();
  const managerId = (
    await pool.query('select id from auth_user where username=$1', ['manager'])
  ).rows[0].id;
  await pool.query('insert into project(id,name) values($1,$2)', [
    projectId,
    'Isolated project fixture',
  ]);
  try {
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
      [id, projectId, 'Isolated', 'test', 'test', managerId],
    );
    await pool.query(
      'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
      [id, managerId, 'manager'],
    );
    const cookie = await login('manager');
    expect(
      (
        await app.inject({
          url: `/api/requirements/${id}/sessions`,
          headers: { cookie },
        })
      ).statusCode,
    ).toBe(403);
    const admin = await login('admin');
    expect(
      (
        await app.inject({
          url: `/api/requirements/${id}/sessions`,
          headers: { cookie: admin },
        })
      ).statusCode,
    ).toBe(403);
  } finally {
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
    await pool.query('delete from project where id=$1', [projectId]);
  }
});
