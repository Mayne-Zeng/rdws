import { createHash, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { bootstrapNative } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { Pool } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

loadEnvironment('test');
const options = {
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
};
const pool = createTestPool('migration');
const app = buildApp(options);
const project = 'details-' + randomUUID(),
  peerProject = 'details-' + randomUUID(),
  foreignProject = 'details-' + randomUUID();
const demand = randomUUID(),
  race = randomUUID(),
  late = randomUUID(),
  auditDemand = randomUUID(),
  projectAuditFirst = randomUUID(),
  projectAuditSecond = randomUUID(),
  projectAuditHidden = randomUUID(),
  crossProjectFirst = randomUUID(),
  crossProjectPeer = randomUUID(),
  crossProjectMismatch = randomUUID(),
  foreign = randomUUID(),
  unassigned = randomUUID(),
  nativeDemand = randomUUID();
const demands = [
  demand,
  race,
  late,
  auditDemand,
  projectAuditFirst,
  projectAuditSecond,
  projectAuditHidden,
  crossProjectFirst,
  crossProjectPeer,
  crossProjectMismatch,
  foreign,
  unassigned,
  nativeDemand,
];
const members = new Map<
  string,
  { id: string; cookie: string; sessionId: string }
>();
let isolated = false;
let beforeResponse: (() => Promise<void>) | undefined;

app.addHook('preSerialization', async (request, _reply, payload) => {
  if (
    beforeResponse &&
    (request.url.startsWith(`/api/requirements/${late}`) ||
      request.url.startsWith(
        `/api/requirements/${auditDemand}/business-audit`,
      ) ||
      request.url.startsWith(`/api/projects/${project}/business-audit`) ||
      request.url.startsWith('/api/audit/business'))
  ) {
    const callback = beforeResponse;
    beforeResponse = undefined;
    await callback();
  }
  return payload;
});

test('searches authorized business events across projects and fences exact lookahead ownership', async () => {
  const path = '/api/audit/business';
  const read = (
    user: string,
    filters: Record<string, string>,
    observed = members.get(user)!.sessionId,
  ) =>
    app.inject({
      url: path + '?' + new URLSearchParams(filters),
      headers: {
        cookie: members.get(user)!.cookie,
        'x-rdws-edit-session': observed,
      },
    });
  const tester = members.get('tester')!;
  const keyword = 'Cross-project %_ ' + randomUUID();
  const marker = 'SYNTHETIC_PRIVATE_CROSS_AUDIT_' + randomUUID();
  await pool.query('update requirement set title=$1 where id=any($2::text[])', [
    keyword,
    [crossProjectFirst, crossProjectPeer, crossProjectMismatch, foreign],
  ]);
  await pool.query("insert into project_member values($1,$2,'developer')", [
    peerProject,
    tester.id,
  ]);
  await pool.query(
    "insert into requirement_participant values($1,$2,'developer')",
    [crossProjectPeer, tester.id],
  );
  const at = '2026-02-10T01:02:03.314159Z';
  const older = '2026-02-10T01:02:03.314158Z';
  const seed = async (demandId: string, ids: string[], recordedAt: string) =>
    pool.query(
      `insert into requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,"after",created_at)
      select id,$2,'requirement.details',$3,'web',$4,1,$5::jsonb,$6::timestamptz
      from unnest($1::text[]) as id`,
      [
        ids,
        demandId,
        members.get('lead')!.id,
        marker,
        JSON.stringify({ description: marker }),
        recordedAt,
      ],
    );
  const firstIds = Array.from({ length: 25 }, () => randomUUID())
    .sort()
    .reverse();
  const peerId = randomUUID(),
    lastId = randomUUID(),
    mismatchId = randomUUID(),
    outsiderId = randomUUID();
  const invalidId = '!' + randomUUID();
  await seed(crossProjectFirst, [...firstIds, invalidId], at);
  await seed(crossProjectPeer, [peerId], older);
  await seed(crossProjectFirst, [lastId], '2026-02-10T01:02:03.314157Z');
  await seed(crossProjectMismatch, [mismatchId], at);
  await seed(foreign, [outsiderId], at);

  const filters = { q: keyword, kind: 'requirement.details' };
  const first = await read('tester', filters);
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('no-store');
  const page = first.json();
  expect(page.scope).toBe('accessible-projects');
  expect(page.events.map(({ id }: { id: string }) => id)).toEqual(firstIds);
  expect(
    page.events.every(
      ({
        projectId,
        projectName,
      }: {
        projectId: string;
        projectName: string;
      }) => projectId === project && projectName === 'Synthetic details',
    ),
  ).toBe(true);
  expect(page.next).toEqual({ at, id: firstIds.at(-1) });
  const next = await read('tester', {
    ...filters,
    beforeAt: page.next.at,
    beforeId: page.next.id,
  });
  expect(next.statusCode).toBe(200);
  expect(next.json()).toMatchObject({
    next: null,
    events: [
      {
        id: peerId,
        projectId: peerProject,
        projectName: 'Synthetic details',
        requirementId: crossProjectPeer,
        requirementTitle: keyword,
      },
      { id: lastId, projectId: project, requirementId: crossProjectFirst },
    ],
  });
  for (const excluded of [
    marker,
    mismatchId,
    outsiderId,
    foreignProject,
    invalidId,
  ])
    expect(first.body + next.body).not.toContain(excluded);
  expect((await read('admin', filters)).json()).toEqual({
    scope: 'accessible-projects',
    next: null,
    events: [],
  });
  expect((await read('tester', { q: marker })).json().events).toEqual([]);
  expect((await read('tester', { projectId: foreignProject })).statusCode).toBe(
    400,
  );
  expect((await read('tester', { beforeAt: at })).statusCode).toBe(400);
  expect((await read('tester', filters, randomUUID())).statusCode).toBe(401);
  expect((await app.inject({ url: path })).statusCode).toBe(401);
  expect(
    (await app.inject({ url: path, headers: { cookie: tester.cookie } }))
      .statusCode,
  ).toBe(401);
  expect(
    (
      await app.inject({
        url: path,
        method: 'HEAD',
        headers: { cookie: tester.cookie },
      })
    ).statusCode,
  ).toBe(404);

  beforeResponse = async () => {
    await pool.query('update requirement set project_id=$1 where id=$2', [
      project,
      crossProjectPeer,
    ]);
  };
  try {
    const moved = await read('tester', filters);
    expect(moved.statusCode).toBe(403);
    expect(moved.json()).not.toHaveProperty('events');
    expect(
      (
        await read('tester', {
          ...filters,
          beforeAt: at,
          beforeId: firstIds.at(-1)!,
        })
      ).json().events,
    ).toContainEqual(
      expect.objectContaining({ id: peerId, projectId: project }),
    );
  } finally {
    beforeResponse = undefined;
    await pool.query('update requirement set project_id=$1 where id=$2', [
      peerProject,
      crossProjectPeer,
    ]);
  }

  beforeResponse = async () => {
    await pool.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='developer'",
      [peerProject, tester.id],
    );
  };
  try {
    const revoked = await read('tester', filters);
    expect(revoked.statusCode).toBe(403);
    expect(revoked.body).not.toContain(firstIds[0]!);
  } finally {
    beforeResponse = undefined;
  }
});

