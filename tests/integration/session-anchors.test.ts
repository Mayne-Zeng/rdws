import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { loadEnvironment } from '@rdws/runtime-config';
import { NativeWebHost } from '@rdws/dsh/web';
import { createTestPool } from '../helpers/test-pool.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

loadEnvironment('test');

test('reads the original session anchor page and fences direct PostgreSQL changes on send', async () => {
  const db = createTestPool('migration');
  const origin = process.env.RDWS_ORIGIN!;
  const start = vi
    .spyOn(NativeWebHost.prototype, 'start')
    .mockRejectedValue(new Error('Unexpected Native start'));
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
  });
  const original = {
    projectId: 'anchor-read-' + randomUUID(),
    demandId: randomUUID(),
    sessionId: 'session-' + randomUUID(),
  };
  const neighbor = {
    projectId: 'anchor-peer-' + randomUUID(),
    demandId: randomUUID(),
    sessionId: 'session-' + randomUUID(),
  };
  const emptySession = 'session-' + randomUUID();
  const sessionIds = [original.sessionId, neighbor.sessionId, emptySession];
  const demandIds = [original.demandId, neighbor.demandId];
  const projects = [original.projectId, neighbor.projectId];
  const path = (demandId: string, sessionId: string) =>
    `/api/requirements/${demandId}/sessions/${sessionId}/anchors`;
  const route = path(original.demandId, original.sessionId);
  const at = '2026-02-10T01:02:03.314159Z';
  const sha = '4'.repeat(64);
  const fileBucket = '9'.repeat(64);
  let isolated = false;
  let beforeSend: (() => Promise<void>) | undefined;
  app.addHook('preSerialization', async (req, _reply, payload) => {
    if (beforeSend && req.url === route) {
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
    async function signIn(username: string, octet: number) {
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        remoteAddress: '192.0.2.' + octet,
        payload: accounts.find((account) => account.username === username),
      });
      expect(login.statusCode).toBe(200);
      const cookie = login.cookies
        .map(({ name, value }) => `${name}=${value}`)
        .join('; ');
      const observed = await app.inject({
        url: '/api/auth/get-session',
        headers: { cookie },
      });
      return {
        cookie,
        userId: login.json().user.id as string,
        loginId: observed.json().session.id as string,
      };
    }
    const reader = await signIn('tester', 231);
    const platform = await signIn('admin', 232);
    const replacement = await signIn('tester', 233);
    for (const { projectId, demandId, sessionId } of [original, neighbor]) {
      await db.query('insert into project(id,name) values($1,$1)', [projectId]);
      await db.query("insert into project_member values($1,$2,'tester')", [
        projectId,
        reader.userId,
      ]);
      await db.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Anchor fixture','','',$3,$3)",
        [demandId, projectId, reader.userId],
      );
      await db.query(
        "insert into requirement_participant values($1,$2,'tester')",
        [demandId, reader.userId],
      );
      await db.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
        [sessionId, demandId, reader.userId],
      );
      await db.query(
        `insert into audit.session_log_anchor(project_id,session_id,bucket_sha256,journal_name,through_byte,sha256,recorded_at)
        select $1,$2,$3,'session.v'||generation||'.jsonl',64,$4,$5 from generate_series(1,27) as generation`,
        [projectId, sessionId, fileBucket, sha, at],
      );
    }
    await db.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [emptySession, original.demandId, reader.userId],
    );
    const get = (who = reader, url = route, observation = who.loginId) =>
      app.inject({
        url,
        headers: { cookie: who.cookie, 'x-rdws-edit-session': observation },
      });
    const first = await get();
    expect(first.statusCode).toBe(200);
    expect(first.headers['cache-control']).toBe('no-store');
    const page = first.json();
    expect(page).toMatchObject({
      projectId: original.projectId,
      requirementId: original.demandId,
      sessionId: original.sessionId,
      next: { recordedAt: at },
    });
    expect(page.items).toHaveLength(25);
    expect(page.items[0]).toEqual({
      id: expect.stringMatching(/^[a-f0-9]{64}$/),
      recordedAt: at,
      sha256: sha,
      throughByte: 64,
    });
    expect(first.body).not.toContain(fileBucket);
    expect(first.body).not.toContain('jsonl');
    expect(page.next.id).toBe(page.items[24].id);
    const cursor = new URLSearchParams({
      beforeAt: page.next.recordedAt,
      beforeId: page.next.id,
    });
    const second = (await get(reader, route + '?' + cursor)).json();
    expect(second.items).toHaveLength(2);
    expect(second.next).toBeNull();
    const ids = [...page.items, ...second.items].map(
      ({ id }: { id: string }) => id,
    );
    expect(new Set(ids).size).toBe(27);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(
      (await get(reader, path(original.demandId, emptySession))).json(),
    ).toEqual({
      projectId: original.projectId,
      requirementId: original.demandId,
      sessionId: emptySession,
      items: [],
      next: null,
    });
    expect(
      (await get(reader, path(original.demandId, neighbor.sessionId)))
        .statusCode,
    ).toBe(403);
    expect((await get(platform)).statusCode).toBe(403);
    expect((await get(replacement, route, reader.loginId)).statusCode).toBe(
      401,
    );
    expect((await app.inject({ url: route })).statusCode).toBe(401);
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
    expect((await get(reader, route + '?beforeAt=' + at)).statusCode).toBe(400);
    expect(
      (await get(reader, route + '?projectId=' + neighbor.projectId))
        .statusCode,
    ).toBe(400);

    beforeSend = async () => {
      await db.query(
        'update native_session set requirement_id=$1 where id=$2',
        [neighbor.demandId, original.sessionId],
      );
    };
    const moved = await get();
    expect(moved.statusCode).toBe(403);
    expect(moved.json()).not.toHaveProperty('items');
    expect(
      (await get(reader, path(neighbor.demandId, original.sessionId))).json(),
    ).toMatchObject({ projectId: neighbor.projectId, items: [], next: null });
    await db.query('update native_session set requirement_id=$1 where id=$2', [
      original.demandId,
      original.sessionId,
    ]);
    beforeSend = async () => {
      await db.query(
        'delete from requirement_participant where requirement_id=$1 and user_id=$2',
        [original.demandId, reader.userId],
      );
    };
    const revoked = await get();
    expect(revoked.statusCode).toBe(403);
    expect(revoked.json()).not.toHaveProperty('items');
    await db.query(
      "insert into requirement_participant values($1,$2,'tester')",
      [original.demandId, reader.userId],
    );
    beforeSend = async () => {
      await db.query(
        "update auth_session set expires_at=statement_timestamp()-interval '1 second' where id=$1",
        [reader.loginId],
      );
    };
    const expired = await get();
    expect(expired.statusCode).toBe(401);
    expect(expired.json()).not.toHaveProperty('items');
    expect(start).not.toHaveBeenCalled();
  } finally {
    beforeSend = undefined;
    try {
      await app.close();
      if (isolated) {
        await db.query(
          'delete from audit.session_log_anchor where session_id=any($1::text[])',
          [sessionIds],
        );
        await db.query('delete from native_session where id=any($1::text[])', [
          sessionIds,
        ]);
        await db.query(
          'delete from requirement_participant where requirement_id=any($1::text[])',
          [demandIds],
        );
        await db.query('delete from requirement where id=any($1::text[])', [
          demandIds,
        ]);
        await db.query(
          'delete from project_member where project_id=any($1::text[])',
          [projects],
        );
        await db.query('delete from project where id=any($1::text[])', [
          projects,
        ]);
      }
    } finally {
      start.mockRestore();
      await db.end();
    }
  }
});
