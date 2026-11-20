import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { Pool, type PoolClient } from 'pg';
import { buildApp } from '@rdws/server';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test, vi } from 'vitest';
import type { OwnedWriteHandoff } from '../../apps/server/src/modules/workbench-write-authority.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { observedLogin } from '../helpers/native-browser.ts';

function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

test.skipIf(process.platform !== 'darwin')(
  'managed write status observes PostgreSQL and Broker without changing either',
  async () => {
    const lab = await authorityDatabase();
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'direct');
    const options = {
      databaseUrl: lab.databaseUrl,
      secret: lab.childEnv.BETTER_AUTH_SECRET!,
      origin: lab.childEnv.RDWS_ORIGIN!,
      nativeRuntimeRoot: lab.root,
      repositoryHome: lab.root,
    };
    const project = 'poc';
    const demand = randomUUID(),
      stranded = randomUUID();
    const ownSession = randomUUID(),
      strandedSession = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    const password = randomBytes(18).toString('hex');
    let app: ReturnType<typeof buildApp> | undefined;
    const releaseChecks: { open(): void }[] = [];
    const nativeStart = vi.spyOn(NativeWebHost.prototype, 'start');
    const nativeRevoke = vi.spyOn(NativeWebHost.prototype, 'revoke');
    try {
      await lab.owner.query(
        "insert into project(id,name) values('poc','Synthetic write status')",
      );
      const passwordHash = await hashPassword(password);
      async function account(name: string, role?: string) {
        const id = randomUUID();
        await lab.owner.query(
          'insert into auth_user(id,name,username,email,active) values($1,$2,$2,$3,true)',
          [id, name, name + '@fixture.invalid'],
        );
        await lab.owner.query(
          "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
          [randomUUID(), id, passwordHash],
        );
        if (role)
          await lab.owner.query(
            'insert into project_member values ($1,$2,$3)',
            [project, id, role],
          );
        return id;
      }
      const developer = await account('status_developer', 'developer');
      const tester = await account('status_tester', 'tester');
      await account('status_outside');
      for (const [id, session] of [
        [demand, ownSession],
        [stranded, strandedSession],
      ] as const) {
        await lab.owner.query(
          "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Status','','',$3,$3)",
          [id, project, developer],
        );
        await lab.owner.query(
          "insert into requirement_participant values ($1,$2,'developer'),($1,$3,'tester')",
          [id, developer, tester],
        );
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values ($1,$2,$3)',
          [session, id, developer],
        );
      }
      const ordinary = buildApp(options);
      app = ordinary;
      let client = 0;
      async function login(name: string) {
        const signed = await ordinary.inject({
          method: 'POST',
          url: '/api/auth/sign-in/username',
          headers: { origin: options.origin },
          remoteAddress: '192.0.2.' + ++client,
          payload: { username: name, password },
        });
        expect(signed.statusCode).toBe(200);
        const cookie = signed.cookies
          .map(({ name, value }) => name + '=' + value)
          .join('; ');
        return { cookie, id: await observedLogin(ordinary, cookie) };
      }
      const owner = await login('status_developer');
      const separate = await login('status_developer');
      const viewer = await login('status_tester');
      const outside = await login('status_outside');
      const expired = await login('status_developer');
      type Login = typeof owner;
      const url = (id = demand) => `/api/requirements/${id}/write-authority`;
      const check = (
        login: Login = owner,
        id = demand,
        observed: string | null = login.id,
      ) =>
        Promise.resolve(
          app!.inject({
            url: url(id),
            headers: {
              cookie: login.cookie,
              ...(observed !== null && { 'x-rdws-edit-session': observed }),
            },
          }),
        );
      const disabled = await check();
      expect(disabled.statusCode).toBe(200);
      expect(disabled.json()).toEqual({ state: 'unavailable' });
      expect((await check(outside)).statusCode).toBe(403);
      await ordinary.close();

      await lab.owner.query(
        "update auth_session set expires_at=now()+interval '6 hours' where id=$1",
        [owner.id],
      );
      await lab.owner.query(
        "update auth_session set expires_at=now()-interval '1 minute' where id=$1",
        [expired.id],
      );
      await lab.owner.query(
        "insert into requirement_write_lease(requirement_id,project_id,owner_id,auth_session_id,native_session_id,generation,phase,expires_at,context_version) values($1,$2,$3,$4,$5,$6,'held',now()-interval '1 minute',1)",
        [stranded, project, developer, owner.id, strandedSession, randomUUID()],
      );
      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'paused');
      const managed = buildApp({
        ...options,
        authorityTicket: ticket,
        isolatedWrite: {
          gitPath: execFileSync('/usr/bin/which', ['git'], {
            encoding: 'utf8',
          }).trim(),
        },
      });
      app = managed;
      let pause:
        | {
            entered: ReturnType<typeof latch>;
            release: ReturnType<typeof latch>;
          }
        | undefined;
      managed.addHook('preSerialization', async (request, _reply, payload) => {
        if (pause && request.url === url()) {
          const active = pause;
          pause = undefined;
          active.entered.open();
          await active.release.wait;
        }
        return payload;
      });
      await managed.ready();
      const broker = managed.getDecorator<() => OwnedWriteHandoff>(
        'isolatedWriteHandoff',
      )();
      const scope = {
        who: { userId: developer, authSessionId: owner.id },
        projectId: project,
        requirementId: demand,
        sessionId: ownSession,
      };
      async function pauseStatus() {
        const entered = latch(),
          release = latch();
        pause = { entered, release };
        releaseChecks.push(release);
        const pending = check();
        await entered.wait;
        return { pending, release };
      }
      const records = async () =>
        (
          await lab.owner.query(
            'select id, updated_at, expires_at from auth_session where id in ($1,$2) order by id',
            [owner.id, expired.id],
          )
        ).rows;
      const originalSessions = await records();
      const idle = await check();
      expect(idle.headers['cache-control']).toBe('no-store');
      expect(idle.headers['set-cookie']).toBeUndefined();
      expect(idle.json()).toEqual({ state: 'idle' });
      expect((await check(owner, stranded)).json()).toEqual({
        state: 'unconfirmed',
      });
      const coldCommand = { type: 'acquire' as const, commandId: randomUUID() };
      const coldScope = {
        ...scope,
        requirementId: stranded,
        sessionId: strandedSession,
      };
      await expect(
        broker.acquire(coldScope, coldCommand.commandId),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(await broker.checkCommand(coldScope, coldCommand)).toEqual({
        state: 'unrecorded',
      });
      expect((await check(owner, demand, null)).statusCode).toBe(401);
      expect((await check(owner, demand, separate.id)).statusCode).toBe(401);
      expect((await check(outside)).statusCode).toBe(403);
      const staleCookie = await check(expired);
      expect(staleCookie.statusCode).toBe(401);
      expect(staleCookie.headers['set-cookie']).toBeUndefined();
      const tampered = await check({
        ...owner,
        cookie: owner.cookie.replace(/=(.)/, '=$1Z'),
      });
      expect(tampered.statusCode).toBe(401);
      expect(await records()).toEqual(originalSessions);
      expect(
        (
          await managed.inject({
            url: '/api/auth/read-observed-login',
            headers: { cookie: owner.cookie },
          })
        ).statusCode,
      ).toBe(404);

      const initialIdle = await pauseStatus();
      const acknowledge = latch(),
        committed = latch();
      releaseChecks.push(acknowledge);
      const connect = Pool.prototype.connect;
      const stopCommit = vi
        .spyOn(Pool.prototype, 'connect')
        .mockImplementation(function (this: Pool, ...args: unknown[]) {
          const connection = Reflect.apply(connect, this, args);
          if (args.length) return connection;
          return connection.then((client: PoolClient) => {
            const query = client.query;
            let writing = false;
            client.query = ((...args: unknown[]) => {
              const input = args[0] as string | { text: string };
              const sql = typeof input === 'string' ? input : input.text;
              if (sql?.startsWith('insert into "requirement_write_lease"'))
                writing = true;
              const response = Reflect.apply(query, client, args);
              if (sql === 'commit' || sql === 'rollback') client.query = query;
              if (sql === 'commit' && writing)
                return response.then(async (result: unknown) => {
                  committed.open();
                  await acknowledge.wait;
                  return result;
                });
              return response;
            }) as typeof query;
            return client;
          });
        } as typeof connect);
      const acquiring = broker.acquire(scope, randomUUID());
      void acquiring.catch(() => {});
      try {
        await committed.wait;
        expect((await check()).json()).toEqual({ state: 'unconfirmed' });
      } finally {
        acknowledge.open();
        stopCommit.mockRestore();
      }
      const grant = await acquiring;
      const held = {
        state: 'held',
        holder: {
          sessionId: ownSession,
          generation: grant.generation,
          expiresAt: grant.expiresAt,
        },
      };
      initialIdle.release.open();
      expect((await initialIdle.pending).json()).toEqual(held);
      expect((await check(separate)).json()).toEqual({ state: 'held' });
      expect((await check(viewer)).json()).toEqual({ state: 'held' });

      const initialHeld = await pauseStatus();
      await broker.release(scope, grant.generation, randomUUID());
      initialHeld.release.open();
      expect((await initialHeld.pending).json()).toEqual({ state: 'idle' });
      const next = await broker.acquire(scope, randomUUID());
      const initialVersion = await pauseStatus();
      const modified = await managed.inject({
        method: 'POST',
        url: `/api/requirements/${demand}/commands`,
        headers: { cookie: owner.cookie, origin: options.origin },
        payload: {
          type: 'task.create',
          commandId: randomUUID(),
          task: { title: 'Change context', assigneeId: developer },
        },
      });
      expect(modified.statusCode, modified.body).toBe(200);
      initialVersion.release.open();
      expect((await initialVersion.pending).json()).toEqual({
        state: 'unconfirmed',
      });
      await broker.release(scope, next.generation, randomUUID());

      const initialAccess = await pauseStatus();
      const logout = await managed.inject({
        method: 'POST',
        url: '/api/auth/sign-out',
        headers: {
          cookie: owner.cookie,
          origin: options.origin,
          'x-rdws-edit-session': owner.id,
        },
      });
      expect(logout.statusCode).toBe(200);
      initialAccess.release.open();
      expect((await initialAccess.pending).statusCode).toBe(401);
      expect(nativeStart).not.toHaveBeenCalled();
      expect(nativeRevoke).not.toHaveBeenCalled();
    } finally {
      for (const active of releaseChecks) active.open();
      nativeStart.mockRestore();
      nativeRevoke.mockRestore();
      vi.unstubAllEnvs();
      try {
        await app?.close();
      } finally {
        await lab.close();
      }
    }
  },
  45_000,
);
