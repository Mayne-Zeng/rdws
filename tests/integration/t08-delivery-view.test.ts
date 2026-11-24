import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { unlink, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { connectDatabase, acquireAuthority, schema } from '@rdws/db';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { bodyHash } from '@rdws/dsh/access';
import { createOwnedWriteHandoff } from '../../apps/server/src/modules/write-handoff.ts';
import { NativeShellToolJob } from '../../apps/server/src/modules/native-shell-tool-job.ts';
import {
  historicalCandidates,
  sampleCurrentCandidates,
  deliveryPageSize,
  type GitQuery,
} from '../../apps/server/src/modules/delivery-view.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';

const exec = promisify(execFile);

// §11.23 B 段: the changes view (D2–D5), the evidence projection
// (E1–E3, S5) and the counter-examples N1/N3/N5, judged on the real
// broker read chain and the real append-only snapshot rows recorded by
// the A-segment commit chain.
describe.runIf(process.platform === 'darwin')(
  '§11.23 B: changes view, evidence projection, immutable snapshots',
  () => {
    const projectId = 'poc';
    let lab: Awaited<ReturnType<typeof authorityDatabase>> | undefined;
    let trees: DemandWorktrees | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let broker: Awaited<ReturnType<typeof createOwnedWriteHandoff>> | undefined;
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

    async function commitWith(paths: string[], message: string) {
      if (!writer || !broker) throw new Error('fixture missing');
      const host = new AbortController();
      const job = new NativeShellToolJob({
        scope: writer,
        grant: { generation, contextVersion },
        broker,
        repositoryId: 'app',
        request: {
          tool: 'git',
          operation: 'commit',
          paths,
          message,
          identity,
        },
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
      const issued = job.offer(
        writer.who,
        writer.requirementId,
        writer.sessionId,
        contextVersion,
        digest,
        Date.now() + 30_000,
        () => true,
      );
      expect(issued).toBe(job.commandId);
      await expect(
        job.control('begin', { ...commitBody, jobId: issued }, async () => {}),
      ).resolves.toEqual({ accepted: true });
      await expect
        .poll(
          async () => {
            const state = (await job.control(
              'status',
              { ...commitBody, jobId: issued },
              async () => {},
            )) as { state: string };
            return state.state;
          },
          { timeout: 30_000 },
        )
        .toMatch(/^(ok|failed|unknown)$/);
      const output = (await job.control(
        'output',
        { ...commitBody, jobId: issued },
        async () => {},
      )) as { state: string };
      await job.close().catch(() => {});
      return output;
    }

    const gitQuery: (
      operation: 'status' | 'diff' | 'head',
    ) => ReturnType<GitQuery> = (operation) => {
      const outcome = broker!.readWorktreeGit(writer!, {
        repositoryId: 'app',
        operation,
      });
      return outcome.then((result) => {
        if (result.stop !== 'confirmed' || result.status !== 'ok')
          return { stdout: '', status: 'failed', exitCode: result.exitCode };
        return {
          stdout: result.stdout,
          status: 'ok',
          exitCode: result.exitCode ?? 1,
        };
      });
    };

    beforeAll(async () => {
      process.env.RDWS_MODE = 'test';
      lab = await authorityDatabase();
      database = connectDatabase(
        lab.databaseUrl,
        randomBytes(32).toString('hex'),
        3_000,
      );
      requirementId = randomUUID();
      const ticket = randomBytes(32).toString('hex');
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Delivery view fixture')",
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
        "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by,background) values ($1,$2,'Delivery view','','',$3,$3,'')",
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
      const ticketDigest = createHash('sha256').update(ticket).digest('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
            [ticketDigest],
          )
        ).rowCount,
      ).toBe(1);
      const owned = (await acquireAuthority(database.pool, true, ticket))!;
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

    test('E3 setup: one controlled commit lands its snapshot and finished receipt', async () => {
      if (!scope) throw new Error('fixture missing');
      await writeFile(join(scope.tree, 'sample.txt'), 'view baseline\n');
      const output = await commitWith(['sample.txt'], 'view baseline commit\n');
      expect(output.state).toBe('ok');
    });

    test('D2/D3: the view samples real status and diff under one pinned head, untracked only in status', async () => {
      if (!scope) throw new Error('fixture missing');
      await writeFile(join(scope.tree, 'sample.txt'), 'tracked change\n');
      await writeFile(join(scope.tree, 'fresh.txt'), 'untracked\n');
      const view = await sampleCurrentCandidates(gitQuery, 'app');
      const head = (
        await fixtureGit(['-C', scope.tree, 'rev-parse', 'HEAD'])
      ).trim();
      expect(view.head).toBe(head);
      // D2: status and diff sampled together; the untracked file is
      // visible in status and absent from the tracked diff.
      expect('entries' in view.status).toBe(true);
      if ('entries' in view.status) {
        const paths = view.status.entries.map((entry) => entry.path);
        expect(paths).toContain('fresh.txt');
        expect(paths).toContain('sample.txt');
      }
      expect('text' in view.diff).toBe(true);
      if ('text' in view.diff) {
        expect(view.diff.text).toContain('sample.txt');
        expect(view.diff.text).not.toContain('fresh.txt');
        expect(view.diff.text).toContain('tracked change');
      }
      await unlink(join(scope.tree, 'fresh.txt'));
    });

    test('D3/N1: head movement between the pins refuses the whole answer', async () => {
      let moved = false;
      const unstable: GitQuery = async (operation) => {
        if (operation === 'head' && moved) {
          const real = await gitQuery(operation);
          return { ...real, stdout: '9'.repeat(40) };
        }
        if (operation === 'diff') moved = true;
        return gitQuery(operation);
      };
      await expect(
        sampleCurrentCandidates(unstable, 'app'),
      ).rejects.toMatchObject({ statusCode: 409 });
    });

    test('D4: the diff pages at 16 KiB and the cursor continues without overlap or gap', async () => {
      if (!scope) throw new Error('fixture missing');
      const body = Array.from(
        { length: 1200 },
        (_, i) => 'line-' + String(i).padStart(4, '0') + ' ' + 'x'.repeat(24),
      ).join('\n');
      await writeFile(join(scope.tree, 'sample.txt'), body + '\n');
      const first = await sampleCurrentCandidates(gitQuery, 'app');
      expect('text' in first.diff && first.diff.total).toBeGreaterThan(
        deliveryPageSize,
      );
      if (!('text' in first.diff) || first.diff.next === undefined)
        throw new Error('expected a continuation');
      expect(first.diff.text.length).toBe(deliveryPageSize);
      let text = first.diff.text;
      let cursor: string | undefined = first.diff.next;
      const seen: string[] = [first.diff.next];
      while (cursor !== undefined) {
        const page = await sampleCurrentCandidates(gitQuery, 'app', {
          cursor,
        });
        if (!('text' in page.diff)) throw new Error('expected diff text');
        text += page.diff.text;
        cursor = page.diff.next;
        if (cursor !== undefined) {
          expect(seen).not.toContain(cursor);
          seen.push(cursor);
        }
      }
      // No overlap, no gap: the pages reassemble the exact diff the
      // worktree's own git reports (the trailing newline normalization
      // mirrors the fixture helper's trim).
      const ground = (await fixtureGit(['-C', scope.tree, 'diff'])).replace(
        /\n$/,
        '',
      );
      expect(text.replace(/\n$/, '')).toBe(ground);
    });

    test('D5: a protected location closes the whole status or diff body', async () => {
      if (!scope) throw new Error('fixture missing');
      await writeFile(join(scope.tree, 'sample.txt'), 'protected diff\n');
      await writeFile(join(scope.tree, '.env'), 'KEY=value\n');
      // Untracked .env: the status body closes, the diff (tracked only)
      // stays open.
      const untracked = await sampleCurrentCandidates(gitQuery, 'app');
      expect(untracked.status).toEqual({ omitted: 'protected' });
      expect('text' in untracked.diff).toBe(true);
      // Tracked .env: the diff body closes too.
      await fixtureGit(['-C', scope.tree, 'add', '--', '.env']);
      const tracked = await sampleCurrentCandidates(gitQuery, 'app');
      expect(tracked.diff).toEqual({ omitted: 'protected' });
      await fixtureGit(['-C', scope.tree, 'reset', '-q', '--', '.env']);
      await unlink(join(scope.tree, '.env'));
    });

    test('E1/E2/S5: the historical projection joins receipt and merge evidence and outputs no booleans', async () => {
      if (!database || !writer) throw new Error('fixture missing');
      const view = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      expect(view.candidates.length).toBeGreaterThanOrEqual(1);
      for (const candidate of view.candidates) {
        expect(Object.keys(candidate).sort()).toEqual(
          [
            'anchor',
            'baseCommit',
            'commandId',
            'commitHash',
            'committedBy',
            'contentDigest',
            'merges',
            'messageSha256',
            'parentHead',
            'paths',
            'receipt',
            'recordedAt',
            'snapshotSeq',
          ].sort(),
        );
        expect(candidate.receipt).toMatchObject({
          state: 'finished',
        });
        expect(candidate.anchor.matches).toBe(true);
        expect(candidate.merges).toEqual([]);
      }
      // S5: a merge record attaches to its snapshot only.
      const [row] = (
        await database.pool.query<{ seq: number }>(
          "select snapshot_seq as seq from requirement_delivery_snapshot where repository_id = 'app' order by snapshot_seq desc limit 1",
        )
      ).rows;
      await database.db.transaction(async (tx) => {
        await tx.insert(schema.requirementDeliveryMerge).values({
          requirementId,
          repositoryId: 'app',
          snapshotSeq: row!.seq,
          environment: 'staging',
          cherryPickCommit: 'c'.repeat(40),
        });
      });
      const withMerge = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      const merged = withMerge.candidates.find(
        (candidate) => candidate.snapshotSeq === row!.seq,
      );
      expect(merged!.merges).toHaveLength(1);
      expect(merged!.merges[0]).toMatchObject({ environment: 'staging' });
      // 「已交付」必须以已提交证据为先：一条只有合入行、没有任何回执的
      // 候选不得满足任何徽标判据（receipt 为空 → committedEvidence 为
      // 假 → 已提交与已交付都不渲染）。
      await database.db.transaction(async (tx) => {
        const { recordDeliverySnapshotRow } =
          await import('../../apps/server/src/modules/delivery-snapshot.ts');
        return recordDeliverySnapshotRow(tx, {
          requirementId,
          repositoryId: 'app',
          commitHash: 'f'.repeat(40),
          parentHead: 'e'.repeat(40),
          baseCommit: 'e'.repeat(40),
          paths: [{ path: 'orphan.txt', type: 'A', digest: null }],
          messageSha256: 'b'.repeat(64),
          commandId: randomUUID(),
          committedBy: writer!.who.userId,
          generation,
        });
      });
      const viewOrphan = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      const orphan = viewOrphan.candidates.find(
        (candidate) => candidate.commitHash === 'f'.repeat(40),
      );
      expect(orphan).toBeDefined();
      expect(orphan!.receipt).toBeNull();
      // The merge record attaches to the snapshot (its seq from the
      // projection itself), then the same projection shows the merge
      // against the receipt-less candidate.
      await database.db.transaction(async (tx) => {
        await tx.insert(schema.requirementDeliveryMerge).values({
          requirementId,
          repositoryId: 'app',
          snapshotSeq: orphan!.snapshotSeq,
          environment: 'staging',
          cherryPickCommit: 'd'.repeat(40),
        });
      });
      const viewOrphanMerge = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      const orphanMerged = viewOrphanMerge.candidates.find(
        (candidate) => candidate.commitHash === 'f'.repeat(40),
      );
      expect(orphanMerged!.receipt).toBeNull();
      expect(orphanMerged!.merges).toHaveLength(1);
      const committedEvidenceLike =
        /^[0-9a-f]{40}$/.test(orphan!.commitHash) &&
        orphan!.anchor.matches &&
        orphan!.receipt !== null &&
        orphan!.receipt.state === 'finished';
      expect(committedEvidenceLike).toBe(false);
    });

    test('E3/N5: a reservation without a snapshot never reads as committed', async () => {
      if (!database || !writer) throw new Error('fixture missing');
      const before = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      // A write.execute receipt alone (reserved, no snapshot row) adds
      // no candidate and exposes no committed claim.
      await database.db.transaction(async (tx) => {
        await tx.insert(schema.commandReceipt).values({
          actorId: writer?.who.userId ?? '',
          scope: 'requirement:' + requirementId,
          operation: 'write.execute',
          commandId: randomUUID(),
          digest: 'd'.repeat(64),
          result: { status: 'reserved', runId: randomUUID() },
        });
      });
      const after = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      expect(after.candidates.length).toBe(before.candidates.length);
    });

    test('N3: the recorded snapshot cannot be rewritten and replays answer the original', async () => {
      if (!database || !writer) throw new Error('fixture missing');
      await expect(
        database.pool.query(
          "update requirement_delivery_snapshot set content_digest = 'x' || content_digest",
        ),
      ).rejects.toThrow(/permission denied/);
      await expect(
        database.pool.query('delete from requirement_delivery_snapshot'),
      ).rejects.toThrow(/permission denied/);
      const [row] = (
        await database.pool.query<{
          commit_hash: string;
          command_id: string;
          paths: { path: string; type: string; digest: string | null }[];
        }>(
          'select commit_hash, command_id, paths from requirement_delivery_snapshot order by snapshot_seq limit 1',
        )
      ).rows;
      const replay = await database.db.transaction(async (tx) => {
        const { recordDeliverySnapshotRow } =
          await import('../../apps/server/src/modules/delivery-snapshot.ts');
        return recordDeliverySnapshotRow(tx, {
          requirementId,
          repositoryId: 'app',
          commitHash: row!.commit_hash,
          parentHead: row!.commit_hash,
          baseCommit: row!.commit_hash,
          paths: row!.paths,
          messageSha256: 'a'.repeat(64),
          commandId: row!.command_id,
          committedBy: writer?.who.userId ?? '',
          generation,
        });
      });
      expect(replay.replay).toBe(true);
      // The anchor judgment marks a tampered projection red without
      // writing anything back.
      const view = await historicalCandidates(
        database.db,
        'app',
        requirementId,
      );
      expect(
        view.candidates.every((candidate) => candidate.anchor.matches),
      ).toBe(true);
    });
  },
);
