import { execFileSync } from 'node:child_process';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { hashPassword } from 'better-auth/crypto';
import { taskAssignmentMaterial } from '@rdws/contracts';
import { NativeWebHost } from '@rdws/dsh/web';
import { DemandWorktrees } from '@rdws/orchestrator';
import { buildApp } from '@rdws/server';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { Client, Pool, type PoolClient } from 'pg';
import { afterEach, expect, test, vi } from 'vitest';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import { checkedWriteTransaction } from '../../apps/server/src/modules/checked-write-transaction.ts';
import { connectDatabase, schema } from '@rdws/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import WebSocket from 'ws';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { bootstrapNative, observedLogin } from '../helpers/native-browser.ts';

afterEach(() => vi.unstubAllEnvs());

function latch() {
  let resolve!: () => void;
  let opened = false;
  const promise = new Promise<void>((done) => {
    resolve = () => {
      opened = true;
      done();
    };
  });
  return { promise, resolve, wait: () => expect.poll(() => opened).toBe(true) };
}

function holdGuardedCommit(
  scope: string,
  outcome: 'delay' | 'lose' | 'rollback' = 'delay',
) {
  let release!: () => void;
  let entered = false;
  let command: string | undefined;
  let originalBackend: number | undefined;
  const receiptBackends: number[] = [];
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient & { processID: number }) => {
      const query = client.query;
      let marked = false;
      client.query = ((...parameters: unknown[]) => {
        const config = parameters[0] as
          string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof config === 'string'
            ? []
            : config.values;
        if (values?.includes('write.authority:' + scope)) {
          if (text?.startsWith('insert into "command_receipt"') && !entered) {
            marked = true;
            originalBackend = client.processID;
          }
          if (
            text?.startsWith('select "digest" from "command_receipt"') &&
            entered
          )
            receiptBackends.push(client.processID);
        }
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (text === 'commit' && marked && !entered)
          return (async () => {
            if (outcome === 'rollback')
              await Reflect.apply(query, client, ['select 1 / 0']).catch(
                () => {},
              );
            const result = await Reflect.apply(query, client, parameters);
            command = result.command;
            entered = true;
            if (outcome === 'lose')
              throw new Error(
                'Synthetic guarded transaction acknowledgement failure',
              );
            if (outcome === 'delay') await wait;
            return result;
          })();
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    get entered() {
      return entered;
    },
    expectIndependentReceipt(expected: 'COMMIT' | 'ROLLBACK') {
      expect(command).toBe(expected);
      expect(originalBackend).toEqual(expect.any(Number));
      expect(receiptBackends.length).toBeGreaterThan(0);
      expect(receiptBackends).not.toContain(originalBackend);
    },
    release,
    restore: () => spy.mockRestore(),
  };
}

function holdCheckoutResult(
  matches: (sql: string, parameters: unknown[]) => boolean,
) {
  const persisted = latch();
  const finish = latch();
  const rolledBack = latch();
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      let held = false;
      client.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as string | { text: string };
        const sql = typeof input === 'string' ? input : input.text;
        const response = Reflect.apply(query, client, parameters);
        if (sql === 'rollback' || sql === 'commit') {
          client.query = query;
          if (held && sql === 'rollback') rolledBack.resolve();
        }
        if (matches(sql, parameters)) {
          held = true;
          return response.then(async (result: unknown) => {
            persisted.resolve();
            await finish.promise;
            return result;
          });
        }
        return response;
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return { persisted, finish, rolledBack, restore: () => spy.mockRestore() };
}

function refuseGuardedRead(scope: string, foreign: AsyncLocalStorage<boolean>) {
  let foreignReads = 0;
  let attempts = 0;
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      client.query = ((...parameters: unknown[]) => {
        const config = parameters[0] as
          string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof config === 'string'
            ? []
            : config.values;
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (
          text?.startsWith('select "digest" from "command_receipt"') &&
          values?.includes('write.authority:' + scope)
        ) {
          attempts++;
          if (foreign.getStore()) foreignReads++;
          return Promise.reject(
            new Error('Synthetic write authority proof unavailable'),
          );
        }
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    get foreignReads() {
      return foreignReads;
    },
    get attempts() {
      return attempts;
    },
    restore: () => spy.mockRestore(),
  };
}

test('a guarded transaction discards a pooled connection with an unfinished transaction', async () => {
  const lab = await authorityDatabase();
  const pool = new Pool({ connectionString: lab.databaseUrl, max: 1 });
  try {
    await lab.admin.query(
      "alter role rdws_test_app set synchronous_commit='off'",
    );
    const configured = connectDatabase(
      lab.databaseUrl,
      undefined,
      undefined,
      true,
    ).pool;
    try {
      const [first, second] = await Promise.all([
        configured.connect(),
        configured.connect(),
      ]);
      try {
        const settings = await Promise.all(
          [first, second].map((client) =>
            client.query('show synchronous_commit'),
          ),
        );
        expect(settings.map(({ rows }) => rows[0]?.synchronous_commit)).toEqual(
          ['on', 'on'],
        );
      } finally {
        first.release();
        second.release();
      }
    } finally {
      await configured.end();
    }
    const stale = await pool.connect();
    try {
      await stale.query('begin');
      await stale.query(
        "insert into project(id,name) values('uncommitted','Synthetic unfinished operation')",
      );
    } finally {
      stale.release();
    }
    const guarded = checkedWriteTransaction(pool);
    const read = (tx: Parameters<Parameters<typeof guarded>[0]>[0]) =>
      tx
        .select()
        .from(schema.project)
        .where(eq(schema.project.id, 'uncommitted'));
    await expect(guarded(read)).rejects.toThrow('connection is not idle');
    expect(await guarded(read)).toEqual([]);
    const bounded = connectDatabase(lab.databaseUrl, undefined, 250, true).pool;
    try {
      const timed = await bounded.connect();
      let previousBackend: number | undefined;
      try {
        previousBackend = (
          await timed.query<{ pid: number }>('select pg_backend_pid() as pid')
        ).rows[0]?.pid;
        await timed.query('begin');
        await timed.query(
          "insert into project(id,name) values('timed','Synthetic timed operation')",
        );
        await expect(timed.query('select pg_sleep(2)')).rejects.toThrow(
          'Query read timeout',
        );
      } finally {
        timed.release();
      }
      expect(
        (await bounded.query<{ pid: number }>('select pg_backend_pid() as pid'))
          .rows[0]?.pid,
      ).not.toBe(previousBackend);
      expect(
        (await bounded.query("select id from project where id='timed'")).rows,
      ).toEqual([]);
      const beforeBegin = await bounded.connect();
      const query = beforeBegin.query;
      let opened = false;
      beforeBegin.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as string | { text: string };
        const text = typeof input === 'string' ? input : input.text;
        if (!opened && text?.startsWith('begin')) {
          opened = true;
          return Reflect.apply(query, beforeBegin, ['select pg_sleep(2)']);
        }
        return Reflect.apply(query, beforeBegin, parameters);
      }) as typeof query;
      beforeBegin.release();
      await expect(
        drizzle(bounded).transaction(async () => true),
      ).rejects.toMatchObject({ cause: { message: 'Query read timeout' } });
      expect(opened).toBe(true);
      expect(bounded.totalCount).toBe(0);
    } finally {
      await bounded.end();
    }
  } finally {
    await pool.end();
    await lab.close();
  }
});

