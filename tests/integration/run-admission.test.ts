import { test, expect } from 'vitest';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { buildApp } from '@rdws/server';
import { fixtureBinding } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment, runtimeHome } from '@rdws/runtime-config';
loadEnvironment('test');
class FailedAdmissionHost extends NativeWebHost {
  mode: 'sideband' | 'rejected' | 'accepted' = 'sideband';
  constructor() {
    super('/tmp/rdws-admission-unstarted');
  }
  override async workspace() {
    return { workspaceId: 'w', cwd: '/unused' };
  }
  override ticket() {
    return 'synthetic-ticket';
  }
  override claims() {
    return {
      aud: this.audience,
      purpose: 'browser' as const,
      nonce: 'peer',
      issuedAt: Date.now(),
      expiresAt: Date.now() + 20000,
    };
  }
  override async control(operation: string) {
    if (operation === 'run' && this.mode === 'sideband')
      throw new Error('Controlled admission outage');
    return { seen: false };
  }
  override async fetch(
    _path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    return new Response(
      JSON.stringify({
        type: 'server-response',
        rpcId: JSON.parse(String(init.body)).rpcId,
        result:
          this.mode === 'accepted'
            ? { ok: true, value: { accepted: true } }
            : {
                ok: false,
                error: {
                  code: 'gateway/internal',
                  message: 'Rejected',
                  details: {},
                },
              },
      }),
    );
  }
  override async close() {}
}

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

class OverlappingAdmissionHost extends FailedAdmissionHost {
  readonly registered: string[] = [];
  readonly cancelled: string[] = [];
  readonly firstForward = latch();
  readonly releaseFirst = latch();
  readonly cleaningFirst = latch();
  readonly releaseCleanup = latch();
  readonly cachedForward = latch();
  readonly releaseCached = latch();
  private deliveries = 0;
  heldRequestId = '';
  heldSessionId = '';
  holdFailed = false;
  holdCached = false;

  override async control(
    operation: string,
    input: Record<string, unknown> = {},
  ) {
    const id = String(input.runId);
    if (operation === 'run') this.registered.push(id);
    if (operation === 'run.cancel') {
      this.cancelled.push(id);
      if (
        this.holdFailed &&
        this.releaseFirstSettled &&
        id === this.registered[0]
      ) {
        this.cleaningFirst.release();
        await this.releaseCleanup.wait;
      }
    }
    return { seen: !this.cancelled.includes(id) };
  }

  override async fetch(
    _path: string,
    _grant: Parameters<NativeWebHost['fetch']>[1],
    init: RequestInit = {},
  ) {
    const envelope = JSON.parse(String(init.body));
    const { requestId, sessionId } = envelope.payload.args.request;
    const original =
      requestId === this.heldRequestId && sessionId === this.heldSessionId;
    const first = original && this.deliveries++ === 0;
    if (first) {
      this.firstForward.release();
      await this.releaseFirst.wait;
    }
    if (original && this.holdCached) {
      this.holdCached = false;
      this.cachedForward.release();
      await this.releaseCached.wait;
    }
    if (first && this.holdFailed)
      throw new Error('fixture aborted the first forwarding');
    return Response.json({
      type: 'server-response',
      rpcId: envelope.rpcId,
      result:
        !original || first || this.releaseFirstSettled
          ? { ok: true, value: { accepted: true } }
          : {
              ok: false,
              error: {
                code: 'gateway/internal',
                message: 'fixture rejected overlap',
                details: {},
              },
            },
    });
  }

  private releaseFirstSettled = false;
  finishFirst() {
    this.releaseFirstSettled = true;
    this.releaseFirst.release();
  }
}

