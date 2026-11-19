import { afterAll, beforeAll, expect, test, vi } from 'vitest';
import { Pool } from 'pg';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment } from '@rdws/runtime-config';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

const lookupFault = vi.hoisted(() => ({
  column: undefined as 'token' | 'id' | undefined,
  failures: 0,
  completedLookups: 0,
  observeLookups: false,
}));
vi.mock('@rdws/db', async (importOriginal) => {
  const original = await importOriginal<typeof import('@rdws/db')>();
  return {
    ...original,
    connectDatabase(connectionString: string) {
      const database = original.connectDatabase(connectionString);
      const query = database.pool.query;
      database.pool.query = ((
        statement: string | { text: string },
        ...args: unknown[]
      ) => {
        const sql = typeof statement === 'string' ? statement : statement.text;
        const column =
          /^select "id" from "auth_session" where "auth_session"\."(token|id)" = \$1$/.exec(
            sql,
          )?.[1];
        if (column && column === lookupFault.column) {
          lookupFault.failures++;
          return Promise.reject(new Error('Fixture private lookup failure'));
        }
        const result = Reflect.apply(query, database.pool, [
          statement,
          ...args,
        ]);
        if (column === 'token' && lookupFault.observeLookups)
          return result.then((value: unknown) => {
            lookupFault.completedLookups++;
            return value;
          });
        return result;
      }) as typeof database.pool.query;
      return database;
    },
  };
});

