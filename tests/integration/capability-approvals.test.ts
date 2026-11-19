import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { currentAccount } from '../../apps/server/src/modules/auth.ts';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

loadEnvironment('test');
const origin = process.env.RDWS_ORIGIN!;
const pool = createTestPool('migration');
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin,
});
const reference = `platform/fixture-${randomUUID()}`;
const templateProject = 'template-' + randomUUID();
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
  if (
    (
      await pool.query(
        "select to_regclass('capability_template_revision') present",
      )
    ).rows[0].present
  )
    await pool.query(
      'delete from capability_template_revision where project_id=$1',
      [templateProject],
    );
  await pool.query('delete from project_member where project_id=$1', [
    templateProject,
  ]);
  await pool.query('delete from project where id=$1', [templateProject]);
  await pool.query(
    'delete from command_receipt where command_id=any($1::text[])',
    [commandIds],
  );
  await pool.query('delete from auth_user where id=$1', [actorId]);
  await pool.end();
});

async function login(username: string) {
  const accounts: { username: string; password: string }[] =
    await readTestAccounts();
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

test('platform template saves preserve exact reviewed references and serialize revisions across administrators', async () => {
  const platform = await login('admin');
  await pool.query('update auth_user set platform_admin=true where id=$1', [
    actorId,
  ]);
  const otherPlatform = await login(actorName);
  const member = await login('pm');
  const outsider = await login('dev');
  const projectUrl = `/api/projects/${templateProject}/capability-templates`;
  const platformUrl = `/api/management/projects/${templateProject}/capability-templates`;
  await pool.query('insert into project(id,name) values($1,$2)', [
    templateProject,
    'Template fixture',
  ]);
  await pool.query(
    "insert into project_member(project_id,user_id,role) select $1,id,'project_admin' from auth_user where username='pm'",
    [templateProject],
  );
  function get(url: string, cookie: string) {
    return app.inject({ url, headers: { cookie } });
  }
  expect((await get(platformUrl, member)).statusCode).toBe(403);
  expect((await get(projectUrl, outsider)).statusCode).toBe(403);
  expect((await get(projectUrl, platform)).statusCode).toBe(403);
  expect((await get(projectUrl, member)).json()).toEqual({ templates: [] });
  expect((await send(platform, approval(true, '4.0.0'))).json().changed).toBe(
    true,
  );
  expect((await send(platform, approval(true, '5.0.0'))).json().changed).toBe(
    true,
  );
  const item = { kind: 'skill', reference, revision: '4.0.0' };
  const otherItem = { ...item, revision: '5.0.0' };
  function save(fields: Record<string, unknown> = {}) {
    const commandId = randomUUID();
    commandIds.push(commandId);
    return {
      kind: 'capability.template.save',
      commandId,
      projectId: templateProject,
      name: 'Reviewed template',
      description: 'Request review',
      capabilities: [item, otherItem],
      ...fields,
    };
  }
  const original = save();
  const memberWrite = await send(member, original);
  expect(memberWrite.statusCode, memberWrite.body).toBe(403);
  const malformed = [
    save({ capabilities: [{ ...item, revision: 4 }] }),
    save({ capabilities: [item, item] }),
    save({ name: 'Bad\0name' }),
    save({ capabilities: [{ ...item, approved: true }] }),
  ];
  for (const command of malformed)
    expect((await send(platform, command)).statusCode).toBe(400);
  const created = await send(platform, original);
  expect(created.statusCode).toBe(200);
  expect(created.json()).toMatchObject({
    changed: true,
    template: { status: 'saved', revision: 1 },
  });
  const templateId = created.json().template.templateId as string;
  const current = { templateId, expectedRevision: 1 };
  expect(
    (
      await send(
        platform,
        save({ ...current, capabilities: [otherItem, item] }),
      )
    ).json(),
  ).toMatchObject({
    changed: false,
    template: { status: 'unchanged', revision: 1 },
  });
  const updates = [
    save({ ...current, name: 'Editor A' }),
    save({ ...current, name: 'Editor B' }),
  ];
  const responses = await Promise.all([
    send(platform, updates[0]!),
    send(otherPlatform, updates[1]!),
  ]);
  expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
  expect(
    responses.map((response) => response.json().template.status).sort(),
  ).toEqual(['conflict', 'saved']);
  const loser = responses.findIndex(
    (response) => response.json().template.status === 'conflict',
  );
  const retry = await send(
    loser === 0 ? platform : otherPlatform,
    updates[loser]!,
  );
  expect(retry.json()).toMatchObject({
    replayed: true,
    template: { status: 'conflict' },
  });
  expect(
    (await send(platform, { ...original, description: 'Different intent' }))
      .statusCode,
  ).toBe(409);
  expect((await send(platform, approval(false, '4.0.0'))).json().changed).toBe(
    true,
  );

  const currentList = await get(projectUrl, member);
  expect(currentList.headers['cache-control']).toBe('no-store');
  expect(currentList.json().templates).toEqual([
    expect.objectContaining({
      templateId,
      revision: 2,
      capabilities: [
        { ...item, approved: false },
        { ...otherItem, approved: true },
      ],
    }),
  ]);
  expect(currentList.json()).not.toHaveProperty('options');
  expect((await get(platformUrl, platform)).json().options).toContainEqual(
    otherItem,
  );
  expect((await send(platform, original)).json()).toMatchObject({
    replayed: true,
    template: { status: 'saved', revision: 1 },
  });
  expect(
    (await send(platform, save({ ...current, expectedRevision: 2 }))).json(),
  ).toMatchObject({ changed: false, template: { status: 'unavailable' } });
  expect(
    (await send(platform, save({ ...current, projectId: 'poc' }))).statusCode,
  ).toBe(404);
  const { rows } = await pool.query(
    'select revision,name from capability_template_revision where template_id=$1 order by revision',
    [templateId],
  );
  expect(rows).toEqual([
    { revision: 1, name: 'Reviewed template' },
    { revision: 2, name: updates[1 - loser]!.name },
  ]);
  const [permissions] = (
    await pool.query(
      "select has_table_privilege('rdws_test_app','capability_template_revision','SELECT') readable, has_table_privilege('rdws_test_app','capability_template_revision','INSERT') insertable, has_table_privilege('rdws_test_app','capability_template_revision','UPDATE') mutable, has_table_privilege('rdws_test_app','capability_template_revision','DELETE') deletable, has_table_privilege('rdws_test_app','capability_template_revision','TRUNCATE') truncatable, pg_get_userbyid(relowner) owner from pg_class where oid='capability_template_revision'::regclass",
    )
  ).rows;
  expect(permissions).toMatchObject({
    readable: true,
    insertable: true,
    mutable: false,
    deletable: false,
    truncatable: false,
  });
  expect(permissions.owner).not.toBe('rdws_test_app');
});

test('template publication orders against retirement and rechecks expiry and membership after waiting', async () => {
  const projectId = 'template-lock-' + randomUUID();
  await pool.query('insert into project(id,name) values($1,$2)', [
    projectId,
    'Template lock fixture',
  ]);
  const client = await pool.connect();
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  const inFlight: Promise<unknown>[] = [];
  async function waitForBlockedQuery(
    label: string,
    sql: string,
    args: unknown[] = [],
  ) {
    await vi.waitFor(
      async () => {
        expect((await pool.query(sql, args)).rows[0].waiting, label).toBe(true);
      },
      { timeout: 1500 },
    );
  }
  const blockedHere =
    'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting';
  function save(revision: string) {
    const commandId = randomUUID();
    commandIds.push(commandId);
    return {
      kind: 'capability.template.save',
      commandId,
      projectId,
      name: 'Lock fixture',
      description: '',
      capabilities: [{ kind: 'skill', reference, revision }],
    };
  }
  try {
    const platform = await login('admin');
    await pool.query('update auth_user set platform_admin=true where id=$1', [
      actorId,
    ]);
    const other = await login(actorName);
    for (const revision of ['6.0.0', '7.0.0', '8.0.0'])
      expect((await send(platform, approval(true, revision))).statusCode).toBe(
        200,
      );

    await client.query('begin');
    await client.query(
      "update capability_approval set approved=false where reference=$1 and revision='6.0.0'",
      [reference],
    );
    const retiredFirst = Promise.resolve(send(platform, save('6.0.0')));
    inFlight.push(retiredFirst);
    await waitForBlockedQuery('retirement before save', blockedHere, [pid]);
    await client.query('commit');
    expect((await retiredFirst).json()).toMatchObject({
      changed: false,
      template: { status: 'unavailable' },
    });

    await client.query('begin');
    await client.query('lock table capability_template_revision in share mode');
    const savedFirst = Promise.resolve(send(platform, save('7.0.0')));
    inFlight.push(savedFirst);
    await waitForBlockedQuery('save waits for insert', blockedHere, [pid]);
    const savingPid = (
      await pool.query(
        'select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
        [pid],
      )
    ).rows[0].pid;
    const retire = Promise.resolve(send(other, approval(false, '7.0.0')));
    inFlight.push(retire);
    await waitForBlockedQuery('retirement waits for save', blockedHere, [
      savingPid,
    ]);
    await client.query('commit');
    expect((await savedFirst).json().template.status).toBe('saved');
    expect((await retire).json().changed).toBe(true);

    const expiresAt = (
      await pool.query(
        'select max(expires_at) expires_at from auth_session where user_id=$1',
        [actorId],
      )
    ).rows[0].expires_at as Date;
    await client.query('begin');
    await client.query(
      "select reference from capability_approval where reference=$1 and revision='8.0.0' for update",
      [reference],
    );
    const expired = save('8.0.0');
    const pending = Promise.resolve(send(other, expired));
    inFlight.push(pending);
    await waitForBlockedQuery('save waits before expiry', blockedHere, [pid]);
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(expiresAt.getTime() + 1000);
      await client.query('commit');
      expect((await pending).statusCode).toBe(401);
    } finally {
      vi.useRealTimers();
    }
    expect(
      (
        await pool.query(
          'select command_id from command_receipt where command_id=$1',
          [expired.commandId],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await pool.query(
          'select revision from capability_template_revision where project_id=$1',
          [projectId],
        )
      ).rowCount,
    ).toBe(1);

    await pool.query(
      "insert into project_member(project_id,user_id,role) select $1,id,'project_admin' from auth_user where username='pm'",
      [projectId],
    );
    const member = await login('pm');
    await client.query('begin');
    await client.query(
      'lock table capability_template_revision in access exclusive mode',
    );
    const read = Promise.resolve(
      app.inject({
        url: `/api/projects/${projectId}/capability-templates`,
        headers: { cookie: member },
      }),
    );
    inFlight.push(read);
    await waitForBlockedQuery(
      'member read waits before revocation',
      blockedHere,
      [pid],
    );
    await client.query('delete from project_member where project_id=$1', [
      projectId,
    ]);
    await client.query('commit');
    const response = await read;
    expect(response.statusCode).toBe(403);
    expect(response.body).not.toContain('Lock fixture');
  } finally {
    await client.query('rollback');
    client.release();
    await Promise.allSettled(inFlight);
    await pool.query(
      'delete from capability_template_revision where project_id=$1',
      [projectId],
    );
    await pool.query('delete from project_member where project_id=$1', [
      projectId,
    ]);
    await pool.query('delete from project where id=$1', [projectId]);
  }
});
