import { createHash, randomUUID } from 'node:crypto';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { importLimits, type RequirementImportRow } from '@rdws/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { loadEnvironment, runtimeHome } from '@rdws/runtime-config';
import { httpsGitFixture } from '../helpers/https-git.ts';
import { RepositoryMirrors } from '@rdws/syncer/mirror';

loadEnvironment('test');
const config = {
  origin: process.env.RDWS_ORIGIN!,
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
};
const db = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
const project = 'import-' + randomUUID(),
  mirrorProject = 'import-mirror-' + randomUUID();
const users = new Map<
  string,
  { id: string; cookie: string; sessionId: string }
>();
let app: ReturnType<typeof buildApp>;
let root: string;
let isolated = false;
let beforeResponse: (() => Promise<void>) | undefined;
const headers = (user: string) => ({
  origin: config.origin,
  cookie: users.get(user)!.cookie,
  'content-type': 'application/json',
  'x-rdws-edit-session': users.get(user)!.sessionId,
});
const send = (user: string, path: 'preview' | 'commit', payload: unknown) =>
  app.inject({
    method: 'POST',
    url: `/api/projects/${project}/requirements/import/${path}`,
    headers: headers(user),
    payload: JSON.stringify(payload),
  });
const row = (
  number: number,
  patch: Partial<RequirementImportRow> = {},
): RequirementImportRow => ({
  row: number,
  title: `Synthetic requirement ${number}`,
  description: 'Context',
  acceptance: 'Acceptance',
  lead: 'lead',
  managers: '',
  developers: '',
  testers: '',
  tasks: '',
  ...patch,
});
const input = (rows: RequirementImportRow[]) => ({
  commandId: randomUUID(),
  rows,
});
async function requirements(id = project) {
  return (
    await db.query(
      'select count(*)::int n from requirement where project_id=$1',
      [id],
    )
  ).rows[0].n as number;
}
async function receipts(id: string) {
  return (
    await db.query(
      'select count(*)::int n from command_receipt where command_id=$1',
      [id],
    )
  ).rows[0].n as number;
}

beforeAll(async () => {
  expect(
    (await db.query('select current_database() db, session_user role')).rows[0],
  ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
  const testUrl = new URL(config.databaseUrl);
  expect([testUrl.hostname, testUrl.pathname, testUrl.username]).toEqual([
    '127.0.0.1',
    '/rdws_test',
    'rdws_test_app',
  ]);
  isolated = true;
  root = await mkdtemp(join(tmpdir(), 'rdws-import-fixture-'));
  app = buildApp({ ...config, repositoryHome: root, nativeRuntimeRoot: root });
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (beforeResponse && request.url.endsWith('/requirements/import/commit')) {
      const fn = beforeResponse;
      beforeResponse = undefined;
      await fn();
    }
    return payload;
  });
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  for (const [i, user] of [
    'pm',
    'lead',
    'manager',
    'dev',
    'tester',
    'admin',
  ].entries()) {
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: config.origin },
      remoteAddress: `192.0.2.${133 + i}`,
      payload: accounts.find((account) => account.username === user),
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
    users.set(user, {
      id: login.json().user.id,
      cookie,
      sessionId: current.json().session.id,
    });
  }
  await db.query('insert into project(id,name) values($1,$3),($2,$3)', [
    project,
    mirrorProject,
    'Import fixture',
  ]);
  for (const id of [project, mirrorProject]) {
    for (const [user, role] of [
      ['pm', 'project_admin'],
      ['lead', 'developer'],
      ['manager', 'requirement_manager'],
      ['dev', 'developer'],
      ['tester', 'tester'],
    ])
      await db.query('insert into project_member values($1,$2,$3)', [
        id,
        users.get(user!)!.id,
        role,
      ]);
  }
});