test('a rejected ordinary BEGIN discards that real PostgreSQL checkout', async () => {
  const lab = await authorityDatabase();
  const { db, pool } = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const original = await pool.connect();
  try {
    const pid = (
      await original.query<{ pid: number }>('select pg_backend_pid() as pid')
    ).rows[0]!.pid;
    original.release();
    const entered = vi.fn(async () => true);
    await expect(
      db.transaction(entered, {
        isolationLevel: 'invalid isolation fixture' as 'read committed',
      }),
    ).rejects.toMatchObject({ cause: { code: '42601' } });
    expect(entered).not.toHaveBeenCalled();
    expect(pool.totalCount).toBe(0);
    expect(
      (await pool.query<{ pid: number }>('select pg_backend_pid() as pid'))
        .rows[0]!.pid,
    ).not.toBe(pid);
  } finally {
    if (pool.totalCount > pool.idleCount) original.release(true);
    await pool.end();
    await lab.close();
  }
});

test('a borrowed PostgreSQL backend can disconnect and a saturated pool recovers', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const clients: PoolClient[] = [];
  try {
    const broken = await database.pool.connect();
    try {
      const pid = (
        await broken.query<{ pid: number }>('select pg_backend_pid() as pid')
      ).rows[0]!.pid;
      expect(
        (
          await lab.admin.query('select pg_terminate_backend($1) as stopped', [
            pid,
          ])
        ).rows[0]?.stopped,
      ).toBe(true);
      await expect.poll(() => database.pool.totalCount).toBe(0);
      await expect(broken.query('select 1')).rejects.toThrow();
      expect(
        (
          await database.pool.query<{ pid: number }>(
            'select pg_backend_pid() as pid',
          )
        ).rows[0]!.pid,
      ).not.toBe(pid);
    } finally {
      broken.release();
    }
    for (let index = 0; index < database.pool.options.max!; index++)
      clients.push(await database.pool.connect());
    await expect(database.pool.connect()).rejects.toThrow('timeout');
    expect(database.pool.waitingCount).toBe(0);
    clients.pop()!.release();
    expect((await database.pool.query('select 1 as ready')).rows).toEqual([
      { ready: 1 },
    ]);
  } finally {
    for (const client of clients) client.release();
    await database.close();
    await lab.close();
  }
});

test('a late real BEGIN never enters business logic and remains in the shutdown drain', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const acknowledgedBegin = latch();
  const finishBegin = latch();
  const client = await database.pool.connect();
  const [{ pid }] = (
    await client.query<{ pid: number }>('select pg_backend_pid() as pid')
  ).rows as [{ pid: number }];
  const query = client.query;
  client.query = ((...parameters: unknown[]) => {
    const input = parameters[0] as string | { text: string };
    const sql = typeof input === 'string' ? input : input.text;
    const result = Reflect.apply(query, client, parameters);
    return /^begin\b/i.test(sql)
      ? result.then(async (value: unknown) => {
          acknowledgedBegin.resolve();
          await finishBegin.promise;
          return value;
        })
      : result;
  }) as typeof query;
  client.release();
  const checked = checkedWriteTransaction(database.pool);
  const work = vi.fn(async () => true);
  const rejected = expect(checked(work)).rejects.toThrow(
    'transaction timed out',
  );
  try {
    await acknowledgedBegin.promise;
    expect(client.getTransactionStatus()).toBe('T');
    expect(
      (
        await lab.admin.query(
          'select state from pg_stat_activity where pid=$1',
          [pid],
        )
      ).rows[0]?.state,
    ).toBe('idle in transaction');
    await rejected;
    const drained = vi.fn();
    const draining = checked.drain().then(drained);
    await expect.poll(() => database.pool.totalCount).toBe(0);
    await expect
      .poll(
        async () =>
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
      )
      .toBe(0);
    expect(drained).not.toHaveBeenCalled();
    finishBegin.resolve();
    await draining;
    expect(work).not.toHaveBeenCalled();
  } finally {
    finishBegin.resolve();
    await checked.drain();
    await database.close();
    await lab.close();
  }
});

