import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { loadEnvironment } from '@rdws/runtime-config';
import { NativeWebHost } from '@rdws/dsh/web';
import { createTestPool } from '../helpers/test-pool.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

loadEnvironment('test');

test('reads safe execution events at the frozen Native cut and fences exact scope before send', async () => {
  const project = 'exec-audit-' + randomUUID();
  const demand = randomUUID(),
    neighbor = randomUUID();
  const sessionId = 'session-' + randomUUID(),
    sourceId = 'session-' + randomUUID();
  const route = `/api/requirements/${demand}/sessions/${sessionId}/execution`;
  const root = await mkdtemp(join(tmpdir(), 'rdws-execution-read-'));
  const native = new NativeWebHost(root, join(root, 'native'), project);
  const db = createTestPool('migration');
  const origin = process.env.RDWS_ORIGIN!;
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    nativeHost: native,
    nativeRuntimeRoot: root,
    repositoryHome: root,
  });
  const marker = 'SYNTHETIC_PRIVATE_TOOL_FIELD';
  type Event = {
    seq: number;
    type: string;
    data: Record<string, unknown>;
    sourceEventSeqs?: number[];
    surfaceOp?: unknown;
  };
  const raw: Event[] = Array.from({ length: 112 }, (_, seq) => ({
    seq,
    type: 'turn/start',
    data: {},
  }));
  const call = (seq: number) => {
    raw[seq] = {
      seq,
      type: 'tool/call',
      data: {
        turn: 1,
        step: 1,
        callId: marker,
        name: marker,
        arguments: marker,
      },
    };
  };
  const result = (
    seq: number,
    isError?: boolean,
    name?: string,
    code?: string,
    ref?: number,
    surfaceOp: unknown = 'append',
    toolCallId = marker,
  ) => {
    raw[seq] = {
      seq,
      type: 'tool/result',
      surfaceOp,
      sourceEventSeqs: ref === undefined ? undefined : [ref],
      data: {
        turn: 1,
        step: 1,
        message: {
          role: 'tool',
          source: { kind: 'tool', callId: toolCallId },
          toolCallId,
          isError,
          content: [{ type: 'text', text: marker }],
        },
        error: { name, code, reason: marker },
        meta: marker,
      },
    };
  };
  call(1);
  call(62);
  result(63, true, 'RdwsToolGuardError', 'RDWS_TOOLS_DISABLED', 62);
  result(64, false);
  result(65, true);
  result(66, true, 'AbortError', 'ABORTED_BEFORE_DISPATCH');
  result(67, true, 'ToolNotStartedError', 'TOOL_NOT_STARTED');
  result(68, true, 'ToolOutcomeUnknownError', 'TOOL_OUTCOME_UNKNOWN', 1);
  result(69);
  result(70, false, undefined, undefined, 63, {
    op: 'replace',
    startSeq: 63,
    endSeq: 63,
  });
  result(
    71,
    true,
    'Elsewhere',
    'RDWS_TOOLS_DISABLED',
    62,
    'append',
    'Different call',
  );

  let badPage: 'cut' | 'position' | undefined;
  const workspace = vi.spyOn(native, 'workspace');
  const fetch = vi
    .spyOn(native, 'fetch')
    .mockImplementation(async (path, grant, init) => {
      expect(path).toBe('/api/session/events');
      expect(grant).toMatchObject({
        requirementId: demand,
        readSessionIds: [sessionId],
        ownSessionIds: [],
      });
      const envelope = JSON.parse(String(init?.body));
      const request = envelope.payload.args.request;
      expect(request.address).toEqual({ kind: 'session', sessionId });
      const cursor = request.throughSeq ?? 111;
      const before = request.beforeSeq ?? cursor + 1;
      return Response.json({
        rpcId: envelope.rpcId,
        result: {
          ok: true,
          value: {
            cursor: badPage === 'cut' ? cursor + 1 : cursor,
            hasMore: false,
            records: raw
              .filter(
                ({ seq }) =>
                  seq < before || (badPage === 'position' && seq === before),
              )
              .map((event) => ({ type: 'event', event })),
          },
        },
      });
    });
  let isolated = false;
  let beforeSend: (() => Promise<void>) | undefined;
  app.addHook('preSerialization', async (request, _reply, payload) => {
    if (beforeSend && request.url === route) {
      const update = beforeSend;
      beforeSend = undefined;
      await update();
    }
    return payload;
  });
  try {
    expect(
      (await db.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const accounts = await readTestAccounts();
    async function login(username: string, octet: number) {
      const signed = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        remoteAddress: '192.0.2.' + octet,
        payload: accounts.find((account) => account.username === username),
      });
      expect(signed.statusCode).toBe(200);
      const cookie = signed.cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join('; ');
      const current = await app.inject({
        url: '/api/auth/get-session',
        headers: { cookie },
      });
      return {
        cookie,
        userId: signed.json().user.id as string,
        loginId: current.json().session.id as string,
      };
    }
    const reader = await login('tester', 241);
    const platform = await login('admin', 242);
    const replacement = await login('tester', 243);
    await db.query('insert into project(id,name) values($1,$1)', [project]);
    await db.query("insert into project_member values($1,$2,'tester')", [
      project,
      reader.userId,
    ]);
    for (const id of [demand, neighbor]) {
      await db.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,'Execution read fixture','','',$3,$3,$4)",
        [id, project, reader.userId, 'workspace-' + randomUUID()],
      );
      await db.query(
        "insert into requirement_participant values($1,$2,'tester')",
        [id, reader.userId],
      );
    }
    await db.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sourceId, demand, reader.userId],
    );
    await db.query(
      'insert into native_session(id,requirement_id,owner_id,source_session_id,source_through_seq) values($1,$2,$3,$4,63)',
      [sessionId, demand, reader.userId, sourceId],
    );
    const get = (who = reader, url = route, observed = who.loginId) =>
      app.inject({
        url,
        headers: { cookie: who.cookie, 'x-rdws-edit-session': observed },
      });
    const next = (beforeSeq: number) =>
      `${route}?throughSeq=111&beforeSeq=${beforeSeq}`;
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    expect(first.body).not.toContain(marker);
    expect(first.body).not.toContain('RDWS_TOOLS_DISABLED');
    expect(first.json()).toMatchObject({
      projectId: project,
      requirementId: demand,
      sessionId,
      sessionOwnerId: reader.userId,
      throughSeq: 111,
      next: { throughSeq: 111, beforeSeq: 62 },
      events: [
        { seq: 62, status: 'requested', origin: 'inherited', turn: 1, step: 1 },
        { seq: 63, status: 'blocked', origin: 'inherited', sourceSeq: 62 },
        { seq: 64, status: 'result-returned', origin: 'session' },
        { seq: 65, status: 'result-error' },
        { seq: 66, status: 'not-started' },
        { seq: 67, status: 'not-started' },
        { seq: 68, status: 'outcome-unknown', sourceSeq: 1 },
        { seq: 69, status: 'outcome-unknown' },
        { seq: 71, status: 'result-error' },
      ],
    });
    expect(first.json().events.at(-1)).not.toHaveProperty('sourceSeq');
    expect((await get(reader, next(62))).json()).toMatchObject({
      events: [],
      next: { throughSeq: 111, beforeSeq: 12 },
    });
    expect((await get(reader, next(12))).json()).toMatchObject({
      events: [{ seq: 1, status: 'requested', origin: 'inherited' }],
      next: null,
    });
    expect((await get(reader, route + '?beforeSeq=62')).statusCode).toBe(400);
    expect(
      (await get(reader, route + '?throughSeq=4&beforeSeq=62')).statusCode,
    ).toBe(400);
    badPage = 'cut';
    expect((await get(reader, next(62))).statusCode).toBe(503);
    badPage = 'position';
    expect((await get(reader, next(62))).statusCode).toBe(503);
    badPage = undefined;

    const invocationCount = fetch.mock.calls.length;
    expect((await get(platform)).statusCode).toBe(403);
    expect((await get(replacement, route, reader.loginId)).statusCode).toBe(
      401,
    );
    expect(
      (await app.inject({ url: route, headers: { cookie: reader.cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (
        await app.inject({
          url: route,
          method: 'HEAD',
          headers: { cookie: reader.cookie },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (await get(reader, route.replace(demand, neighbor))).statusCode,
    ).toBe(403);
    expect(fetch).toHaveBeenCalledTimes(invocationCount);
    beforeSend = async () => {
      await db.query(
        'update native_session set requirement_id=$1 where id=$2',
        [neighbor, sessionId],
      );
    };
    const moved = await get();
    expect(moved.statusCode).toBe(403);
    expect(moved.json()).not.toHaveProperty('events');
    await db.query('update native_session set requirement_id=$1 where id=$2', [
      demand,
      sessionId,
    ]);
    beforeSend = async () => {
      await db.query(
        'delete from requirement_participant where requirement_id=$1 and user_id=$2',
        [demand, reader.userId],
      );
    };
    const revoked = await get();
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).not.toHaveProperty('events');
    expect(workspace).not.toHaveBeenCalled();
  } finally {
    beforeSend = undefined;
    try {
      await app.close();
      if (isolated) {
        await db.query('delete from native_session where id=any($1::text[])', [
          [sessionId, sourceId],
        ]);
        await db.query(
          'delete from requirement_participant where requirement_id=any($1::text[])',
          [[demand, neighbor]],
        );
        await db.query('delete from requirement where id=any($1::text[])', [
          [demand, neighbor],
        ]);
        await db.query('delete from project_member where project_id=$1', [
          project,
        ]);
        await db.query('delete from project where id=$1', [project]);
      }
    } finally {
      await db.end();
      await rm(root, { recursive: true, force: true });
    }
  }
});
