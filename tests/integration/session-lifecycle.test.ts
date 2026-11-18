import { test, expect, beforeAll, afterAll } from 'vitest';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Pool } from 'pg';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { actionAllowed, type Grant } from '@rdws/dsh/access';
import { forkBoundary } from '@rdws/dsh/sessions';
import { loadEnvironment, runtimeHome } from '../../scripts/env.mjs';
loadEnvironment('test');
const pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
let account: { username: string; password: string };
let owner: string;
const ids: string[] = [];
beforeAll(async () => {
  owner = (
    await pool.query("select id from auth_user where username='manager'")
  ).rows[0].id;
  account = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ).find((row: { username: string }) => row.username === 'manager');
});
afterAll(async () => {
  for (const id of ids) {
    if (
      (await pool.query("select to_regclass('session_operation') present"))
        .rows[0].present
    )
      await pool.query(
        'delete from session_operation where requirement_id=$1',
        [id],
      );
    await pool.query('delete from native_session where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
  }
  await pool.end();
});
class Host extends NativeWebHost {
  calls: { action: string; input: Record<string, unknown> }[] = [];
  gate?: () => Promise<void>;
  lost = false;
  wrongWorkspace = false;
  attachFailed = false;
  notify?: () => Promise<void>;
  cursor = 5;
  constructor() {
    super('/tmp/rdws-session-lifecycle-test');
  }
  override async workspace(id: string) {
    return { cwd: join(this.demandRoot, id), workspaceId: 'w' };
  }
  override async control(_operation: string, input: Record<string, unknown>) {
    return {
      cwd: join(this.demandRoot, String(input.requirementId)),
      workspaceId: this.wrongWorkspace ? 'other' : 'w',
    };
  }
  override async fetch(
    path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    const request = JSON.parse(String(init.body));
    const action = path.slice('/api/'.length);
    const input = request.payload.args.request as Record<string, unknown>;
    if (action === 'session/events') {
      const cursor = Number(input.throughSeq ?? this.cursor);
      return Response.json({
        rpcId: request.rpcId,
        result: {
          ok: true,
          value: {
            cursor,
            hasMore: false,
            records: [
              {
                type: 'event',
                event: { seq: 0, type: 'turn/start', data: {} },
              },
              {
                type: 'event',
                event: {
                  seq: 1,
                  type: 'user/message',
                  surfaceOp: 'append',
                  data: {
                    source: { kind: 'user', principal: { secret: 'internal' } },
                    message: {
                      content: [{ type: 'text', text: '<b>history</b>' }],
                    },
                  },
                },
              },
              {
                type: 'event',
                event: {
                  seq: 2,
                  type: 'request/header',
                  data: { private: 'internal' },
                },
              },
              {
                type: 'event',
                event: {
                  seq: 3,
                  type: 'turn/end',
                  data: { reason: { kind: 'interrupted' } },
                },
              },
              {
                type: 'event',
                event: { seq: 4, type: 'session/title', data: {} },
              },
              {
                type: 'event',
                event: { seq: 5, type: 'turn/start', data: {} },
              },
            ].filter((r) => r.event.seq <= cursor),
          },
        },
      });
    }
    this.calls.push({ action, input });
    await this.gate?.();
    if (this.lost) throw new Error('Controlled lost Native response');
    if (this.attachFailed)
      return Response.json({
        rpcId: request.rpcId,
        result: {
          ok: false,
          error: {
            code: 'session/workspace-attach-failed',
            details: { sessionId: 'session-' + randomUUID(), workspaceId: 'w' },
          },
        },
      });
    return Response.json({
      rpcId: request.rpcId,
      result: { ok: true, value: { sessionId: 'session-' + randomUUID() } },
    });
  }
  override async revoke() {
    await this.notify?.();
  }
  override async close() {}
}
async function fixture(host = new Host()) {
  const id = randomUUID();
  ids.push(id);
  await pool.query(
    'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
    [id, 'poc', 'Lifecycle', 'test', 'test', owner, 'w'],
  );
  await pool.query(
    'insert into requirement_participant(requirement_id,user_id,role) values($1,$2,$3)',
    [id, owner, 'requirement_manager'],
  );
  const source = 'session-' + randomUUID();
  await pool.query(
    'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
    [source, id, owner],
  );
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin: process.env.RDWS_ORIGIN!,
    nativeHost: host,
  });
  await app.ready();
  const login = await app.inject({
    method: 'POST',
    remoteAddress: '127.0.10.' + ids.length,
    url: '/api/auth/sign-in/username',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: account,
  });
  expect(login.statusCode).toBe(200);
  const cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  const post = (commandId: string, fork = false) =>
    app.inject({
      method: 'POST',
      url: `/api/requirements/${id}/sessions${fork ? '/' + source + '/fork' : ''}`,
      headers: { cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId },
    });
  return { app, id, source, cookie, post, host };
}
test('one create command survives concurrent retry and returns the same Native id', async () => {
  const f = await fixture();
  try {
    const command = randomUUID();
    const results = await Promise.all([f.post(command), f.post(command)]);
    expect(results.every((r) => [200, 202].includes(r.statusCode))).toBe(true);
    const done = await f.post(command);
    expect(done.statusCode).toBe(200);
    expect(done.json().sessionId).toBeTruthy();
    expect(f.host.calls).toHaveLength(1);
    expect((await f.post(command)).json().sessionId).toBe(
      done.json().sessionId,
    );
  } finally {
    await f.app.close();
  }
});
test('fork freezes the last closed logical prefix and maps provenance once', async () => {
  const f = await fixture();
  try {
    const command = randomUUID(),
      r = await f.post(command, true);
    expect(r.statusCode).toBe(200);
    expect(f.host.calls).toEqual([
      {
        action: 'session/fork',
        input: { sessionId: f.source, atSeq: 4, allowMigration: false },
      },
    ]);
    const child = (
      await pool.query('select * from native_session where id=$1', [
        r.json().sessionId,
      ])
    ).rows[0];
    expect(child.source_session_id).toBe(f.source);
    expect(child.source_through_seq).toBe(4);
    expect((await f.post(command, true)).json().sessionId).toBe(child.id);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await f.app.close();
  }
});
test('unknown Native result never dispatches again after retry or BFF restart', async () => {
  const f = await fixture();
  f.host.lost = true;
  const command = randomUUID();
  try {
    expect((await f.post(command)).json().status).toBe('unknown');
    expect((await f.post(command)).json().status).toBe('unknown');
    await f.app.close();
    const app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin: process.env.RDWS_ORIGIN!,
      nativeHost: f.host,
    });
    try {
      const retry = await app.inject({
        method: 'POST',
        url: `/api/requirements/${f.id}/sessions`,
        headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
        payload: { commandId: command },
      });
      expect(retry.json().status).toBe('unknown');
      expect(f.host.calls).toHaveLength(1);
    } finally {
      await app.close();
    }
  } finally {
    await f.app.close();
  }
});
test('fork cannot use somebody else, another requirement or a mismatched workspace', async () => {
  const f = await fixture();
  try {
    const other = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id;
    await pool.query('update native_session set owner_id=$1 where id=$2', [
      other,
      f.source,
    ]);
    expect((await f.post(randomUUID(), true)).statusCode).toBe(403);
    await pool.query('update native_session set owner_id=$1 where id=$2', [
      owner,
      f.source,
    ]);
    f.host.wrongWorkspace = true;
    expect((await f.post(randomUUID(), true)).statusCode).toBe(409);
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('logout while Native is running retains evidence but does not map the new session', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.gate = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const pending = f.post(randomUUID());
    await ready;
    expect(
      (
        await f.app.inject({
          method: 'POST',
          url: '/api/auth/sign-out',
          headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
          payload: {},
        })
      ).statusCode,
    ).toBe(200);
    release();
    expect((await pending).statusCode).toBe(401);
    expect(
      (
        await pool.query(
          'select id from native_session where requirement_id=$1',
          [f.id],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query(
          'select native_session_id from session_operation where requirement_id=$1',
          [f.id],
        )
      ).rows[0].native_session_id,
    ).toBeTruthy();
  } finally {
    release();
    await f.app.close();
  }
});
test('fork capability binds source and cut without giving browsers fork access', () => {
  const grant = {
    aud: 'test',
    purpose: 'fork',
    issuedAt: Date.now(),
    expiresAt: Date.now() + 10000,
    nonce: 'test',
    sourceSessionId: 's',
    atSeq: 4,
  } as unknown as Grant;
  const args = { request: { sessionId: 's', atSeq: 4, allowMigration: false } };
  expect(actionAllowed(grant, 'session/fork', args)).toBe(true);
  expect(
    actionAllowed(
      {
        ...grant,
        purpose: 'browser',
        readSessionIds: ['s'],
        ownSessionIds: ['s'],
      },
      'session/fork',
      args,
    ),
  ).toBe(false);
  for (const request of [
    { ...args.request, sessionId: 'other' },
    { ...args.request, atSeq: 5 },
    { ...args.request, cwd: '/wrong' },
  ])
    expect(actionAllowed(grant, 'session/fork', { request })).toBe(false);
});
test('passive replay returns a safe fixed-cut projection without activating Native', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      url: `/api/requirements/${f.id}/sessions/${f.source}/history?throughSeq=3`,
      headers: { cookie: f.cookie },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().cursor).toBe(3);
    expect(response.json().events.map((e: { type: string }) => e.type)).toEqual(
      ['turn/start', 'user/message', 'turn/end'],
    );
    expect(response.body).toContain('<b>history</b>');
    expect(response.body).not.toContain('principal');
    expect(response.body).not.toContain('internal');
    expect(response.json().events.at(-1).outcome).toBe('已中断');
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('a known child repairs mapping with its frozen cut after another BFF generation', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID(),
      child = 'session-' + randomUUID();
    const { digestOf } =
      await import('../../apps/server/src/modules/business.ts');
    await pool.query(
      'insert into session_operation(id,actor_id,requirement_id,operation,command_id,digest,status,generation,source_session_id,frozen,native_session_id) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)',
      [
        randomUUID(),
        owner,
        f.id,
        'fork',
        commandId,
        digestOf({ operation: 'fork', sourceSessionId: f.source }),
        'native-created',
        'old',
        f.source,
        { workspaceId: 'w', cwd: join(f.host.demandRoot, f.id), atSeq: 1 },
        child,
      ],
    );
    f.host.cursor = 500;
    const response = await f.post(commandId, true);
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBe(child);
    expect(
      (
        await pool.query(
          'select source_through_seq from native_session where id=$1',
          [child],
        )
      ).rows[0].source_through_seq,
    ).toBe(1);
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('a frozen dispatched operation from a lost process becomes unknown without redispatch', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID();
    const { digestOf } =
      await import('../../apps/server/src/modules/business.ts');
    await pool.query(
      'insert into session_operation(id,actor_id,requirement_id,operation,command_id,digest,status,generation,frozen) values($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [
        randomUUID(),
        owner,
        f.id,
        'create',
        commandId,
        digestOf({ operation: 'create', sourceSessionId: null }),
        'dispatched',
        'old',
        { workspaceId: 'w', cwd: join(f.host.demandRoot, f.id) },
      ],
    );
    expect((await f.post(commandId)).json().status).toBe('unknown');
    expect(f.host.calls).toHaveLength(0);
  } finally {
    await f.app.close();
  }
});
test('retry during an in-flight dispatch stays pending and cannot start another Native call', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.gate = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const commandId = randomUUID(),
      pending = f.post(commandId);
    await ready;
    const retry = await f.post(commandId);
    expect(retry.statusCode).toBe(202);
    expect(retry.json().status).toBe('dispatched');
    expect(f.host.calls).toHaveLength(1);
    release();
    expect((await pending).statusCode).toBe(200);
    expect((await f.post(commandId)).json().status).toBe('mapped');
    expect(f.host.calls).toHaveLength(1);
  } finally {
    release();
    await f.app.close();
  }
});
test('a failed PG mapping keeps the known child and the frozen cut for a later repair', async () => {
  const f = await fixture();
  f.host.gate = async () => {
    await pool.query('revoke insert on native_session from rdws_test_app');
  };
  try {
    const commandId = randomUUID();
    expect((await f.post(commandId, true)).statusCode).toBe(500);
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    expect(record.status).toBe('native-created');
    expect(record.native_session_id).toBeTruthy();
    expect(record.frozen.atSeq).toBe(4);
    await pool.query('grant insert on native_session to rdws_test_app');
    f.host.cursor = 500;
    expect((await f.post(commandId, true)).json().sessionId).toBe(
      record.native_session_id,
    );
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant insert on native_session to rdws_test_app');
    await f.app.close();
  }
});
test('a failed Native-result write preserves a private orphan record and repairs without redispatch', async () => {
  const f = await fixture();
  f.host.gate = async () => {
    await pool.query('revoke update on session_operation from rdws_test_app');
  };
  try {
    const commandId = randomUUID(),
      first = await f.post(commandId);
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('unknown');
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    const file = join(
      f.host.runtimeHome,
      'state/exports',
      'session-operation-' + record.id + '.json',
    );
    const saved = JSON.parse(await readFile(file, 'utf8'));
    const { stat } = await import('node:fs/promises');
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(saved.sessionId).toBeTruthy();
    await pool.query('grant update on session_operation to rdws_test_app');
    expect((await f.post(commandId)).json().sessionId).toBe(saved.sessionId);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant update on session_operation to rdws_test_app');
    await f.app.close();
  }
});
test('fork command cannot be replayed against another source or accept client-controlled settings', async () => {
  const f = await fixture();
  try {
    const commandId = randomUUID();
    expect((await f.post(commandId, true)).statusCode).toBe(200);
    const another = 'session-' + randomUUID();
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [another, f.id, owner],
    );
    const changed = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions/${another}/fork`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId },
    });
    expect(changed.statusCode).toBe(409);
    const forged = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
      payload: { commandId: randomUUID(), actor: owner, agentPreset: 'unsafe' },
    });
    expect(forged.statusCode).toBe(400);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await f.app.close();
  }
});
test('a fork boundary can cross pages and stops before the next append input', async () => {
  const host = new Host();
  host.fetch = async (_path, _grant, init = {}) => {
    const rpc = JSON.parse(String(init.body));
    const before = rpc.payload.args.request.beforeSeq;
    const events =
      before === undefined
        ? [
            { seq: 4, type: 'user/message', surfaceOp: 'append', data: {} },
            { seq: 5, type: 'turn/start', data: {} },
            { seq: 6, type: 'step/start', data: {} },
          ]
        : [
            { seq: 0, type: 'turn/start', data: {} },
            {
              seq: 1,
              type: 'turn/end',
              data: { reason: { kind: 'completed' } },
            },
            { seq: 2, type: 'session/title', data: {} },
            { seq: 3, type: 'session/title', data: {} },
          ];
    return Response.json({
      rpcId: rpc.rpcId,
      result: {
        ok: true,
        value: {
          cursor: 6,
          hasMore: before === undefined,
          records: events.map((event) => ({ type: 'event', event })),
        },
      },
    });
  };
  const grant = { purpose: 'browser' as const, readSessionIds: ['s'] };
  expect(await forkBoundary(host, grant, 's')).toBe(3);
  host.fetch = async (_path, _grant, init = {}) =>
    Response.json({
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: { ok: true, value: { cursor: -1, hasMore: false, records: [] } },
    });
  expect(await forkBoundary(host, grant, 's')).toBeUndefined();
  host.fetch = async (_path, _grant, init = {}) =>
    Response.json({
      rpcId: JSON.parse(String(init.body)).rpcId,
      result: { ok: true, value: { cursor: 6, hasMore: true, records: [] } },
    });
  await expect(forkBoundary(host, grant, 's')).rejects.toThrow('no progress');
});
test('legacy create without a request body remains supported', async () => {
  const f = await fixture();
  try {
    const response = await f.app.inject({
      method: 'POST',
      url: `/api/requirements/${f.id}/sessions`,
      headers: { cookie: f.cookie, origin: process.env.RDWS_ORIGIN! },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().sessionId).toBeTruthy();
  } finally {
    await f.app.close();
  }
});
test('an empty-source rejection is terminal and cannot later dispatch under the same key', async () => {
  const f = await fixture();
  try {
    const original = f.host.fetch.bind(f.host);
    f.host.fetch = async (path, grant, init = {}) =>
      path === '/api/session/events'
        ? Response.json({
            rpcId: JSON.parse(String(init.body)).rpcId,
            result: {
              ok: true,
              value: { cursor: -1, hasMore: false, records: [] },
            },
          })
        : original(path, grant, init);
    const commandId = randomUUID(),
      rejected = await f.post(commandId, true);
    expect(rejected.statusCode).toBe(409);
    expect(rejected.json().status).toBe('rejected');
    f.host.fetch = original;
    expect((await f.post(commandId, true)).json().status).toBe('rejected');
    expect(f.host.calls).toHaveLength(0);
    expect((await f.post(randomUUID())).statusCode).toBe(200);
  } finally {
    await f.app.close();
  }
});
test('a known child in an attach error also survives a PG result-write failure', async () => {
  const f = await fixture();
  f.host.attachFailed = true;
  f.host.gate = async () => {
    await pool.query('revoke update on session_operation from rdws_test_app');
  };
  try {
    const commandId = randomUUID(),
      first = await f.post(commandId, true);
    expect(first.statusCode).toBe(202);
    expect(first.json().status).toBe('unknown');
    const record = (
      await pool.query(
        'select * from session_operation where requirement_id=$1',
        [f.id],
      )
    ).rows[0];
    const saved = JSON.parse(
      await readFile(
        join(
          f.host.runtimeHome,
          'state/exports',
          'session-operation-' + record.id + '.json',
        ),
        'utf8',
      ),
    );
    expect(saved.sessionId).toBeTruthy();
    await pool.query('grant update on session_operation to rdws_test_app');
    const retry = await f.post(commandId, true);
    expect(retry.statusCode).toBe(200);
    expect(retry.json().sessionId).toBe(saved.sessionId);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    await pool.query('grant update on session_operation to rdws_test_app');
    await f.app.close();
  }
});
test('permission is checked again after the mapping notification wait', async () => {
  const f = await fixture();
  let release = () => {},
    entered = () => {};
  const ready = new Promise<void>((r) => (entered = r));
  f.host.notify = () => {
    entered();
    return new Promise<void>((r) => (release = r));
  };
  try {
    const pending = f.post(randomUUID());
    await ready;
    await pool.query('update auth_user set active=false where id=$1', [owner]);
    release();
    expect((await pending).statusCode).toBe(401);
    expect(f.host.calls).toHaveLength(1);
  } finally {
    release();
    await pool.query('update auth_user set active=true where id=$1', [owner]);
    await f.app.close();
  }
});