test('searches project business events with exact microsecond cursors and rechecks lookahead access', async () => {
  const read = (
    user: string,
    query: Record<string, string> = {},
    projectId = project,
    observedLogin = members.get(user)!.sessionId,
  ) =>
    app.inject({
      url:
        `/api/projects/${projectId}/business-audit?` +
        new URLSearchParams(query),
      headers: {
        cookie: members.get(user)!.cookie,
        'x-rdws-edit-session': observedLogin,
      },
    });
  const keyword = 'Synthetic audit %_';
  await pool.query('update requirement set title=$1 where id=any($2::text[])', [
    keyword,
    [projectAuditFirst, projectAuditSecond, projectAuditHidden, foreign],
  ]);
  await pool.query('update requirement set title=$1 where id=$2', [
    'Synthetic audit AB',
    unassigned,
  ]);
  await pool.query(
    "delete from requirement_participant where requirement_id=$1 and user_id=$2 and role='tester'",
    [projectAuditHidden, members.get('tester')!.id],
  );
  const marker = 'PRIVATE_AUDIT_FIXTURE_' + randomUUID();
  const newest = '2026-02-10T01:02:03.314159Z';
  async function seed(demandId: string, amount: number, at: string) {
    const ids = Array.from({ length: amount }, () => randomUUID());
    await pool.query(
      `insert into requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,"after",created_at)
        select id, $2, 'task.updated', $3, 'web', $4, 1, $5::jsonb, $6::timestamptz
        from unnest($1::text[]) as id`,
      [
        ids,
        demandId,
        members.get('lead')!.id,
        marker,
        JSON.stringify({ status: 'done', description: marker }),
        at,
      ],
    );
    return ids;
  }
  const firstIds = await seed(projectAuditFirst, 25, newest);
  const [secondId] = await seed(
    projectAuditSecond,
    1,
    '2026-02-10T01:02:03.314158Z',
  );
  const [lastId] = await seed(
    projectAuditFirst,
    1,
    '2026-02-10T01:02:03.314157Z',
  );
  const [hiddenId] = await seed(
    projectAuditHidden,
    1,
    '2026-02-10T01:02:03.314160Z',
  );
  const [foreignId] = await seed(foreign, 1, '2026-02-10T01:02:03.314160Z');
  const [wildcardId] = await seed(unassigned, 1, '2026-02-10T01:02:03.314160Z');

  const filters = { q: keyword, kind: 'task.updated' };
  const first = await read('tester', filters);
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('no-store');
  const page = first.json();
  expect(page.projectId).toBe(project);
  expect(page.events.map(({ id }: { id: string }) => id)).toEqual(
    firstIds.sort().reverse(),
  );
  expect(page.next).toEqual({ at: newest, id: firstIds.at(-1) });
  const next = await read('tester', {
    ...filters,
    beforeAt: page.next.at,
    beforeId: page.next.id,
  });
  expect(next.statusCode).toBe(200);
  expect(next.json().events).toMatchObject([
    {
      id: secondId,
      requirementId: projectAuditSecond,
      requirementTitle: keyword,
      taskStatus: { after: 'done' },
    },
    { id: lastId, requirementId: projectAuditFirst },
  ]);
  expect(next.json().next).toBeNull();
  for (const excluded of [marker, hiddenId, foreignId, wildcardId])
    expect(first.body + next.body).not.toContain(excluded!);
  expect((await read('tester', { q: marker })).json().events).toEqual([]);
  expect(
    (await read('tester', { ...filters, kind: 'requirement.stage' })).json()
      .events,
  ).toEqual([]);
  expect((await read('admin', filters)).statusCode).toBe(403);
  expect((await read('tester', filters, foreignProject)).statusCode).toBe(403);
  expect(
    (await read('tester', filters, project, randomUUID())).statusCode,
  ).toBe(401);
  const withoutObservation = {
    url: `/api/projects/${project}/business-audit`,
    headers: { cookie: members.get('tester')!.cookie },
  };
  expect((await app.inject(withoutObservation)).statusCode).toBe(401);
  expect(
    (await app.inject({ ...withoutObservation, method: 'HEAD' })).statusCode,
  ).toBe(404);
  expect((await read('tester', { beforeAt: newest })).statusCode).toBe(400);
  expect(
    (
      await read('tester', {
        beforeAt: '2026-02-30T01:02:03.314159Z',
        beforeId: firstIds[0]!,
      })
    ).statusCode,
  ).toBe(400);

  const actorName = (
    await pool.query('select name from auth_user where id=$1', [
      members.get('lead')!.id,
    ])
  ).rows[0].name as string;
  const byActor = await read('tester', { q: actorName, kind: 'task.updated' });
  expect(byActor.statusCode).toBe(200);
  expect(byActor.json().events).toContainEqual(
    expect.objectContaining({ actorId: members.get('lead')!.id }),
  );
  const administratorView = await read('pm', filters);
  expect(administratorView.statusCode).toBe(200);
  expect(administratorView.json().events).toContainEqual(
    expect.objectContaining({
      id: hiddenId,
      requirementId: projectAuditHidden,
    }),
  );

  beforeResponse = async () => {
    await pool.query(
      "delete from requirement_participant where requirement_id=$1 and user_id=$2 and role='tester'",
      [projectAuditSecond, members.get('tester')!.id],
    );
  };
  const revokedLookahead = await read('tester', filters);
  expect(revokedLookahead.statusCode).toBe(403);
  expect(revokedLookahead.body).not.toContain(firstIds[0]!);
  const tester = members.get('tester')!.id;
  beforeResponse = async () => {
    await pool.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='tester'",
      [project, tester],
    );
  };
  try {
    const revokedEmpty = await read('tester', { q: marker });
    expect(revokedEmpty.statusCode).toBe(403);
    expect(revokedEmpty.json()).not.toHaveProperty('events');
  } finally {
    await pool.query(
      "insert into project_member values($1,$2,'tester') on conflict do nothing",
      [project, tester],
    );
  }
});

