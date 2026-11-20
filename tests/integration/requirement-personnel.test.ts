import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '@rdws/server';
import { bootstrapNative, fixtureBinding } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import WebSocket, { WebSocketServer } from 'ws';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  taskAssignmentMaterial,
  type RequirementPersonnelInput,
} from '@rdws/contracts';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

loadEnvironment('test');
const config = {
  origin: process.env.RDWS_ORIGIN!,
  secret: process.env.BETTER_AUTH_SECRET!,
  databaseUrl: process.env.DATABASE_URL!,
};
const db = createTestPool('migration');
const app = buildApp(config);
const project = 'personnel-' + randomUUID();
const demand = randomUUID(),
  neighbor = randomUUID(),
  noTasks = randomUUID(),
  race = randomUUID(),
  unknown = randomUUID(),
  rollback = randomUUID(),
  retrySerialization = randomUUID(),
  retryDeadlock = randomUUID(),
  self = randomUUID(),
  selfKnown = randomUUID(),
  roleRace = randomUUID(),
  duplicate = randomUUID(),
  wireFirst = randomUUID(),
  wireSecond = randomUUID(),
  wireNeighbor = randomUUID(),
  nativeDemand = randomUUID();
const demands = [
  demand,
  neighbor,
  noTasks,
  race,
  unknown,
  rollback,
  retrySerialization,
  retryDeadlock,
  self,
  selfKnown,
  roleRace,
  duplicate,
  wireFirst,
  wireSecond,
  wireNeighbor,
  nativeDemand,
];
const people = new Map<
  string,
  { id: string; cookie: string; sessionId: string }
>();
const taskIds = {
  first: randomUUID(),
  second: randomUUID(),
  done: randomUUID(),
  cancelled: randomUUID(),
  racing: randomUUID(),
};
let accounts: { username: string; password: string }[];
let isolated = false;
let loginIndex = 120;
const actor = (user: string) => people.get(user)!;
const headers = (user: string) => ({
  origin: config.origin,
  cookie: actor(user).cookie,
  'x-rdws-edit-session': actor(user).sessionId,
});
const get = (user: string, id: string, suffix = '') =>
  app.inject({
    method: 'GET',
    url: `/api/requirements/${id}${suffix}`,
    headers:
      suffix === '/personnel' ? headers(user) : { cookie: actor(user).cookie },
  });
const save = async (
  user: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/personnel`,
    headers: headers(user),
    payload,
  });
const command = async (
  user: string,
  id: string,
  payload: Record<string, unknown>,
) =>
  app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/commands`,
    headers: { origin: config.origin, cookie: actor(user).cookie },
    payload: { commandId: randomUUID(), ...payload },
  });
const list = async (user: string) =>
  app.inject({
    method: 'GET',
    url: `/api/projects/${project}/requirements`,
    headers: { cookie: actor(user).cookie },
  });
function edit(
  patch: Partial<RequirementPersonnelInput> = {},
): RequirementPersonnelInput {
  return {
    commandId: randomUUID(),
    previewLeadId: actor('lead').id,
    leadId: actor('lead').id,
    add: [],
    remove: [],
    taskDigest: createHash('sha256')
      .update(taskAssignmentMaterial([]))
      .digest('hex'),
    handoffs: [],
    overrides: [],
    ...patch,
  };
}
const digest = (...ids: string[]) =>
  createHash('sha256')
    .update(
      taskAssignmentMaterial(
        ids.map((id) => ({ id, assigneeId: actor('lead').id })),
      ),
    )
    .digest('hex');
const removeLead = () => ({
  userId: actor('lead').id,
  role: 'developer' as const,
});

async function login(username: string) {
  const result = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: config.origin },
    remoteAddress: '192.0.2.' + ++loginIndex,
    payload: accounts.find((row) => row.username === username),
  });
  expect(result.statusCode).toBe(200);
  const cookie = result.cookies
    .map(({ name, value }) => `${name}=${value}`)
    .join('; ');
  const current = await app.inject({
    method: 'GET',
    url: '/api/auth/get-session',
    headers: { cookie },
  });
  return {
    id: result.json().user.id as string,
    cookie,
    sessionId: current.json().session.id as string,
  };
}

