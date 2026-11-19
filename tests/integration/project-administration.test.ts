import { once } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket, { WebSocketServer } from 'ws';
import { NativeWebHost } from '@rdws/dsh/web';
import { randomUUID } from 'node:crypto';
import { test, expect, vi } from 'vitest';
import { Pool } from 'pg';
import { hashPassword } from 'better-auth/crypto';
import { buildApp } from '@rdws/server';
import { fixtureBinding } from '../helpers/native-browser.ts';
import { loadEnvironment } from '@rdws/runtime-config';
import type { ManagementCommand } from '@rdws/contracts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
loadEnvironment('test');
let loginClient = 0;

test('administrators register projects, manage scoped roles and revoke existing logins without changing history', async () => {
  const pool = createTestPool('migration');
  const origin = process.env.RDWS_ORIGIN!;
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
  });
  const id = randomUUID(),
    username = 'u' + id.slice(0, 12).replaceAll('-', '');
  const email = username + '@example.invalid',
    password = randomUUID();
  const project = 'project-' + randomUUID();
  const accounts = await readTestAccounts();
  const selection = (name: string) =>
    accounts.find((row) => row.username === name)!;
  function signIn(input: object, kind = 'username') {
    return app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/' + kind,
      remoteAddress: '192.0.2.' + ++loginClient,
      headers: { origin },
      payload: input,
    });
  }
  function cookie(response: { cookies: { name: string; value: string }[] }) {
    return response.cookies
      .map((item) => item.name + '=' + item.value)
      .join('; ');
  }
  function get(url: string, session: string) {
    return app.inject({ url, headers: { cookie: session } });
  }
  function command(
    session: string,
    data: ManagementCommand | Record<string, unknown>,
  ) {
    return app.inject({
      method: 'POST',
      url: '/api/management/commands',
      headers: { origin, cookie: session },
      payload: data,
    });
  }
  try {
    await pool.query(
      'insert into auth_user(id,name,email,username,email_verified) values($1,$2,$3,$2,true)',
      [id, username, email],
    );
    await pool.query(
      "insert into auth_account(id,account_id,user_id,provider_id,password) values($1,$2,$2,'credential',$3)",
      [randomUUID(), id, await hashPassword(password)],
    );
    const platform = cookie(await signIn(selection('admin')));
    const pm = cookie(await signIn(selection('pm')));
    const old = cookie(await signIn({ username, password }));
    const oldEmail = cookie(await signIn({ email, password }, 'email'));
    expect(platform && pm && old && oldEmail).toBeTruthy();
    expect(
      (
        await app.inject({
          method: 'POST',
          url: '/api/auth/change-password',
          headers: { origin, cookie: old },
          payload: {
            currentPassword: password,
            newPassword: randomUUID(),
            revokeOtherSessions: true,
          },
        })
      ).statusCode,
    ).toBe(404);

    const create = {
      kind: 'project.create',
      commandId: randomUUID(),
      projectId: project,
      name: '管理验收项目',
      username: 'pm',
    } as const;
    expect((await command(pm, create)).statusCode).toBe(403);
    expect((await command(platform, create)).statusCode).toBe(200);
    expect((await command(platform, create)).json().replayed).toBe(true);
    expect(
      (await command(platform, { ...create, name: 'Different project' }))
        .statusCode,
    ).toBe(409);
    expect(
      (await get('/api/projects/' + project + '/requirements', platform))
        .statusCode,
    ).toBe(403);
    const roleChange = {
      kind: 'project.roles',
      commandId: randomUUID(),
      projectId: project,
      username,
      roles: ['developer', 'tester'],
    } as const;
    expect((await command(old, roleChange)).statusCode).toBe(403);
    expect(
      (await command(pm, { ...roleChange, roles: ['project_admin'] }))
        .statusCode,
    ).toBe(400);
    expect(
      (await command(pm, { ...roleChange, platformAdmin: true })).statusCode,
    ).toBe(400);
    expect((await command(pm, roleChange)).statusCode).toBe(200);
    expect((await get('/api/projects', old)).json().projects).toMatchObject([
      { id: project, roles: ['developer', 'tester'] },
    ]);
    expect(
      (await get('/api/projects/' + project + '/access', pm)).json().members,
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ username, roles: ['developer', 'tester'] }),
      ]),
    );
    const seat = {
      kind: 'project.admin',
      commandId: randomUUID(),
      projectId: project,
      username,
      enabled: true,
    } as const;
    expect((await command(pm, seat)).statusCode).toBe(403);
    expect((await command(platform, seat)).statusCode).toBe(200);
    expect(
      (await command(pm, { ...roleChange, commandId: randomUUID(), roles: [] }))
        .statusCode,
    ).toBe(200);
    expect(
      (await get('/api/projects', oldEmail)).json().projects[0].roles,
    ).toEqual(['project_admin']);
    const status = {
      kind: 'account.active',
      commandId: randomUUID(),
      username,
      active: false,
    } as const;
    expect((await command(pm, status)).statusCode).toBe(403);
    expect((await command(platform, status)).json()).toMatchObject({
      changed: true,
      revocation: 'confirmed',
    });
    for (const previous of [old, oldEmail])
      expect((await get('/api/projects', previous)).statusCode).toBe(401);
    expect((await signIn({ username, password })).statusCode).not.toBe(200);
    expect((await signIn({ email, password }, 'email')).statusCode).not.toBe(
      200,
    );
    expect(
      (
        await command(platform, {
          ...status,
          commandId: randomUUID(),
          active: true,
        })
      ).statusCode,
    ).toBe(200);
    for (const previous of [old, oldEmail]) {
      expect((await get('/api/projects', previous)).statusCode).toBe(401);
      expect((await get('/api/auth/get-session', previous)).json()).toBeNull();
    }
    const fresh = cookie(await signIn({ username, password }));
    expect((await get('/api/projects', fresh)).statusCode).toBe(200);
    expect((await command(platform, status)).json()).toMatchObject({
      replayed: true,
      revocation: 'previously-recorded',
    });
    expect((await get('/api/projects', fresh)).statusCode).toBe(200);
    expect(
      (
        await command(platform, {
          ...seat,
          commandId: randomUUID(),
          username: 'pm',
          enabled: false,
        })
      ).statusCode,
    ).toBe(200);
    expect((await command(pm, roleChange)).statusCode).toBe(403);
  } finally {
    await app.close();
    await pool.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await pool.query('delete from project where id=$1', [project]);
    await pool.query('delete from auth_user where id=$1', [id]);
    await pool.end();
  }
});

