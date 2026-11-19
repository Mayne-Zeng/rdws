import { beforeAll, afterAll, test, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { connectDatabase } from '@rdws/db';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
const app = buildApp({
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
});
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
const headers = new Map<string, { cookie: string; origin: string }>();
const users = new Map<string, string>();
const created: string[] = [];
const commands: string[] = [];
beforeAll(async () => {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await app.ready();
  for (const name of ['manager', 'pm', 'lead', 'dev', 'tester', 'admin']) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: process.env.RDWS_ORIGIN! },
      payload: accounts.find((a) => a.username === name),
    });
    expect(response.statusCode).toBe(200);
    headers.set(name, {
      cookie: response.cookies.map((c) => `${c.name}=${c.value}`).join('; '),
      origin: process.env.RDWS_ORIGIN!,
    });
    users.set(
      name,
      (await pool.query('select id from auth_user where username=$1', [name]))
        .rows[0].id,
    );
  }
});
afterAll(async () => {
  for (const id of created) {
    for (const table of [
      'requirement_event',
      'task',
      'native_session',
      'requirement_participant',
    ])
      await pool.query(`delete from ${table} where requirement_id=$1`, [id]);
    await pool.query('delete from requirement where id=$1', [id]);
  }
  if (commands.length)
    await pool.query('delete from command_receipt where command_id=any($1)', [
      commands,
    ]);
  await app.close();
  await pool.end();
});
function key() {
  const id = randomUUID();
  commands.push(id);
  return id;
}
function input() {
  return {
    commandId: key(),
    title: 'Business fixture',
    description: 'A synthetic requirement',
    acceptance: 'Atomic and scoped',
    leadId: users.get('lead'),
    participants: [
      { userId: users.get('dev'), roles: ['developer'] },
      { userId: users.get('tester'), roles: ['tester'] },
    ],
    tasks: [{ title: 'Initial task' }],
  };
}
async function create() {
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/poc/requirements',
    headers: headers.get('manager'),
    payload: input(),
  });
  expect(response.statusCode).toBe(200);
  const id = response.json().id;
  created.push(id);
  return id as string;
}
async function detail(id: string, who = 'lead') {
  const r = await app.inject({
    url: `/api/requirements/${id}`,
    headers: headers.get(who),
  });
  expect(r.statusCode).toBe(200);
  return r.json();
}
async function command(id: string, who: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/api/requirements/${id}/commands`,
    headers: headers.get(who),
    payload: { commandId: key(), ...body },
  });
}
test('creation is atomic, defaults task owner and replays a concurrent project command', async () => {
  const payload = input();
  const send = () =>
    app.inject({
      method: 'POST',
      url: '/api/projects/poc/requirements',
      headers: headers.get('manager'),
      payload,
    });
  const [a, b] = await Promise.all([send(), send()]);
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(a.json().id).toBe(b.json().id);
  const id = a.json().id;
  created.push(id);
  const value = await detail(id);
  expect(value.requirement.stage).toBe('assignment');
  expect(value.tasks).toHaveLength(1);
  expect(value.tasks[0].assigneeId).toBe(users.get('lead'));
  expect(
    value.events.filter((e: { kind: string }) => e.kind === 'task.created'),
  ).toHaveLength(1);
  const changed = await app.inject({
    method: 'POST',
    url: '/api/projects/poc/requirements',
    headers: headers.get('manager'),
    payload: { ...payload, title: 'Different' },
  });
  expect(changed.statusCode).toBe(409);
});
test('an invalid assignee rolls back the entire new requirement', async () => {
  const payload = {
    ...input(),
    title: 'Invalid ' + randomUUID(),
    tasks: [{ title: 'Invalid', assigneeId: users.get('tester') }],
  };
  const response = await app.inject({
    method: 'POST',
    url: '/api/projects/poc/requirements',
    headers: headers.get('manager'),
    payload,
  });
  expect(response.statusCode).toBe(400);
  expect(
    (
      await pool.query(
        'select count(*)::int n from requirement where title=$1',
        [payload.title],
      )
    ).rows[0].n,
  ).toBe(0);
});
test('only current lead maintains tasks and only assigned developers change their state', async () => {
  const id = await create();
  const task = (await detail(id)).tasks[0];
  expect(
    (
      await command(id, 'dev', {
        type: 'task.update',
        taskId: task.id,
        patch: { status: 'in_progress' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await command(id, 'lead', {
        type: 'task.update',
        taskId: task.id,
        patch: { assigneeId: users.get('dev') },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await command(id, 'dev', {
        type: 'task.update',
        taskId: task.id,
        patch: { status: 'in_progress' },
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (
      await command(id, 'dev', {
        type: 'task.update',
        taskId: task.id,
        patch: { title: 'Not mine to edit' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await command(id, 'tester', {
        type: 'task.update',
        taskId: task.id,
        patch: { status: 'done' },
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await command(id, 'pm', {
        type: 'task.create',
        task: { title: 'Not lead' },
      })
    ).statusCode,
  ).toBe(403);
  const other = await create();
  expect(
    (
      await command(other, 'lead', {
        type: 'task.update',
        taskId: task.id,
        patch: { status: 'done' },
      })
    ).statusCode,
  ).toBe(404);
});
test('lead jumps and rolls back stages while retries do not create extra history', async () => {
  const id = await create();
  const commandId = key();
  const payload = { commandId, type: 'requirement.stage', stage: 'testing' };
  const send = () => command(id, 'lead', payload);
  const [a, b] = await Promise.all([send(), send()]);
  expect(a.statusCode).toBe(200);
  expect(b.statusCode).toBe(200);
  expect(
    (
      await command(id, 'dev', {
        type: 'requirement.stage',
        stage: 'integration',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await command(id, 'pm', {
        type: 'requirement.stage',
        stage: 'integration',
      })
    ).statusCode,
  ).toBe(403);
  expect(
    (
      await command(id, 'lead', {
        type: 'requirement.stage',
        stage: 'development',
      })
    ).statusCode,
  ).toBe(200);
  const value = await detail(id);
  expect(value.requirement.stage).toBe('development');
  expect(
    value.events.filter(
      (e: { kind: string }) => e.kind === 'requirement.stage',
    ),
  ).toHaveLength(2);
});
test('concurrent fields survive and stage history has a coherent committed order', async () => {
  const id = await create();
  const task = (await detail(id)).tasks[0];
  const results = await Promise.all([
    command(id, 'lead', {
      type: 'task.update',
      taskId: task.id,
      patch: { title: 'Updated' },
    }),
    command(id, 'lead', {
      type: 'task.update',
      taskId: task.id,
      patch: { status: 'in_progress' },
    }),
  ]);
  expect(results.map((r) => r.statusCode)).toEqual([200, 200]);
  const [a, b] = await Promise.all([
    command(id, 'lead', { type: 'requirement.stage', stage: 'testing' }),
    command(id, 'lead', { type: 'requirement.stage', stage: 'design' }),
  ]);
  expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
  const value = await detail(id);
  expect(value.tasks[0]).toMatchObject({
    title: 'Updated',
    status: 'in_progress',
  });
  const events = value.events
    .filter((e: { kind: string }) => e.kind === 'requirement.stage')
    .reverse();
  expect(events[1].before).toBe(events[0].after);
  expect(value.requirement.stage).toBe(events[1].after);
});
async function waitForBlocked(blocker: number) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const r = await pool.query(
      'select count(*)::int n from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
      [blocker],
    );
    if (r.rows[0].n > 0) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Expected a real database lock wait');
}
test('a committed disable wins over a state operation waiting for identity', async () => {
  const id = await create(),
    locker = await pool.connect();
  try {
    await locker.query('begin');
    const pid = (await locker.query('select pg_backend_pid() id')).rows[0].id;
    await locker.query('update auth_user set active=false where id=$1', [
      users.get('lead'),
    ]);
    const operation = command(id, 'lead', {
      type: 'requirement.stage',
      stage: 'testing',
    });
    await waitForBlocked(pid);
    await locker.query('commit');
    expect((await operation).statusCode).toBe(401);
  } finally {
    await locker.query('rollback');
    locker.release();
    await pool.query('update auth_user set active=true where id=$1', [
      users.get('lead'),
    ]);
  }
});
test('an admitted operation finishes before a later disable that waits for its shared identity lock', async () => {
  const id = await create(),
    locker = await pool.connect(),
    disabler = await pool.connect();
  try {
    await locker.query('begin');
    const pid = (await locker.query('select pg_backend_pid() id')).rows[0].id;
    await locker.query('select id from requirement where id=$1 for update', [
      id,
    ]);
    const operation = command(id, 'lead', {
      type: 'requirement.stage',
      stage: 'testing',
    });
    await waitForBlocked(pid);
    const disable = disabler.query(
      'update auth_user set active=false where id=$1',
      [users.get('lead')],
    );
    await locker.query('commit');
    expect((await operation).statusCode).toBe(200);
    await disable;
    expect(
      (await pool.query('select stage from requirement where id=$1', [id]))
        .rows[0].stage,
    ).toBe('testing');
  } finally {
    await locker.query('rollback');
    locker.release();
    disabler.release();
    await pool.query('update auth_user set active=true where id=$1', [
      users.get('lead'),
    ]);
  }
});
test('a disabled assignment target cannot be accepted after a lock wait', async () => {
  const id = await create(),
    task = (await detail(id)).tasks[0],
    locker = await pool.connect();
  try {
    await locker.query('begin');
    const pid = (await locker.query('select pg_backend_pid() id')).rows[0].id;
    await locker.query('update auth_user set active=false where id=$1', [
      users.get('dev'),
    ]);
    const operation = command(id, 'lead', {
      type: 'task.update',
      taskId: task.id,
      patch: { assigneeId: users.get('dev') },
    });
    await waitForBlocked(pid);
    await locker.query('commit');
    expect((await operation).statusCode).toBe(400);
  } finally {
    await locker.query('rollback');
    locker.release();
    await pool.query('update auth_user set active=true where id=$1', [
      users.get('dev'),
    ]);
  }
});
test('one participant may hold multiple explicit project-backed roles', async () => {
  await pool.query(
    'insert into project_member(project_id,user_id,role) values($1,$2,$3)',
    ['poc', users.get('dev'), 'tester'],
  );
  try {
    const payload = input();
    payload.participants[0]!.roles = ['developer', 'tester'];
    const result = await app.inject({
      method: 'POST',
      url: '/api/projects/poc/requirements',
      headers: headers.get('manager'),
      payload,
    });
    expect(result.statusCode).toBe(200);
    const id = result.json().id;
    created.push(id);
    expect(
      (await detail(id)).participants
        .find((p: { id: string }) => p.id === users.get('dev'))
        .roles.sort(),
    ).toEqual(['developer', 'tester']);
  } finally {
    await pool.query(
      'delete from project_member where project_id=$1 and user_id=$2 and role=$3',
      ['poc', users.get('dev'), 'tester'],
    );
  }
});
test('incremental lead migration preserves existing roles and never grants project development', async () => {
  const client = await pool.connect();
  try {
    await client.query('begin');
    await client.query(
      'create temp table requirement(id text,project_id text,lead_id text,context_version int);create temp table project_member(project_id text,user_id text,role text);create temp table requirement_participant(requirement_id text,user_id text,role text,primary key(requirement_id,user_id,role));create temp table requirement_event(id text,requirement_id text,kind text,actor_id text,source text,command_id text,version int,after jsonb)',
    );
    await client.query(
      "insert into requirement values('r','p','lead',1),('other','p','tester',1);insert into project_member values('p','lead','developer'),('p','tester','tester');insert into requirement_participant values('r','lead','tester'),('other','tester','tester')",
    );
    const migration = await readFile(
      'packages/db/migrations/0003_preserve_lead_participation.sql',
      'utf8',
    );
    await client.query(migration);
    await client.query(migration);
    expect(
      (
        await client.query(
          'select role from requirement_participant where requirement_id=$1 order by role',
          ['r'],
        )
      ).rows.map((r) => r.role),
    ).toEqual(['developer', 'tester']);
    expect(
      (
        await client.query(
          'select count(*)::int n from requirement_participant where requirement_id=$1 and role=$2',
          ['other', 'developer'],
        )
      ).rows[0].n,
    ).toBe(0);
    expect(
      (await client.query('select count(*)::int n from requirement_event'))
        .rows[0].n,
    ).toBe(1);
  } finally {
    await client.query('rollback');
    client.release();
  }
});

test('the context snapshot cannot mix versions when a task changes between queries', async () => {
  const id = await create(),
    initial = await detail(id),
    task = initial.tasks[0];
  const auth = (
    await app.inject({
      url: '/api/auth/get-session',
      headers: headers.get('lead'),
    })
  ).json();
  expect((await pool.query('select current_database() db')).rows[0]?.db).toBe(
    'rdws_test',
  );
  const related = randomUUID();
  const relatedExpiry = new Date(Date.now() + 60_000);
  expect(new Date(auth.session.expiresAt).getTime()).toBeGreaterThan(
    relatedExpiry.getTime(),
  );
  const database = connectDatabase(process.env.DATABASE_URL!);
  let enter = () => {},
    release = () => {};
  const entered = new Promise<void>((resolve) => {
      enter = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  database.pool.on('connect', (client) => {
    const original = client.query.bind(client);
    client.query = ((...args: unknown[]) => {
      const first = args[0];
      const text =
        typeof first === 'string'
          ? first
          : ((first as { text?: string })?.text ?? '');
      if (text.includes('from "task"')) {
        enter();
        return gate.then(() => Reflect.apply(original, client, args));
      }
      return Reflect.apply(original, client, args);
    }) as typeof client.query;
  });
  try {
    const added = await pool.query(
      'insert into auth_session(id,token,expires_at,user_id,auth_epoch,created_at,updated_at) select $2,$3,$4,user_id,auth_epoch,now(),now() from auth_session where id=$1',
      [auth.session.id, related, randomUUID(), relatedExpiry],
    );
    expect(added.rowCount).toBe(1);
    const pending = createBusiness(database.db).readWithDeadline(
      { userId: auth.user.id, authSessionId: auth.session.id },
      id,
      undefined,
      [{ userId: auth.user.id, authSessionId: related }],
    );
    await entered;
    expect(
      (
        await command(id, 'lead', {
          type: 'task.update',
          taskId: task.id,
          patch: { title: 'Changed during snapshot' },
        })
      ).statusCode,
    ).toBe(200);
    release();
    const { detail: snapshot, validBefore } = await pending;
    expect(validBefore).toBe(relatedExpiry.getTime());
    expect(snapshot.requirement.contextVersion).toBe(
      initial.requirement.contextVersion,
    );
    expect(snapshot.tasks[0]!.title).toBe(task.title);
    const fresh = await detail(id);
    expect(fresh).not.toHaveProperty('validBefore');
    expect(fresh.requirement.contextVersion).toBe(
      initial.requirement.contextVersion + 1,
    );
    expect(fresh.tasks[0].title).toBe('Changed during snapshot');
  } finally {
    release();
    await database.pool.end();
    await pool.query('delete from auth_session where id=$1', [related]);
  }
});
test('stage reachability survives a large recent task activity window', async () => {
  const id = await create();
  expect(
    (await command(id, 'lead', { type: 'requirement.stage', stage: 'testing' }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await command(id, 'lead', {
        type: 'requirement.stage',
        stage: 'development',
      })
    ).statusCode,
  ).toBe(200);
  await pool.query(
    "insert into requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,after) select $1||g,$2,'task.updated',$3,'web',$1,100+g,'{}'::jsonb from generate_series(1,110) g",
    [randomUUID(), id, users.get('lead')],
  );
  const value = await detail(id);
  expect(
    value.events.some((e: { kind: string }) => e.kind === 'requirement.stage'),
  ).toBe(false);
  expect(value.reachedStages).toContain('testing');
});
test.each(['role', 'assignment'] as const)(
  'a committed %s change wins over a waiting developer state operation',
  async (kind) => {
    const id = await create(),
      task = (await detail(id)).tasks[0];
    await command(id, 'lead', {
      type: 'task.update',
      taskId: task.id,
      patch: { assigneeId: users.get('dev') },
    });
    const locker = await pool.connect();
    try {
      await locker.query('begin');
      const pid = (await locker.query('select pg_backend_pid() id')).rows[0].id;
      if (kind === 'role')
        await locker.query(
          'delete from project_member where project_id=$1 and user_id=$2 and role=$3',
          ['poc', users.get('dev'), 'developer'],
        );
      else {
        await locker.query(
          'select id from requirement where id=$1 for update',
          [id],
        );
        await locker.query('update task set assignee_id=$1 where id=$2', [
          users.get('lead'),
          task.id,
        ]);
      }
      const operation = command(id, 'dev', {
        type: 'task.update',
        taskId: task.id,
        patch: { status: 'done' },
      });
      await waitForBlocked(pid);
      await locker.query('commit');
      expect((await operation).statusCode).toBe(403);
    } finally {
      await locker.query('rollback');
      locker.release();
      if (kind === 'role')
        await pool.query(
          'insert into project_member values($1,$2,$3) on conflict do nothing',
          ['poc', users.get('dev'), 'developer'],
        );
    }
  },
);
test.each(['role', 'assignment', 'target'] as const)(
  'an admitted operation finishes before a later %s change',
  async (kind) => {
    const id = await create(),
      task = (await detail(id)).tasks[0];
    if (kind !== 'target')
      await command(id, 'lead', {
        type: 'task.update',
        taskId: task.id,
        patch: { assigneeId: users.get('dev') },
      });
    const locker = await pool.connect(),
      other = await pool.connect();
    try {
      await locker.query('begin');
      const pid = (await locker.query('select pg_backend_pid() id')).rows[0].id;
      await locker.query('select id from requirement where id=$1 for update', [
        id,
      ]);
      const operation = command(id, kind === 'target' ? 'lead' : 'dev', {
        type: 'task.update',
        taskId: task.id,
        patch:
          kind === 'target'
            ? { assigneeId: users.get('dev') }
            : { status: 'in_progress' },
      });
      await waitForBlocked(pid);
      const change =
        kind === 'role'
          ? other.query(
              'delete from project_member where project_id=$1 and user_id=$2 and role=$3',
              ['poc', users.get('dev'), 'developer'],
            )
          : kind === 'target'
            ? other.query('update auth_user set active=false where id=$1', [
                users.get('dev'),
              ])
            : command(id, 'lead', {
                type: 'task.update',
                taskId: task.id,
                patch: { assigneeId: users.get('lead') },
              });
      await locker.query('commit');
      expect((await operation).statusCode).toBe(200);
      await change;
    } finally {
      await locker.query('rollback');
      locker.release();
      other.release();
      await pool.query('update auth_user set active=true where id=$1', [
        users.get('dev'),
      ]);
      if (kind === 'role')
        await pool.query(
          'insert into project_member values($1,$2,$3) on conflict do nothing',
          ['poc', users.get('dev'), 'developer'],
        );
    }
  },
);