test('database shutdown waits for the real connection end after the pool removes it', async () => {
  const lab = await authorityDatabase();
  const database = connectDatabase(lab.databaseUrl, undefined, 500, true);
  const client = await database.pool.connect();
  const pid = (
    await client.query<{ pid: number }>('select pg_backend_pid() as pid')
  ).rows[0]!.pid;
  const finish = latch();
  const end = Client.prototype.end;
  const closeClient = vi
    .spyOn(Client.prototype, 'end')
    .mockImplementation(function (this: Client, ...args: unknown[]) {
      return this === (client as unknown)
        ? finish.promise.then(() => Reflect.apply(end, this, args))
        : Reflect.apply(end, this, args);
    } as typeof end);
  const returned = vi.fn();
  client.release(true);
  const closing = database.close().then(returned);
  try {
    await expect.poll(() => database.pool.totalCount).toBe(0);
    expect(
      (
        await lab.admin.query('select pid from pg_stat_activity where pid=$1', [
          pid,
        ])
      ).rowCount,
    ).toBe(1);
    expect(returned).not.toHaveBeenCalled();
    finish.resolve();
    await closing;
    await expect
      .poll(
        async () =>
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
      )
      .toBe(0);
  } finally {
    finish.resolve();
    closeClient.mockRestore();
    await closing;
    await lab.close();
  }
});

test.skipIf(process.platform !== 'darwin')(
  'shutdown retains its owner when a committed qualification command still cannot be read back',
  async () => {
    const lab = await authorityDatabase();
    const userId = randomUUID();
    const requirementId = randomUUID();
    const taskId = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      await lab.owner.query(
        "insert into project(id,name) values('poc','Proof fixture')",
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username) values($1,'Fixture','proof@fixture.invalid','proof')",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values('poc',$1,'developer')",
        [userId],
      );
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,'poc','Proof fixture','','',$2,$2)",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      await lab.owner.query(
        "insert into task(id,requirement_id,title,assignee_id,created_by) values($1,$2,'Proof task',$3,$3)",
        [taskId, requirementId, userId],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      const bff = buildApp({
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        origin,
        nativeRuntimeRoot: lab.root,
        repositoryHome: lab.root,
        authorityTicket: ticket,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      });
      app = bff;
      await bff.ready();
      const login = await bff.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: { username: 'proof', password },
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies
        .map(({ name, value }) => name + '=' + value)
        .join('; ');
      const authority = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      const readFailure = refuseGuardedRead(
        'requirement:' + requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        const outcome = await bff.inject({
          method: 'POST',
          url: `/api/requirements/${requirementId}/commands`,
          headers: { cookie, origin },
          payload: {
            type: 'task.update',
            commandId: randomUUID(),
            taskId,
            patch: { status: 'done' },
          },
        });
        expect(outcome.statusCode, outcome.body).toBe(503);
        expect(
          (
            await lab.owner.query('select status from task where id=$1', [
              taskId,
            ])
          ).rows[0]?.status,
        ).toBe('done');
        expect(readFailure.attempts).toBeGreaterThan(0);
        await expect(bff.close()).rejects.toThrow('shutdown was not confirmed');
        app = undefined;
        expect(
          (
            await lab.owner.query(
              'select generation from rdws_authority.owner where singleton',
            )
          ).rows[0]?.generation,
        ).toBe(authority);
      } finally {
        readFailure.restore();
      }
    } finally {
      await app?.close().catch(() => {});
      await lab.close();
    }
  },
);

