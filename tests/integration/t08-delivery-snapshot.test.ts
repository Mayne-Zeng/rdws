import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectDatabase, acquireAuthority, schema } from '@rdws/db';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { bodyHash } from '@rdws/dsh/access';
import {
  gitCommitArguments,
  gitCommitMessageLimit,
  gitCommitPathsLimit,
  writeToolArguments,
} from '@rdws/dsh/write-tool-arguments';
import {
  runMacosWorktree,
  type ExecutionRequest,
} from '../../dsh/execution/macos.ts';
import { createOwnedWriteHandoff } from '../../apps/server/src/modules/write-handoff.ts';
import {
  NativeShellToolJob,
  type ShellRequest,
} from '../../apps/server/src/modules/native-shell-tool-job.ts';
import {
  deliveryContentDigest,
  verifyDeliveryAnchor,
} from '../../apps/server/src/modules/delivery-snapshot.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const exec = promisify(execFile);

// §11.23 A segment: the controlled commit chain and the immutable
// delivery snapshots. Red first on unmodified main, green after the
// implementation: permit shape (C1), broker reservation and the
// supervised T06 sandbox (C2/C3), the staged-set fence and the three
// post-commit checks (C4), the holder binding (C5), the append-only
// rows and their revokes (S1/S2), the content anchor (S3), the frozen
// baseline (S4), and the counter-examples N2/N4/N6/N7/N8/N9.
describe.runIf(process.platform === 'darwin')(
  '§11.23 A: controlled commit and delivery snapshots',
  () => {
    const projectId = 'poc';
    let lab: Awaited<ReturnType<typeof authorityDatabase>> | undefined;
    let trees: DemandWorktrees | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let broker: Awaited<ReturnType<typeof createOwnedWriteHandoff>> | undefined;
    let owned: string | undefined;
    let database: ReturnType<typeof connectDatabase> | undefined;
    let scope:
      Awaited<ReturnType<DemandWorktrees['executionScope']>> | undefined;
    let plan: Parameters<DemandWorktrees['prepare']>[2] | undefined;
    let writer:
      | {
          who: { userId: string; authSessionId: string };
          sessionId: string;
          projectId: string;
          requirementId: string;
          role: string;
        }
      | undefined;
    let requirementId: string;
    let generation: string;
    let contextVersion: number;
    const identity = {
      name: 'Fixture Holder',
      email: 'holder@fixture.invalid',
    };
    const commitBody = { kind: 'delivery-commit' };
    let gitPath = '/usr/bin/git';

    async function worktreeStatus() {
      if (!scope) throw new Error('fixture missing');
      const result = await exec(
        '/usr/bin/git',
        ['-C', scope.tree, 'status', '--porcelain'],
        { encoding: 'utf8' },
      );
      return result.stdout
        .replace(/\n$/, '')
        .split('\n')
        .filter(Boolean)
        .sort();
    }

    type CommitCallOutput = {
      state: string;
      outcome: string;
      reason?: string;
      exitCode?: number | null;
      commit?: {
        head: string;
        parent: string;
        messageSha256: string;
        paths: { path: string; type: string; digest: string | null }[];
      };
      snapshot?: {
        requirementId: string;
        repositoryId: string;
        snapshotSeq: number;
        commitHash: string;
        contentDigest: string;
        commandId: string;
      };
    };

    async function commitWith(
      request: ShellRequest,
      options: { grantGeneration?: string } = {},
    ) {
      if (!writer || !broker) throw new Error('fixture missing');
      const actor = writer;
      const grantGeneration = options.grantGeneration ?? generation;
      const host = new AbortController();
      const job = new NativeShellToolJob({
        scope: writer,
        grant: { generation: grantGeneration, contextVersion },
        broker,
        repositoryId: 'app',
        request,
        hostSignal: host.signal,
        onCommit: (input) =>
          broker!.recordDeliverySnapshot(input.scope, {
            repositoryId: input.repositoryId,
            generation: input.generation,
            commitHash: input.commit.head,
            parentHead: input.commit.parent,
            paths: input.commit.paths,
            messageSha256: input.commit.messageSha256,
            commandId: input.commandId,
          }),
      });
      const digest = bodyHash(commitBody);
      let jobId: string;
      try {
        const issued = job.offer(
          actor.who,
          actor.requirementId,
          actor.sessionId,
          contextVersion,
          digest,
          Date.now() + 30_000,
          () => true,
        );
        expect(issued).toBe(job.commandId);
        jobId = issued;
      } catch (error) {
        // W2/N6: a zero-permit refusal is definite zero execution; the
        // job never begins and nothing is reserved or run.
        await job.close().catch(() => {});
        return {
          state: 'denied',
          outcome: 'refused',
          reason: error instanceof Error ? error.message : String(error),
        } as CommitCallOutput;
      }
      await expect(
        job.control('begin', { ...commitBody, jobId }, async () => {}),
      ).resolves.toEqual({ accepted: true });
      await expect
        .poll(
          async () => {
            const state = (await job.control(
              'status',
              { ...commitBody, jobId },
              async () => {},
            )) as { state: string };
            return state.state;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^(ok|failed|unknown)$/);
      const output = (await job.control(
        'output',
        { ...commitBody, jobId },
        async () => {},
      )) as {
        state: string;
        outcome: string;
        reason?: string;
        commit?: {
          head: string;
          parent: string;
          messageSha256: string;
          paths: { path: string; type: string; digest: string | null }[];
        };
        snapshot?: {
          requirementId: string;
          repositoryId: string;
          snapshotSeq: number;
          commitHash: string;
          contentDigest: string;
          commandId: string;
        };
      };
      await job.close().catch(() => {});
      return output as CommitCallOutput;
    }

    beforeAll(async () => {
      process.env.RDWS_MODE = 'test';
      lab = await authorityDatabase();
      // The connection carries the runtime authority proof: admission
      // binds it against the ticket.
      database = connectDatabase(
        lab.databaseUrl,
        randomBytes(32).toString('hex'),
        3_000,
      );
      requirementId = randomUUID();
      const ticket = randomBytes(32).toString('hex');
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Delivery snapshot fixture')",
        [projectId],
      );
      const userId = randomUUID();
      const authSessionId = randomUUID();
      await lab.owner.query(
        'insert into auth_user (id,name,email,username,active) values ($1,$2,$3,$2,true)',
        [userId, identity.name, identity.email],
      );
      await lab.owner.query(
        "insert into auth_session (id,user_id,token,auth_epoch,expires_at) values ($1,$2,$3,0,now()+interval '30 minutes')",
        [authSessionId, userId, randomUUID()],
      );
      await lab.owner.query('insert into project_member values ($1,$2,$3)', [
        projectId,
        userId,
        'developer',
      ]);
      writer = {
        who: { userId, authSessionId },
        sessionId: randomUUID(),
        projectId,
        requirementId,
        role: 'developer',
      };
      await lab.owner.query(
        "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by,background) values ($1,$2,'Delivery snapshot','','',$3,$3,'')",
        [requirementId, projectId, userId],
      );
      await lab.owner.query(
        'insert into native_session (id,requirement_id,owner_id) values ($1,$2,$3)',
        [writer.sessionId, requirementId, userId],
      );
      await lab.owner.query(
        'insert into requirement_participant values ($1,$2,$3)',
        [requirementId, userId, 'developer'],
      );
      const fixture = await httpsGitFixture(projectId);
      mirrors = new RepositoryMirrors(fixture.root);
      trees = new DemandWorktrees(fixture.root, mirrors);
      await writeFile(join(fixture.work, 'sample.txt'), 'frozen baseline\n');
      await fixtureGit(['-C', fixture.work, 'add', '--', 'sample.txt']);
      await fixture.commit();
      await fixture.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
        ...entry,
        branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
        worktreePath: 'worktrees/' + entry.repositoryId,
        gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
      }));
      await trees.prepare(projectId, requirementId, plan);
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [requirementId, JSON.stringify(plan)],
      );
      scope = await trees.executionScope(projectId, requirementId, plan, 'app');
      gitPath = (
        await exec('/usr/bin/which', ['git'], { encoding: 'utf8' })
      ).stdout.trim();
      // Arm the authority owner with the ticket digest, then acquire
      // (the app role admits through the armed ticket, per the owner
      // fixture discipline).
      const ticketDigest = createHash('sha256').update(ticket).digest('hex');
      const armed = await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
        [ticketDigest],
      );
      expect(armed.rowCount).toBe(1);
      owned = (await acquireAuthority(database.pool, true, ticket))!;
      if (!owned) throw new Error('The fixture database has no managed owner');
      broker = createOwnedWriteHandoff(
        database,
        owned,
        trees,
        gitPath,
        undefined,
        () => false,
        true,
        true,
      );
      const grant = await broker.acquire(writer, randomUUID());
      generation = grant.generation;
      contextVersion = grant.contextVersion;
    });

    afterAll(async () => {
      try {
        await broker?.close();
      } finally {
        await database?.pool.end().catch(() => {});
        await lab?.close();
      }
    });

    test('C1-C5/S1-S4: a selected-scope commit lands supervised, is read back and recorded as an immutable snapshot', async () => {
      if (!scope || !plan || !database) throw new Error('fixture missing');
      const before = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      await writeFile(
        join(scope.tree, 'sample.txt'),
        'committed by the controlled chain\n',
      );
      const output = await commitWith({
        tool: 'git',
        operation: 'commit',
        paths: ['sample.txt'],
        message: 'controlled commit\n',
        identity,
      });
      expect(output.state).toBe('ok');
      expect(output.outcome).toBe('finished');
      const commit = output.commit;
      expect(commit).toBeDefined();
      const after = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      expect(commit!.head).toBe(after);
      expect(after).not.toBe(before);
      expect(commit!.parent).toBe(before);
      expect(commit!.messageSha256).toBe(
        createHash('sha256').update('controlled commit\n').digest('hex'),
      );
      expect(commit!.paths).toEqual([
        {
          path: 'sample.txt',
          type: 'M',
          digest: createHash('sha256')
            .update('committed by the controlled chain\n')
            .digest('hex'),
        },
      ]);
      // S1: the read-back recorded the true commit; the worktree is clean.
      expect(output.snapshot).toMatchObject({
        requirementId,
        repositoryId: 'app',
        snapshotSeq: 1,
        commitHash: after,
      });
      const recorded = await database.pool.query<{
        commit_hash: string;
        parent_head: string;
        base_commit: string;
        paths: { path: string; type: string; digest: string | null }[];
        content_digest: string;
        message_sha256: string;
        command_id: string;
        committed_by: string;
        generation: string;
      }>(
        "select commit_hash,parent_head,base_commit,paths,content_digest,message_sha256,command_id,committed_by,generation from requirement_delivery_snapshot where repository_id = 'app' and commit_hash = $1",
        [after],
      );
      expect(recorded.rows).toHaveLength(1);
      const row = recorded.rows[0]!;
      expect(row.parent_head).toBe(before);
      expect(row.base_commit).toBe(plan[0]!.baseCommit);
      expect(row.command_id).toBe(output.snapshot!.commandId);
      expect(row.committed_by).toBe(writer!.who.userId);
      expect(row.generation).toBe(generation);
      expect(deliveryContentDigest(row.paths)).toBe(row.content_digest);
      // C5/E1: the write.execute receipt of the same commandId exists.
      const receipts = await database.pool.query<{ result: unknown }>(
        "select result from command_receipt where operation = 'write.execute' and command_id = $1",
        [row.command_id],
      );
      expect(receipts.rows).toHaveLength(1);
      // S4: the head read-back query ran its own receipt under the same
      // command id key namespace; the index is clean for the list.
      expect(await worktreeStatus()).toEqual([]);
    });

    test('S1 原键回查: the same commit replay answers the original row without a new sequence', async () => {
      if (!database || !writer) throw new Error('fixture missing');
      const [row] = (
        await database.pool.query<{
          commit_hash: string;
          command_id: string;
          paths: { path: string; type: string; digest: string | null }[];
        }>(
          "select commit_hash, command_id, paths from requirement_delivery_snapshot where repository_id = 'app' order by snapshot_seq limit 1",
        )
      ).rows;
      expect(row).toBeDefined();
      const holder = writer;
      const replay = await database.db.transaction(async (tx) => {
        const { recordDeliverySnapshotRow } =
          await import('../../apps/server/src/modules/delivery-snapshot.ts');
        return recordDeliverySnapshotRow(tx, {
          requirementId: holder.requirementId,
          repositoryId: 'app',
          commitHash: row!.commit_hash,
          parentHead: row!.commit_hash,
          baseCommit: row!.commit_hash,
          paths: row!.paths,
          messageSha256: 'a'.repeat(64),
          commandId: row!.command_id,
          committedBy: holder.who.userId,
          generation: generation,
        });
      });
      expect(replay.replay).toBe(true);
      expect(replay.snapshot.snapshotSeq).toBe(1);
      // A different command under the same commit is a conflict.
      await expect(
        database.db.transaction(async (tx) => {
          const { recordDeliverySnapshotRow } =
            await import('../../apps/server/src/modules/delivery-snapshot.ts');
          return recordDeliverySnapshotRow(tx, {
            requirementId: holder.requirementId,
            repositoryId: 'app',
            commitHash: row!.commit_hash,
            parentHead: row!.commit_hash,
            baseCommit: row!.commit_hash,
            paths: [{ path: 'sample.txt', type: 'M', digest: null }],
            messageSha256: 'a'.repeat(64),
            commandId: randomUUID(),
            committedBy: holder.who.userId,
            generation: generation,
          });
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    test('N2: a staged file outside the list is refused with zero commit and the list index restored', async () => {
      if (!scope) throw new Error('fixture missing');
      const before = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      await writeFile(join(scope.tree, 'sample.txt'), 'second change\n');
      await writeFile(join(scope.tree, 'extra.txt'), 'outside the list\n');
      await fixtureGit(['-C', scope.tree, 'add', '--', 'extra.txt']);
      const output = await commitWith({
        tool: 'git',
        operation: 'commit',
        paths: ['sample.txt'],
        message: 'must be refused\n',
        identity,
      });
      expect(output.state).toBe('failed');
      expect(output.outcome).toBe('refused');
      expect(output.reason).toBe('commit-refused:staged-set-mismatch');
      expect(output.commit).toBeUndefined();
      expect(output.snapshot).toBeUndefined();
      // Zero commit; the outside-of-list staged state is preserved and
      // the list's own add is rolled back.
      expect(
        (await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])).trim(),
      ).toBe(before);
      const status = (
        await fixtureGit(['-C', scope.tree, 'status', '--porcelain'])
      )
        .trim()
        .split('\n')
        .sort();
      expect(status).toEqual(['A  extra.txt', ' M sample.txt'].sort());
      await fixtureGit(['-C', scope.tree, 'reset', '-q', '--', 'extra.txt']);
    });

    test('N2 变体: an AM out-of-list entry counts as staged and is refused', async () => {
      if (!scope) throw new Error('fixture missing');
      const before = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      await writeFile(join(scope.tree, 'sample.txt'), 'am list change\n');
      // The out-of-list file is staged and then modified again: its
      // porcelain entry is 'AM' — staged half plus a newer worktree edit.
      await writeFile(join(scope.tree, 'extra.txt'), 'am extra\n');
      await fixtureGit(['-C', scope.tree, 'add', '--', 'extra.txt']);
      await writeFile(join(scope.tree, 'extra.txt'), 'am extra modified\n');
      const output = await commitWith({
        tool: 'git',
        operation: 'commit',
        paths: ['sample.txt'],
        message: 'am variant must be refused\n',
        identity,
      });
      // The staged half of the 'AM' entry is exactly what a commit would
      // take: the fence must count it (first-column judgment) and refuse.
      expect(output.state).toBe('failed');
      expect(output.outcome).toBe('refused');
      expect(output.reason).toBe('commit-refused:staged-set-mismatch');
      expect(output.snapshot).toBeUndefined();
      expect(
        (await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])).trim(),
      ).toBe(before);
      // The list's own add is restored; the out-of-list entry keeps its
      // staged half and its newer worktree edit ('AM' preserved).
      expect(await worktreeStatus()).toEqual([' M sample.txt', 'AM extra.txt']);
      await fixtureGit(['-C', scope.tree, 'reset', '-q', '--', 'extra.txt']);
    });
    test('N9/B3: a repository with a filter driver defined is refused closed with zero commit', async () => {
      if (!scope) throw new Error('fixture missing');
      const before = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      // The repo declares a filter in .gitattributes (git-lfs style);
      // the store configuration stays exactly the platform's bare
      // config, so the refusal must come from the commit pre-check.
      await writeFile(
        join(scope.tree, '.gitattributes'),
        '*.bin filter=lfs diff=lfs merge=lfs\n',
      );
      await writeFile(join(scope.tree, 'sample.txt'), 'filter change\n');
      const output = await commitWith({
        tool: 'git',
        operation: 'commit',
        paths: ['sample.txt'],
        message: 'filter repo\n',
        identity,
      });
      expect(output.state).toBe('failed');
      expect(output.outcome).toBe('refused');
      // The refusal names the declared filter attribute, the repo-wide
      // attributes check of the fixed worker.
      expect(output.reason).toBe('commit-refused:attribute-filter');
      expect(output.snapshot).toBeUndefined();
      expect(
        (await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])).trim(),
      ).toBe(before);
      // The file value and the index are unchanged (no add residue);
      // extra.txt from the previous counter-example stays untracked.
      expect(await worktreeStatus()).toEqual([
        ' M sample.txt',
        '?? .gitattributes',
        '?? extra.txt',
      ]);
      await unlink(join(scope.tree, '.gitattributes'));
    });

    test('N6/C5: a generation that is not the confirmed holding executes nothing', async () => {
      if (!scope) throw new Error('fixture missing');
      const before = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      await writeFile(join(scope.tree, 'sample.txt'), 'unauthorized\n');
      const output = await commitWith(
        {
          tool: 'git',
          operation: 'commit',
          paths: ['sample.txt'],
          message: 'wrong generation\n',
          identity,
        },
        { grantGeneration: randomUUID() },
      );
      expect(output.state).toBe('denied');
      // Zero permit, zero placeholder, zero start: the reservation was
      // refused and nothing was written.
      expect(output.snapshot).toBeUndefined();
      expect(output.outcome).toBe('refused');
      expect(
        (await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])).trim(),
      ).toBe(before);
      expect(await worktreeStatus()).toEqual([' M sample.txt', '?? extra.txt']);
    });

    test('N4/S2: the application role cannot update or delete the snapshots', async () => {
      if (!lab || !database) throw new Error('fixture missing');
      for (const table of [
        'requirement_delivery_snapshot',
        'requirement_delivery_merge',
      ]) {
        const privileges = await database.pool.query<{
          update: boolean;
          delete: boolean;
          insert: boolean;
          select: boolean;
        }>(
          "select has_table_privilege($1, 'UPDATE') update, has_table_privilege($1, 'DELETE') delete, has_table_privilege($1, 'INSERT') insert, has_table_privilege($1, 'SELECT') select",
          [table],
        );
        expect(privileges.rows[0]).toEqual({
          update: false,
          delete: false,
          insert: true,
          select: true,
        });
        await expect(
          database.pool.query(`update ${table} set recorded_at = now()`),
        ).rejects.toThrow(/permission denied/);
        await expect(
          database.pool.query(`delete from ${table}`),
        ).rejects.toThrow(/permission denied/);
      }
    });

    test('S3: the anchor check recomputes the content digest read-only and detects tampering', async () => {
      if (!database) throw new Error('fixture missing');
      const rows = await database.pool.query<{
        paths: { path: string; type: string; digest: string | null }[];
        content_digest: string;
      }>('select paths, content_digest from requirement_delivery_snapshot');
      expect(rows.rows.length).toBeGreaterThan(0);
      for (const row of rows.rows) {
        const stored = { paths: row.paths, contentDigest: row.content_digest };
        expect(verifyDeliveryAnchor(stored).matches).toBe(true);
        expect(
          verifyDeliveryAnchor({
            ...stored,
            paths: [
              ...stored.paths,
              { path: 'sample.txt', type: 'M', digest: null },
            ],
          }).matches,
        ).toBe(false);
      }
    });

    test('A4/S1: the merge table exists, stays empty for T09 and is append-only', async () => {
      if (!lab || !database) throw new Error('fixture missing');
      expect(
        (
          await database.pool.query<{ present: boolean }>(
            "select to_regclass('public.requirement_delivery_merge') is not null as present",
          )
        ).rows[0]!.present,
      ).toBe(true);
      expect(
        (
          await database.pool.query<{ count: string }>(
            'select count(*) from requirement_delivery_merge',
          )
        ).rows[0]!.count,
      ).toBe('0');
      // The record structure is usable (a snapshot reference with the
      // merge hashes) while the role still cannot rewrite it.
      const snapshot = await database.pool.query<{ seq: number }>(
        "select snapshot_seq as seq from requirement_delivery_snapshot where repository_id = 'app' order by snapshot_seq desc limit 1",
      );
      expect(snapshot.rows.length).toBeGreaterThan(0);
      await database.db.transaction(async (tx) => {
        await tx.insert(schema.requirementDeliveryMerge).values({
          requirementId,
          repositoryId: 'app',
          snapshotSeq: snapshot.rows[0]!.seq,
          environment: 'staging',
          cherryPickCommit: 'a'.repeat(40),
        });
      });
      await expect(
        database.pool.query(
          'update requirement_delivery_merge set merge_commit = $1',
          ['b'.repeat(40)],
        ),
      ).rejects.toThrow(/permission denied/);
    });

    test('隔离库升级: the migration re-runs cleanly over the upgraded test database', async () => {
      if (!lab) throw new Error('fixture missing');
      const rerun = await lab.migrate();
      expect(rerun.stdout).toContain('Migrations applied');
    });
  },
);