let delayResponse: ((path: string) => Promise<void>) | undefined;
app.addHook('preSerialization', async (request, _reply, payload) => {
  await delayResponse?.(request.url);
  return payload;
});

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
  accounts = await readTestAccounts();
  for (const username of ['pm', 'manager', 'lead', 'dev', 'tester', 'admin'])
    people.set(username, await login(username));
  await db.query('insert into project(id,name) values($1,$2)', [
    project,
    'Personnel fixture',
  ]);
  await db.query(
    "insert into project_member values($1,$2,'project_admin'),($1,$3,'requirement_manager'),($1,$4,'developer'),($1,$5,'developer'),($1,$6,'developer')",
    [
      project,
      actor('pm').id,
      actor('manager').id,
      actor('lead').id,
      actor('dev').id,
      actor('tester').id,
    ],
  );
  for (const id of demands) {
    await db.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
      [
        id,
        project,
        'Personnel demand',
        'Fixture context',
        'Explicit eligible transfers',
        actor('lead').id,
      ],
    );
    await db.query(
      "insert into requirement_participant values($1,$2,'developer'),($1,$3,'developer')",
      [id, actor('lead').id, actor('dev').id],
    );
  }
  await db.query(
    "insert into requirement_participant values($1,$4,'requirement_manager'),($2,$4,'requirement_manager'),($3,$4,'requirement_manager')",
    [demand, self, selfKnown, actor('manager').id],
  );
  for (const [key, status] of [
    ['first', 'todo'],
    ['second', 'in_progress'],
    ['done', 'done'],
    ['cancelled', 'cancelled'],
    ['racing', 'todo'],
  ] as const) {
    await db.query(
      'insert into task(id,requirement_id,title,assignee_id,created_by,status) values($1,$2,$3,$4,$4,$5)',
      [
        taskIds[key],
        key === 'racing' ? race : demand,
        key,
        actor('lead').id,
        status,
      ],
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
      'requirement_participant',
    ])
      await db.query(
        `delete from ${table} where requirement_id=any($1::text[])`,
        [demands],
      );
    await db.query('delete from requirement where id=any($1::text[])', [
      demands,
    ]);
    await db.query('delete from command_receipt where scope=any($1::text[])', [
      demands.map((id) => 'requirement:' + id),
    ]);
    await db.query('delete from project_member where project_id=$1', [project]);
    await db.query('delete from project where id=$1', [project]);
  } finally {
    await db.end();
  }
});

test('check current personnel authority and require the target lead to be a demand developer even with no open tasks', async () => {
  expect((await get('manager', noTasks, '/personnel')).statusCode).toBe(403);
  expect((await get('lead', noTasks, '/personnel')).statusCode).toBe(403);
  expect(
    (await get('pm', noTasks, '/personnel')).json().members,
  ).toContainEqual({
    id: actor('tester').id,
    name: 'tester',
    role: 'developer',
  });
  expect(
    (await get('pm', noTasks, '/personnel')).headers['cache-control'],
  ).toBe('no-store');
  const forgery = edit({ leadId: actor('tester').id });
  expect((await save('admin', noTasks, forgery)).statusCode).toBe(403);
  expect((await save('manager', noTasks, forgery)).statusCode).toBe(403);
  expect((await save('pm', noTasks, forgery)).json()).toMatchObject({
    status: 'invalid',
    contextVersion: 1,
  });
  expect((await save('pm', noTasks, edit())).json()).toMatchObject({
    status: 'unchanged',
    contextVersion: 1,
  });
  const duplicate = removeLead();
  expect(
    (await save('pm', noTasks, edit({ add: [duplicate], remove: [duplicate] })))
      .statusCode,
  ).toBe(400);
  expect((await get('lead', noTasks)).json().requirement.leadId).toBe(
    actor('lead').id,
  );
});