test.skipIf(process.platform !== 'darwin')(
  'the BFF shares one owner and stops a real write when a guarded route removes its authority',
  async () => {
    const lab = await authorityDatabase();
    const projectId = 'poc';
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('hex');
    const origin = lab.childEnv.RDWS_ORIGIN!;
    const taskId = randomUUID();
    const secondTask = randomUUID();
    let fixture: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    let app: ReturnType<typeof buildApp> | undefined;
    try {
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Shared writer')",
        [projectId],
      );
      const encrypted = await hashPassword(password);
      async function account(username: string, role: string, admin = false) {
        const userId = randomUUID();
        await lab.owner.query(
          'insert into auth_user (id,name,email,username,active,platform_admin) values ($1,$2,$3,$2,true,$4)',
          [userId, username, username + '@fixture.invalid', admin],
        );
        await lab.owner.query('insert into project_member values ($1,$2,$3)', [
          projectId,
          userId,
          role,
        ]);
        await lab.owner.query(
          "insert into auth_account (id,account_id,provider_id,user_id,password) values ($1,$2,'credential',$2,$3)",
          [randomUUID(), userId, encrypted],
        );
        return { userId, username };
      }
      const lead = await account('shared_lead', 'developer');
      const assigned = await account('shared_worker', 'developer');
      const manager = await account('shared_manager', 'project_admin', true);

      fixture = await httpsGitFixture(projectId);
      mirrors = new RepositoryMirrors(fixture.root);
      trees = new DemandWorktrees(fixture.root, mirrors);
      await writeFile(join(fixture.work, 'sample.txt'), 'baseline');
      await fixtureGit(['-C', fixture.work, 'add', '--', 'sample.txt']);
      await fixture.commit();
      await fixture.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const baselines = await mirrors.captureBaselines(projectId);
      async function demand(ownerId: string) {
        const id = randomUUID();
        const sessionId = randomUUID();
        await lab.owner.query(
          "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by) values ($1,$2,'Fixture','','',$3,$4)",
          [id, projectId, lead.userId, lead.userId],
        );
        for (const member of [lead, assigned])
          await lab.owner.query(
            "insert into requirement_participant values ($1,$2,'developer')",
            [id, member.userId],
          );
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values ($1,$2,$3)',
          [sessionId, id, ownerId],
        );
        const plan = baselines.map((entry) => ({
          ...entry,
          branch: `rdws/${id}/${entry.repositoryId}`,
          worktreePath: 'worktrees/' + entry.repositoryId,
          gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
        }));
        await trees!.prepare(projectId, id, plan);
        await lab.owner.query(
          'insert into requirement_worktree_plan values ($1,$2)',
          [id, JSON.stringify(plan)],
        );
        const scope = await trees!.executionScope(projectId, id, plan, 'app');
        return {
          requirementId: id,
          sessionId,
          tree: scope.tree,
          control: scope.control,
        };
      }
      const work = await demand(assigned.userId);
      const other = await demand(lead.userId);
      const forFailedClose = await demand(lead.userId);
      await lab.owner.query(
        "insert into task (id,requirement_id,title,assignee_id,created_by,status) values ($1,$2,'Assignment',$3,$4,'in_progress')",
        [taskId, work.requirementId, assigned.userId, lead.userId],
      );
      await lab.owner.query(
        "insert into task (id,requirement_id,title,assignee_id,created_by,status) values ($1,$2,'Second assignment',$3,$4,'todo')",
        [secondTask, work.requirementId, assigned.userId, lead.userId],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      const profile = join(fixture.root, 'config/projects/poc/dsh');
      await mkdir(join(profile, 'profiles/rdws'), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(profile, '.credentials.yaml'),
        JSON.stringify({
          version: 1,
          refs: { FIXTURE_WRITE: 'synthetic-local-only' },
        }),
        { mode: 0o600 },
      );
      await writeFile(
        join(profile, 'profiles/rdws/cordis.patch.yml'),
        JSON.stringify([
          {
            id: 'llm-pi-ai',
            config: {
              providers: {
                'rdws-glm': {
                  api: 'openai-completions',
                  baseURL: 'http://127.0.0.1:1/v1',
                  apiKeyEnv: 'FIXTURE_WRITE',
                  models: [{ id: 'synthetic-test' }],
                },
              },
            },
          },
        ]),
        { mode: 0o600 },
      );
      vi.stubEnv('RDWS_MODE', 'test');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      const config = {
        databaseUrl: lab.databaseUrl,
        origin,
        secret: lab.childEnv.BETTER_AUTH_SECRET!,
        nativeRuntimeRoot: fixture.root,
        repositoryHome: fixture.root,
        nativeProfiles: new Map([[projectId, profile]]),
        authorityTicket: ticket,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      };
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
      expect(() => buildApp(config)).toThrow('managed macOS test BFF');
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      let pathReads = 0;
      const halfStarted = buildApp({
        ...config,
        isolatedWrite: {
          get gitPath() {
            if (++pathReads > 1)
              throw new Error('Synthetic failure after owner admission');
            return config.isolatedWrite.gitPath;
          },
        },
      });
      await expect(halfStarted.ready()).rejects.toThrow(
        'Synthetic failure after owner admission',
      );
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBeNull();
      await halfStarted.close().catch(() => {});
      async function refreshTicket() {
        config.authorityTicket = randomBytes(32).toString('hex');
        await lab.owner.query(
          'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
          [createHash('sha256').update(config.authorityTicket).digest('hex')],
        );
      }
      await refreshTicket();
      const inStartup = buildApp(config);
      const admission = holdCheckoutResult((sql) =>
        sql.startsWith('select rdws_authority.admit_owner'),
      );
      const starting = Promise.resolve(inStartup.ready()).catch(
        (error: unknown) => error,
      );
      try {
        await admission.persisted.wait();
        const shutdown = inStartup.close().catch((error: unknown) => error);
        admission.finish.resolve();
        expect(await starting).toMatchObject({
          message: 'Write handoff closed during startup',
        });
        await shutdown;
        expect(
          inStartup.getDecorator<() => OwnedWriteHandoff | undefined>(
            'isolatedWriteHandoff',
          )(),
        ).toBeUndefined();
        expect(
          (
            await lab.owner.query(
              'select generation from rdws_authority.owner where singleton',
            )
          ).rows[0]?.generation,
        ).toBeNull();
      } finally {
        admission.finish.resolve();
        admission.restore();
        await inStartup.close().catch(() => {});
      }
      await refreshTicket();
      const shared = buildApp(config);
      app = shared;
      await shared.ready();
      const broker = shared.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      expect(broker).toBeDefined();
      const originalGeneration = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      expect(originalGeneration).toBeTruthy();
      const competing = buildApp(config);
      await expect(competing.ready()).rejects.toThrow();
      await competing.close().catch(() => {});
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBe(originalGeneration);

      async function login(
        account: { username: string; userId: string },
        instance = shared,
      ) {
        const loggedIn = await instance.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin },
          payload: { username: account.username, password },
        });
        expect(loggedIn.statusCode, loggedIn.body).toBe(200);
        const cookie = loggedIn.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        return {
          cookie,
          userId: account.userId,
          authSessionId: await observedLogin(instance, cookie),
        };
      }
      const developer = await login(assigned);
      const maintainer = await login(lead);
      const administrator = await login(manager);
      const rows = async (id: string) =>
        (
          await lab.owner.query(
            'select generation,phase,run_id from requirement_write_lease where requirement_id=$1',
            [id],
          )
        ).rows[0];
      async function launch(
        who: typeof developer,
        target: typeof work,
        text: string,
      ) {
        const scope = {
          who: { userId: who.userId, authSessionId: who.authSessionId },
          projectId,
          requirementId: target.requirementId,
          sessionId: target.sessionId,
        };
        const grant = await broker.acquire(scope, randomUUID());
        let running = false;
        const result = broker.execute(
          scope,
          {
            generation: grant.generation,
            commandId: randomUUID(),
            repositoryId: 'app',
            request: {
              tool: 'shell',
              script: `printf '%s' '${text}' > sample.txt; printf running; while :; do :; done`,
            },
          },
          () => {
            running = true;
          },
        );
        void result.catch(() => {});
        await expect.poll(() => running).toBe(true);
        return { scope, grant, result };
      }
      const idle = await launch(maintainer, other, 'other demand');
      const running = await launch(developer, work, 'old worker');
      const task = (
        person: typeof developer,
        status: 'done' | 'in_progress',
        id = taskId,
        commandId = randomUUID(),
      ) =>
        shared.inject({
          method: 'POST',
          url: `/api/requirements/${work.requirementId}/commands`,
          headers: { origin, cookie: person.cookie },
          payload: {
            type: 'task.update',
            commandId,
            taskId: id,
            patch: { status },
          },
        });
      const rejected = await task(developer, 'done', randomUUID());
      expect(rejected.statusCode).toBe(404);
      expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
      const nonAuthority = refuseGuardedRead(
        'requirement:' + work.requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        const updated = await shared.inject({
          method: 'POST',
          url: `/api/requirements/${work.requirementId}/commands`,
          headers: { origin, cookie: maintainer.cookie },
          payload: {
            type: 'task.update',
            commandId: randomUUID(),
            taskId,
            patch: { description: 'Context only' },
          },
        });
        expect(updated.statusCode, updated.body).toBe(200);
        expect(nonAuthority.attempts).toBe(0);
      } finally {
        nonAuthority.restore();
      }
      const anotherTaskProof = refuseGuardedRead(
        'requirement:' + work.requirementId,
        new AsyncLocalStorage<boolean>(),
      );
      try {
        expect((await task(developer, 'done', secondTask)).statusCode).toBe(
          503,
        );
        expect(anotherTaskProof.attempts).toBeGreaterThan(0);
      } finally {
        anotherTaskProof.restore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await rows(work.requirementId)).toMatchObject({
        generation: running.grant.generation,
        phase: 'held',
      });
      expect((await rows(work.requirementId))?.run_id).toBeTruthy();
      const rollback = holdGuardedCommit(
        'requirement:' + work.requirementId,
        'rollback',
      );
      try {
        expect((await task(developer, 'done')).statusCode).toBe(500);
        expect(rollback.entered).toBe(true);
        rollback.expectIndependentReceipt('ROLLBACK');
        expect(
          (
            await lab.owner.query('select status from task where id=$1', [
              taskId,
            ])
          ).rows[0]?.status,
        ).toBe('in_progress');
        expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
      } finally {
        rollback.release();
        rollback.restore();
      }
      const commitGate = holdGuardedCommit('requirement:' + work.requirementId);
      const complete = task(developer, 'done');
      let reopening: ReturnType<typeof task> | undefined;
      try {
        await expect.poll(() => commitGate.entered).toBe(true);
        reopening = task(maintainer, 'in_progress');
        await expect
          .poll(
            async () =>
              (
                await lab.owner.query('select status from task where id=$1', [
                  taskId,
                ])
              ).rows[0]?.status,
          )
          .toBe('done');
        expect(await rows(work.requirementId)).toMatchObject({ phase: 'held' });
        commitGate.release();
        const completed = await complete;
        expect(completed.statusCode, completed.body).toBe(200);
        commitGate.expectIndependentReceipt('COMMIT');
      } finally {
        commitGate.release();
        commitGate.restore();
      }
      expect(await running.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect(await rows(work.requirementId)).toMatchObject({
        phase: 'released',
        run_id: null,
      });
      expect(await rows(other.requirementId)).toMatchObject({ phase: 'held' });
      expect(await readFile(join(other.tree, 'sample.txt'), 'utf8')).toBe(
        'other demand',
      );
      const reopened = await reopening!;
      expect(reopened.statusCode, reopened.body).toBe(200);
      const beforeLost = await launch(
        developer,
        work,
        'before lost acknowledgement',
      );
      const lost = holdGuardedCommit(
        'requirement:' + work.requirementId,
        'lose',
      );
      const originalCommand = randomUUID();
      try {
        expect(
          (await task(developer, 'done', taskId, originalCommand)).statusCode,
        ).toBe(500);
        expect(lost.entered).toBe(true);
        lost.expectIndependentReceipt('COMMIT');
        expect(await beforeLost.result).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed' },
        });
        expect(
          (await task(developer, 'done', taskId, originalCommand)).statusCode,
        ).toBe(200);
        expect(
          (
            await lab.owner.query(
              'select id from requirement_event where command_id=$1',
              [originalCommand],
            )
          ).rows,
        ).toHaveLength(1);
      } finally {
        lost.release();
        lost.restore();
      }
      expect((await task(maintainer, 'in_progress')).statusCode).toBe(200);
      const alternate = await login(assigned);
      const beforeUnreadable = await launch(
        developer,
        work,
        'before unreadable receipt',
      );
      const foreign = new AsyncLocalStorage<boolean>();
      const unavailableProof = refuseGuardedRead(
        'requirement:' + work.requirementId,
        foreign,
      );
      const unreadableCommand = randomUUID();
      try {
        const unresolved = await task(
          developer,
          'done',
          taskId,
          unreadableCommand,
        );
        expect(unresolved.statusCode, unresolved.body).toBe(503);
        expect(unavailableProof.attempts).toBeGreaterThan(0);
        expect(await beforeUnreadable.result).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed' },
        });
        const differentLogin = await foreign.run(true, () =>
          task(alternate, 'done', taskId, unreadableCommand),
        );
        expect(differentLogin.statusCode).toBe(503);
        expect(unavailableProof.foreignReads).toBe(0);
      } finally {
        unavailableProof.restore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await rows(work.requirementId)).toMatchObject({
        phase: 'released',
        run_id: null,
      });
      expect(
        (await task(developer, 'done', taskId, unreadableCommand)).statusCode,
      ).toBe(200);
      expect(
        (
          await lab.owner.query(
            'select id from requirement_event where command_id=$1',
            [unreadableCommand],
          )
        ).rows,
      ).toHaveLength(1);
      expect((await task(maintainer, 'in_progress')).statusCode).toBe(200);
      const forRoles = await launch(developer, work, 'before role change');
      expect(forRoles.grant.generation).not.toBe(running.grant.generation);
      const roles = (list: string[]) =>
        shared.inject({
          method: 'POST',
          url: '/api/management/commands',
          headers: { origin, cookie: administrator.cookie },
          payload: {
            kind: 'project.roles',
            projectId,
            username: assigned.username,
            roles: list,
            commandId: randomUUID(),
          },
        });
      await bootstrapNative(shared, developer.cookie, work.requirementId);
      const roleProof = refuseGuardedRead(
        projectId,
        new AsyncLocalStorage<boolean>(),
      );
      const nativeRevoke = NativeWebHost.prototype.revoke;
      let notified = false;
      const observeRevocation = vi
        .spyOn(NativeWebHost.prototype, 'revoke')
        .mockImplementation(function (this: NativeWebHost, ...args) {
          if (args[0] === developer.authSessionId) notified = true;
          return nativeRevoke.apply(this, args);
        });
      try {
        const removed = await roles([]);
        expect(removed.statusCode, removed.body).toBe(503);
        expect(roleProof.attempts).toBeGreaterThan(0);
        expect(notified).toBe(true);
      } finally {
        roleProof.restore();
        observeRevocation.mockRestore();
      }
      await shared.getDecorator<() => Promise<void>>(
        'recoverIsolatedWriteAuthority',
      )();
      expect(await forRoles.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect((await roles(['developer'])).statusCode).toBe(200);

      const logout = () =>
        shared.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: {
            origin,
            cookie: maintainer.cookie,
            'x-rdws-edit-session': maintainer.authSessionId,
          },
        });
      const blocker = await lab.owner.connect();
      try {
        await blocker.query('begin');
        await blocker.query(
          'select id from auth_session where id=$1 for update',
          [maintainer.authSessionId],
        );
        const pending = await logout();
        expect(pending.statusCode).toBe(503);
        expect(pending.cookies).toHaveLength(0);
        expect(
          (
            await lab.owner.query('select id from auth_session where id=$1', [
              maintainer.authSessionId,
            ])
          ).rowCount,
        ).toBe(1);
        await expect(
          broker.acquire(idle.scope, randomUUID()),
        ).rejects.toMatchObject({ statusCode: 401 });
      } finally {
        await blocker.query('rollback');
        blocker.release();
      }
      const loggedOut = await logout();
      expect(loggedOut.statusCode, loggedOut.body).toBe(200);
      expect(await idle.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect(await rows(other.requirementId)).toMatchObject({
        phase: 'released',
      });
      await expect(
        broker.acquire(idle.scope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 401 });
      expect(await readFile(join(work.tree, 'sample.txt'), 'utf8')).toBe(
        'before role change',
      );
      const reloggedLead = await login(lead);
      const beforePersonnel = await launch(reloggedLead, other, 'former lead');
      const replacement = await shared.inject({
        method: 'POST',
        url: `/api/requirements/${other.requirementId}/personnel`,
        headers: {
          origin,
          cookie: administrator.cookie,
          'x-rdws-edit-session': administrator.authSessionId,
        },
        payload: {
          commandId: randomUUID(),
          previewLeadId: lead.userId,
          leadId: assigned.userId,
          add: [],
          remove: [],
          taskDigest: createHash('sha256')
            .update(taskAssignmentMaterial([]))
            .digest('hex'),
          handoffs: [],
          overrides: [],
        },
      });
      expect(replacement.statusCode, replacement.body).toBe(200);
      expect(await beforePersonnel.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      expect(
        (
          await lab.owner.query(
            'select role from requirement_participant where requirement_id=$1 and user_id=$2',
            [other.requirementId, lead.userId],
          )
        ).rows,
      ).toEqual([{ role: 'developer' }]);
      await expect(
        broker.acquire(beforePersonnel.scope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 403 });

      for (const stale of [
        {
          url: '/api/management/commands',
          payload: {
            kind: 'account.active',
            username: assigned.username,
            active: false,
          },
          target: developer,
          demandId: work.requirementId,
        },
        {
          url: `/api/requirements/${other.requirementId}/personnel`,
          payload: {
            previewLeadId: assigned.userId,
            leadId: assigned.userId,
            add: [],
            remove: [{ userId: lead.userId, role: 'developer' }],
            taskDigest: createHash('sha256')
              .update(taskAssignmentMaterial([]))
              .digest('hex'),
            handoffs: [],
            overrides: [],
          },
          target: reloggedLead,
          demandId: other.requirementId,
        },
      ]) {
        const commandId = randomUUID();
        const late = holdCheckoutResult(
          (sql, parameters) =>
            sql.startsWith('update "command_receipt"') &&
            Array.isArray(parameters[1]) &&
            parameters[1].includes(commandId),
        );
        const pending = shared
          .inject({
            method: 'POST',
            url: stale.url,
            headers: {
              origin,
              cookie: administrator.cookie,
              ...(stale.url.endsWith('/personnel') && {
                'x-rdws-edit-session': administrator.authSessionId,
              }),
            },
            payload: { ...stale.payload, commandId },
          })
          .then((response) => response);
        try {
          await expect(
            Promise.race([
              late.persisted.promise.then(() => ({ held: true })),
              pending.then(({ statusCode, body }) => ({ statusCode, body })),
            ]),
          ).resolves.toEqual({ held: true });
          expect((await pending).statusCode).toBe(500);
          expect(
            (
              await lab.owner.query(
                'select 1 from command_receipt where command_id=$1',
                [commandId],
              )
            ).rowCount,
          ).toBe(0);
          late.finish.resolve();
          await late.rolledBack.wait();
          const readable = await shared.inject({
            url: `/api/requirements/${stale.demandId}`,
            headers: { cookie: stale.target.cookie },
          });
          expect(readable.statusCode, readable.body).toBe(200);
        } finally {
          late.finish.resolve();
          late.restore();
          await pending;
        }
      }

      const beforeAccount = await launch(
        developer,
        work,
        'before account stop',
      );
      const inactive = await shared.inject({
        method: 'POST',
        url: '/api/management/commands',
        headers: { origin, cookie: administrator.cookie },
        payload: {
          kind: 'account.active',
          username: assigned.username,
          active: false,
          commandId: randomUUID(),
        },
      });
      expect(inactive.statusCode, inactive.body).toBe(200);
      expect(await beforeAccount.result).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      await expect(
        broker.acquire(beforeAccount.scope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 401 });
      const drainingUser = await login(lead);
      const binding = await bootstrapNative(
        shared,
        drainingUser.cookie,
        other.requirementId,
      );
      const address = await shared.listen({ host: '127.0.0.1', port: 0 });
      const bootstrapEntered = latch();
      const workspaceEntered = latch();
      const finishBootstrap = latch();
      const finishWorkspace = latch();
      const auditEntered = latch();
      const finishAudit = latch();
      const physicalEntered = latch();
      const finishPhysical = latch();
      const fetchNative = NativeWebHost.prototype.fetch;
      const workspace = NativeWebHost.prototype.workspace;
      const holdBootstrap = vi
        .spyOn(NativeWebHost.prototype, 'fetch')
        .mockImplementation(async function (this: NativeWebHost, ...args) {
          const response = await fetchNative.apply(this, args);
          if (args[0] !== '/api/rdws/bootstrap') return response;
          const body = await response.arrayBuffer();
          expect(response.ok).toBe(true);
          bootstrapEntered.resolve();
          await finishBootstrap.promise;
          return new Response(body, response);
        });
      const browserRequest = httpRequest(
        address + `/api/dsh/${other.requirementId}/bootstrap`,
        {
          headers: {
            cookie: drainingUser.cookie,
            'x-rdws-edit-session': drainingUser.authSessionId,
          },
        },
      );
      browserRequest.on('error', () => {});
      const disconnectedHttp = once(browserRequest, 'close').catch(() => {});
      const poolQuery = Pool.prototype.query;
      const holdAudit = vi
        .spyOn(Pool.prototype, 'query')
        .mockImplementation(function (this: Pool, ...args: unknown[]) {
          const input = args[0] as string | { text: string };
          const sql = typeof input === 'string' ? input : input.text;
          const result = Reflect.apply(poolQuery, this, args);
          if (
            sql.includes('select count(*)::integer') &&
            sql.includes('from "auth_session" inner join') &&
            sql.includes('project_member')
          )
            return result.then(async (rows: unknown) => {
              auditEntered.resolve();
              await finishAudit.promise;
              return rows;
            });
          return result;
        } as typeof poolQuery);
      const auditRequest = httpRequest(
        address + `/api/projects/${projectId}/business-audit`,
        {
          headers: {
            cookie: administrator.cookie,
            'x-rdws-edit-session': administrator.authSessionId,
          },
        },
      );
      auditRequest.on('error', () => {});
      const disconnectedAudit = once(auditRequest, 'close').catch(() => {});
      let browser: WebSocket | undefined;
      let closing: Promise<undefined> | undefined;
      let holdWorkspace: { mockRestore(): void } | undefined;
      let holdPhysical: { mockRestore(): void } | undefined;
      const ownerGeneration = async () =>
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation;
      try {
        browserRequest.end();
        auditRequest.end();
        await expect.poll(() => holdBootstrap.mock.calls.length).toBe(1);
        await bootstrapEntered.wait();
        await auditEntered.wait();
        holdWorkspace = vi
          .spyOn(NativeWebHost.prototype, 'workspace')
          .mockImplementation(async function (this: NativeWebHost, ...args) {
            const result = await workspace.apply(this, args);
            workspaceEntered.resolve();
            await finishWorkspace.promise;
            return result;
          });
        browser = new WebSocket(
          address.replace('http:', 'ws:') +
            `/api/dsh/${other.requirementId}/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
          { headers: { origin, cookie: drainingUser.cookie } },
        );
        await once(browser, 'open');
        await workspaceEntered.wait();
        const disconnectedWs = once(browser, 'close');
        browser.close();
        browserRequest.destroy();
        auditRequest.destroy();
        await Promise.all([
          disconnectedHttp,
          disconnectedWs,
          disconnectedAudit,
        ]);
        const pid = (
          await lab.admin.query<{ pid: number }>(
            "select pid from pg_stat_activity where datname=current_database() and usename='rdws_test_app' and state='idle' limit 1",
          )
        ).rows[0]!.pid;
        const end = Client.prototype.end;
        holdPhysical = vi
          .spyOn(Client.prototype, 'end')
          .mockImplementation(function (
            this: Client & { processID: number },
            ...args: unknown[]
          ) {
            if (this.processID !== pid) return Reflect.apply(end, this, args);
            physicalEntered.resolve();
            return finishPhysical.promise.then(() =>
              Reflect.apply(end, this, args),
            );
          } as typeof end);
        closing = shared.close();
        expect(shared.close()).toBe(closing);
        const stoppedCommand = randomUUID();
        await expect(
          broker.release(
            beforePersonnel.scope,
            beforePersonnel.grant.generation,
            stoppedCommand,
          ),
        ).rejects.toMatchObject({ statusCode: 503 });
        expect(
          (
            await lab.owner.query(
              'select 1 from command_receipt where command_id=$1',
              [stoppedCommand],
            )
          ).rowCount,
        ).toBe(0);
        await expect.poll(() => shared.server.listening).toBe(false);
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishBootstrap.resolve();
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishWorkspace.resolve();
        expect(await ownerGeneration()).toBe(originalGeneration);
        finishAudit.resolve();
        await physicalEntered.wait();
        expect(await ownerGeneration()).toBe(originalGeneration);
        expect(
          (
            await lab.admin.query(
              'select pid from pg_stat_activity where pid=$1',
              [pid],
            )
          ).rowCount,
        ).toBe(1);
        finishPhysical.resolve();
        await closing;
        expect(await ownerGeneration()).toBeNull();
      } finally {
        browser?.terminate();
        browserRequest.destroy();
        auditRequest.destroy();
        finishBootstrap.resolve();
        finishWorkspace.resolve();
        finishAudit.resolve();
        finishPhysical.resolve();
        holdPhysical?.mockRestore();
        holdAudit.mockRestore();
        holdWorkspace?.mockRestore();
        holdBootstrap.mockRestore();
        await closing;
      }
      app = undefined;
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBeNull();

      const nextTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
            [createHash('sha256').update(nextTicket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      const broken = buildApp({ ...config, authorityTicket: nextTicket });
      app = broken;
      await broken.ready();
      const blockedBroker = broken.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      const lastLogin = await login(lead, broken);
      const forStop = {
        who: { userId: lead.userId, authSessionId: lastLogin.authSessionId },
        projectId,
        requirementId: forFailedClose.requirementId,
        sessionId: forFailedClose.sessionId,
      };
      const lastGrant = await blockedBroker.acquire(forStop, randomUUID());
      await mkdir(join(forFailedClose.control, 'isolated-execution'), {
        mode: 0o700,
      });
      expect(
        await blockedBroker.execute(forStop, {
          generation: lastGrant.generation,
          commandId: randomUUID(),
          repositoryId: 'app',
          request: {
            tool: 'file',
            operation: 'write',
            path: 'sample.txt',
            text: 'must not apply',
          },
        }),
      ).toMatchObject({
        status: 'unknown',
        result: { marker: 'retained', stop: 'not-started' },
      });
      expect(
        await readFile(join(forFailedClose.tree, 'sample.txt'), 'utf8'),
      ).toBe('baseline');
      const failedGeneration = (
        await lab.owner.query(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]?.generation;
      const failure = broken.close();
      expect(broken.close()).toBe(failure);
      await expect(failure).rejects.toThrow('shutdown was not confirmed');
      app = undefined;
      expect(
        (
          await lab.owner.query(
            'select generation from rdws_authority.owner where singleton',
          )
        ).rows[0]?.generation,
      ).toBe(failedGeneration);
      const deniedOwner = buildApp({ ...config, authorityTicket: nextTicket });
      await expect(deniedOwner.ready()).rejects.toThrow();
      await deniedOwner.close().catch(() => {});
    } finally {
      try {
        await app?.close();
      } finally {
        await trees?.close();
        await mirrors?.close();
        await fixture?.close();
        await lab.close();
      }
    }
  },
  60_000,
);