test('reads an authorized business audit cut without exporting original business values', async () => {
  const readAudit = (
    user: string,
    id = auditDemand,
    query = '',
    login = members.get(user)!.sessionId,
  ) =>
    app.inject({
      url: `/api/requirements/${id}/business-audit${query}`,
      headers: {
        cookie: members.get(user)!.cookie,
        'x-rdws-edit-session': login,
      },
    });
  const marker = 'SYNTHETIC_AUDIT_PAYLOAD_' + randomUUID();
  const changed = await post(
    'manager',
    auditDemand,
    intent({ description: marker }),
  );
  expect(changed.statusCode).toBe(200);
  const version = changed.json().contextVersion as number;
  const eventIds = Array.from({ length: 25 }, () => randomUUID());
  const taskId = randomUUID();
  await pool.query(
    `insert into requirement_event(id,requirement_id,task_id,kind,actor_id,source,command_id,version,"before","after")
     select event, $2, $3, 'task.updated', $4, 'web', $5, $6, $7::jsonb, $8::jsonb
     from unnest($1::text[]) as event`,
    [
      eventIds,
      auditDemand,
      taskId,
      members.get('lead')!.id,
      marker,
      version,
      JSON.stringify({ status: 'todo', description: marker }),
      JSON.stringify({ status: 'in_progress', description: marker }),
    ],
  );
  const first = await readAudit('tester');
  expect(first.statusCode).toBe(200);
  expect(first.headers['cache-control']).toBe('no-store');
  const page = first.json();
  expect(page.throughVersion).toBe(version);
  expect(page.events).toHaveLength(25);
  expect(page.events).toContainEqual(
    expect.objectContaining({
      kind: 'task.updated',
      taskId,
      actorId: members.get('lead')!.id,
      taskStatus: { before: 'todo', after: 'in_progress' },
    }),
  );
  expect(first.body).not.toContain(marker);
  expect(page.next).toMatchObject({ version, id: page.events.at(-1).id });
  const later = await post(
    'manager',
    auditDemand,
    intent({ acceptance: 'New audit cut' }),
  );
  expect(later.statusCode).toBe(200);
  const next = await readAudit(
    'tester',
    auditDemand,
    '?' +
      new URLSearchParams({
        throughVersion: String(page.throughVersion),
        beforeVersion: String(page.next.version),
        beforeId: page.next.id,
      }),
  );
  expect(next.statusCode).toBe(200);
  expect(next.json().events).toHaveLength(1);
  expect(next.json().throughVersion).toBe(version);
  expect(next.json().next).toBeNull();
  const all = [...page.events, ...next.json().events];
  expect(all.every((event) => event.version === version)).toBe(true);
  expect(new Set(all.map(({ id }) => id)).size).toBe(26);
  expect(all.map(({ id }) => id)).toEqual(
    all
      .map(({ id }) => id)
      .sort()
      .reverse(),
  );
  expect(all.find(({ kind }) => kind === 'requirement.details')).toMatchObject({
    actorId: members.get('manager')!.id,
    changedFields: ['description'],
  });
  expect(next.body).not.toContain(marker);
  expect((await readAudit('admin')).statusCode).toBe(403);
  expect((await readAudit('pm', foreign)).statusCode).toBe(403);
  expect((await readAudit('manager', unassigned)).statusCode).toBe(403);
  expect(
    (await readAudit('tester', auditDemand, '', randomUUID())).statusCode,
  ).toBe(401);
  expect(
    (await readAudit('tester', auditDemand, '?beforeVersion=1')).statusCode,
  ).toBe(400);
  expect(
    (await readAudit('tester', auditDemand, '?throughVersion=2147483647'))
      .statusCode,
  ).toBe(400);
  beforeResponse = async () => {
    await pool.query(
      "delete from requirement_participant where requirement_id=$1 and user_id=$2 and role='tester'",
      [auditDemand, members.get('tester')!.id],
    );
  };
  const revoked = await readAudit('tester');
  expect(revoked.statusCode).toBe(403);
  expect(revoked.body).not.toContain(eventIds[0]!);
});