test('N7/N8/C1: the shared commit shape refuses traversal, protected locations, extra keys and out-of-bounds values', () => {
  const good = {
    operation: 'commit',
    paths: ['src/a.txt'],
    message: 'ok',
  };
  expect(gitCommitArguments(good)).toEqual({
    paths: ['src/a.txt'],
    message: 'ok',
  });
  expect(writeToolArguments('git', good)).toBe(true);
  const bad: Record<string, unknown>[] = [
    { ...good, extra: 1 },
    { ...good, paths: [] },
    { ...good, paths: ['..'] },
    { ...good, paths: ['a/../../b'] },
    { ...good, paths: ['/etc/passwd'] },
    { ...good, paths: ['.git/config'] },
    { ...good, paths: ['.rdws-read/x'] },
    { ...good, paths: ['.env'] },
    { ...good, paths: ['a.txt', 'a.txt'] },
    { ...good, message: 'x'.repeat(gitCommitMessageLimit + 1) },
    { ...good, message: 3 },
    { ...good, paths: 'a.txt' },
    { operation: 'commit', paths: ['a.txt'] },
    {},
    {
      operation: 'commit',
      paths: Array.from({ length: gitCommitPathsLimit + 1 }, (_, i) => 'p' + i),
      message: 'x',
    },
  ];
  for (const input of bad) {
    expect(gitCommitArguments(input)).toBe(false);
    expect(writeToolArguments('git', input)).toBe(false);
  }
  // The read-only git operations keep their shape.
  expect(writeToolArguments('git', { operation: 'status' })).toBe(true);
  expect(writeToolArguments('git', { operation: 'head' })).toBe(false);
});

describe.runIf(process.platform === 'darwin')(
  '§11.23 C3: the T06 admission of commit requests',
  () => {
    test('N7/N8: T06 rejects commit requests the shared shape refuses', async () => {
      const verified = async () => {
        throw new Error('must not be reached');
      };
      const badRequests = [
        {
          tool: 'git',
          operation: 'commit',
          paths: ['../escape'],
          message: 'x',
          identity: { name: 'a', email: 'b' },
        },
        {
          tool: 'git',
          operation: 'commit',
          paths: [],
          message: 'x',
          identity: { name: 'a', email: 'b' },
        },
        {
          tool: 'git',
          operation: 'commit',
          paths: ['a.txt'],
          message: 'x'.repeat(gitCommitMessageLimit + 1),
          identity: { name: 'a', email: 'b' },
        },
        {
          tool: 'git',
          operation: 'commit',
          paths: ['a.txt'],
          message: 'x',
        },
      ] as unknown as ExecutionRequest[];
      for (const request of badRequests) {
        const result = await runMacosWorktree(
          verified,
          '/usr/bin/git',
          request,
        );
        expect(result.status).toBe('rejected');
      }
    });
  },
);
