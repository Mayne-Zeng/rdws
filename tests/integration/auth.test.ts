import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '@rdws/server';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
});
const migrator = new Pool({
  connectionString: process.env.DATABASE_MIGRATION_URL,
});
let accounts: { username: string; password: string }[];
beforeAll(async () => {
  accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  );
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await migrator.end();
});
async function login(username: string) {
  const entry = accounts.find((a) => a.username === username)!;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: entry,
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  expect(cookie).toBeTruthy();
  return cookie;
}
test('anonymous requests cannot read project data', async () => {
  expect((await app.inject('/api/projects')).statusCode).toBe(401);
});
test('database sessions grant only project memberships and sign-out revokes the same cookie', async () => {
  const cookie = await login('lead');
  const response = await app.inject({
    url: '/api/projects',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    projects: [{ id: 'poc', name: 'RDWS PoC', roles: ['developer'] }],
  });
  const out = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { cookie, origin: process.env.RDWS_ORIGIN! },
    payload: {},
  });
  expect(out.statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/projects', headers: { cookie } }))
      .statusCode,
  ).toBe(401);
});
test('platform administrator does not inherit project business membership', async () => {
  const cookie = await login('admin');
  expect(
    (await app.inject({ url: '/api/projects', headers: { cookie } })).json(),
  ).toEqual({ projects: [] });
});
test('the preset two-character project administrator can sign in', async () => {
  const cookie = await login('pm');
  const response = await app.inject({
    url: '/api/projects',
    headers: { cookie },
  });
  expect(response.json().projects[0].roles).toEqual(['project_admin']);
});
test('disabling a user invalidates business access for an existing session', async () => {
  const cookie = await login('dev');
  await migrator.query('update auth_user set active=false where username=$1', [
    'dev',
  ]);
  try {
    expect(
      (await app.inject({ url: '/api/projects', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  } finally {
    await migrator.query('update auth_user set active=true where username=$1', [
      'dev',
    ]);
  }
});
test('public signup and untrusted origins are rejected', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: {
      name: 'outsider',
      email: 'outsider@rdws.invalid',
      password: crypto.randomUUID(),
    },
  });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  const entry = accounts.find((a) => a.username === 'lead')!;
  const forged = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: 'https://untrusted.invalid' },
    payload: entry,
  });
  expect(forged.statusCode).toBe(403);
});
test('application role cannot create tables or connect to development database', async () => {
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await expect(
      pool.query('create table forbidden_table(id text)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('update requirement_event set actor_id=actor_id where false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('delete from requirement_event where false'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await pool.end();
  }
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/rdws_dev';
  const cross = new Pool({ connectionString: url.toString() });
  try {
    await expect(cross.query('select 1')).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await cross.end();
  }
});

test('repeated sign-in requests are rate-limited', async () => {
  const entry = accounts.find((a) => a.username === 'lead')!;
  let blocked = false;
  for (let attempt = 0; attempt < 11; attempt++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: {
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-client-ip': String(attempt),
      },
      payload: entry,
    });
    if (response.statusCode === 429) {
      blocked = true;
      break;
    }
    expect(response.statusCode).toBe(200);
  }
  expect(blocked).toBe(true);
});

test('malformed JSON is a client error without internal details', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: {
      origin: process.env.RDWS_ORIGIN!,
      'content-type': 'application/json',
    },
    payload: '{',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: '请求参数不正确' });
});