test('the latest preview saves all affected tasks atomically and ends only the removed demand roles', async () => {
  const payload = edit({
    leadId: actor('dev').id,
    remove: [removeLead()],
    add: [{ userId: actor('tester').id, role: 'developer' }],
    taskDigest: digest(taskIds.first, taskIds.second),
    handoffs: [{ fromId: actor('lead').id, toId: actor('dev').id }],
    overrides: [{ taskId: taskIds.second, toId: actor('tester').id }],
  });
  expect(
    (
      await save('manager', demand, {
        ...payload,
        commandId: randomUUID(),
        handoffs: [],
      })
    ).json(),
  ).toMatchObject({ status: 'invalid', contextVersion: 1 });
  expect((await get('lead', demand)).statusCode).toBe(200);
  let release!: () => void, captured!: () => void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    captured = resolve;
  });
  let waitingList = false,
    waitingDetail = false;
  delayResponse = async (path) => {
    if (path === `/api/requirements/${demand}`) waitingDetail = true;
    else if (path === `/api/projects/${project}/requirements`)
      waitingList = true;
    else return;
    if (waitingDetail && waitingList) captured();
    await waiting;
  };
  const response = Promise.resolve(get('lead', demand));
  const listing = list('lead');
  let receipt: unknown;
  try {
    await started;
    receipt = (await save('manager', demand, payload)).json();
    expect(receipt).toMatchObject({
      status: 'saved',
      contextVersion: 2,
      revocation: 'confirmed',
    });
  } finally {
    delayResponse = undefined;
    release();
  }
  expect((await response).statusCode).toBe(403);
  expect((await listing).statusCode).toBe(401);
  expect((await get('lead', demand)).statusCode).toBe(403);
  expect((await get('lead', neighbor)).statusCode).toBe(200);
  expect(
    (await list('lead'))
      .json()
      .requirements.map((row: { id: string }) => row.id),
  ).not.toContain(demand);
  const updated = (await get('dev', demand)).json();
  expect(updated.permissions.canManageTasks).toBe(true);
  expect(updated.requirement.leadId).toBe(actor('dev').id);
  expect(updated.participants.map((p: { id: string }) => p.id)).not.toContain(
    actor('lead').id,
  );
  expect(updated.assignmentNames[actor('lead').id]).toBe('lead');
  expect(updated.tasks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: taskIds.first,
        assigneeId: actor('dev').id,
      }),
      expect.objectContaining({
        id: taskIds.second,
        assigneeId: actor('tester').id,
      }),
      expect.objectContaining({
        id: taskIds.done,
        assigneeId: actor('lead').id,
      }),
      expect.objectContaining({
        id: taskIds.cancelled,
        assigneeId: actor('lead').id,
      }),
    ]),
  );
  const history = updated.events.filter(
    (e: { version: number }) => e.version === 2,
  );
  expect(history).toHaveLength(3);
  expect(history).toContainEqual(
    expect.objectContaining({
      kind: 'task.updated',
      taskId: taskIds.first,
      before: { assigneeId: actor('lead').id },
      after: { assigneeId: actor('dev').id },
    }),
  );
  expect(
    (
      await command('dev', demand, {
        type: 'task.update',
        taskId: taskIds.done,
        patch: { status: 'todo' },
      })
    ).statusCode,
  ).toBe(400);
  expect(
    (
      await command('dev', demand, {
        type: 'task.update',
        taskId: taskIds.done,
        patch: { status: 'todo', assigneeId: actor('dev').id },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await command('dev', demand, {
        type: 'requirement.stage',
        stage: 'testing',
      })
    ).statusCode,
  ).toBe(200);
  await db.query(
    "delete from project_member where project_id=$1 and user_id=$2 and role='developer'",
    [project, actor('tester').id],
  );
  try {
    expect((await save('manager', demand, payload)).json()).toMatchObject({
      status: 'saved',
      contextVersion: 2,
      revocation: 'previously-recorded',
    });
  } finally {
    await db.query("insert into project_member values($1,$2,'developer')", [
      project,
      actor('tester').id,
    ]);
  }
});

test('an affected task completed before the personnel command makes the preview stale', async () => {
  const payload = edit({
    leadId: actor('dev').id,
    remove: [removeLead()],
    taskDigest: digest(taskIds.racing),
    handoffs: [{ fromId: actor('lead').id, toId: actor('dev').id }],
  });
  expect(
    (
      await command('lead', race, {
        type: 'task.update',
        taskId: taskIds.racing,
        patch: { status: 'done' },
      })
    ).statusCode,
  ).toBe(200);
  expect((await save('pm', race, payload)).json()).toMatchObject({
    status: 'stale',
    contextVersion: 2,
  });
  const current = (await get('lead', race)).json();
  expect(current.requirement.leadId).toBe(actor('lead').id);
  expect(current.tasks[0]).toMatchObject({
    status: 'done',
    assigneeId: actor('lead').id,
  });
});