test('a login blocked at session insertion cannot cross a disable and enable transition', async () => {
  const pool = createTestPool('migration');
  const holding = await pool.connect();
  const origin = process.env.RDWS_ORIGIN!;
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
  });
  const id = randomUUID(),
    username = 'r' + id.slice(0, 10).replaceAll('-', '');
  const password = randomUUID(),
    email = username + '@example.invalid';
  let pending: PromiseLike<{ statusCode: number }>[] = [];
  try {
    await pool.query(
      'insert into auth_user(id,name,email,username,email_verified) values($1,$2,$3,$2,true)',
      [id, username, email],
    );
    await pool.query(
      "insert into auth_account(id,account_id,user_id,provider_id,password) values($1,$2,$2,'credential',$3)",
      [randomUUID(), id, await hashPassword(password)],
    );
    await holding.query('begin');
    await holding.query('select id from auth_user where id=$1 for update', [
      id,
    ]);
    const pid = (await holding.query('select pg_backend_pid() as pid')).rows[0]
      .pid;
    pending = (['username', 'email'] as const).map((field) =>
      app
        .inject({
          method: 'POST',
          url: '/api/auth/sign-in/' + field,
          remoteAddress: '192.0.2.' + ++loginClient,
          headers: { origin },
          payload: {
            [field]: field === 'username' ? username : email,
            password,
          },
        })
        .then((response) => response),
    );
    await vi.waitFor(
      async () => {
        const waiting = await pool.query(
          'select count(*)::int as count from pg_stat_activity where $1=any(pg_blocking_pids(pid))',
          [pid],
        );
        expect(waiting.rows[0].count).toBeGreaterThanOrEqual(2);
      },
      { timeout: 6000 },
    );
    await holding.query(
      'update auth_user set active=false,auth_epoch=1 where id=$1',
      [id],
    );
    await holding.query(
      'update auth_user set active=true,auth_epoch=2 where id=$1',
      [id],
    );
    await holding.query('commit');
    const responses = await Promise.all(pending);
    for (const response of responses) expect(response.statusCode).not.toBe(200);
    expect(
      (
        await pool.query(
          'select auth_epoch from auth_session where user_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([]);
    const fresh = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: '192.0.2.' + ++loginClient,
      headers: { origin },
      payload: { username, password },
    });
    expect(fresh.statusCode).toBe(200);
    expect(
      (
        await pool.query(
          'select auth_epoch from auth_session where user_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ auth_epoch: 2 }]);
  } finally {
    await holding.query('rollback');
    holding.release();
    await Promise.allSettled(pending);
    await app.close();
    await pool.query('delete from auth_user where id=$1', [id]);
    await pool.end();
  }
});

function interceptCommit(
  commandId: string,
  fault: (rollback: () => Promise<void>) => Promise<never>,
) {
  const connect = Pool.prototype.connect;
  let used = false;
  return vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(connect, this, args);
    if (args.length || used) return connection;
    return connection.then((client: import('pg').PoolClient) => {
      const query = client.query;
      let original = false;
      client.query = ((...arguments_: unknown[]) => {
        const value = arguments_[0] as string | { text: string };
        const text = typeof value === 'string' ? value : value.text;
        if (
          text.includes('command_receipt') &&
          Array.isArray(arguments_[1]) &&
          arguments_[1].includes(commandId)
        )
          original = true;
        if (text === 'commit' || text === 'rollback') client.query = query;
        if (original && text === 'commit' && !used) {
          used = true;
          return fault(async () => {
            await Reflect.apply(query, client, ['rollback']);
          });
        }
        return Reflect.apply(query, client, arguments_);
      }) as typeof query;
      return client;
    });
  } as typeof connect);
}

