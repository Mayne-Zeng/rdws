import { test, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { buildApp } from '@rdws/server';
import { fixtureBinding } from '../helpers/native-browser.ts';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';
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
    if (operation === 'run.cancel') return { seen: false, cancelled: true };
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
    return {
      seen: !this.cancelled.includes(id),
      ...(operation === 'run.cancel' ? { cancelled: true } : {}),
    };
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

test('reconciliation confirms omissions and retries an unacknowledged Native cancellation', async () => {
  const active: unknown[] = [];
  let activeReads = 0;
  let acknowledge = true;
  class ReconciliationHost extends OverlappingAdmissionHost {
    override async control(
      operation: string,
      input: Record<string, unknown> = {},
    ) {
      if (operation === 'runs.active') {
        activeReads++;
        return {
          seen: false,
          runIds: active.length ? await active.shift() : this.registered,
        };
      }
      const result = await super.control(operation, input);
      return operation === 'run.cancel'
        ? { ...result, cancelled: acknowledge }
        : result;
    }
  }
  const native = new ReconciliationHost();
  const origin = process.env.RDWS_ORIGIN!;
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    nativeHost: native,
  });
  const pool = createTestPool('migration');
  const requirementId = randomUUID(),
    sessionId = 'session-' + randomUUID();
  let isolated = false;
  try {
    const identity = await pool.query(
      'select current_database() as database, current_user as role',
    );
    expect(identity.rows[0]).toEqual({
      database: 'rdws_test',
      role: 'rdws_test_migrator',
    });
    isolated = true;
    const login = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: (await readTestAccounts()).find(
        (entry) => entry.username === 'lead',
      ),
    });
    expect(login.statusCode).toBe(200);
    const uid = login.json().user.id;
    const cookie = login.cookies
      .map(({ name, value }) => name + '=' + value)
      .join('; ');
    await pool.query(
      "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by,native_workspace_id) values($1,'poc','Reconciliation fixture','','',$2,$2,'w')",
      [requirementId, uid],
    );
    await pool.query(
      "insert into requirement_participant values($1,$2,'developer')",
      [requirementId, uid],
    );
    await pool.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [sessionId, requirementId, uid],
    );
    const binding = await fixtureBinding(app, cookie, 'poc', requirementId);
    const send = (requestId = randomUUID()) =>
      app.inject({
        method: 'POST',
        url: `/api/dsh/${requirementId}/native/api/session/prompt`,
        headers: {
          origin,
          cookie,
          'x-rdws-native-login': binding,
          'x-rdws-client-generation': randomUUID(),
        },
        payload: {
          type: 'client-request',
          rpcId: randomUUID(),
          method: 'session/prompt',
          payload: {
            args: {
              request: {
                sessionId,
                requestId,
                mode: 'queue',
                content: [{ type: 'text', text: 'Synthetic input' }],
              },
            },
          },
        },
      });
    const original = randomUUID();
    expect((await send(original)).statusCode).toBe(200);
    const [old] = native.registered;
    active.push([], [old]);
    expect((await send()).statusCode).toBe(200);
    expect(activeReads).toBe(2);
    expect(native.cancelled).toEqual([]);
    active.push([false]);
    expect((await send()).statusCode).toBe(200);
    expect(activeReads).toBe(3);
    expect(native.cancelled).toEqual([]);
    expect((await send(original)).statusCode).toBe(200);
    expect(activeReads).toBe(3);
    expect(native.registered).toHaveLength(3);

    const remaining = native.registered.slice(1);
    active.push(remaining, remaining);
    acknowledge = false;
    const newKey = randomUUID();
    expect((await send(newKey)).statusCode).toBe(503);
    expect(native.cancelled).toEqual([old]);
    expect(native.registered).toHaveLength(3);
    acknowledge = true;
    expect((await send(newKey)).statusCode).toBe(200);
    expect(native.cancelled).toEqual([old, old]);
    expect(native.registered).toHaveLength(4);
    expect((await send()).statusCode).toBe(200);
    expect(native.cancelled).toEqual([old, old]);

    const omitted = native.registered.at(-1)!;
    const withoutOmitted = native.registered.filter((id) => id !== omitted);
    const firstRead = latch();
    const before = activeReads;
    active.push(firstRead.wait.then(() => withoutOmitted));
    const pending = Promise.resolve(send());
    try {
      await expect.poll(() => activeReads).toBe(before + 1);
      expect((await send()).statusCode).toBe(200);
      const concurrentlySubmitted = native.registered.at(-1);
      expect(concurrentlySubmitted).not.toBe(omitted);
      active.push(withoutOmitted);
      firstRead.release();
      expect((await pending).statusCode).toBe(200);
      expect(native.cancelled).toEqual([old, old, omitted]);
    } finally {
      firstRead.release();
      await pending;
    }
  } finally {
    await app.close();
    try {
      if (isolated) {
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
    } finally {
      await pool.end();
    }
  }
});

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
    const pool = createTestPool('migration');
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
      const accounts = (await readTestAccounts()) as { username: string }[];
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
    pool = createTestPool('migration');
  const id = randomUUID(),
    sid = 'admission-' + randomUUID();
  try {
    const accounts = await readTestAccounts();
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