afterAll(async () => {
  await app?.close();
  try {
    if (!isolated) return;
    const scopes = [project, mirrorProject];
    for (const table of [
      'task',
      'requirement_event',
      'requirement_worktree_plan',
      'requirement_participant',
    ])
      await db.query(
        `delete from ${table} where requirement_id in (select id from requirement where project_id=any($1::text[]))`,
        [scopes],
      );
    await db.query('delete from requirement where project_id=any($1::text[])', [
      scopes,
    ]);
    await db.query('delete from command_receipt where scope=any($1::text[])', [
      scopes.map((id) => 'project:' + id),
    ]);
    await db.query(
      'delete from project_member where project_id=any($1::text[])',
      [scopes],
    );
    await db.query('delete from project where id=any($1::text[])', [scopes]);
    if (root) await rm(root, { recursive: true, force: true });
  } finally {
    await db.end();
  }
});

test('preview reports rows and preserves empty business, receipt and runtime state', async () => {
  const before = await requirements();
  const body = {
    rows: [
      row(2, { lead: ' lead ', developers: 'LEAD;dev', testers: 'tester' }),
      row(5, { title: '', developers: 'tester' }),
    ],
  };
  expect((await send('lead', 'preview', body)).statusCode).toBe(403);
  expect((await send('admin', 'preview', body)).statusCode).toBe(403);
  const result = await send('manager', 'preview', body);
  expect(result.statusCode).toBe(200);
  expect(result.headers['cache-control']).toBe('no-store');
  expect(result.json().rows).toEqual([
    { row: 2, issues: [] },
    {
      row: 5,
      issues: [
        { field: 'title', message: expect.any(String) },
        { field: 'developers', message: expect.any(String) },
      ],
    },
  ]);
  expect(await requirements()).toBe(before);
  expect(
    (
      await db.query(
        "select 1 from command_receipt where scope=$1 and operation='requirement.import'",
        ['project:' + project],
      )
    ).rowCount,
  ).toBe(0);
  expect(await readdir(root)).toEqual([]);
  expect(
    (await send('pm', 'preview', { rows: [row(2, { title: '\ud800' })] }))
      .statusCode,
  ).toBe(400);
  expect(
    (await send('pm', 'preview', { rows: [row(2), row(2)] })).statusCode,
  ).toBe(400);
  const stale = await app.inject({
    method: 'POST',
    url: `/api/projects/${project}/requirements/import/preview`,
    headers: {
      ...headers('pm'),
      'x-rdws-edit-session': users.get('manager')!.sessionId,
    },
    payload: body,
  });
  expect(stale.statusCode).toBe(401);
  expect(stale.body).not.toContain('issues');
});

test('uses route-local byte limits and validates the whole transaction workload', async () => {
  const large = {
    rows: Array.from({ length: 12 }, (_, index) =>
      row(index + 2, { description: 'x'.repeat(6500) }),
    ),
  };
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(65536);
  const allowed = await send('pm', 'preview', large);
  expect(allowed.statusCode).toBe(200);
  expect(allowed.json().rows).toHaveLength(12);
  expect(
    (
      await send('pm', 'preview', {
        rows: [row(2, { description: 'x'.repeat(importLimits.bytes) })],
      })
    ).statusCode,
  ).toBe(413);
  const tooMany = input([
    row(2, { tasks: Array(100).fill('Task').join('\n') }),
    row(3, { tasks: Array(100).fill('Task').join('\n') }),
    row(4, { tasks: 'Extra' }),
  ]);
  const before = await requirements();
  expect((await send('pm', 'commit', tooMany)).json()).toMatchObject({
    status: 'rejected',
    rows: expect.arrayContaining([
      expect.objectContaining({
        row: 4,
        issues: expect.arrayContaining([
          expect.objectContaining({ field: 'tasks' }),
        ]),
      }),
    ]),
  });
  expect(await requirements()).toBe(before);
  const boundary = input(tooMany.rows.slice(0, 2));
  const added = (await send('pm', 'commit', boundary)).json();
  expect(added.status).toBe('created');
  expect(
    (
      await db.query(
        'select count(*)::int n from task where requirement_id=any($1::text[])',
        [added.rows.map((r: { id: string }) => r.id)],
      )
    ).rows[0].n,
  ).toBe(200);
});