test('an unknown self-command is recoverable by its original receipt, including a confirmed no-op', async () => {
  const origin = process.env.RDWS_ORIGIN!;
  const pool = createTestPool('migration');
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
  });
  const project = 'receipt-' + randomUUID();
  const id = randomUUID();
  const accounts = await readTestAccounts();
  async function login(name: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: '192.0.2.' + ++loginClient,
      headers: { origin },
      payload: accounts.find((row) => row.username === name),
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.map((c) => c.name + '=' + c.value).join('; ');
  }
  const want = {
    kind: 'project.roles',
    username: 'pm',
    projectId: project,
    commandId: id,
    roles: ['developer'],
  };
  const send = (cookie: string, data: object) =>
    app.inject({
      method: 'POST',
      url: '/api/management/commands',
      headers: { origin, cookie },
      payload: data,
    });
  const list = (cookie: string) =>
    app.inject({ url: '/api/projects', headers: { cookie } });
  let torn = false;
  try {
    await pool.query('insert into project(id,name) values ($1,$2)', [
      project,
      'Management receipt fixture',
    ]);
    await pool.query(
      `insert into project_member(project_id,user_id,role)
      select $1,id,'project_admin' from auth_user where username in ('pm','manager')`,
      [project],
    );
    const pm = await login('pm'),
      other = await login('manager');
    const spy = interceptCommit(id, async (rollback) => {
      torn = true;
      await rollback();
      throw Object.assign(new Error('Synthetic transport result lost'), {
        code: 'EPIPE',
      });
    });
    try {
      const lost = await send(pm, want);
      expect(torn).toBe(true);
      expect(lost.statusCode).toBe(503);
    } finally {
      spy.mockRestore();
    }
    expect((await list(pm)).statusCode).toBe(401);
    expect((await send(pm, { ...want, roles: ['tester'] })).statusCode).toBe(
      409,
    );
    const independent = await send(other, { ...want, commandId: randomUUID() });
    expect(independent.json()).toMatchObject({ changed: true });
    expect((await list(pm)).statusCode).toBe(401);
    const recovered = await send(pm, want);
    expect(recovered.json()).toMatchObject({ changed: false });
    expect((await list(pm)).statusCode).toBe(200);
  } finally {
    await app.close();
    await pool.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await pool.query('delete from project where id=$1', [project]);
    await pool.end();
  }
});