type CommitFault = (end: (commit: boolean) => Promise<void>) => Promise<never>;
function interceptCommit(
  commandId: string,
  fault: CommitFault,
  recovery?: { id: string; blocked: () => boolean },
) {
  return interceptCommits(new Map([[commandId, fault]]), recovery);
}
function interceptCommits(
  cases: Map<string, CommitFault>,
  recovery?: { id: string; blocked: () => boolean },
) {
  const connect = Pool.prototype.connect;
  const used = new Set<string>();
  return vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(connect, this, args);
    if (args.length || (used.size === cases.size && !recovery))
      return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      let match: string | undefined;
      client.query = ((...parameters: unknown[]) => {
        const statement = parameters[0] as string | { text: string };
        const text = typeof statement === 'string' ? statement : statement.text;
        if (
          used.size > 0 &&
          recovery?.blocked() &&
          text.startsWith('select "id" from "requirement"') &&
          text.endsWith('for update') &&
          Array.isArray(parameters[1]) &&
          parameters[1].includes(recovery.id)
        )
          return Promise.reject(
            new Error('Synthetic recovery read unavailable'),
          );
        if (text.includes('command_receipt') && Array.isArray(parameters[1])) {
          const values = parameters[1];
          match =
            [...cases.keys()].find((key) => values.includes(key)) ?? match;
        }
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (match && !used.has(match) && text === 'commit') {
          used.add(match);
          return cases.get(match)!(async (commit) => {
            await Reflect.apply(query, client, [
              commit ? 'commit' : 'rollback',
            ]);
          });
        }
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof connect);
}

function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

test.each([
  { code: '40001', id: retrySerialization },
  { code: '40P01', id: retryDeadlock },
])(
  'a rolled-back personnel commit retries after $code',
  async ({ code, id }) => {
    const payload = edit({ leadId: actor('dev').id, remove: [removeLead()] });
    const spy = interceptCommit(payload.commandId, async (finish) => {
      await finish(false);
      throw Object.assign(new Error('Synthetic transaction rollback'), {
        code,
      });
    });
    try {
      const result = await save('pm', id, payload);
      expect(result.statusCode).toBe(200);
      expect(result.json()).toMatchObject({
        status: 'saved',
        contextVersion: 2,
        revocation: 'confirmed',
      });
      expect((await get('lead', id)).statusCode).toBe(403);
      expect(
        (
          await db.query('select 1 from command_receipt where command_id=$1', [
            payload.commandId,
          ])
        ).rowCount,
      ).toBe(1);
    } finally {
      spy.mockRestore();
    }
  },
);

test.each([
  { committed: true, id: unknown },
  { committed: false, id: rollback },
])(
  'scope recovery separates committed and rolled-back commands ($committed)',
  async ({ committed, id }) => {
    const payload = edit({ leadId: actor('dev').id, remove: [removeLead()] });
    let enter!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const spy = interceptCommit(payload.commandId, async (finish) => {
      enter();
      await held;
      await finish(committed);
      throw new Error('Synthetic commit acknowledgement failure');
    });
    const pending = save('pm', id, payload);
    try {
      await entered;
      expect((await get('lead', id)).statusCode).toBe(401);
      expect((await list('lead')).statusCode).toBe(401);
      expect((await get('lead', neighbor)).statusCode).toBe(200);
    } finally {
      release();
    }
    try {
      expect((await pending).statusCode).toBe(503);
      expect((await get('lead', id)).statusCode).toBe(committed ? 403 : 200);
      expect(
        (
          await db.query('select 1 from command_receipt where command_id=$1', [
            payload.commandId,
          ])
        ).rowCount,
      ).toBe(Number(committed));
      expect((await save('pm', id, payload)).json()).toMatchObject({
        status: 'saved',
        contextVersion: 2,
      });
    } finally {
      spy.mockRestore();
    }
  },
);

test('after self-removal another affected account can resolve an unknown commit without seeing the original receipt', async () => {
  const payload = edit({
    leadId: actor('dev').id,
    remove: [
      removeLead(),
      { userId: actor('manager').id, role: 'requirement_manager' },
    ],
  });
  let unavailable = true;
  const spy = interceptCommit(
    payload.commandId,
    async (finish) => {
      await finish(true);
      throw new Error('Synthetic commit acknowledgement failure');
    },
    { id: self, blocked: () => unavailable },
  );
  try {
    const withheld = await save('manager', self, payload);
    expect(withheld.statusCode).toBe(503);
    expect(withheld.json()).not.toHaveProperty('commandId');
    expect((await get('lead', self)).statusCode).toBe(401);
    expect((await get('lead', neighbor)).statusCode).toBe(200);
    unavailable = false;
    const recovered = await get('lead', self);
    expect(recovered.statusCode).toBe(401);
    expect(recovered.json()).not.toHaveProperty('commandId');
    expect((await get('lead', self)).statusCode).toBe(403);
    const stillUnauthorized = await save('manager', self, payload);
    expect(stillUnauthorized.statusCode).toBe(403);
    expect(stillUnauthorized.json()).not.toHaveProperty('commandId');
  } finally {
    spy.mockRestore();
  }
  const restore = edit({
    previewLeadId: actor('dev').id,
    leadId: actor('dev').id,
    add: [{ userId: actor('manager').id, role: 'requirement_manager' }],
  });
  expect((await save('pm', self, restore)).json()).toMatchObject({
    status: 'saved',
    contextVersion: 3,
  });
  expect((await save('manager', self, payload)).json()).toMatchObject({
    status: 'saved',
    contextVersion: 2,
    revocation: 'previously-recorded',
  });
});

test('a recovered commit returns only authorization rejection when the original editor removed their own role', async () => {
  const payload = edit({
    remove: [{ userId: actor('manager').id, role: 'requirement_manager' }],
  });
  const spy = interceptCommit(payload.commandId, async (finish) => {
    await finish(true);
    throw new Error('Synthetic commit acknowledgement failure');
  });
  try {
    const rejected = await save('manager', selfKnown, payload);
    expect(rejected.statusCode).toBe(403);
    expect(rejected.json()).not.toHaveProperty('commandId');
    expect(
      (
        await db.query('select 1 from command_receipt where command_id=$1', [
          payload.commandId,
        ])
      ).rowCount,
    ).toBe(1);
    expect((await get('lead', selfKnown)).statusCode).toBe(200);
  } finally {
    spy.mockRestore();
  }
});

test('project-role withdrawal and personnel save follow their actual account and demand lock order', async () => {
  const target = actor('dev').id;
  const blockedHere =
    'select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))';
  const client = await db.connect();
  const pid = (await client.query('select pg_backend_pid() pid')).rows[0]
    .pid as number;
  const removeRole =
    "delete from project_member where project_id=$1 and user_id=$2 and role='developer'";
  const restoreRole =
    "insert into project_member values($1,$2,'developer') on conflict do nothing";
  const requests: Promise<unknown>[] = [];
  async function waitingOn(owner: number) {
    let waiting: number | undefined;
    await vi.waitFor(
      async () => {
        waiting = (await db.query(blockedHere, [owner])).rows[0]?.pid;
        expect(waiting).toBeDefined();
      },
      { timeout: 1700 },
    );
    return waiting!;
  }
  try {
    await client.query('begin');
    await client.query(removeRole, [project, target]);
    const rejected = save('pm', roleRace, edit({ leadId: target }));
    requests.push(rejected);
    await waitingOn(pid);
    await client.query('commit');
    expect((await rejected).json()).toMatchObject({
      status: 'invalid',
      contextVersion: 1,
    });
    await db.query(restoreRole, [project, target]);

    await client.query('begin');
    await client.query('select id from requirement where id=$1 for update', [
      roleRace,
    ]);
    const saved = save('pm', roleRace, edit({ leadId: target }));
    requests.push(saved);
    const savePid = await waitingOn(pid);
    const retirement = db.query(removeRole, [project, target]);
    requests.push(retirement);
    await waitingOn(savePid);
    await client.query('commit');
    expect((await saved).json()).toMatchObject({
      status: 'saved',
      contextVersion: 2,
    });
    await retirement;
    expect((await get('pm', roleRace)).json().requirement.leadId).toBe(target);
  } finally {
    await client.query('rollback');
    await Promise.allSettled(requests);
    await db.query(restoreRole, [project, target]);
    client.release();
  }
});

test('a queued duplicate cannot take over the same unsettled command after rollback', async () => {
  const input = edit({ leadId: actor('dev').id, remove: [removeLead()] });
  const entered = latch(),
    release = latch();
  const spy = interceptCommit(input.commandId, async (finish) => {
    entered.open();
    await release.wait;
    await finish(false);
    throw new Error('Synthetic rollback acknowledgement failure');
  });
  const blocker = await db.connect();
  const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0]
    .pid as number;
  const pending = [] as ReturnType<typeof save>[];
  try {
    await blocker.query('begin');
    await blocker.query('select id from requirement where id=$1 for update', [
      duplicate,
    ]);
    const first = save('pm', duplicate, input);
    pending.push(first);
    let firstPid!: number;
    await vi.waitFor(
      async () => {
        firstPid = (
          await db.query(
            'select pid from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
            [pid],
          )
        ).rows[0]?.pid;
        expect(firstPid).toBeDefined();
      },
      { timeout: 1700 },
    );
    const second = save('pm', duplicate, input);
    pending.push(second);
    await vi.waitFor(
      async () => {
        expect(
          (
            await db.query(
              'select 1 from pg_stat_activity where pid<>$2 and ($1=any(pg_blocking_pids(pid)) or $2=any(pg_blocking_pids(pid)))',
              [pid, firstPid],
            )
          ).rowCount,
        ).toBeGreaterThanOrEqual(1);
      },
      { timeout: 1700 },
    );
    await blocker.query('commit');
    await entered.wait;
    release.open();
    expect(
      (await Promise.all([first, second])).map(
        (response) => response.statusCode,
      ),
    ).toEqual([503, 503]);
    expect(
      (
        await db.query('select 1 from command_receipt where command_id=$1', [
          input.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    expect((await get('lead', duplicate)).statusCode).toBe(200);
    expect((await save('pm', duplicate, input)).json()).toMatchObject({
      status: 'saved',
      contextVersion: 2,
    });
  } finally {
    await blocker.query('rollback');
    release.open();
    await Promise.allSettled(pending);
    blocker.release();
    spy.mockRestore();
  }
});

test('pending demand fences independently stop wire frames in both directions', async () => {
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  class WireHost extends NativeWebHost {
    override async workspace() {
      return { cwd: '/unused', workspaceId: 'fixture' };
    }
    override socketUrl() {
      return `ws://127.0.0.1:${(upstream.address() as { port: number }).port}`;
    }
    override ticket() {
      return 'local-fixture';
    }
    override async close() {}
  }
  const server = buildApp({
    ...config,
    nativeHost: new WireHost(
      '/tmp/rdws-personnel-wire-fixture',
      undefined,
      project,
    ),
  });
  const sockets: WebSocket[] = [];
  const a = edit({ leadId: actor('dev').id, remove: [removeLead()] }),
    b = edit({ leadId: actor('dev').id, remove: [removeLead()] });
  const firstReady = latch(),
    secondReady = latch(),
    releaseFirst = latch(),
    releaseSecond = latch();
  const spy = interceptCommits(
    new Map([
      [
        a.commandId,
        async (finish) => {
          firstReady.open();
          await releaseFirst.wait;
          await finish(false);
          throw new Error('Synthetic rollback acknowledgement failure');
        },
      ],
      [
        b.commandId,
        async (finish) => {
          secondReady.open();
          await releaseSecond.wait;
          await finish(true);
          throw new Error('Synthetic commit acknowledgement failure');
        },
      ],
    ]),
  );
  const writes: Promise<unknown>[] = [];
  try {
    const address = await server.listen({ host: '127.0.0.1', port: 0 });
    async function bridge(requirementId: string) {
      const binding = await fixtureBinding(
        server,
        actor('lead').cookie,
        project,
        requirementId,
      );
      const connected = once(upstream, 'connection');
      const client = new WebSocket(
        address.replace('http:', 'ws:') +
          `/api/dsh/${requirementId}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
        { headers: { origin: config.origin, cookie: actor('lead').cookie } },
      );
      sockets.push(client);
      await once(client, 'open');
      const [peer] = (await connected) as [WebSocket];
      return { client, peer };
    }
    const first = await bridge(wireFirst),
      second = await bridge(wireSecond),
      other = await bridge(wireNeighbor);
    const outbound = (id: string) =>
      JSON.stringify({
        type: 'item',
        streamId: id,
        value: { type: 'ready', clientId: id, host: { home: '/synthetic' } },
      });
    const notice = JSON.stringify({
      type: 'item',
      streamId: 'active-before',
      value: {
        type: 'emit',
        event: 'api-session/removed',
        args: ['blocked-session'],
      },
    });
    const inbound = (id: string) =>
      JSON.stringify({
        type: 'open',
        streamId: id,
        endpoint: '$events',
        payload: { args: {} },
      });
    async function exchange(
      bridge: { client: WebSocket; peer: WebSocket },
      id: string,
    ) {
      const sent = once(bridge.peer, 'message'),
        received = once(bridge.client, 'message');
      bridge.client.send(inbound(id));
      expect(String((await sent)[0])).toBe(inbound(id));
      bridge.peer.send(outbound(id));
      expect(String((await received)[0])).toBe(outbound(id));
    }
    await exchange(first, 'active-before');
    await exchange(second, 'active-before');
    const seen: string[] = [];
    for (const side of [first, second]) {
      side.client.on('message', (data) => seen.push(String(data)));
      side.peer.on('message', (data) => seen.push(String(data)));
    }
    const post = (id: string, payload: RequirementPersonnelInput) =>
      Promise.resolve(
        server.inject({
          method: 'POST',
          url: `/api/requirements/${id}/personnel`,
          headers: headers('pm'),
          payload,
        }),
      );
    const one = post(wireFirst, a),
      two = post(wireSecond, b);
    writes.push(one, two);
    await Promise.all([firstReady.wait, secondReady.wait]);
    for (const side of [first, second]) {
      side.client.send(inbound('blocked'));
      side.peer.send(notice);
    }
    await exchange(other, 'neighbor-before');
    await sleep(100);
    expect(seen).toEqual([]);
    releaseFirst.open();
    expect((await one).statusCode).toBe(503);
    await exchange(first, 'after-rollback');
    second.client.send(inbound('blocked'));
    second.peer.send(notice);
    await exchange(other, 'neighbor-during');
    await sleep(100);
    expect(
      seen.some(
        (frame) =>
          frame.includes('"streamId":"blocked"') ||
          frame.includes('"blocked-session"'),
      ),
    ).toBe(false);
    const closed = once(second.client, 'close');
    releaseSecond.open();
    expect((await two).statusCode).toBe(503);
    expect((await closed)[0]).toBe(4001);
    await exchange(other, 'neighbor-after');
  } finally {
    releaseFirst.open();
    releaseSecond.open();
    await Promise.allSettled(writes);
    spy.mockRestore();
    for (const client of sockets) client.terminate();
    for (const peer of upstream.clients) peer.terminate();
    await server.close();
    const stopped = once(upstream, 'close');
    upstream.close();
    await stopped;
  }
});

test('Native personnel revocation closes only the affected demand and the old peer expires on notification failure', async () => {
  const root = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-personnel-native-'),
  );
  const configuration = join(root, 'config', 'projects', project, 'dsh');
  const notifications: [string, string | undefined][] = [];
  let failNotification = false;
  class Host extends NativeWebHost {
    override async revoke(
      session: string,
      id?: string,
      before?: number,
      invalidateRuns?: boolean,
    ) {
      if (!failNotification)
        return super.revoke(session, id, before, invalidateRuns);
      notifications.push([session, id]);
      throw new Error('Synthetic native notification failure');
    }
  }
  const host = new Host(root, configuration, project);
  const server = buildApp({
    ...config,
    nativeHost: host,
    nativeRuntimeRoot: root,
    repositoryHome: root,
  });
  const sockets: WebSocket[] = [],
    calls: string[] = [];
  let release!: () => void;
  const frozen = new Promise<void>((resolve) => {
    release = resolve;
  });
  const provider = createServer(async (request, response) => {
    if (request.url !== '/v1/chat/completions') {
      response.writeHead(404).end();
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk);
    calls.push(Buffer.concat(chunks).toString());
    if (calls.length === 1) await frozen;
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    for (const [delta, finish_reason] of [
      [{ role: 'assistant', content: 'Synthetic reply' }, null],
      [{}, 'stop'],
    ]) {
      response.write(
        'data: ' +
          JSON.stringify({
            id: 'personnel-fixture',
            object: 'chat.completion.chunk',
            created: 1,
            model: 'personnel-model',
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
                models: [{ id: 'personnel-model' }],
              },
            },
          },
        },
        { id: 'session-title-llm', disabled: true },
      ]),
      { mode: 0o600 },
    );
    const base = await server.listen({ host: '127.0.0.1', port: 0 });
    const removed = actor('lead');
    const otherLogin = await login('lead');
    async function openSocket(url: string, headers: Record<string, string>) {
      const client = new WebSocket(url, { headers });
      sockets.push(client);
      await once(client, 'open');
      return client;
    }
    const bridge = async (id: string, cookie: string) => {
      const binding = await bootstrapNative(server, cookie, id);
      return openSocket(
        base.replace('http:', 'ws:') +
          `/api/dsh/${id}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
        { origin: config.origin, cookie },
      );
    };
    async function create(id: string, cookie: string) {
      const response = await server.inject({
        method: 'POST',
        url: `/api/requirements/${id}/sessions`,
        headers: { origin: config.origin, cookie },
        payload: { commandId: randomUUID() },
      });
      expect(response.statusCode).toBe(200);
      return response.json().sessionId as string;
    }
    const prompt = (
      id: string,
      sessionId: string,
      cookie: string,
      binding: string,
    ) =>
      server.inject({
        method: 'POST',
        url: `/api/dsh/${id}/native/api/session/prompt`,
        headers: {
          origin: config.origin,
          cookie,
          'x-rdws-client-generation': randomUUID(),
          'x-rdws-native-login': binding,
        },
        payload: {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session/prompt',
          payload: {
            args: {
              request: {
                sessionId,
                requestId: randomUUID(),
                mode: 'queue',
                content: [
                  { type: 'text', text: 'Synthetic scope verification' },
                ],
              },
            },
          },
        },
      });
    const previous = await create(nativeDemand, removed.cookie);
    const continuing = await create(neighbor, removed.cookie);
    const removedBinding = await bootstrapNative(
      server,
      removed.cookie,
      nativeDemand,
    );
    const neighborBinding = await bootstrapNative(
      server,
      removed.cookie,
      neighbor,
    );
    const managerBinding = await bootstrapNative(
      server,
      actor('pm').cookie,
      nativeDemand,
    );
    const ownBridge = await bridge(nativeDemand, removed.cookie);
    const secondBridge = await bridge(nativeDemand, otherLogin.cookie);
    const otherBridge = await bridge(neighbor, removed.cookie);
    const stopped = Promise.all([
      once(ownBridge, 'close'),
      once(secondBridge, 'close'),
    ]);
    const scope = (await get('lead', nativeDemand)).json().requirement;
    const token = host.ticket({
      purpose: 'browser',
      userId: removed.id,
      authSessionId: removed.sessionId,
      requirementId: nativeDemand,
      workspaceId: scope.nativeWorkspaceId,
      cwd: join(host.demandRoot, nativeDemand),
      readSessionIds: [previous],
      ownSessionIds: [previous],
    });
    const expires = host.claims(token)!.expiresAt;
    const peer = await openSocket(host.socketUrl(), {
      origin: host.socketUrl().replace('ws:', 'http:').split('/_rdws')[0]!,
      'x-rdws-delegation': token,
    });
    const expired = once(peer, 'close').then(() => Date.now());
    expect(
      (
        await prompt(nativeDemand, previous, removed.cookie, removedBinding)
      ).json().result,
    ).toMatchObject({ ok: true, value: { accepted: true } });
    await expect.poll(() => calls.length).toBe(1);
    const developerRole = {
      userId: actor('dev').id,
      role: 'developer' as const,
    };
    const uncertain = edit({ remove: [developerRole] });
    let holdRecovery = true;
    const uncertainCommit = interceptCommit(
      uncertain.commandId,
      async (finish) => {
        await finish(true);
        throw new Error('Synthetic commit acknowledgement failure');
      },
      { id: nativeDemand, blocked: () => holdRecovery },
    );
    try {
      const pending = await server.inject({
        method: 'POST',
        url: `/api/requirements/${nativeDemand}/personnel`,
        headers: headers('pm'),
        payload: uncertain,
      });
      expect(pending.statusCode).toBe(503);
      holdRecovery = false;
      failNotification = true;
      for (let attempt = 0; attempt < 2; attempt++) {
        const status = await server.inject({
          url: `/api/requirements/${nativeDemand}/write-authority`,
          headers: headers('dev'),
        });
        expect(status.statusCode).toBe(401);
        expect(status.headers['cache-control']).toBe('no-store');
        expect(notifications).toHaveLength(0);
      }
      expect(ownBridge.readyState).toBe(WebSocket.OPEN);
      expect(calls).toHaveLength(1);
      const recover = () =>
        server.inject({
          url: `/api/requirements/${nativeDemand}/sessions`,
          headers: headers('dev'),
        });
      expect((await recover()).statusCode).toBe(401);
      expect((await recover()).statusCode).toBe(403);
      expect(notifications).toContainEqual([
        actor('dev').sessionId,
        nativeDemand,
      ]);
    } finally {
      uncertainCommit.mockRestore();
      failNotification = false;
      notifications.length = 0;
    }
    const restored = await server.inject({
      method: 'POST',
      url: `/api/requirements/${nativeDemand}/personnel`,
      headers: headers('pm'),
      payload: edit({ add: [developerRole] }),
    });
    expect(restored.json()).toMatchObject({ status: 'saved' });
    const operation = edit({ leadId: actor('dev').id, remove: [removeLead()] });
    failNotification = true;
    const result = await server.inject({
      method: 'POST',
      url: `/api/requirements/${nativeDemand}/personnel`,
      headers: headers('pm'),
      payload: operation,
    });
    expect(result.json()).toMatchObject({
      status: 'saved',
      revocation: 'lease-expiry',
    });
    expect((await stopped).map(([code]) => code)).toEqual([4001, 4001]);
    expect(notifications).toEqual(
      expect.arrayContaining([
        [removed.sessionId, nativeDemand],
        [otherLogin.sessionId, nativeDemand],
      ]),
    );
    expect(notifications.every(([, id]) => id === nativeDemand)).toBe(true);
    failNotification = false;
    expect(otherBridge.readyState).toBe(WebSocket.OPEN);
    expect(peer.readyState).toBe(WebSocket.OPEN);
    const denied = await prompt(
      nativeDemand,
      previous,
      removed.cookie,
      removedBinding,
    );
    expect(denied.statusCode).toBe(403);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(
      JSON.stringify({ leadId: removed.id })
        .slice(1, -1)
        .replaceAll('"', '\\"'),
    );
    release();
    await expect
      .poll(
        async () => {
          const response = await server.inject({
            method: 'POST',
            url: `/api/dsh/${nativeDemand}/native/api/session/page`,
            headers: {
              origin: config.origin,
              cookie: actor('pm').cookie,
              'x-rdws-client-generation': randomUUID(),
              'x-rdws-native-login': managerBinding,
            },
            payload: {
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/page',
              payload: {
                args: {
                  request: {
                    address: { kind: 'session', sessionId: previous },
                    maxMessages: 30,
                  },
                },
              },
            },
          });
          expect(response.statusCode).toBe(200);
          return response.body.includes('Synthetic reply');
        },
        { timeout: 5000 },
      )
      .toBe(true);
    expect(
      (
        await prompt(neighbor, continuing, removed.cookie, neighborBinding)
      ).json().result.ok,
    ).toBe(true);
    await expect.poll(() => calls.length).toBe(2);
    expect(calls[1]).toContain(neighbor);
    const next = await create(nativeDemand, actor('dev').cookie);
    const nextBinding = await bootstrapNative(
      server,
      actor('dev').cookie,
      nativeDemand,
    );
    expect(
      (
        await prompt(nativeDemand, next, actor('dev').cookie, nextBinding)
      ).json().result.ok,
    ).toBe(true);
    await expect.poll(() => calls.length).toBe(3);
    expect(calls[2]).toContain(nativeDemand);
    expect(calls[2]).toContain(
      JSON.stringify({ leadId: actor('dev').id })
        .slice(1, -1)
        .replaceAll('"', '\\"'),
    );
    expect(await expired).toBeGreaterThanOrEqual(expires - 5);
  } finally {
    release();
    for (const client of sockets) client.terminate();
    await server.close();
    const closed = once(provider, 'close');
    provider.close();
    provider.closeAllConnections();
    await closed;
    await rm(root, { recursive: true, force: true });
  }
}, 42000);
