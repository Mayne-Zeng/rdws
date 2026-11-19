import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { basename, join } from 'node:path';
import { Pool } from 'pg';
import { expect, test, vi } from 'vitest';
import { buildApp } from '@rdws/server';
import { connectDatabase } from '@rdws/db';
import { NativeWebHost } from '@rdws/dsh/web';
import { loadEnvironment } from '@rdws/runtime-config';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { DemandWorktrees } from '@rdws/orchestrator';
import { createBusiness } from '../../apps/server/src/modules/business.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

loadEnvironment('test');

async function fingerprint(path: string) {
  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name));
  const digest = createHash('sha256');
  for (const file of files.sort()) {
    digest.update(file + '\0');
    digest.update(await readFile(file));
  }
  return digest.digest('hex');
}

test('the accepted demand keeps its frozen worktree through failure, source advance, and Native creation', async () => {
  const project = 'worktree-' + randomUUID();
  const f = await httpsGitFixture(project);
  const origin = process.env.RDWS_ORIGIN!;
  const migration = new URL(process.env.DATABASE_MIGRATION_URL!);
  expect(migration.hostname).toBe('127.0.0.1');
  expect(migration.pathname).toBe('/rdws_test');
  const application = new URL(process.env.DATABASE_URL!);
  expect(application.hostname).toBe('127.0.0.1');
  expect(application.pathname).toBe('/rdws_test');
  const pool = new Pool({ connectionString: migration.href });
  const configuration = join(f.root, 'config/projects', project, 'dsh');
  const profile = join(configuration, 'profiles/rdws');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            'rdws-glm': {
              api: 'openai-completions',
              baseURL: 'http://127.0.0.1:1/v1',
              models: [{ id: 'fixture-only' }],
            },
          },
        },
      },
    ]),
    { mode: 0o600 },
  );
  await writeFile(
    join(configuration, '.credentials.yaml'),
    'version: 1\nrefs: {}\n',
    { mode: 0o600 },
  );
  const native = new NativeWebHost(f.root, configuration, project);
  const app = buildApp({
    databaseUrl: process.env.DATABASE_URL!,
    secret: process.env.BETTER_AUTH_SECRET!,
    origin,
    repositoryHome: f.root,
    nativeHost: native,
    nativeRuntimeRoot: f.root,
  });
  const accounts = await readTestAccounts();
  let createdId: string | undefined;
  try {
    const identity = await pool.query(
      'select current_database() db, session_user as role',
    );
    expect(identity.rows[0]).toEqual({
      db: 'rdws_test',
      role: 'rdws_test_migrator',
    });
    await pool.query('insert into project (id,name) values ($1,$2)', [
      project,
      'T05 fixture',
    ]);
    await pool.query(
      `insert into project_member(project_id,user_id,role)
      select $1,id,case when username='pm' then 'project_admin' else 'developer' end
      from auth_user where username in ('pm','lead')`,
      [project],
    );
    const lead = (
      await pool.query("select id from auth_user where username='lead'")
    ).rows[0].id as string;
    async function login(username: string) {
      const result = await app.inject({
        method: 'POST',
        url: '/api/auth/sign-in/username',
        headers: { origin },
        payload: accounts.find((account) => account.username === username),
      });
      expect(result.statusCode).toBe(200);
      return result.cookies
        .map((cookie) => cookie.name + '=' + cookie.value)
        .join('; ');
    }
    const admin = await login('pm'),
      developer = await login('lead');
    const post = (
      url: string,
      cookie: string,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method: 'POST',
        url,
        headers: { origin, cookie },
        ...(payload ? { payload } : {}),
      });
    const projectUrl = '/api/projects/' + project;
    const command = {
      commandId: randomUUID(),
      title: 'T05 fixture',
      description: 'scope',
      acceptance: 'frozen',
      leadId: lead,
      participants: [],
    };
    const create = () => post(projectUrl + '/requirements', admin, command);
    const sync = (repository = 'app') =>
      post(projectUrl + '/repositories/' + repository + '/sync', admin, {
        commandId: randomUUID(),
      });
    const second = { ...f.entry, id: 'secondary', name: 'Second repository' };
    const register = (targetRef = f.entry.targetRef) =>
      writeFile(
        f.registration,
        JSON.stringify([{ ...f.entry, targetRef }, second]),
      );
    await register();
    expect((await create()).statusCode).toBe(503);
    expect(
      (
        await pool.query(
          'select count(*) from requirement where project_id=$1',
          [project],
        )
      ).rows[0].count,
    ).toBe('0');
    expect((await sync()).json()).toMatchObject({
      status: 'succeeded',
      candidateCommit: f.first,
    });
    expect((await create()).statusCode).toBe(503);
    expect((await sync('secondary')).json()).toMatchObject({
      status: 'succeeded',
      candidateCommit: f.first,
    });
    const sources = join(f.root, 'projects', project, 'sources');
    const receipts = join(sources, '.app.state');
    const parked = join(sources, '.app.fixture');
    await rename(receipts, parked);
    expect((await create()).statusCode).toBe(503);
    await rename(parked, receipts);
    await register('refs/heads/missing');
    expect((await sync()).json()).toMatchObject({
      status: 'failed',
      issue: 'target',
    });
    await register();
    const shortLogin = await login('pm');
    const session = await app.inject({
      url: '/api/auth/get-session',
      headers: { cookie: shortLogin },
    });
    const shortId: string = session.json().session.id;
    const expiredCommand = { ...command, commandId: randomUUID() };
    const blocker = await pool.connect();
    const current = connectDatabase(application.href);
    let expiring: Promise<number | undefined> | undefined;
    try {
      await blocker.query('begin');
      const pid = (await blocker.query('select pg_backend_pid() pid')).rows[0]
        .pid;
      await blocker.query(
        "select 1 from project_member where project_id=$1 and role='project_admin' for update",
        [project],
      );
      const deadline = Date.now() + 1700;
      await pool.query('update auth_session set expires_at=$1 where id=$2', [
        new Date(deadline),
        shortId,
      ]);
      expiring = createBusiness(current.db)
        .create(
          { userId: session.json().user.id as string, authSessionId: shortId },
          project,
          expiredCommand,
        )
        .then(
          () => 200,
          (error: { statusCode?: number }) => error.statusCode,
        );
      await expect
        .poll(
          async () =>
            (
              await pool.query(
                'select exists (select 1 from pg_stat_activity where $1=any(pg_blocking_pids(pid))) waiting',
                [pid],
              )
            ).rows[0].waiting,
          { timeout: 1200, interval: 30 },
        )
        .toBe(true);
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, deadline - Date.now() + 50)),
      );
      await blocker.query('rollback');
      expect(await expiring).toBe(401);
      expect(
        (
          await pool.query(
            'select 1 from command_receipt where command_id=$1',
            [expiredCommand.commandId],
          )
        ).rowCount,
      ).toBe(0);
    } finally {
      await blocker.query('rollback').catch(() => {});
      blocker.release();
      await expiring?.catch(() => {});
      await current.pool.end();
    }
    const demands = join(f.root, 'projects', project, 'demands');
    const outside = join(f.root, 'outside-demand');
    await mkdir(outside);
    await symlink(outside, demands);
    const basePrepare = DemandWorktrees.prototype.prepare;
    let reached!: () => void, release!: () => void;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const stall = new Promise<void>((resolve) => {
      release = resolve;
    });
    const prepare = vi
      .spyOn(DemandWorktrees.prototype, 'prepare')
      .mockImplementationOnce(async function (this: DemandWorktrees, ...args) {
        reached();
        await stall;
        return basePrepare.apply(this, args);
      });
    const withdrawn = create();
    try {
      await Promise.race([
        entered,
        withdrawn.then(() => {
          throw new Error('Creation did not reach preparation');
        }),
      ]);
      const committed = await pool.query(
        'select result from command_receipt where command_id=$1',
        [command.commandId],
      );
      createdId = committed.rows[0].result.id as string;
      await pool.query(
        "update project_member set role='requirement_manager' where project_id=$1 and role='project_admin'",
        [project],
      );
      release();
      expect((await withdrawn).statusCode).toBe(403);
      await pool.query(
        "update project_member set role='project_admin' where project_id=$1 and role='requirement_manager'",
        [project],
      );
    } finally {
      release();
      prepare.mockRestore();
      await withdrawn.catch(() => {});
    }
    const pending = await create();
    expect(pending.statusCode).toBe(200);
    expect(pending.json()).toMatchObject({ workspaceState: 'pending' });
    expect(pending.json().id).toBe(createdId);
    const url = '/api/requirements/' + createdId;
    const status = (cookie = developer) =>
      app.inject({ url: url + '/worktrees', headers: { cookie } });
    const openSession = () =>
      post(url + '/sessions', developer, { commandId: randomUUID() });
    expect((await status()).json()).toMatchObject({
      state: 'pending',
      canPrepare: false,
      repositories: [
        { repositoryId: 'app', baseCommit: f.first },
        { repositoryId: 'secondary', baseCommit: f.first },
      ],
    });
    expect((await openSession()).statusCode).toBe(503);
    expect((await post(url + '/worktrees', developer)).statusCode).toBe(403);
    expect(await readdir(outside)).toEqual([]);
    expect(
      (
        await pool.query(
          'select native_workspace_id from requirement where id=$1',
          [createdId],
        )
      ).rows[0].native_workspace_id,
    ).toBeNull();
    await unlink(demands);
    const next = await f.commit();
    await f.update();
    expect((await sync()).json()).toMatchObject({
      status: 'succeeded',
      candidateCommit: next,
    });
    const source = join(f.root, 'projects', project, 'sources', 'app.git');
    const sourceBefore = await fingerprint(source);
    const secondBefore = await fingerprint(join(sources, 'secondary.git'));
    await pool.query(
      "update project_member set role='requirement_manager' where project_id=$1 and role='project_admin'",
      [project],
    );
    expect((await create()).statusCode).toBe(403);
    await pool.query(
      "update project_member set role='project_admin' where project_id=$1 and role='requirement_manager'",
      [project],
    );
    const recovered = await create();
    expect(recovered.statusCode).toBe(200);
    expect(recovered.json()).toEqual({
      id: createdId,
      workspaceState: 'pending',
    });
    await expect(lstat(join(demands, createdId))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    expect((await post(url + '/worktrees', admin)).json()).toEqual({
      state: 'ready',
    });
    const sourceStatus = await status(admin);
    expect(sourceStatus.body).not.toContain('sourceBinding');
    const branch = 'rdws/' + createdId + '/app';
    expect(sourceStatus.json()).toEqual({
      state: 'ready',
      canPrepare: true,
      repositories: [
        {
          repositoryId: 'app',
          baseCommit: f.first,
          branch,
          worktreePath: 'worktrees/app',
          gitStorePath: '.gitstore/app.git',
        },
        {
          repositoryId: 'secondary',
          baseCommit: f.first,
          branch: 'rdws/' + createdId + '/secondary',
          worktreePath: 'worktrees/secondary',
          gitStorePath: '.gitstore/secondary.git',
        },
      ],
    });
    const demand = await realpath(join(demands, createdId));
    const worktree = join(demand, 'worktrees/app');
    expect(await fixtureGit(['-C', worktree, 'rev-parse', 'HEAD'])).toBe(
      f.first,
    );
    expect(
      await fixtureGit(['-C', worktree, 'symbolic-ref', '--short', 'HEAD']),
    ).toBe(branch);
    expect(
      await fixtureGit(['-C', worktree, 'rev-parse', '--git-common-dir']),
    ).toBe(join(demand, '.gitstore/app.git'));
    expect(await fingerprint(source)).toBe(sourceBefore);
    expect(await fingerprint(join(sources, 'secondary.git'))).toBe(
      secondBefore,
    );
    await expect(lstat(join(source, 'worktrees'))).rejects.toMatchObject({
      code: 'ENOENT',
    });

    const controls = join(demand, '.rdws-worktree');
    const stage = await mkdtemp(join(controls, 'stage-'));
    await rename(join(demand, 'worktrees'), join(stage, 'worktrees'));
    await rename(join(demand, 'demand.yaml'), join(stage, 'demand.yaml'));
    await unlink(join(controls, 'ready'));
    await writeFile(join(controls, 'promotion'), basename(stage) + '\n');
    const stageLink = join(stage, 'worktrees/app/.git');
    const adminLink = join(demand, '.gitstore/app.git/worktrees/app/gitdir');
    await writeFile(
      stageLink,
      'gitdir: ' + join(stage, '.gitstore/app.git/worktrees/app') + '\n',
    );
    await writeFile(adminLink, join(outside, '.git') + '\n');
    const rejected = await post(url + '/worktrees', admin);
    expect(rejected.json()).toEqual({ state: 'pending' });
    expect(await readFile(adminLink, 'utf8')).toBe(
      join(outside, '.git') + '\n',
    );
    expect((await openSession()).statusCode).toBe(503);
    await writeFile(adminLink, stageLink + '\n');
    const alias = join(outside, 'gitdir-link');
    await link(adminLink, alias);
    expect((await post(url + '/worktrees', admin)).json()).toEqual({
      state: 'pending',
    });
    expect(await readFile(alias, 'utf8')).toBe(stageLink + '\n');
    await unlink(alias);
    expect((await post(url + '/worktrees', admin)).json()).toEqual({
      state: 'ready',
    });
    expect(await fixtureGit(['-C', worktree, 'rev-parse', 'HEAD'])).toBe(
      f.first,
    );
    const store = '--git-dir=' + join(demand, '.gitstore/app.git');
    await fixtureGit([store, 'update-ref', '-d', 'refs/heads/' + branch]);
    expect((await openSession()).statusCode).toBe(503);
    await fixtureGit([store, 'update-ref', 'refs/heads/' + branch, f.first]);

    let workspace: unknown;
    for (let i = 0; i < 2; i++) {
      const response = await openSession();
      expect(response.statusCode).toBe(200);
      const sessionId = response.json().sessionId as string;
      const nativeScope = await native.control('session.inspect', {
        requirementId: createdId,
        sessionId,
      });
      expect(nativeScope.cwd).toBe(demand);
      workspace ??= nativeScope.workspaceId;
      expect(nativeScope.workspaceId).toBe(workspace);
    }
    expect(
      (
        await pool.query(
          'select native_workspace_id from requirement where id=$1',
          [createdId],
        )
      ).rows[0].native_workspace_id,
    ).toBe(workspace);
    expect(
      (
        await pool.query(
          'select count(*) from requirement where project_id=$1',
          [project],
        )
      ).rows[0].count,
    ).toBe('1');
  } finally {
    try {
      await app.close();
      const fixtures = await pool.query<{ id: string }>(
        'select id from requirement where project_id=$1',
        [project],
      );
      for (const { id } of fixtures.rows) {
        for (const table of [
          'session_operation',
          'native_session',
          'requirement_event',
          'requirement_participant',
          'requirement_worktree_plan',
        ])
          await pool.query(`delete from ${table} where requirement_id=$1`, [
            id,
          ]);
        await pool.query('delete from requirement where id=$1', [id]);
      }
      await pool.query('delete from command_receipt where scope=$1', [
        'project:' + project,
      ]);
      await pool.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await pool.query('delete from project where id=$1', [project]);
    } finally {
      await pool.end();
      await f.close();
    }
  }
}, 45000);