test('a stale last row rejects the whole batch and the same command stays rejected after role restoration', async () => {
  const command = input([row(2), row(5, { lead: 'dev' })]);
  expect(
    (await send('pm', 'preview', { rows: command.rows })).json().rows,
  ).toEqual([
    { row: 2, issues: [] },
    { row: 5, issues: [] },
  ]);
  const before = await requirements();
  await db.query(
    "delete from project_member where project_id=$1 and user_id=$2 and role='developer'",
    [project, users.get('dev')!.id],
  );
  let rejected: unknown;
  try {
    rejected = (await send('pm', 'commit', command)).json();
    expect(rejected).toMatchObject({
      commandId: command.commandId,
      status: 'rejected',
      rows: [
        { row: 2, issues: [] },
        { row: 5, issues: [{ field: 'lead' }] },
      ],
    });
    expect(await requirements()).toBe(before);
  } finally {
    await db.query("insert into project_member values($1,$2,'developer')", [
      project,
      users.get('dev')!.id,
    ]);
  }
  expect((await send('pm', 'commit', command)).json()).toEqual(rejected);
  expect(await receipts(command.commandId)).toBe(1);
  expect(
    (
      await send('pm', 'commit', {
        ...command,
        rows: [row(2, { title: 'Changed same command' })],
      })
    ).statusCode,
  ).toBe(409);
  expect(await requirements()).toBe(before);
  const next = (await send('pm', 'commit', input(command.rows))).json();
  expect(next.status).toBe('created');
  expect(await requirements()).toBe(before + 2);
});

test('same-key concurrency returns stable row ids and creates normal assignment history', async () => {
  const command = input([
    row(2, {
      title: '  Imported and trimmed  ',
      managers: 'manager',
      developers: 'Dev；lead',
      testers: 'tester',
      tasks: 'First\nSecond',
    }),
    row(4),
  ]);
  const before = await requirements();
  const requests = await Promise.all([
    send('manager', 'commit', command),
    send('manager', 'commit', command),
  ]);
  expect(requests.map((result) => result.statusCode)).toEqual([200, 200]);
  const result = requests[0]!.json();
  expect(requests[1]!.json()).toEqual(result);
  expect(result).toMatchObject({
    commandId: command.commandId,
    status: 'created',
    rows: [
      { row: 2, workspaceState: 'unconfigured' },
      { row: 4, workspaceState: 'unconfigured' },
    ],
  });
  const first = result.rows[0].id as string;
  expect(
    (
      await db.query('select title,lead_id from requirement where id=$1', [
        first,
      ])
    ).rows[0],
  ).toEqual({ title: 'Imported and trimmed', lead_id: users.get('lead')!.id });
  expect(
    (
      await db.query(
        'select assignee_id,title from task where requirement_id=$1 order by title',
        [first],
      )
    ).rows,
  ).toEqual(
    ['First', 'Second'].map((title) => ({
      assignee_id: users.get('lead')!.id,
      title,
    })),
  );
  expect(
    (
      await db.query(
        'select kind from requirement_event where requirement_id=$1 order by kind',
        [first],
      )
    ).rows.map((item) => item.kind),
  ).toEqual(['requirement.created', 'task.created', 'task.created']);
  expect(await receipts(command.commandId)).toBe(1);
  expect(await requirements()).toBe(before + 2);
});

