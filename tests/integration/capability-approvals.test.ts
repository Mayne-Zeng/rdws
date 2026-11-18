import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { currentAccount } from '../../apps/server/src/modules/auth.ts';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';

loadEnvironment('test');
const origin = process.env.RDWS_ORIGIN!;
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin,
});
const reference = `platform/fixture-${randomUUID()}`;
const actorId = randomUUID();
const actorName = 'cap_' + actorId.slice(0, 12).replaceAll('-', '');
const password = randomUUID();
const commandIds: string[] = [];
let loginClient = 0;

beforeAll(async () => {
  await app.ready();
  await pool.query(
    'insert into auth_user(id,name,email,username,email_verified,platform_admin) values($1,$2,$3,$2,true,true)',
    [actorId, actorName, `${actorName}@example.invalid`],
  );
  await pool.query(
    "insert into auth_account(id,account_id,user_id,provider_id,password) values($1,$2,$2,'credential',$3)",
    [randomUUID(), actorId, await hashPassword(password)],
  );
});
afterAll(async () => {
  await app.close();
  const { rows } = await pool.query(
    "select to_regclass('capability_approval') present",
  );
  if (rows[0].present)
    await pool.query('delete from capability_approval where reference=$1', [
      reference,
    ]);
  await pool.query(
    'delete from command_receipt where command_id=any($1::text[])',
    [commandIds],
  );
  await pool.query('delete from auth_user where id=$1', [actorId]);
  await pool.end();
});

async function login(username: string) {
  const accounts: { username: string; password: string }[] = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  );
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    remoteAddress: '192.0.2.' + ++loginClient,
    headers: { origin },
    payload:
      username === actorName
        ? { username, password }
        : accounts.find((account) => account.username === username),
  });
  expect(response.statusCode).toBe(200);
  return response.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
}
function approval(approved = true, revision = '1.0.0') {
  const commandId = randomUUID();
  commandIds.push(commandId);
  return {
    kind: 'capability.approval',
    commandId,
    capabilityKind: 'skill',
    reference,
    revision,
    approved,
  };
}
function send(cookie: string, payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: '/api/management/commands',
    headers: { cookie, origin },
    payload,
  });
}
function list(cookie: string) {
  return app.inject({
    url: '/api/management/capability-approvals',
    headers: { cookie },
  });
}

test('only platform administrators manage exact approved versions and an old registration cannot undo retirement', async () => {
  const platform = await login('admin');
  const otherPlatform = await login(actorName);
  const projectAdmin = await login('pm');
  expect((await list('')).statusCode).toBe(401);
  expect((await list(projectAdmin)).statusCode).toBe(403);
  const allowedList = await list(platform);
  expect(allowedList.statusCode).toBe(200);
  expect(allowedList.headers['cache-control']).toBe('no-store');
  const first = approval();
  expect((await send(projectAdmin, first)).statusCode).toBe(403);
  const invalid = [
    { reference: 42 },
    { reference: [reference] },
    { revision: 12 },
    { approved: 'false' },
    { kind: ['capability.approval'], revision: 12, approved: 'true' },
    { reference: 'https://fixture.invalid/plugin' },
    { reference: 'platform/../fixture' },
    { reference: 'platform/name;echo' },
    { reference: reference + '\n' },
    { install: 'fixture' },
  ].map((patch) => ({ ...approval(), ...patch }));
  for (const input of invalid)
    expect((await send(platform, input)).statusCode).toBe(400);
  expect(
    (
      await pool.query(
        'select command_id from command_receipt where command_id=any($1::text[])',
        [invalid.map((row) => row.commandId)],
      )
    ).rowCount,
  ).toBe(0);
  const distinct = approval();
  const concurrent = await Promise.all([
    send(platform, first),
    send(otherPlatform, distinct),
  ]);
  expect(concurrent.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(concurrent.map((response) => response.json().changed).sort()).toEqual([
    false,
    true,
  ]);
  const replay = await send(platform, first);
  expect(replay.json()).toMatchObject({ replayed: true, revocation: 'none' });
  expect((await send(platform, { ...first, approved: false })).statusCode).toBe(
    409,
  );
  const second = approval(true, '2.0.0');
  expect((await send(platform, second)).json().changed).toBe(true);
  const late = approval();
  const retired = approval(false);
  expect((await send(otherPlatform, retired)).json()).toMatchObject({
    changed: true,
    revocation: 'none',
  });
  expect((await send(platform, late)).json()).toMatchObject({
    changed: false,
    replayed: false,
  });
  expect((await send(platform, late)).json()).toMatchObject({
    changed: false,
    replayed: true,
  });
  expect((await send(platform, first)).json()).toMatchObject({
    replayed: true,
  });
  const clearance = (await list(platform))
    .json()
    .approvals.filter(
      (row: { reference: string }) => row.reference === reference,
    );
  expect(clearance).toEqual([
    { kind: 'skill', reference, revision: '1.0.0', approved: false },
    { kind: 'skill', reference, revision: '2.0.0', approved: true },
  ]);
  const { rows } = await pool.query(
    'select result from command_receipt where command_id=any($1::text[])',
    [[first.commandId, distinct.commandId, retired.commandId, late.commandId]],
  );
  expect(rows.map((row) => row.result)).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ before: false, after: true, changed: true }),
      expect.objectContaining({ before: true, after: true, changed: false }),
      expect.objectContaining({ before: true, after: false, changed: true }),
      expect.objectContaining({ before: false, after: false, changed: false }),
    ]),
  );
  const [permissions] = (
    await pool.query(
      "select has_table_privilege('rdws_test_app','capability_approval','SELECT') readable, has_table_privilege('rdws_test_app','capability_approval','DELETE') deletable, pg_get_userbyid(relowner) owner from pg_class where oid='capability_approval'::regclass",
    )
  ).rows;
  expect(permissions).toMatchObject({ readable: true, deletable: false });
  expect(permissions.owner).not.toBe('rdws_test_app');
  await expect(
    pool.query(
      'insert into capability_approval(kind,reference,revision,approved) values($1,$2,$3,true)',
      ['skill', reference, '../wrong'],
    ),
  ).rejects.toMatchObject({ code: '23514' });
});