test('a temporary project fence suppresses output without revoking a socket when the transaction rolls back', async () => {
  const origin = process.env.RDWS_ORIGIN!;
  const pool = createTestPool('migration');
  const project = 'fence-' + randomUUID(),
    requirement = randomUUID(),
    commandId = randomUUID();
  const upstream = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(upstream, 'listening');
  const port = (upstream.address() as { port: number }).port;
  class TestNative extends NativeWebHost {
    revoked = 0;
    override async workspace() {
      return { cwd: '/unused', workspaceId: 'fixture' };
    }
    override socketUrl() {
      return 'ws://127.0.0.1:' + port;
    }
    override ticket() {
      return 'fixture';
    }
    override async revoke() {
      this.revoked++;
    }
    override async close() {}
  }
  const native = new TestNative('/tmp/rdws-unused-fence', undefined, project);
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    nativeHost: native,
  });
  const accounts = await readTestAccounts();
  async function login(name: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      remoteAddress: '192.0.2.' + ++loginClient,
      headers: { origin },
      payload: accounts.find((item) => item.username === name),
    });
    expect(response.statusCode).toBe(200);
    return response.cookies
      .map((item) => item.name + '=' + item.value)
      .join('; ');
  }
  let release!: () => void, entered!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let browser: WebSocket | undefined;
  let mutation: Promise<unknown> | undefined;
  let restore: (() => void) | undefined;
  try {
    await pool.query('insert into project(id,name) values($1,$2)', [
      project,
      'Provisional permission fixture',
    ]);
    const leadId = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    await pool.query(
      `insert into project_member(project_id,user_id,role)
      select $1,id,case when username='pm' then 'project_admin' else 'developer' end from auth_user where username in ('pm','lead')`,
      [project],
    );
    await pool.query(
      `insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id)
      values($1,$2,'Provisional permission','fixture','fixture',$3,$3,'fixture')`,
      [requirement, project, leadId],
    );
    await pool.query(
      `insert into requirement_participant(requirement_id,user_id,role) values($1,$2,'developer')`,
      [requirement, leadId],
    );
    const address = await app.listen({ host: '127.0.0.1', port: 0 });
    const pm = await login('pm'),
      lead = await login('lead');
    const binding = await fixtureBinding(app, lead, project, requirement);
    const connected = once(upstream, 'connection');
    browser = new WebSocket(
      address.replace('http:', 'ws:') +
        '/api/dsh/' +
        requirement +
        `/native/api/remote.mux?generation=${randomUUID()}&login=${binding}`,
      {
        headers: { cookie: lead, origin },
      },
    );
    await once(browser, 'open');
    const [peer] = (await connected) as [WebSocket];
    const downlink: string[] = [];
    browser.on('message', (data) => downlink.push(data.toString()));
    const spy = interceptCommit(commandId, async (rollback) => {
      entered();
      await blocked;
      await rollback();
      throw Object.assign(new Error('Synthetic confirmed rollback'), {
        code: '40001',
        severity: 'ERROR',
      });
    });
    restore = () => spy.mockRestore();
    const attempt = app
      .inject({
        method: 'POST',
        url: '/api/management/commands',
        headers: { origin, cookie: pm },
        payload: {
          kind: 'project.roles',
          projectId: project,
          username: 'lead',
          roles: [],
          commandId,
        },
      })
      .then((response) => response);
    mutation = attempt;
    await Promise.race([
      held,
      attempt.then(() => {
        throw new Error('Commit not intercepted');
      }),
    ]);
    expect(
      (await app.inject({ url: '/api/projects', headers: { cookie: lead } }))
        .statusCode,
    ).toBe(401);
    peer.send(
      JSON.stringify({
        type: 'item',
        streamId: 'fixture',
        value: 'provisional-output',
      }),
    );
    await sleep(1200);
    expect(browser.readyState).toBe(WebSocket.OPEN);
    expect(native.revoked).toBe(0);
    expect(downlink).toEqual([]);
    release();
    expect((await attempt).statusCode).toBe(500);
    const afterRollback = JSON.stringify({
      type: 'item',
      streamId: 'fixture',
      value: 'after-rollback',
    });
    peer.send(afterRollback);
    await vi.waitFor(() => expect(downlink).toEqual([afterRollback]));
    expect(
      (await app.inject({ url: '/api/projects', headers: { cookie: lead } }))
        .statusCode,
    ).toBe(200);
  } finally {
    release();
    await Promise.allSettled([mutation]);
    restore?.();
    browser?.terminate();
    await app.close();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [requirement],
    );
    await pool.query('delete from requirement where id=$1', [requirement]);
    await pool.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await pool.query('delete from project where id=$1', [project]);
    await pool.end();
  }
});