function interceptImportEvents(
  commandId: string,
  onInsert: (
    client: PoolClient,
    proceed: () => Promise<unknown>,
  ) => Promise<unknown>,
) {
  const connect = Pool.prototype.connect;
  let intercepted = false;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(connect, this, args);
    if (intercepted || args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      client.query = ((...parameters: unknown[]) => {
        const statement = parameters[0] as string | { text: string };
        const text = typeof statement === 'string' ? statement : statement.text;
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (
          !intercepted &&
          text.startsWith('insert into "requirement_event"') &&
          Array.isArray(parameters[1]) &&
          parameters[1].includes(commandId)
        ) {
          intercepted = true;
          return onInsert(client, () =>
            Reflect.apply(query, client, parameters),
          );
        }
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof connect);
  return { spy, matched: () => intercepted };
}

test('write failure after inserting requirements rolls back the entire batch and its receipt', async () => {
  const command = input([row(2), row(3)]);
  const before = await requirements();
  const { spy, matched } = interceptImportEvents(
    command.commandId,
    async () => {
      throw new Error('Synthetic event insert failure');
    },
  );
  try {
    expect((await send('pm', 'commit', command)).statusCode).toBe(500);
  } finally {
    spy.mockRestore();
  }
  expect(matched()).toBe(true);
  expect(await requirements()).toBe(before);
  expect(await receipts(command.commandId)).toBe(0);
  expect((await send('pm', 'commit', command)).json().status).toBe('created');
});

test('the database transaction budget is set and elapsed time at the final wait rolls back the batch', async () => {
  const command = input([row(2), row(3)]);
  const before = await requirements();
  let jumped = false;
  let databaseBudget: unknown;
  const clock = performance.now.bind(performance);
  const timer = vi
    .spyOn(performance, 'now')
    .mockImplementation(() => clock() + (jumped ? 10000 : 0));
  const boundary = interceptImportEvents(
    command.commandId,
    async (client, proceed) => {
      databaseBudget = (await client.query('show transaction_timeout')).rows[0]
        .transaction_timeout;
      const result = await proceed();
      jumped = true;
      return result;
    },
  );
  try {
    expect((await send('pm', 'commit', command)).statusCode).toBe(503);
  } finally {
    boundary.spy.mockRestore();
    timer.mockRestore();
  }
  expect(databaseBudget).toBe('8s');
  expect(await requirements()).toBe(before);
  expect(await receipts(command.commandId)).toBe(0);
});

test('a login expiring while the batch waits for a candidate row cannot write a receipt', async () => {
  const command = input([row(2), row(3)]);
  const before = await requirements();
  const client = await db.connect();
  let pending: ReturnType<typeof send> | undefined;
  try {
    const expiry = (
      await db.query('select expires_at from auth_session where id=$1', [
        users.get('manager')!.sessionId,
      ])
    ).rows[0].expires_at as Date;
    const pid = (await client.query('select pg_backend_pid() pid')).rows[0].pid;
    await client.query('begin');
    await client.query('select id from auth_user where id=$1 for update', [
      users.get('lead')!.id,
    ]);
    pending = send('manager', 'commit', command);
    const response = Promise.resolve(pending);
    await vi.waitFor(
      async () =>
        expect(
          (
            await db.query(
              'select exists(select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
              [pid],
            )
          ).rows[0].waiting,
        ).toBe(true),
      { timeout: 1700 },
    );
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(expiry.getTime() + 1000);
    await client.query('commit');
    expect((await response).statusCode).toBe(401);
  } finally {
    vi.useRealTimers();
    await client.query('rollback');
    await Promise.allSettled(pending ? [pending] : []);
    client.release();
  }
  expect(await requirements()).toBe(before);
  expect(await receipts(command.commandId)).toBe(0);
});

test('a batch result is denied after write authority is withdrawn and can be reconciled on reauthorization', async () => {
  const command = input([row(2), row(4)]);
  const before = await requirements();
  beforeResponse = async () => {
    await db.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='requirement_manager'",
      [project, users.get('manager')!.id],
    );
  };
  try {
    const denied = await send('manager', 'commit', command);
    expect(denied.statusCode).toBe(403);
    expect(denied.json()).not.toHaveProperty('rows');
    expect(await requirements()).toBe(before + 2);
  } finally {
    beforeResponse = undefined;
    await db.query(
      "insert into project_member values($1,$2,'requirement_manager') on conflict do nothing",
      [project, users.get('manager')!.id],
    );
  }
  expect((await send('manager', 'commit', command)).json()).toMatchObject({
    commandId: command.commandId,
    status: 'created',
  });
  expect(await requirements()).toBe(before + 2);
  expect(await receipts(command.commandId)).toBe(1);
  const restored = (await send('manager', 'commit', command)).json();
  const blockedRow = restored.rows[0].id as string;
  await db.query(
    "delete from requirement_participant where requirement_id=$1 and user_id=$2 and role='requirement_manager'",
    [blockedRow, users.get('manager')!.id],
  );
  try {
    const inaccessible = await send('manager', 'commit', command);
    expect(inaccessible.statusCode).toBe(403);
    expect(inaccessible.json()).not.toHaveProperty('rows');
  } finally {
    await db.query(
      "insert into requirement_participant values($1,$2,'requirement_manager')",
      [blockedRow, users.get('manager')!.id],
    );
  }
});

test('a personnel edit on an unrelated demand cannot invalidate the authorized import rows', async () => {
  const base = await app.inject({
    method: 'POST',
    url: `/api/projects/${project}/requirements`,
    headers: { origin: config.origin, cookie: users.get('manager')!.cookie },
    payload: {
      commandId: randomUUID(),
      title: 'Unrelated demand fixture',
      description: '',
      acceptance: '',
      leadId: users.get('lead')!.id,
    },
  });
  expect(base.statusCode).toBe(200);
  const neighbor = base.json().id as string;
  beforeResponse = async () => {
    const edit = await app.inject({
      method: 'POST',
      url: `/api/requirements/${neighbor}/personnel`,
      headers: headers('pm'),
      payload: {
        commandId: randomUUID(),
        previewLeadId: users.get('lead')!.id,
        leadId: users.get('lead')!.id,
        add: [],
        remove: [
          { userId: users.get('manager')!.id, role: 'requirement_manager' },
        ],
        taskDigest: createHash('sha256').update('[]').digest('hex'),
        handoffs: [],
        overrides: [],
      },
    });
    expect(edit.statusCode).toBe(200);
    expect(edit.json().status).toBe('saved');
  };
  try {
    const result = await send('manager', 'commit', input([row(2), row(3)]));
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ status: 'created' });
    expect(
      result.json().rows.map((entry: { id: string }) => entry.id),
    ).not.toContain(neighbor);
  } finally {
    beforeResponse = undefined;
  }
});