test.each([false, true])(
  'overlapping sends cannot retire the original run (original forwarding fails: %s)',
  async (holdFailed) => {
    const native = new OverlappingAdmissionHost();
    native.holdFailed = holdFailed;
    const origin = process.env.RDWS_ORIGIN!;
    const app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin,
      nativeHost: native,
    });
    const pool = new Pool({
      connectionString: process.env.DATABASE_MIGRATION_URL,
    });
    const requirementId = randomUUID(),
      sessionId = 'session-' + randomUUID();
    const requestId = randomUUID(),
      generation = randomUUID();
    const anotherSession = 'session-' + randomUUID();
    native.heldRequestId = requestId;
    native.heldSessionId = sessionId;
    let first: PromiseLike<unknown> | undefined;
    let cached: PromiseLike<unknown> | undefined;
    let testDatabase = false;
    try {
      const identity = await pool.query(
        'select current_database() as database, current_user as role',
      );
      expect(identity.rows[0]).toEqual({
        database: 'rdws_test',
        role: 'rdws_test_migrator',
      });
      testDatabase = true;
      const accounts = JSON.parse(
        await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
      ) as { username: string }[];
      const login = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: accounts.find((account) => account.username === 'lead'),
      });
      expect(login.statusCode).toBe(200);
      const uid = login.json().user.id;
      const cookie = login.cookies
        .map(({ name, value }) => name + '=' + value)
        .join('; ');
      await pool.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,'poc','Overlap fixture','','',$2,$2,'w')",
        [requirementId, uid],
      );
      await pool.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, uid],
      );
      await pool.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3),($4,$2,$3)',
        [sessionId, requirementId, uid, anotherSession],
      );

      const binding = await fixtureBinding(app, cookie, 'poc', requirementId);
      const send = (
        id: string,
        text = 'Original prompt',
        targetSessionId = sessionId,
      ) =>
        Promise.resolve(
          app.inject({
            method: 'POST',
            url: `/api/dsh/${requirementId}/native/api/session/prompt`,
            headers: {
              cookie,
              origin,
              'x-rdws-client-generation': generation,
              'x-rdws-native-login': binding,
            },
            payload: {
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/prompt',
              payload: {
                args: {
                  request: {
                    sessionId: targetSessionId,
                    requestId: id,
                    mode: 'queue',
                    content: [{ type: 'text', text }],
                  },
                },
              },
            },
          }),
        );
      const original = send(requestId);
      first = original;
      await native.firstForward.wait;
      const duplicate = await send(requestId);
      expect(native.cancelled).toEqual([]);
      expect(duplicate.statusCode).toBe(409);
      expect(
        (await send(requestId, 'Different prompt with the same key'))
          .statusCode,
      ).toBe(409);
      expect(native.registered).toHaveLength(1);
      expect((await send(randomUUID())).statusCode).toBe(200);
      expect(
        (await send(requestId, 'Separate session prompt', anotherSession))
          .statusCode,
      ).toBe(200);
      const originalRun = native.registered[0]!;
      native.finishFirst();
      if (holdFailed) {
        await native.cleaningFirst.wait;
        expect((await send(requestId)).statusCode).toBe(409);
        native.releaseCleanup.release();
      }
      const completed = await original;
      expect(completed.statusCode).toBe(holdFailed ? 500 : 200);
      if (holdFailed) expect(native.cancelled).toEqual([originalRun]);
      else expect(native.cancelled).toEqual([]);
      expect((await send(requestId)).statusCode).toBe(200);
      const registered = holdFailed ? 4 : 3;
      expect(native.registered).toHaveLength(registered);

      native.holdCached = true;
      const replay = send(requestId);
      cached = replay;
      await native.cachedForward.wait;
      expect((await send(requestId)).statusCode).toBe(409);
      native.releaseCached.release();
      expect((await replay).statusCode).toBe(200);
      expect(native.registered).toHaveLength(registered);
    } finally {
      native.finishFirst();
      native.releaseCleanup.release();
      native.releaseCached.release();
      if (first) await first;
      if (cached) await cached;
      if (testDatabase) {
        await pool.query('delete from native_session where requirement_id=$1', [
          requirementId,
        ]);
        await pool.query(
          'delete from requirement_participant where requirement_id=$1',
          [requirementId],
        );
        await pool.query('delete from requirement where id=$1', [
          requirementId,
        ]);
      }
      await app.close();
      await pool.end();
    }
  },
);
test('failed sideband and rejected RPC admissions release their global quota', async () => {
  const native = new FailedAdmissionHost(),
    app = buildApp({
      databaseUrl: process.env.DATABASE_URL!,
      secret: process.env.BETTER_AUTH_SECRET!,
      origin: process.env.RDWS_ORIGIN!,
      nativeHost: native,
    }),
    pool = new Pool({ connectionString: process.env.DATABASE_MIGRATION_URL });
  const id = randomUUID(),
    sid = 'admission-' + randomUUID();
  try {
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    );
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin: process.env.RDWS_ORIGIN! },
      payload: accounts.find(
        (a: { username: string }) => a.username === 'lead',
      ),
    });
    const uid = login.json().user.id,
      cookie = login.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,$2,$3,$4,$5,$6,$6,$7)',
      [id, 'poc', 'Admission fixture', 'Synthetic', 'No quota leak', uid, 'w'],
    );
    await pool.query('insert into requirement_participant values($1,$2,$3)', [
      id,
      uid,
      'developer',
    ]);
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sid, id, uid],
    );
    const binding = await fixtureBinding(app, cookie, 'poc', id);
    const send = () =>
      app.inject({
        method: 'POST',
        url: `/api/dsh/${id}/native/api/session/prompt`,
        headers: {
          cookie,
          origin: process.env.RDWS_ORIGIN!,
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
                sessionId: sid,
                requestId: randomUUID(),
                mode: 'queue',
                content: [{ type: 'text', text: 'Synthetic prompt' }],
              },
            },
          },
        },
      });
    for (let i = 0; i < 515; i++) expect((await send()).statusCode).toBe(500);
    native.mode = 'rejected';
    for (let i = 0; i < 515; i++) expect((await send()).statusCode).toBe(200);
    native.mode = 'accepted';
    expect((await send()).statusCode).toBe(200);
  } finally {
    await pool.query('delete from native_session where requirement_id=$1', [
      id,
    ]);
    await pool.query(
      'delete from requirement_participant where requirement_id=$1',
      [id],
    );
    await pool.query('delete from requirement where id=$1', [id]);
    await app.close();
    await pool.end();
  }
}, 30000);
