import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, expect, test, vi } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '@rdws/server';
import type { ManagementCommand, TemplateBindingInput } from '@rdws/contracts';
import { grantApplication } from '../../scripts/db-migrate.ts';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';

loadEnvironment('test');
const origin = process.env.RDWS_ORIGIN!;
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
const application = new Pool({ connectionString: process.env.DATABASE_URL });
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin,
});
const project = 'bind-' + randomUUID();
const foreignProject = 'bind-' + randomUUID();
const [demand, race, moving, foreign, retiredFirst, boundFirst] = Array.from(
  { length: 6 },
  () => randomUUID(),
) as [string, string, string, string, string, string];
const templateId = randomUUID(),
  foreignTemplate = randomUUID();
const reference = 'platform/binding-' + randomUUID();
const people = new Map<
  string,
  { id: string; sessionId: string; cookie: string }
>();
let beforeSend: (() => Promise<void>) | undefined;

app.addHook('preSerialization', async (request, _reply, payload) => {
  if (request.url.endsWith('/capability-template') && beforeSend) {
    const callback = beforeSend;
    beforeSend = undefined;
    await callback();
  }
  return payload;
});
const post = async (
  username: string,
  id: string,
  payload: Record<string, unknown>,
  requestOrigin = origin,
) =>
  app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/capability-template`,
    headers: {
      origin: requestOrigin,
      cookie: people.get(username)!.cookie,
      'x-rdws-edit-session': people.get(username)!.sessionId,
    },
    payload,
  });
const get = (username: string, id = demand) =>
  app.inject({
    method: 'GET',
    url: `/api/requirements/${id}/capability-template`,
    headers: { cookie: people.get(username)!.cookie },
  });
const choice = (revision = 1, template = templateId): TemplateBindingInput => ({
  commandId: randomUUID(),
  templateId: template,
  revision,
});
const role = (enabled: boolean) =>
  enabled
    ? pool.query(
        "insert into project_member values($1,$2,'project_admin') on conflict do nothing",
        [project, people.get('pm')!.id],
      )
    : pool.query(
        "delete from project_member where project_id=$1 and user_id=$2 and role='project_admin'",
        [project, people.get('pm')!.id],
      );
async function waitForBlock(pid: number) {
  await vi.waitFor(
    async () => {
      expect(
        (
          await pool.query(
            'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
            [pid],
          )
        ).rows[0].waiting,
      ).toBe(true);
    },
    { timeout: 1700, interval: 20 },
  );
}

const manage = (payload: ManagementCommand) =>
  app.inject({
    method: 'POST',
    url: '/api/management/commands',
    headers: { origin, cookie: people.get('admin')!.cookie },
    payload,
  });

async function publishSecond() {
  const result = await manage({
    kind: 'capability.template.save',
    commandId: randomUUID(),
    projectId: project,
    templateId,
    expectedRevision: 1,
    name: 'Reviewed version two',
    description: '',
    capabilities: [{ kind: 'skill', reference, revision: '2' }],
  });
  expect(result.statusCode).toBe(200);
  expect(result.json()).toMatchObject({
    template: { status: 'saved', revision: 2 },
  });
}

beforeAll(async () => {
  const identitySql = 'select current_database() db, session_user as role';
  expect((await pool.query(identitySql)).rows[0]).toEqual({
    db: 'rdws_test',
    role: 'rdws_test_migrator',
  });
  expect((await application.query(identitySql)).rows[0]).toEqual({
    db: 'rdws_test',
    role: 'rdws_test_app',
  });
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  for (const [index, username] of [
    'admin',
    'pm',
    'manager',
    'lead',
    'tester',
  ].entries()) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: `192.0.2.${60 + index}`,
      headers: { origin },
      payload: accounts.find((account) => account.username === username),
    });
    expect(login.statusCode).toBe(200);
    const cookie = login.cookies
      .map(({ name, value }) => `${name}=${value}`)
      .join('; ');
    const current = await app.inject({
      method: 'GET',
      url: '/api/auth/get-session',
      headers: { cookie },
    });
    people.set(username, {
      id: login.json().user.id,
      sessionId: current.json().session.id,
      cookie,
    });
  }
  await pool.query('insert into project(id,name) values($1,$3),($2,$3)', [
    project,
    foreignProject,
    'T14 synthetic',
  ]);
  for (const [username, projectRole] of [
    ['pm', 'project_admin'],
    ['tester', 'project_admin'],
    ['manager', 'requirement_manager'],
    ['lead', 'developer'],
  ]) {
    await pool.query('insert into project_member values($1,$2,$3)', [
      project,
      people.get(username!)!.id,
      projectRole,
    ]);
  }
  for (const id of [demand, race, moving, foreign, retiredFirst, boundFirst]) {
    const p = id === foreign ? foreignProject : project;
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
      [
        id,
        p,
        'Template binding fixture',
        'Synthetic',
        'Scoped binding',
        people.get('lead')!.id,
      ],
    );
  }
  await pool.query(
    "insert into requirement_participant values($1,$2,'developer'),($1,$3,'requirement_manager')",
    [demand, people.get('lead')!.id, people.get('manager')!.id],
  );
  await pool.query(
    "insert into capability_approval values('skill',$1,'1',true),('skill',$1,'2',true)",
    [reference],
  );
  await pool.query(
    'insert into capability_template_revision values($1,1,$2,$3,$4,$5),($6,1,$7,$8,$4,$9)',
    [
      templateId,
      project,
      'Reviewed version one',
      '',
      JSON.stringify([{ kind: 'skill', reference, revision: '1' }]),
      foreignTemplate,
      foreignProject,
      'Foreign template',
      '[]',
    ],
  );
});

beforeEach(async () => {
  beforeSend = undefined;
  await role(true);
  await pool.query(
    'delete from requirement_capability_binding where project_id=$1',
    [project],
  );
  await pool.query(
    'delete from capability_template_revision where template_id=$1 and revision=2',
    [templateId],
  );
  await pool.query(
    'update capability_approval set approved=true where reference=$1',
    [reference],
  );
  await pool.query('update requirement set project_id=$1 where id=$2', [
    project,
    moving,
  ]);
});

afterAll(async () => {
  await app.close();
  if (people.size === 5) {
    const ids = [demand, race, moving, foreign, retiredFirst, boundFirst];
    await pool.query(
      'delete from requirement_capability_binding where requirement_id=any($1::text[])',
      [ids],
    );
    await pool.query(
      'delete from requirement_participant where requirement_id=any($1::text[])',
      [ids],
    );
    await pool.query('delete from requirement where id=any($1::text[])', [ids]);
    await pool.query(
      'delete from capability_template_revision where project_id=any($1::text[])',
      [[project, foreignProject]],
    );
    await pool.query('delete from capability_approval where reference=$1', [
      reference,
    ]);
    await pool.query(
      'delete from command_receipt where scope=any($1::text[])',
      [[...ids.map((id) => 'requirement:' + id), 'project:' + project]],
    );
    await pool.query(
      'delete from project_member where project_id=any($1::text[])',
      [[project, foreignProject]],
    );
    await pool.query('delete from project where id=any($1::text[])', [
      [project, foreignProject],
    ]);
  }
  await pool.end();
  await application.end();
});

test('binding checks the observed login before selecting a demand or writing a receipt', async () => {
  const { cookie, sessionId } = people.get('pm')!;
  const differentLogin = people.get('tester')!.sessionId;
  const url = `/api/requirements/${demand}/capability-template`;
  const input = choice();
  for (const headers of [
    { cookie, origin },
    { cookie, origin, 'x-rdws-edit-session': differentLogin },
    { origin, 'x-rdws-edit-session': sessionId },
    { cookie, origin, 'x-rdws-edit-session': `${sessionId}, ${sessionId}` },
  ]) {
    const denied = await app.inject({
      method: 'POST',
      url,
      headers,
      payload: input,
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.json()).not.toHaveProperty('commandId');
  }
  for (const id of [demand, randomUUID()]) {
    const denied = await app.inject({
      method: 'GET',
      url: `/api/requirements/${id}/capability-template`,
      headers: { cookie, 'x-rdws-edit-session': differentLogin },
    });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['cache-control']).toBe('no-store');
    expect(denied.json()).not.toHaveProperty('options');
  }
  expect(
    (
      await app.inject({
        method: 'GET',
        url: `/api/projects/${project}/requirements`,
        headers: { cookie, 'x-rdws-edit-session': sessionId },
      })
    ).statusCode,
  ).toBe(403);
  const current = await app.inject({
    method: 'GET',
    url,
    headers: { cookie, 'x-rdws-edit-session': sessionId },
  });
  expect(current.statusCode).toBe(200);
  expect(current.json()).toEqual((await get('pm')).json());
  expect(current.json().binding).toBeNull();
  const head = await app.inject({ method: 'HEAD', url, headers: { cookie } });
  expect(head.statusCode).toBe(200);
  expect(head.headers['cache-control']).toBe('no-store');
  expect(head.body).toBe('');
  expect(
    (
      await app.inject({
        method: 'HEAD',
        url,
        headers: { cookie, 'x-rdws-edit-session': sessionId },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await pool.query('select 1 from command_receipt where command_id=$1', [
        input.commandId,
      ])
    ).rowCount,
  ).toBe(0);
});

test('only project admins bind exact published versions and other participants see a minimal state', async () => {
  expect((await get('pm')).json()).toEqual({
    binding: null,
    options: [{ templateId, revision: 1, name: 'Reviewed version one' }],
  });
  expect((await get('lead')).json()).toEqual({ binding: null });
  expect((await get('admin')).statusCode).toBe(403);
  expect((await get('pm', foreign)).statusCode).toBe(403);
  const first = choice();
  for (const username of ['admin', 'manager', 'lead'])
    expect((await post(username, demand, first)).statusCode).toBe(403);
  expect((await post('pm', foreign, first)).statusCode).toBe(403);
  expect(
    (await post('pm', demand, first, 'https://untrusted.invalid')).statusCode,
  ).toBe(403);
  for (const payload of [
    { ...first, revision: '1' },
    { ...first, templateId: [templateId] },
    { ...first, projectId: project },
  ]) {
    expect((await post('pm', demand, payload)).statusCode).toBe(400);
  }
  const original = await post('pm', demand, first);
  expect(original.statusCode).toBe(200);
  expect(original.headers['cache-control']).toBe('no-store');
  expect(original.json()).toEqual({
    commandId: first.commandId,
    status: 'saved',
    replayed: false,
    before: null,
    after: { templateId, revision: 1 },
  });
  const staleReceipt = await app.inject({
    method: 'POST',
    url: `/api/requirements/${demand}/capability-template`,
    headers: {
      origin,
      cookie: people.get('tester')!.cookie,
      'x-rdws-edit-session': people.get('pm')!.sessionId,
    },
    payload: first,
  });
  expect(staleReceipt.statusCode).toBe(401);
  expect(staleReceipt.headers['cache-control']).toBe('no-store');
  expect(staleReceipt.json()).not.toHaveProperty('commandId');
  expect(
    (
      await pool.query(
        'select actor_id from command_receipt where command_id=$1',
        [first.commandId],
      )
    ).rows,
  ).toEqual([{ actor_id: people.get('pm')!.id }]);
  const current = await get('lead');
  expect(current.headers['cache-control']).toBe('no-store');
  expect(current.json()).toEqual({
    binding: {
      templateId,
      revision: 1,
      available: true,
      name: 'Reviewed version one',
    },
  });

  await publishSecond();
  expect((await get('pm')).json()).toMatchObject({
    binding: { revision: 1 },
    options: expect.arrayContaining([
      { templateId, revision: 1, name: 'Reviewed version one' },
      { templateId, revision: 2, name: 'Reviewed version two' },
    ]),
  });
  expect((await post('pm', demand, choice(2))).json()).toMatchObject({
    status: 'saved',
    before: { revision: 1 },
    after: { revision: 2 },
  });
  expect((await post('pm', demand, choice())).json()).toMatchObject({
    status: 'saved',
    before: { revision: 2 },
    after: { revision: 1 },
  });
  const unknown = choice(1, foreignTemplate);
  const unavailable = await post('pm', demand, unknown);
  expect(unavailable.json()).toMatchObject({
    status: 'unavailable',
    before: { revision: 1 },
    after: { revision: 1 },
    replayed: false,
  });
  expect((await post('pm', demand, unknown)).json()).toMatchObject({
    status: 'unavailable',
    replayed: true,
  });
  expect((await post('pm', demand, { ...first, revision: 2 })).statusCode).toBe(
    409,
  );
});

test('cross-project foreign keys and application column grants survive rollback of grant changes', async () => {
  const insert =
    'insert into requirement_capability_binding values($1,$2,$3,$4)';
  await expect(
    application.query(insert, [foreign, project, templateId, 1]),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'requirement_capability_binding_demand_fk',
  });
  await expect(
    application.query(insert, [moving, project, foreignTemplate, 1]),
  ).rejects.toMatchObject({
    code: '23503',
    constraint: 'requirement_capability_binding_template_fk',
  });
  const [rights] = (
    await pool.query(`select
    pg_get_userbyid(relowner) owner,
    has_table_privilege('rdws_test_app',oid,'UPDATE') wide_update,
    has_table_privilege('rdws_test_app',oid,'DELETE') deletable,
    has_table_privilege('rdws_test_app',oid,'TRUNCATE') truncatable,
    has_column_privilege('rdws_test_app',oid,'template_id','UPDATE') template_update,
    has_column_privilege('rdws_test_app',oid,'revision','UPDATE') revision_update,
    has_column_privilege('rdws_test_app',oid,'project_id','UPDATE') project_update,
    has_column_privilege('rdws_test_app',oid,'requirement_id','UPDATE') demand_update
    from pg_class where oid='requirement_capability_binding'::regclass`)
  ).rows;
  expect(rights).toMatchObject({
    wide_update: false,
    deletable: false,
    truncatable: false,
    template_update: true,
    revision_update: true,
    project_update: false,
    demand_update: false,
  });
  expect(rights.owner).not.toBe('rdws_test_app');
  const client = await pool.connect();
  try {
    const query = ((statement: string) => {
      if (
        statement.startsWith(
          'revoke update, delete, truncate on requirement_capability_binding',
        )
      )
        throw new Error('Injected grant failure');
      return client.query(statement);
    }) as typeof client.query;
    await expect(grantApplication({ query }, 'rdws_test_app')).rejects.toThrow(
      'Injected grant failure',
    );
  } finally {
    client.release();
  }
  await expect(
    application.query(
      'update requirement_capability_binding set project_id=$1 where requirement_id=$2',
      [project, demand],
    ),
  ).rejects.toMatchObject({ code: '42501' });
  await expect(
    application.query(
      'delete from requirement_capability_binding where requirement_id=$1',
      [demand],
    ),
  ).rejects.toMatchObject({ code: '42501' });
});

test('real database ordering preserves truthful before and after and keeps an old receipt separate', async () => {
  await publishSecond();
  const blocker = await pool.connect();
  const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
  const a = choice(),
    b = choice(2);
  const pending: ReturnType<typeof post>[] = [];
  try {
    await blocker.query('begin');
    await blocker.query('select id from requirement where id=$1 for update', [
      race,
    ]);
    const first = post('pm', race, a);
    pending.push(first);
    await waitForBlock(pid);
    const second = post('tester', race, b);
    pending.push(second);
    await blocker.query('commit');
    expect((await first).json()).toMatchObject({
      status: 'saved',
      before: null,
      after: { revision: 1 },
    });
    expect((await second).json()).toMatchObject({
      status: 'saved',
      before: { revision: 1 },
      after: { revision: 2 },
    });
    expect((await post('pm', race, a)).json()).toMatchObject({
      replayed: true,
      before: null,
      after: { revision: 1 },
    });
    expect((await get('pm', race)).json()).toMatchObject({
      binding: { revision: 2 },
    });
    const same = choice(2);
    const copies = await Promise.all([
      post('pm', race, same),
      post('pm', race, same),
    ]);
    expect(copies.map((copy) => copy.json().replayed).sort()).toEqual([
      false,
      true,
    ]);
    expect(copies.every((copy) => copy.json().status === 'unchanged')).toBe(
      true,
    );
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          same.commandId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await blocker.query('rollback');
    await Promise.allSettled(pending);
    blocker.release();
  }
});

test('a blocked write rechecks both the original project and the actual login deadline', async () => {
  const blocker = await pool.connect();
  const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending: ReturnType<typeof post>[] = [];
  const moved = choice();
  const expired = choice();
  try {
    await blocker.query('begin');
    await blocker.query('update requirement set project_id=$1 where id=$2', [
      foreignProject,
      moving,
    ]);
    const waiting = post('pm', moving, moved);
    pending.push(waiting);
    await waitForBlock(pid);
    await blocker.query('commit');
    expect((await waiting).statusCode).toBe(403);
    const expires = (
      await pool.query('select expires_at from auth_session where id=$1', [
        people.get('pm')!.sessionId,
      ])
    ).rows[0].expires_at as Date;
    await blocker.query('begin');
    await blocker.query('select id from requirement where id=$1 for update', [
      retiredFirst,
    ]);
    const next = post('pm', retiredFirst, expired);
    pending.push(next);
    await waitForBlock(pid);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expires.getTime() + 2000);
    await blocker.query('commit');
    expect((await next).statusCode).toBe(401);
    vi.useRealTimers();
    expect(
      (
        await pool.query(
          'select 1 from command_receipt where command_id=any($1::text[])',
          [[moved.commandId, expired.commandId]],
        )
      ).rowCount,
    ).toBe(0);
  } finally {
    vi.useRealTimers();
    await blocker.query('rollback');
    await Promise.allSettled(pending);
    blocker.release();
  }
});

test('a late downgrade hides privileged GET, committed writes and command conflicts until authorization returns', async () => {
  await publishSecond();
  expect((await post('pm', demand, choice())).statusCode).toBe(200);
  try {
    beforeSend = async () => {
      await role(false);
    };
    expect((await get('pm')).statusCode).toBe(403);
    await role(true);
    const changed = choice(2);
    beforeSend = async () => {
      await role(false);
    };
    expect((await post('pm', demand, changed)).statusCode).toBe(403);
    expect((await get('lead')).json()).toMatchObject({
      binding: { revision: 2 },
    });
    expect((await post('pm', demand, changed)).statusCode).toBe(403);
    await role(true);
    beforeSend = async () => {
      await role(false);
    };
    const conflict = await post('pm', demand, { ...changed, revision: 1 });
    expect(conflict.statusCode).toBe(403);
    expect(conflict.body).not.toContain('操作标识已用于不同内容');
    await role(true);
    expect((await post('pm', demand, changed)).json()).toMatchObject({
      status: 'saved',
      replayed: true,
    });
    beforeSend = async () => {
      for (const enabled of [false, true]) {
        const result = await manage({
          kind: 'project.admin',
          commandId: randomUUID(),
          projectId: project,
          username: 'pm',
          enabled,
        });
        expect(result.statusCode).toBe(200);
        expect(result.json().changed).toBe(true);
      }
    };
    expect(
      (await post('pm', demand, { ...changed, revision: 1 })).statusCode,
    ).toBe(401);
    expect((await post('pm', demand, changed)).json()).toMatchObject({
      status: 'saved',
      replayed: true,
    });
  } finally {
    beforeSend = undefined;
    await role(true);
  }
});

test('retirement and binding are ordered by locks and retired bindings remain visible', async () => {
  await publishSecond();
  const blocker = await pool.connect();
  const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0].pid;
  const pending: Promise<unknown>[] = [];
  try {
    await blocker.query('begin');
    await blocker.query(
      "update capability_approval set approved=false where reference=$1 and revision='1'",
      [reference],
    );
    const retired = post('pm', retiredFirst, choice());
    pending.push(retired);
    await waitForBlock(pid);
    await blocker.query('commit');
    expect((await retired).json()).toMatchObject({
      status: 'unavailable',
      before: null,
      after: null,
    });
    const invalidated = (await get('pm', race)).json().options as {
      revision: number;
    }[];
    expect(invalidated.map((item) => item.revision)).toEqual([2]);

    await blocker.query('begin');
    await blocker.query(
      'lock table requirement_capability_binding in share mode',
    );
    const binding = post('pm', boundFirst, choice(2));
    pending.push(binding);
    await waitForBlock(pid);
    const waiters = (
      await pool.query(
        'select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
        [pid],
      )
    ).rows;
    const retirement = pool.query(
      "update capability_approval set approved=false where reference=$1 and revision='2'",
      [reference],
    );
    pending.push(retirement);
    await waitForBlock(waiters[0]!.pid);
    await blocker.query('commit');
    expect((await binding).json()).toMatchObject({ status: 'saved' });
    await retirement;
    expect((await get('pm', boundFirst)).json()).toMatchObject({
      binding: { revision: 2, available: false },
      options: [],
    });
  } finally {
    await blocker.query('rollback');
    await Promise.allSettled(pending);
    blocker.release();
  }
});