const get = (user: string, id: string) =>
  app.inject({
    method: 'GET',
    url: `/api/requirements/${id}`,
    headers: { cookie: members.get(user)!.cookie },
  });
const post = async (
  user: string,
  id: string,
  payload: Record<string, unknown>,
  observedSession = members.get(user)!.sessionId,
) =>
  app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/details`,
    headers: {
      origin: options.origin,
      cookie: members.get(user)!.cookie,
      'x-rdws-edit-session': observedSession,
    },
    payload,
  });
const intent = (patch: Record<string, unknown>) => ({
  commandId: randomUUID(),
  patch,
});
const managerRole = (enabled: boolean) =>
  enabled
    ? pool.query(
        "insert into project_member values($1,$2,'requirement_manager') on conflict do nothing",
        [project, members.get('manager')!.id],
      )
    : pool.query(
        "delete from project_member where project_id=$1 and user_id=$2 and role='requirement_manager'",
        [project, members.get('manager')!.id],
      );
async function waitsOn(pid: number) {
  await vi.waitFor(
    async () =>
      expect(
        (
          await pool.query(
            'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
            [pid],
          )
        ).rows[0].waiting,
      ).toBe(true),
    { timeout: 1700 },
  );
}

beforeAll(async () => {
  expect(
    (await pool.query('select current_database() db, session_user role'))
      .rows[0],
  ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
  const application = new Pool({ connectionString: options.databaseUrl });
  try {
    expect(
      (
        await application.query(
          'select current_database() db, session_user role',
        )
      ).rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_app' });
  } finally {
    await application.end();
  }
  isolated = true;
  const accounts = await readTestAccounts();
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
      headers: { origin: options.origin },
      remoteAddress: `192.0.2.${91 + index}`,
      payload: accounts.find((row) => row.username === username),
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
    members.set(username, {
      id: login.json().user.id,
      cookie,
      sessionId: current.json().session.id,
    });
  }
  await pool.query(
    'insert into project(id,name) values($1,$4),($2,$4),($3,$4)',
    [project, peerProject, foreignProject, 'Synthetic details'],
  );
  const manager = members.get('manager')!.id,
    lead = members.get('lead')!.id,
    pm = members.get('pm')!.id,
    tester = members.get('tester')!.id;
  await pool.query(
    "insert into project_member values($1,$2,'project_admin'),($1,$3,'requirement_manager'),($1,$3,'developer'),($1,$4,'developer'),($1,$5,'tester'),($6,$4,'project_admin')",
    [project, pm, manager, lead, tester, foreignProject],
  );
  for (const id of demands) {
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$7)',
      [
        id,
        id === foreign
          ? foreignProject
          : id === crossProjectPeer || id === crossProjectMismatch
            ? peerProject
            : project,
        'Original title',
        'Original description',
        'Original acceptance',
        lead,
        manager,
      ],
    );
    if (id !== foreign)
      await pool.query(
        "insert into requirement_participant values($1,$2,'developer'),($1,$3,'tester')",
        [id, lead, tester],
      );
    if (id !== foreign && id !== unassigned)
      await pool.query(
        "insert into requirement_participant values($1,$2,'requirement_manager'),($1,$2,'developer')",
        [id, manager],
      );
  }
});

afterAll(async () => {
  await app.close();
  try {
    if (!isolated) return;
    for (const table of [
      'session_operation',
      'native_session',
      'task',
      'requirement_event',
      'requirement_worktree_plan',
      'requirement_participant',
    ])
      await pool.query(
        `delete from ${table} where requirement_id=any($1::text[])`,
        [demands],
      );
    await pool.query('delete from requirement where id=any($1::text[])', [
      demands,
    ]);
    await pool.query(
      'delete from command_receipt where scope=any($1::text[])',
      [demands.map((id) => 'requirement:' + id)],
    );
    await pool.query(
      'delete from project_member where project_id=any($1::text[])',
      [[project, peerProject, foreignProject]],
    );
    await pool.query('delete from project where id=any($1::text[])', [
      [project, peerProject, foreignProject],
    ]);
  } finally {
    await pool.end();
  }
});

test('only current demand editors can write valid details, and readers receive a redacted history', async () => {
  expect((await get('pm', demand)).json().permissions.canEditDetails).toBe(
    true,
  );
  expect((await get('manager', demand)).json().permissions.canEditDetails).toBe(
    true,
  );
  expect((await get('lead', demand)).json().permissions).toMatchObject({
    canEditDetails: false,
    canChangeStage: true,
  });
  const good = intent({
    title: '  已更新 🌏  ',
    description: 'Internal text updated',
    acceptance: '',
  });
  for (const user of ['admin', 'lead', 'tester'])
    expect((await post(user, demand, good)).statusCode).toBe(403);
  expect((await post('manager', unassigned, good)).statusCode).toBe(403);
  expect((await post('pm', foreign, good)).statusCode).toBe(403);
  expect(
    (await post('pm', demand, good, members.get('manager')!.sessionId))
      .statusCode,
  ).toBe(401);
  const staleRead = await app.inject({
    method: 'GET',
    url: `/api/requirements/${demand}`,
    headers: {
      cookie: members.get('pm')!.cookie,
      'x-rdws-edit-session': members.get('manager')!.sessionId,
    },
  });
  expect(staleRead.statusCode).toBe(401);
  expect(staleRead.json()).not.toHaveProperty('requirement');
  const invalid = [
    {},
    { leadId: 'denied' },
    { title: ['x'] },
    { title: 42 },
    { title: '   ' },
    { title: '\ud800' },
    { description: '\0' },
    { acceptance: 'a'.repeat(8001) },
  ];
  for (const patch of invalid) {
    const rejected = await post('pm', demand, { ...good, patch });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json().code).toBe('invalid-details');
  }
  expect(
    (
      await post(
        'pm',
        unassigned,
        intent({ title: '  ' + '界'.repeat(160) + '  ' }),
      )
    ).statusCode,
  ).toBe(200);
  expect((await get('pm', unassigned)).json().requirement.title).toBe(
    '界'.repeat(160),
  );
  const unchangedBefore = (await get('lead', demand)).json();
  const plan = [
    {
      repositoryId: 'fixture',
      baseCommit: 'a'.repeat(40),
      baselineRef: 'refs/heads/main',
      sourceBinding: 'b'.repeat(64),
      branch: 'rdws/' + demand + '/fixture',
      worktreePath: 'worktrees/fixture',
      gitStorePath: '.gitstore/fixture.git',
    },
  ];
  await pool.query('insert into requirement_worktree_plan values($1,$2)', [
    demand,
    JSON.stringify(plan),
  ]);
  const changed = await post('pm', demand, good);
  expect(changed.statusCode).toBe(200);
  expect(changed.headers['cache-control']).toBe('no-store');
  expect(changed.json()).toEqual({
    commandId: good.commandId,
    changed: true,
    contextVersion: 2,
  });
  expect(
    (
      await pool.query(
        'select repositories from requirement_worktree_plan where requirement_id=$1',
        [demand],
      )
    ).rows[0].repositories,
  ).toEqual(plan);
  const stored = await pool.query(
    'select actor_id,"before","after" from requirement_event where command_id=$1',
    [good.commandId],
  );
  expect(stored.rows).toEqual([
    {
      actor_id: members.get('pm')!.id,
      before: {
        title: 'Original title',
        description: 'Original description',
        acceptance: 'Original acceptance',
      },
      after: {
        title: '已更新 🌏',
        description: 'Internal text updated',
        acceptance: '',
      },
    },
  ]);
  const data = await get('lead', demand);
  expect(data.headers['cache-control']).toBe('no-store');
  expect(data.json()).toMatchObject({
    requirement: {
      projectId: project,
      leadId: unchangedBefore.requirement.leadId,
      stage: unchangedBefore.requirement.stage,
      title: '已更新 🌏',
      description: 'Internal text updated',
      acceptance: '',
    },
    participants: unchangedBefore.participants,
  });
  const activity = data.json().events[0];
  expect(activity).not.toHaveProperty('commandId');
  expect(activity).toMatchObject({
    kind: 'requirement.details',
    actorName: 'pm',
    changedFields: expect.arrayContaining([
      'title',
      'description',
      'acceptance',
    ]),
    before: null,
    after: null,
  });
  expect(
    (await post('pm', demand, intent({ title: '已更新 🌏' }))).json(),
  ).toMatchObject({ changed: false, contextVersion: 2 });
  expect(
    (
      await post('pm', demand, {
        ...good,
        patch: { ...good.patch, title: '已更新 🌏' },
      })
    ).json(),
  ).toEqual(changed.json());
});

test('locked same-field edits, independent patches and stage actions keep causal history', async () => {
  const client = await pool.connect();
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  const first = intent({ title: 'Next title' }),
    second = intent({ title: 'Final title' });
  const waiting: Promise<unknown>[] = [];
  try {
    await client.query('begin');
    await client.query('select id from requirement where id=$1 for update', [
      race,
    ]);
    const a = post('pm', race, first);
    waiting.push(a);
    await waitsOn(pid);
    const b = post('manager', race, second);
    waiting.push(b);
    await client.query('commit');
    expect((await a).json()).toMatchObject({
      changed: true,
      contextVersion: 2,
    });
    expect((await b).json()).toMatchObject({
      changed: true,
      contextVersion: 3,
    });
    expect(
      (
        await pool.query(
          'select version,"before","after" from requirement_event where requirement_id=$1 order by version',
          [race],
        )
      ).rows,
    ).toEqual([
      {
        version: 2,
        before: { title: 'Original title' },
        after: { title: 'Next title' },
      },
      {
        version: 3,
        before: { title: 'Next title' },
        after: { title: 'Final title' },
      },
    ]);
    expect((await post('pm', race, first)).json()).toEqual((await a).json());
    expect((await get('lead', race)).json().requirement.title).toBe(
      'Final title',
    );
    const same = intent({ description: 'Independent description' });
    const [saved, replay, other, stage, task] = await Promise.all([
      post('pm', race, same),
      post('pm', race, same),
      post('manager', race, intent({ acceptance: 'Independent acceptance' })),
      app.inject({
        method: 'POST',
        url: `/api/requirements/${race}/commands`,
        headers: {
          origin: options.origin,
          cookie: members.get('lead')!.cookie,
        },
        payload: {
          commandId: randomUUID(),
          type: 'requirement.stage',
          stage: 'design',
        },
      }),
      app.inject({
        method: 'POST',
        url: `/api/requirements/${race}/commands`,
        headers: {
          origin: options.origin,
          cookie: members.get('lead')!.cookie,
        },
        payload: {
          commandId: randomUUID(),
          type: 'task.create',
          task: { title: 'Independent task' },
        },
      }),
    ]);
    expect(saved.json()).toEqual(replay.json());
    expect(other.statusCode).toBe(200);
    expect(stage.statusCode).toBe(200);
    expect(task.statusCode).toBe(200);
    const state = (await get('lead', race)).json();
    expect(state.requirement).toMatchObject({
      contextVersion: 7,
      stage: 'design',
      title: 'Final title',
      description: 'Independent description',
      acceptance: 'Independent acceptance',
    });
    expect(state.events.map((e: { version: number }) => e.version)).toEqual([
      7, 6, 5, 4, 3, 2,
    ]);
    expect(state.tasks).toContainEqual(
      expect.objectContaining({
        title: 'Independent task',
        assigneeId: members.get('lead')!.id,
      }),
    );
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          same.commandId,
        ])
      ).rowCount,
    ).toBe(1);
  } finally {
    await client.query('rollback');
    await Promise.allSettled(waiting);
    client.release();
  }
});

test('expiry after a real requirement lock rolls back, and out-of-date edit authority cannot return results or conflicts', async () => {
  const client = await pool.connect();
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
  const expires = (
    await pool.query('select expires_at from auth_session where id=$1', [
      members.get('manager')!.sessionId,
    ])
  ).rows[0].expires_at as Date;
  const expired = intent({ title: 'Expired fixture' });
  let waiting: Promise<unknown> | undefined;
  try {
    await client.query('begin');
    await client.query('select id from requirement where id=$1 for update', [
      late,
    ]);
    const write = post('manager', late, expired);
    waiting = write;
    await waitsOn(pid);
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expires.getTime() + 1000);
    await client.query('commit');
    expect((await write).statusCode).toBe(401);
    vi.useRealTimers();
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          expired.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    const remove = async () => {
      await managerRole(false);
    };
    beforeResponse = remove;
    const hidden = await get('manager', late);
    expect(hidden.statusCode).toBe(403);
    expect(hidden.json()).not.toHaveProperty('permissions');
    expect((await get('manager', late)).json().permissions.canEditDetails).toBe(
      false,
    );
    await managerRole(true);
    const committed = intent({ description: 'Saved before downgrade' });
    beforeResponse = remove;
    const interrupted = await post('manager', late, committed);
    expect(interrupted.statusCode).toBe(403);
    expect(interrupted.json()).not.toHaveProperty('commandId');
    expect((await get('lead', late)).json().requirement.description).toBe(
      'Saved before downgrade',
    );
    expect((await post('manager', late, committed)).statusCode).toBe(403);
    await managerRole(true);
    expect((await post('manager', late, committed)).json()).toMatchObject({
      changed: true,
      contextVersion: 2,
    });
    const different = { ...committed, patch: { title: 'Other intent' } };
    expect((await post('manager', late, different)).json()).toMatchObject({
      code: 'command-conflict',
    });
    beforeResponse = remove;
    const conflict = await post('manager', late, different);
    expect(conflict.statusCode).toBe(403);
    expect(conflict.json()).not.toHaveProperty('code');
  } finally {
    beforeResponse = undefined;
    vi.useRealTimers();
    await client.query('rollback');
    await Promise.allSettled(waiting ? [waiting] : []);
    client.release();
    await managerRole(true);
  }
});

test('an actual frozen Native request keeps old details and the next pre-step sees the edit', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-details-native-'),
  );
  const configuration = join(root, 'config', 'projects', project, 'dsh');
  const host = new NativeWebHost(root, configuration, project);
  const server = buildApp({
    ...options,
    nativeHost: host,
    nativeRuntimeRoot: root,
    repositoryHome: root,
  });
  const calls: string[] = [];
  let unblock!: () => void;
  const firstRequest = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  const assistantMarker = 'Synthetic provider answer';
  const provider = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(Buffer.concat(chunks).toString('utf8'));
    if (calls.length === 1) await firstRequest;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: assistantMarker }, null],
      [{}, 'stop'],
    ]) {
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'details-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'details-model',
            choices: [{ index: 0, delta, finish_reason }],
          }) +
          '\n\n',
      );
    }
    response.end('data: [DONE]\n\n');
  });
  provider.listen(0, '127.0.0.1');
  try {
    await once(provider, 'listening');
    const profile = join(configuration, 'profiles', 'rdws');
    await mkdir(profile, { recursive: true, mode: 0o700 });
    await writeFile(
      join(configuration, '.credentials.yaml'),
      JSON.stringify({
        version: 1,
        refs: { FIXTURE_MODEL: 'synthetic-value' },
      }),
      { mode: 0o600 },
    );
    await writeFile(
      join(profile, 'cordis.patch.yml'),
      JSON.stringify([
        {
          id: 'llm-pi-ai',
          config: {
            providers: {
              'rdws-glm': {
                api: 'openai-completions',
                baseURL: `http://127.0.0.1:${(provider.address() as { port: number }).port}/v1`,
                apiKeyEnv: 'FIXTURE_MODEL',
                models: [{ id: 'details-model' }],
              },
            },
          },
        },
        { id: 'session-title-llm', disabled: true },
      ]),
      { mode: 0o600 },
    );
    await server.listen({ host: '127.0.0.1', port: 0 });
    const headers = {
      origin: options.origin,
      cookie: members.get('lead')!.cookie,
    };
    const creation = await server.inject({
      method: 'POST',
      url: `/api/requirements/${nativeDemand}/sessions`,
      headers,
      payload: { commandId: randomUUID() },
    });
    expect(creation.statusCode).toBe(200);
    const { sessionId } = creation.json();
    const binding = await bootstrapNative(server, headers.cookie, nativeDemand);
    const rpc = async (method: string, args: Record<string, unknown>) => {
      const response = await server.inject({
        method: 'POST',
        url: `/api/dsh/${nativeDemand}/native/api/${method}`,
        headers: {
          ...headers,
          'x-rdws-client-generation': randomUUID(),
          'x-rdws-native-login': binding,
        },
        payload: {
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args },
        },
      });
      expect(response.statusCode).toBe(200);
      const result = response.json().result;
      expect(result.ok).toBe(true);
      return result.value;
    };
    const send = () =>
      rpc('session/prompt', {
        request: {
          sessionId,
          requestId: randomUUID(),
          mode: 'queue',
          content: [{ type: 'text', text: 'Synthetic context check' }],
        },
      });
    const journal = () =>
      rpc('session/page', {
        request: { address: { kind: 'session', sessionId }, maxMessages: 100 },
      });
    function objects(value: unknown): Record<string, unknown>[] {
      if (!value || typeof value !== 'object') return [];
      if (Array.isArray(value)) return value.flatMap(objects);
      return [
        value as Record<string, unknown>,
        ...Object.values(value).flatMap(objects),
      ];
    }
    const mentions = (value: unknown) =>
      objects(value).filter(
        (object) =>
          object.role === 'assistant' &&
          Array.isArray(object.content) &&
          object.content.some(
            (block: { text?: string }) => block.text === assistantMarker,
          ),
      );
    expect(await send()).toMatchObject({ accepted: true });
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(1);
    const longDescription = '新验收资料'.repeat(400);
    const edit = await post(
      'pm',
      nativeDemand,
      intent({
        title: 'Updated Native title',
        description: longDescription,
        acceptance: 'New acceptance',
      }),
    );
    expect(edit.json()).toMatchObject({ changed: true, contextVersion: 2 });
    expect(calls[0]).toContain('Original description');
    expect(calls[0]).not.toContain('Updated Native title');
    unblock();
    await expect
      .poll(async () => mentions(await journal()).length, { timeout: 6000 })
      .toBeGreaterThan(0);
    expect(await send()).toMatchObject({ accepted: true });
    await expect.poll(() => calls.length, { timeout: 5000 }).toBe(2);
    const evidence = (
      await readFile(
        join(root, 'runtime', `context-evidence-${project}.jsonl`),
        'utf8',
      )
    )
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
      .filter((row) => row.phase === 'request' && row.sessionId === sessionId);
    expect(evidence.map((row) => row.contextVersion)).toEqual([1, 2]);
    for (const [index, row] of evidence.entries()) {
      const messages = await journal();
      const note = objects(messages).find(
        (item) =>
          item.id === row.messageId &&
          (item.source as { kind?: string })?.kind === 'rdws-context',
      );
      expect(note).toBeDefined();
      const text = (note!.content as { text: string }[])[0]!.text;
      expect(createHash('sha256').update(text).digest('hex')).toBe(
        row.contentHash,
      );
      const snapshot = JSON.parse(text.slice(text.indexOf('\n') + 1));
      expect(snapshot).toMatchObject(
        index === 0
          ? {
              requirementId: nativeDemand,
              contextVersion: 1,
              title: 'Original title',
              description: 'Original description',
              acceptance: 'Original acceptance',
            }
          : {
              requirementId: nativeDemand,
              contextVersion: 2,
              title: 'Updated Native title',
              description: longDescription.slice(0, 1500),
              acceptance: 'New acceptance',
              summarizedFields: { description: true },
            },
      );
      expect(snapshot.permissions).not.toHaveProperty('canEditDetails');
      expect(snapshot.permissions.codeWrite).toBe(false);
      expect(
        snapshot.recentChanges.every(
          (item: Record<string, unknown>) =>
            !('before' in item) && !('after' in item),
        ),
      ).toBe(true);
      expect(calls[index]).toContain(JSON.stringify(text).slice(1, -1));
    }
  } finally {
    unblock();
    await server.close();
    const closed = once(provider, 'close');
    provider.close();
    provider.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 35000);
