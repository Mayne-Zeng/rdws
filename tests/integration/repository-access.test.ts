import { randomUUID } from 'node:crypto';
import { expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { connectDatabase } from '@rdws/db';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import { loadEnvironment } from '@rdws/runtime-config';
import { httpsGitFixture } from '../helpers/https-git.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

loadEnvironment('test');
const origin = process.env.RDWS_ORIGIN!;

function latch() {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { wait, release };
}

test('repository summaries and synchronization use current project roles and a final revocation gate', async () => {
  const project = 'repo-' + randomUUID();
  const f = await httpsGitFixture(project);
  const database = createTestPool('migration');
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    repositoryHome: f.root,
  });
  const accounts = await readTestAccounts();
  async function login(username: string) {
    const response = await app.inject({
      method: 'POST',
      url: '/api/auth/sign-in/username',
      headers: { origin },
      payload: accounts.find((a) => a.username === username),
    });
    expect(response.statusCode).toBe(200);
    return response.cookies.map((c) => c.name + '=' + c.value).join('; ');
  }
  const url = '/api/projects/' + project + '/repositories';
  const get = (cookie?: string) =>
    app.inject({ url, headers: cookie ? { cookie } : {} });
  const sync = (
    cookie: string,
    commandId = randomUUID(),
    overrides: Record<string, unknown> = {},
  ) =>
    app.inject({
      method: 'POST',
      url: url + '/app/sync',
      headers: { cookie, origin },
      payload: { commandId, ...overrides },
    });
  const resume = latch();
  try {
    await database.query('insert into project(id,name) values ($1,$2)', [
      project,
      'Repository fixture',
    ]);
    await database.query(
      `insert into project_member(project_id,user_id,role)
      select $1,id,case when username='pm' then 'project_admin' else 'developer' end
      from auth_user where username in ('pm','lead')`,
      [project],
    );
    const pm = await login('pm'),
      lead = await login('lead'),
      admin = await login('admin');
    expect((await get()).statusCode).toBe(401);
    expect((await get(admin)).statusCode).toBe(403);
    expect((await sync(lead)).statusCode).toBe(403);
    expect((await sync(admin)).statusCode).toBe(403);
    expect(
      (await sync(pm, randomUUID(), { url: f.entry.url })).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: 'POST',
          url: url + '/app/sync',
          headers: { cookie: pm, origin: 'https://example.invalid' },
          payload: { commandId: randomUUID() },
        })
      ).statusCode,
    ).toBe(403);
    expect(f.requests).toHaveLength(0);
    const visible = await get(lead);
    expect(visible.json()).toMatchObject({
      canSync: false,
      repositories: [
        { baselineRef: f.entry.baselineRef, targetRef: f.entry.targetRef },
      ],
    });
    expect(visible.body).not.toContain(f.entry.url);
    expect(visible.body).not.toContain(f.entry.credentialFile);

    const accepted = await sync(pm);
    expect(accepted.statusCode).toBe(200);
    expect(accepted.json()).toMatchObject({
      status: 'succeeded',
      candidateCommit: f.first,
    });
    expect((await get(lead)).json().repositories[0].publishedCommit).toBe(
      f.first,
    );

    const next = await f.commit();
    await f.update();
    const started = latch();
    f.controls.before = async () => {
      started.release();
      await resume.wait;
    };
    const attempt = sync(pm);
    await Promise.race([
      started.wait,
      attempt.then(() => {
        throw new Error('Sync never reached the remote');
      }),
    ]);
    await database.query(
      `delete from project_member where project_id=$1 and role='project_admin'`,
      [project],
    );
    resume.release();
    expect((await attempt).statusCode).toBe(403);
    expect((await get(lead)).json().repositories[0]).toMatchObject({
      publishedCommit: f.first,
      lastSync: {
        status: 'failed',
        issue: 'authorization',
        candidateCommit: next,
      },
    });
  } finally {
    resume.release();
    await app.close();
    await database.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await database.query('delete from project where id=$1', [project]);
    await database.end();
    await f.close();
  }
});

test('a publication that obtains the authorization gate first orders role removal after the local action', async () => {
  const project = 'repo-' + randomUUID();
  const db = connectDatabase(process.env.DATABASE_URL!);
  const migrator = createTestPool('migration');
  const row = await migrator.connect();
  const business = createBusiness(db.db);
  const sessionId = randomUUID();
  const actorId = randomUUID();
  const enter = latch(),
    exit = latch();
  let publication: Promise<void> | undefined;
  let revoke: Promise<unknown> | undefined;
  try {
    await row.query('insert into auth_user(id,name,email) values ($1,$2,$3)', [
      actorId,
      'Synthetic mirror admin',
      actorId + '@example.invalid',
    ]);
    await row.query('insert into project(id,name) values ($1,$2)', [
      project,
      'Repository gate fixture',
    ]);
    await row.query(
      `insert into project_member(project_id,user_id,role) values ($1,$2,'project_admin')`,
      [project, actorId],
    );
    await row.query(
      `insert into auth_session(id,user_id,token,expires_at,created_at,updated_at)
      values ($1,$2,$3,now()+interval '5 minutes',now(),now())`,
      [sessionId, actorId, randomUUID()],
    );
    const identity = { userId: actorId, authSessionId: sessionId };
    const denied = vi.fn(async () => {});
    await expect(
      business.publishRepository(identity, project, () => true, denied),
    ).rejects.toMatchObject({ statusCode: 401 });
    await row.query('update auth_user set active=false where id=$1', [actorId]);
    await expect(
      business.publishRepository(identity, project, () => false, denied),
    ).rejects.toMatchObject({ statusCode: 401 });
    await row.query('update auth_user set active=true where id=$1', [actorId]);
    await row.query(
      "update auth_session set expires_at=now()-interval '1 second' where id=$1",
      [sessionId],
    );
    await expect(
      business.publishRepository(identity, project, () => false, denied),
    ).rejects.toMatchObject({ statusCode: 401 });
    await row.query(
      "update auth_session set expires_at=now()+interval '5 minutes' where id=$1",
      [sessionId],
    );
    expect(denied).not.toHaveBeenCalled();

    publication = business.publishRepository(
      { userId: actorId, authSessionId: sessionId },
      project,
      () => false,
      async () => {
        enter.release();
        await exit.wait;
      },
    );
    await Promise.race([
      enter.wait,
      publication.then(() => {
        throw new Error('Publish callback not reached');
      }),
    ]);
    const backendPid = (await row.query('select pg_backend_pid() as pid'))
      .rows[0].pid as number;
    revoke = row.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await vi.waitFor(async () => {
      const result = await migrator.query(
        'select cardinality(pg_blocking_pids($1)) as count',
        [backendPid],
      );
      expect(result.rows[0].count).toBeGreaterThan(0);
    });
    exit.release();
    await publication;
    await revoke;
    await expect(
      business.publishRepository(
        { userId: actorId, authSessionId: sessionId },
        project,
        () => false,
        async () => {
          throw new Error('Revoked actor must not publish');
        },
      ),
    ).rejects.toMatchObject({ statusCode: 403 });
  } finally {
    exit.release();
    await Promise.allSettled([publication, revoke]);
    await row.query('delete from auth_session where id=$1', [sessionId]);
    await row.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await row.query('delete from project where id=$1', [project]);
    await row.query('delete from auth_user where id=$1', [actorId]);
    row.release();
    await migrator.end();
    await db.pool.end();
  }
});