loadEnvironment('test');
const options = {
  databaseUrl: process.env.DATABASE_URL!,
  secret: process.env.BETTER_AUTH_SECRET!,
  origin: process.env.RDWS_ORIGIN!,
};
const app = buildApp(options);
const migrator = createTestPool('migration');
let accounts: { username: string; password: string }[];
beforeAll(async () => {
  accounts = await readTestAccounts();
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await migrator.end();
});
let loginClient = 0;
async function login(username: string) {
  const entry = accounts.find((a) => a.username === username)!;
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    remoteAddress: '192.0.2.' + ++loginClient,
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: entry,
  });
  expect(response.statusCode).toBe(200);
  const cookie = response.cookies.map((c) => `${c.name}=${c.value}`).join('; ');
  expect(cookie).toBeTruthy();
  return cookie;
}
function signOut(
  instance: ReturnType<typeof buildApp>,
  cookie?: string,
  observed?: string,
) {
  return instance.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: {
      origin: options.origin,
      ...(cookie && { cookie }),
      ...(observed !== undefined && { 'x-rdws-edit-session': observed }),
    },
    payload: {},
  });
}
async function sessionId(cookie: string) {
  const response = await app.inject({
    url: '/api/auth/get-session',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  return response.json().session.id as string;
}
test('anonymous requests cannot read project data', async () => {
  expect((await app.inject('/api/projects')).statusCode).toBe(401);
});
test('database sessions grant only project memberships and sign-out revokes the same cookie', async () => {
  const cookie = await login('lead');
  const response = await app.inject({
    url: '/api/projects',
    headers: { cookie },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    projects: [{ id: 'poc', name: 'RDWS PoC', roles: ['developer'] }],
  });
  const out = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-out',
    headers: { cookie, origin: process.env.RDWS_ORIGIN! },
    payload: {},
  });
  expect(out.statusCode).toBe(200);
  expect(
    (await app.inject({ url: '/api/projects', headers: { cookie } }))
      .statusCode,
  ).toBe(401);
});
test('a locked login row prevents confirmed logout until the original cookie can revoke it', async () => {
  const original = await login('lead');
  const concurrent = await login('lead');
  const originalId = await sessionId(original);
  const concurrentId = await sessionId(concurrent);
  const scoped = new URL(options.databaseUrl);
  scoped.searchParams.set('options', '-c lock_timeout=250ms');
  const failing = buildApp({ ...options, databaseUrl: scoped.href });
  try {
    await failing.ready();
    const blocker = await migrator.connect();
    try {
      await blocker.query('begin');
      await blocker.query(
        'select id from auth_session where id=$1 for update',
        [originalId],
      );
      const pending = await signOut(failing, original);
      const row = await blocker.query(
        'select id from auth_session where id=$1',
        [originalId],
      );
      expect({
        status: pending.statusCode,
        cookieInstructions: pending.cookies.length > 0,
        rowStillExists: row.rowCount === 1,
      }).toEqual({
        status: 503,
        cookieInstructions: false,
        rowStillExists: true,
      });
      expect(pending.headers['cache-control']).toBe('no-store');
      expect(pending.headers['x-rdws-native-revocation']).toBeUndefined();
      expect(
        (
          await failing.inject({
            url: '/api/projects',
            headers: { cookie: original },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await app.inject({
            url: '/api/projects',
            headers: { cookie: original },
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await failing.inject({
            url: '/api/projects',
            headers: { cookie: concurrent },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await blocker.query('rollback');
      blocker.release();
    }
    const retry = await signOut(failing, original);
    expect(retry.statusCode).toBe(200);
    expect(retry.cookies.some(({ maxAge }) => maxAge === 0)).toBe(true);
    expect(
      (
        await migrator.query('select id from auth_session where id=$1', [
          originalId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await app.inject({
          url: '/api/projects',
          headers: { cookie: original },
        })
      ).statusCode,
    ).toBe(401);
    const restarted = buildApp(options);
    try {
      expect(
        (
          await restarted.inject({
            url: '/api/projects',
            headers: { cookie: original },
          })
        ).statusCode,
      ).toBe(401);
      expect(
        (
          await restarted.inject({
            url: '/api/projects',
            headers: { cookie: concurrent },
          })
        ).statusCode,
      ).toBe(200);
    } finally {
      await restarted.close();
    }
  } finally {
    await failing.close();
    await migrator.query('delete from auth_session where id=any($1)', [
      [originalId, concurrentId],
    ]);
  }
});

test.each(['token', 'id'] as const)(
  'logout preserves the original cookie when the %s lookup cannot be confirmed',
  async (column) => {
    const cookie = await login('lead');
    const id = await sessionId(cookie);
    try {
      lookupFault.failures = 0;
      lookupFault.column = column;
      const pending = await signOut(app, cookie);
      lookupFault.column = undefined;
      expect(lookupFault.failures).toBe(1);
      expect(pending.statusCode).toBe(503);
      expect(pending.cookies).toHaveLength(0);
      expect(pending.headers['cache-control']).toBe('no-store');
      expect(pending.headers['x-rdws-native-revocation']).toBeUndefined();
      expect(pending.body).not.toContain('Fixture private lookup failure');
      expect(
        (await migrator.query('select id from auth_session where id=$1', [id]))
          .rowCount,
      ).toBe(column === 'token' ? 1 : 0);
      const retried = await signOut(app, cookie);
      expect(retried.statusCode).toBe(200);
      expect(retried.cookies.some(({ maxAge }) => maxAge === 0)).toBe(true);
      expect(
        (await app.inject({ url: '/api/projects', headers: { cookie } }))
          .statusCode,
      ).toBe(401);
    } finally {
      lookupFault.column = undefined;
      await migrator.query('delete from auth_session where id=$1', [id]);
    }
  },
);

test('anonymous and incorrectly signed logout cannot revoke a valid login', async () => {
  const cookie = await login('lead');
  const id = await sessionId(cookie);
  try {
    const invalid = cookie
      .split(';')
      .map((part) => part.split('=')[0]! + '=invalid-signature')
      .join(';');
    for (const header of [undefined, invalid]) {
      const response = await signOut(app, header);
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-rdws-native-revocation']).toBe('lease-expiry');
    }
    expect(
      (await app.inject({ url: '/api/projects', headers: { cookie } }))
        .statusCode,
    ).toBe(200);
  } finally {
    await migrator.query('delete from auth_session where id=$1', [id]);
  }
});

test('an observed logout refuses the different login now in the browser cookie', async () => {
  const original = await login('lead');
  const replacement = await login('lead');
  const originalId = await sessionId(original);
  const replacementId = await sessionId(replacement);
  try {
    const mismatch = await signOut(app, replacement, originalId);
    expect(mismatch.statusCode).toBe(401);
    expect(mismatch.cookies).toHaveLength(0);
    expect(mismatch.headers['x-rdws-native-revocation']).toBeUndefined();
    expect((await signOut(app, undefined, originalId)).statusCode).toBe(401);
    expect((await signOut(app, original, '')).statusCode).toBe(401);
    for (const cookie of [original, replacement])
      expect(
        (await app.inject({ url: '/api/projects', headers: { cookie } }))
          .statusCode,
      ).toBe(200);
    const response = await signOut(app, original, originalId);
    expect(response.statusCode).toBe(200);
    expect(response.cookies.some(({ maxAge }) => maxAge === 0)).toBe(true);
    const noLongerBound = await signOut(app, original, originalId);
    expect(noLongerBound.statusCode).toBe(401);
    expect(noLongerBound.cookies).toHaveLength(0);
    expect((await signOut(app, original)).statusCode).toBe(200);
    expect(
      (
        await app.inject({
          url: '/api/projects',
          headers: { cookie: replacement },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    await migrator.query('delete from auth_session where id=any($1)', [
      [originalId, replacementId],
    ]);
  }
});

test('an already-deleted replacement cookie cannot confirm an observed logout for another live login', async () => {
  const original = await login('lead');
  const replacement = await login('lead');
  const originalId = await sessionId(original);
  const replacementId = await sessionId(replacement);
  try {
    lookupFault.column = 'id';
    const unconfirmed = await signOut(app, replacement, replacementId);
    lookupFault.column = undefined;
    expect(unconfirmed.statusCode).toBe(503);
    expect(unconfirmed.cookies).toHaveLength(0);
    expect(
      (
        await migrator.query('select id from auth_session where id=$1', [
          replacementId,
        ])
      ).rowCount,
    ).toBe(0);
    const stale = await signOut(app, replacement, originalId);
    expect(stale.statusCode).toBe(401);
    expect(stale.cookies).toHaveLength(0);
    expect(
      (
        await app.inject({
          url: '/api/projects',
          headers: { cookie: original },
        })
      ).statusCode,
    ).toBe(200);
  } finally {
    lookupFault.column = undefined;
    await migrator.query('delete from auth_session where id=any($1)', [
      [originalId, replacementId],
    ]);
  }
});

test('concurrent logout shares a failing Native notification and confirms only the durable deletion', async () => {
  const cookie = await login('lead');
  const id = await sessionId(cookie);
  const host = new NativeWebHost('/tmp/rdws-unstarted-test-host');
  let release!: () => void;
  const notificationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const notify = vi.spyOn(host, 'revoke').mockImplementation(async () => {
    await notificationGate;
    throw new Error('Fixture Native notification failed');
  });
  const firstApp = buildApp({ ...options, nativeHost: host });
  const requests: PromiseLike<unknown>[] = [];
  try {
    await firstApp.ready();
    lookupFault.completedLookups = 0;
    lookupFault.observeLookups = true;
    const first = signOut(firstApp, cookie).then((value) => value);
    requests.push(first);
    await expect.poll(() => notify.mock.calls.length).toBe(1);
    const second = signOut(firstApp, cookie).then((value) => value);
    requests.push(second);
    await expect.poll(() => lookupFault.completedLookups).toBe(2);
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(notify).toHaveBeenCalledOnce();
    expect(
      (await firstApp.inject({ url: '/api/projects', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
    expect(
      (await migrator.query('select id from auth_session where id=$1', [id]))
        .rowCount,
    ).toBe(1);
    release();
    for (const response of await Promise.all([first, second])) {
      expect(response.statusCode).toBe(200);
      expect(response.headers['x-rdws-native-revocation']).toBe('lease-expiry');
      expect(response.cookies.some(({ maxAge }) => maxAge === 0)).toBe(true);
    }
    expect(notify).toHaveBeenCalledOnce();
    expect(
      (await migrator.query('select id from auth_session where id=$1', [id]))
        .rowCount,
    ).toBe(0);
    const replay = await signOut(firstApp, cookie);
    expect(replay.statusCode).toBe(200);
    expect(replay.headers['x-rdws-native-revocation']).toBe('lease-expiry');
    expect(notify).toHaveBeenCalledOnce();
  } finally {
    lookupFault.observeLookups = false;
    release();
    await Promise.allSettled(requests);
    await firstApp.close();
    await migrator.query('delete from auth_session where id=$1', [id]);
  }
});
test('platform administrator does not inherit project business membership', async () => {
  const cookie = await login('admin');
  expect(
    (await app.inject({ url: '/api/projects', headers: { cookie } })).json(),
  ).toEqual({ projects: [] });
});
test('the preset two-character project administrator can sign in', async () => {
  const cookie = await login('pm');
  const response = await app.inject({
    url: '/api/projects',
    headers: { cookie },
  });
  expect(response.json().projects[0].roles).toEqual(['project_admin']);
});
test('disabling a user invalidates business access for an existing session', async () => {
  const cookie = await login('dev');
  await migrator.query('update auth_user set active=false where username=$1', [
    'dev',
  ]);
  try {
    expect(
      (await app.inject({ url: '/api/projects', headers: { cookie } }))
        .statusCode,
    ).toBe(401);
  } finally {
    await migrator.query('update auth_user set active=true where username=$1', [
      'dev',
    ]);
  }
});
test('public signup and untrusted origins are rejected', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-up/email',
    headers: { origin: process.env.RDWS_ORIGIN! },
    payload: {
      name: 'outsider',
      email: 'outsider@rdws.invalid',
      password: crypto.randomUUID(),
    },
  });
  expect(response.statusCode).toBeGreaterThanOrEqual(400);
  const entry = accounts.find((a) => a.username === 'lead')!;
  const forged = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: { origin: 'https://untrusted.invalid' },
    payload: entry,
  });
  expect(forged.statusCode).toBe(403);
});
test('application role cannot create tables or connect to development database', async () => {
  const pool = createTestPool('application');
  try {
    await expect(
      pool.query('create table forbidden_table(id text)'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('update requirement_event set actor_id=actor_id where false'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      pool.query('delete from requirement_event where false'),
    ).rejects.toMatchObject({ code: '42501' });
  } finally {
    await pool.end();
  }
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = '/rdws_dev';
  const cross = new Pool({ connectionString: url.toString() });
  try {
    await expect(cross.query('select 1')).rejects.toMatchObject({
      code: '42501',
    });
  } finally {
    await cross.end();
  }
});

test('repeated sign-in requests are rate-limited', async () => {
  const entry = accounts.find((a) => a.username === 'lead')!;
  let blocked = false;
  for (let attempt = 0; attempt < 11; attempt++) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: {
        origin: process.env.RDWS_ORIGIN!,
        'x-rdws-client-ip': String(attempt),
      },
      payload: entry,
    });
    if (response.statusCode === 429) {
      blocked = true;
      break;
    }
    expect(response.statusCode).toBe(200);
  }
  expect(blocked).toBe(true);
});

test('malformed JSON is a client error without internal details', async () => {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/sign-in/username',
    headers: {
      origin: process.env.RDWS_ORIGIN!,
      'content-type': 'application/json',
    },
    payload: '{',
  });
  expect(response.statusCode).toBe(400);
  expect(response.json()).toEqual({ error: '请求参数不正确' });
});