test('delayed approval responses and writes recheck current authority', async () => {
  const client = await pool.connect();
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  async function waitForLock() {
    await vi.waitFor(
      async () => {
        const { rows } = await pool.query(
          'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
          [pid],
        );
        expect(rows[0].waiting).toBe(true);
      },
      { timeout: 1500 },
    );
  }
  try {
    for (const [change, status] of [
      ['role', 403],
      ['expiry', 401],
    ] as const) {
      await pool.query('update auth_user set platform_admin=true where id=$1', [
        actorId,
      ]);
      const current = await login(actorName);
      await client.query('begin');
      await client.query(
        'lock table capability_approval in access exclusive mode',
      );
      const pending = list(current);
      await waitForLock();
      if (change === 'role')
        await client.query(
          'update auth_user set platform_admin=false where id=$1',
          [actorId],
        );
      else
        await client.query(
          "update auth_session set expires_at=now()-interval '1 minute' where user_id=$1",
          [actorId],
        );
      await client.query('commit');
      const response = await pending;
      expect(response.statusCode).toBe(status);
      expect(response.body).not.toContain('approvals');
    }

    const current = await login(actorName);
    await client.query('begin');
    await client.query('select id from auth_user where id=$1 for update', [
      actorId,
    ]);
    const command = approval(true, '3.0.0');
    const pending = send(current, command);
    await waitForLock();
    await client.query(
      'update auth_user set platform_admin=false where id=$1',
      [actorId],
    );
    await client.query('commit');
    expect((await pending).statusCode).toBe(403);
    expect(
      (
        await pool.query(
          'select command_id from command_receipt where command_id=$1',
          [command.commandId],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('account authority expires while the final database read is pending', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  try {
    const start = Date.now();
    const expiresAt = new Date(start + 1000);
    type AccountRow = { id: string; platformAdmin: boolean; expiresAt: Date };
    let release!: (accounts: AccountRow[]) => void;
    const promise = new Promise<AccountRow[]>((resolve) => {
      release = resolve;
    });
    const db = {
      select: () => ({
        from: () => ({ innerJoin: () => ({ where: () => promise }) }),
      }),
    } as unknown as Parameters<typeof currentAccount>[0];
    const pending = currentAccount(db, 'session', actorId);
    vi.setSystemTime(start + 2000);
    release([{ id: actorId, platformAdmin: true, expiresAt }]);
    expect(await pending).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