test('configured import freezes one real Git baseline and reads independent worktree states without reimporting', async () => {
  const fixture = await httpsGitFixture(mirrorProject);
  const mirrors = new RepositoryMirrors(fixture.root);
  const server = buildApp({
    ...config,
    repositoryHome: fixture.root,
    nativeRuntimeRoot: fixture.root,
  });
  const command = input([row(2), row(4)]);
  const submit = () =>
    server.inject({
      method: 'POST',
      url: `/api/projects/${mirrorProject}/requirements/import/commit`,
      headers: headers('pm'),
      payload: command,
    });
  try {
    expect(
      (
        await mirrors.sync(
          mirrorProject,
          fixture.entry.id,
          'fixture',
          randomUUID(),
          (publish) => publish(),
        )
      ).status,
    ).toBe('succeeded');
    const result = (await submit()).json();
    expect(result).toMatchObject({
      status: 'created',
      rows: [
        { row: 2, workspaceState: 'pending' },
        { row: 4, workspaceState: 'pending' },
      ],
    });
    const ids = result.rows.map((row: { id: string }) => row.id);
    const plans = await db.query(
      'select repositories from requirement_worktree_plan where requirement_id=any($1::text[])',
      [ids],
    );
    expect(plans.rows).toHaveLength(2);
    expect(
      plans.rows.every(
        (record) => record.repositories[0]?.baseCommit === fixture.first,
      ),
    ).toBe(true);
    const prepare = (id: string) =>
      server.inject({
        method: 'POST',
        url: `/api/requirements/${id}/worktrees`,
        headers: { cookie: users.get('pm')!.cookie, origin: config.origin },
        payload: {},
      });
    const foreign = join(
      fixture.root,
      'projects',
      mirrorProject,
      'demands',
      ids[1],
      '.gitstore',
    );
    await mkdir(foreign, { recursive: true });
    expect((await prepare(ids[0])).json()).toMatchObject({ state: 'ready' });
    expect((await prepare(ids[1])).json()).toMatchObject({ state: 'pending' });
    await writeFile(fixture.registration, 'invalid fixture configuration');
    const replay = (await submit()).json();
    expect(replay.rows).toEqual([
      { row: 2, id: ids[0], workspaceState: 'ready' },
      { row: 4, id: ids[1], workspaceState: 'pending' },
    ]);
    expect(await requirements(mirrorProject)).toBe(2);
  } finally {
    await server.close();
    await mirrors.close();
    await fixture.close();
  }
});
