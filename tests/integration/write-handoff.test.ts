import { execFileSync } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connectDatabase, schema } from '@rdws/db';
import { eq, sql } from 'drizzle-orm';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { Pool, type PoolClient } from 'pg';
import { expect, test, vi } from 'vitest';
import { createWriteHandoff } from '../../apps/server/src/modules/write-handoff.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';

type FinalReadGate = { pid?: number; wait: Promise<void>; release: () => void };

function controlledCommits() {
  let next:
    | {
        lose: boolean;
        rollBackSettlement?: true;
        entered: boolean;
        wait: Promise<void>;
        release: () => void;
      }
    | undefined;
  let finalRead: FinalReadGate | undefined;
  const original = Pool.prototype.connect;
  const spy = vi.spyOn(Pool.prototype, 'connect').mockImplementation(function (
    this: Pool,
    ...args: unknown[]
  ) {
    const connection = Reflect.apply(original, this, args);
    if (args.length) return connection;
    return connection.then((client: PoolClient) => {
      const query = client.query;
      let brokerTransaction = false;
      let completingExecution = false;
      client.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as
          string | { text: string; values?: unknown[] };
        const sql = typeof input === 'string' ? input : input.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof input === 'string'
            ? []
            : input.values;
        if (sql?.includes("transaction_timeout='2400ms'"))
          brokerTransaction = true;
        if (
          sql?.startsWith('update "command_receipt"') &&
          values?.some(
            (value) =>
              typeof value === 'string' &&
              value.startsWith('{"status":"finished","runId":'),
          )
        )
          completingExecution = true;
        if (
          brokerTransaction &&
          finalRead &&
          sql?.includes('from "requirement_write_lease"') &&
          sql.endsWith('for update')
        ) {
          const gate = finalRead;
          finalRead = undefined;
          return Reflect.apply(query, client, parameters).then(
            async (result: unknown) => {
              const backend = (await Reflect.apply(query, client, [
                'select pg_backend_pid() as pid',
              ])) as { rows: { pid: number }[] };
              gate.pid = backend.rows[0]?.pid;
              await gate.wait;
              return result;
            },
          );
        }
        if (sql === 'commit' || sql === 'rollback') client.query = query;
        if (
          sql === 'commit' &&
          brokerTransaction &&
          next &&
          (!next.rollBackSettlement || completingExecution)
        ) {
          const gate = next;
          next = undefined;
          return Reflect.apply(
            query,
            client,
            gate.rollBackSettlement ? ['rollback'] : parameters,
          ).then(async (result: unknown) => {
            gate.entered = true;
            if (gate.lose) throw new Error('Synthetic commit response lost');
            await gate.wait;
            return result;
          });
        }
        return Reflect.apply(query, client, parameters);
      }) as typeof query;
      return client;
    });
  } as typeof original);
  return {
    arm(lose = true, rollBackSettlement?: true) {
      if (next) throw new Error('A commit gate is already armed');
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (rollBackSettlement) release();
      return (next = {
        lose,
        rollBackSettlement,
        entered: false,
        wait,
        release,
      });
    },
    holdFinalRead(): FinalReadGate {
      if (finalRead) throw new Error('A final read is already armed');
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return (finalRead = { wait, release });
    },
    restore: () => spy.mockRestore(),
  };
}

test.skipIf(process.platform !== 'darwin')(
  'one qualified session can write until its execution stops, then the next session writes',
  async () => {
    const lab = await authorityDatabase();
    const projectId = 'poc';
    const requirementId = randomUUID();
    const ticket = randomBytes(32).toString('hex');
    let fixture: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let mirrors: RepositoryMirrors | undefined;
    let trees: DemandWorktrees | undefined;
    let broker: Awaited<ReturnType<typeof createWriteHandoff>> | undefined;
    const database = connectDatabase(lab.databaseUrl);
    const commits = controlledCommits();
    try {
      await lab.owner.query(
        "insert into project (id,name) values ($1,'Write fixture')",
        [projectId],
      );
      async function account(name: string, role: string) {
        const userId = randomUUID();
        const authSessionId = randomUUID();
        await lab.owner.query(
          'insert into auth_user (id,name,email,username,active) values ($1,$2,$3,$2,true)',
          [userId, name, name + '@fixture.invalid'],
        );
        await lab.owner.query(
          "insert into auth_session (id,user_id,token,auth_epoch,expires_at) values ($1,$2,$3,0,now()+interval '10 minutes')",
          [authSessionId, userId, randomUUID()],
        );
        await lab.owner.query('insert into project_member values ($1,$2,$3)', [
          projectId,
          userId,
          role,
        ]);
        return {
          who: { userId, authSessionId },
          sessionId: randomUUID(),
          projectId,
          requirementId,
          role,
        };
      }
      const lead = await account('lead', 'developer');
      const worker = await account('worker', 'developer');
      const unassigned = await account('unassigned', 'developer');
      const tester = await account('tester', 'tester');
      const administrator = await account('administrator', 'project_admin');
      const alternateLogins = new Map<string, string>();
      for (const { who } of [lead, worker]) {
        const alternate = randomUUID();
        alternateLogins.set(who.userId, alternate);
        await lab.owner.query(
          "insert into auth_session (id,user_id,token,auth_epoch,expires_at) values ($1,$2,$3,0,now()+interval '10 minutes')",
          [alternate, who.userId, randomUUID()],
        );
      }
      await lab.owner.query(
        "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by,background) values ($1,$2,'Write fixture','','',$3,$3,$4)",
        [
          requirementId,
          projectId,
          lead.who.userId,
          'Broker background fixture',
        ],
      );
      for (const actor of [lead, worker, unassigned, tester, administrator]) {
        await lab.owner.query(
          'insert into native_session (id,requirement_id,owner_id) values ($1,$2,$3)',
          [actor.sessionId, requirementId, actor.who.userId],
        );
        if (actor.role !== 'project_admin')
          await lab.owner.query(
            'insert into requirement_participant values ($1,$2,$3)',
            [requirementId, actor.who.userId, actor.role],
          );
      }
      const differentRequirement = randomUUID();
      const differentSession = randomUUID();
      await lab.owner.query(
        "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by) values ($1,$2,'Other demand','','',$3,$3)",
        [differentRequirement, projectId, lead.who.userId],
      );
      await lab.owner.query(
        'insert into native_session (id,requirement_id,owner_id) values ($1,$2,$3)',
        [differentSession, differentRequirement, lead.who.userId],
      );
      const taskId = randomUUID();
      await lab.owner.query(
        "insert into task (id,requirement_id,title,assignee_id,created_by,status) values ($1,$2,'Synthetic assignment',$3,$4,'in_progress')",
        [taskId, requirementId, worker.who.userId, lead.who.userId],
      );

      fixture = await httpsGitFixture(projectId);
      mirrors = new RepositoryMirrors(fixture.root);
      trees = new DemandWorktrees(fixture.root, mirrors);
      await writeFile(join(fixture.work, 'sample.txt'), 'isolated baseline');
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
      const plan = (await mirrors.captureBaselines(projectId)).map((entry) => ({
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
      const scope = await trees.executionScope(
        projectId,
        requirementId,
        plan,
        'app',
      );
      const path = join(scope.tree, 'sample.txt');
      const protectedPaths = [
        join(
          scope.runtimeRoot,
          'projects',
          projectId,
          'sources',
          'app.git',
          'HEAD',
        ),
        join(scope.store, 'config'),
        join(scope.tree, '.git'),
      ];
      const protectedContents = await Promise.all(
        protectedPaths.map((file) => readFile(file, 'utf8')),
      );

      await lab.owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton',
        [createHash('sha256').update(ticket).digest('hex')],
      );
      const git = execFileSync('/usr/bin/which', ['git'], {
        encoding: 'utf8',
      }).trim();
      await lab.owner.query(
        'alter table task disable trigger rdws_authority_writer',
      );
      try {
        await expect(
          createWriteHandoff(lab.databaseUrl, ticket, trees, git),
        ).rejects.toThrow('database protection');
      } finally {
        await lab.owner.query(
          'alter table task enable always trigger rdws_authority_writer',
        );
      }
      const active = await createWriteHandoff(
        lab.databaseUrl,
        ticket,
        trees,
        git,
      );
      broker = active;
      for (const denied of [
        unassigned,
        tester,
        administrator,
        { ...lead, sessionId: worker.sessionId },
        { ...lead, sessionId: differentSession },
      ])
        await expect(
          active.acquire(denied, randomUUID()),
        ).rejects.toMatchObject({ statusCode: 403 });

      const candidates = [lead, worker];
      const candidateIds = candidates.map(() => randomUUID());
      const outcomes = await Promise.allSettled(
        candidates.map((actor, index) =>
          active.acquire(actor, candidateIds[index]!),
        ),
      );
      const winningIndex = outcomes.findIndex(
        ({ status }) => status === 'fulfilled',
      );
      expect(
        outcomes.filter(({ status }) => status === 'fulfilled'),
      ).toHaveLength(1);
      const winning = outcomes[winningIndex]!;
      if (winning.status !== 'fulfilled')
        throw new Error('No writer was acquired');
      const writer = candidates[winningIndex]!;
      const next = candidates[1 - winningIndex]!;
      const { generation } = winning.value;
      const alternate = {
        ...writer,
        who: {
          ...writer.who,
          authSessionId: alternateLogins.get(writer.who.userId)!,
        },
      };
      await expect(
        active.acquire(alternate, candidateIds[winningIndex]!),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(winning.value.tasks).toMatchObject([
        { id: taskId, assigneeId: worker.who.userId },
      ]);
      expect(winning.value.requirement).not.toHaveProperty('background');
      const currentRows = () =>
        database.pool.query(
          'select generation,phase,run_id from requirement_write_lease where requirement_id=$1',
          [requirementId],
        );
      expect((await currentRows()).rows).toEqual([
        { generation, phase: 'held', run_id: null },
      ]);

      const input = {
        generation,
        commandId: randomUUID(),
        repositoryId: 'app',
        request: {
          tool: 'shell' as const,
          script:
            'printf old > sample.txt; printf started; while :; do :; done',
        },
      };
      let started = false;
      const running = active.execute(writer, input, () => {
        started = true;
      });
      void running.catch(() => {});
      await expect.poll(() => started).toBe(true);
      expect(await readFile(path, 'utf8')).toBe('old');
      expect((await currentRows()).rows[0]?.run_id).toBeTruthy();
      await expect(active.acquire(next, randomUUID())).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(
        active.release(next, generation, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 409 });

      const releaseId = randomUUID();
      const missingRelease = commits.arm();
      await expect(
        active.release(writer, generation, releaseId),
      ).rejects.toThrow('commit could not be confirmed');
      expect(missingRelease.entered).toBe(true);
      const firstReceipt = await running;
      expect(firstReceipt).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed', marker: 'released' },
      });
      expect((await currentRows()).rows).toEqual([
        { generation, phase: 'released', run_id: null },
      ]);
      expect(await active.release(writer, generation, releaseId)).toBe(
        'released',
      );
      await expect(active.execute(alternate, input)).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(
        active.release(alternate, generation, releaseId),
      ).rejects.toMatchObject({ statusCode: 409 });

      const secondId = randomUUID();
      const missingAcquisition = commits.arm();
      await expect(active.acquire(next, secondId)).rejects.toThrow(
        'commit could not be confirmed',
      );
      expect(missingAcquisition.entered).toBe(true);
      const second = await active.acquire(next, secondId);
      expect(second.generation).not.toBe(generation);
      expect(await active.execute(writer, input)).toEqual(firstReceipt);
      await expect(
        active.execute(writer, {
          ...input,
          request: { tool: 'shell', script: 'exit 1' },
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      const file = {
        generation: second.generation,
        commandId: randomUUID(),
        repositoryId: 'app',
        request: {
          tool: 'file' as const,
          operation: 'write' as const,
          path: 'sample.txt',
          text: 'new',
        },
      };
      const firstChange = active.beginAuthorityChange(() => true);
      const secondChange = active.beginAuthorityChange(() => true);
      firstChange.rolledBack();
      await expect(active.execute(next, file)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(await readFile(path, 'utf8')).toBe('old');
      secondChange.rolledBack();
      const neverStarted = {
        ...file,
        commandId: randomUUID(),
        request: { ...file.request, text: 'unexpected' },
      };
      const missingReservation = commits.arm();
      await expect(active.execute(next, neverStarted)).rejects.toThrow(
        'commit could not be confirmed',
      );
      expect(missingReservation.entered).toBe(true);
      expect(await active.execute(next, neverStarted)).toMatchObject({
        status: 'finished',
        result: { stop: 'not-started' },
      });
      expect(await readFile(path, 'utf8')).toBe('old');
      expect(await active.execute(next, file)).toMatchObject({
        status: 'finished',
        result: { status: 'ok', stop: 'confirmed' },
      });
      expect(await readFile(path, 'utf8')).toBe('new');
      const settlementFile = join(scope.tree, 'settlement.txt');
      const settlementRequest = {
        ...input,
        generation: second.generation,
        commandId: randomUUID(),
        request: {
          tool: 'shell' as const,
          script: 'printf once >> settlement.txt',
        },
      };
      const rolledBackSettlement = commits.arm(false, true);
      await expect(active.execute(next, settlementRequest)).rejects.toThrow(
        'transaction rolled back',
      );
      expect(rolledBackSettlement.entered).toBe(true);
      expect(await readFile(settlementFile, 'utf8')).toBe('once');
      expect((await currentRows()).rows[0]?.run_id).toBeTruthy();
      expect(await active.execute(next, settlementRequest)).toMatchObject({
        status: 'finished',
        result: { stop: 'confirmed' },
      });
      expect(await readFile(settlementFile, 'utf8')).toBe('once');
      expect((await currentRows()).rows[0]?.run_id).toBeNull();

      const verify = trees.executionScope.bind(trees);
      let launchCommit: ReturnType<typeof commits.arm> | undefined;
      const stageLaunch = vi
        .spyOn(trees, 'executionScope')
        .mockImplementationOnce(async (...args) => {
          const verified = await verify(...args);
          launchCommit = commits.arm();
          return verified;
        });
      const interruptedExecution = {
        ...input,
        generation: second.generation,
        commandId: randomUUID(),
        request: { tool: 'shell' as const, script: 'while :; do :; done' },
      };
      try {
        const uncertain = await active.execute(next, interruptedExecution);
        expect(launchCommit?.entered).toBe(true);
        expect(uncertain).toMatchObject({
          status: 'unknown',
          result: { stop: 'confirmed', status: 'aborted' },
        });
        expect(await active.execute(next, interruptedExecution)).toEqual(
          uncertain,
        );
        expect((await currentRows()).rows[0]?.run_id).toBeNull();
      } finally {
        stageLaunch.mockRestore();
      }
      await expect(
        lstat(join(scope.control, 'isolated-execution')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        await Promise.all(protectedPaths.map((file) => readFile(file, 'utf8'))),
      ).toEqual(protectedContents);

      let preflightChecked = false;
      let finishPreflight!: () => void;
      const preflight = new Promise<void>((resolve) => {
        finishPreflight = resolve;
      });
      const pausedScope = vi
        .spyOn(trees, 'executionScope')
        .mockImplementationOnce(async (...args) => {
          const verified = await verify(...args);
          preflightChecked = true;
          await preflight;
          return verified;
        });
      const queued = active.execute(next, {
        ...file,
        commandId: randomUUID(),
        request: { ...file.request, text: 'queued write must stay absent' },
      });
      void queued.catch(() => {});
      try {
        await expect.poll(() => preflightChecked).toBe(true);
        const releasing = active.release(next, second.generation, randomUUID());
        void releasing.catch(() => {});
        await expect
          .poll(async () => (await currentRows()).rows[0]?.phase)
          .toBe('draining');
        finishPreflight();
        expect(await releasing).toBe('released');
        expect(await queued).toMatchObject({
          status: 'finished',
          result: { stop: 'not-started' },
        });
        expect(await readFile(path, 'utf8')).toBe('new');
      } finally {
        finishPreflight();
        pausedScope.mockRestore();
      }

      const lateId = randomUUID();
      const lateCommit = commits.arm(false);
      const lostOrdering = active.acquire(next, lateId);
      void lostOrdering.catch(() => {});
      let latest: Awaited<ReturnType<typeof active.acquire>>;
      try {
        await expect.poll(() => lateCommit.entered).toBe(true);
        const repeated = await active.acquire(next, lateId);
        const prepareFinalRead = vi
          .spyOn(trees, 'executionScope')
          .mockImplementationOnce(async (...args) => {
            const verified = await verify(...args);
            finalGate = commits.holdFinalRead();
            return verified;
          });
        let finalGate: ReturnType<typeof commits.holdFinalRead> | undefined;
        const disconnected = active.execute(next, {
          ...file,
          generation: repeated.generation,
          commandId: randomUUID(),
          request: {
            ...file.request,
            text: 'stale authorization must not write',
          },
        });
        void disconnected.catch(() => {});
        try {
          await expect.poll(() => finalGate?.pid).toBeGreaterThan(0);
          const mutate = active.changeAuthority(
            randomUUID(),
            ({ requirementId: id }) => id === requirementId,
            async (tx) =>
              tx
                .update(schema.requirement)
                .set({
                  contextVersion: sql`${schema.requirement.contextVersion} + 1`,
                })
                .where(eq(schema.requirement.id, requirementId)),
            async (tx) => {
              const [row] = await tx
                .select({ version: schema.requirement.contextVersion })
                .from(schema.requirement)
                .where(eq(schema.requirement.id, requirementId));
              return row?.version === repeated.contextVersion + 1
                ? 'committed'
                : 'unknown';
            },
          );
          void mutate.catch(() => {});
          expect(
            (
              await lab.admin.query<{ stopped: boolean }>(
                'select pg_terminate_backend($1) as stopped',
                [finalGate!.pid],
              )
            ).rows[0]?.stopped,
          ).toBe(true);
          await expect
            .poll(
              async () =>
                (
                  await database.pool.query(
                    'select context_version from requirement where id=$1',
                    [requirementId],
                  )
                ).rows[0]?.context_version,
            )
            .toBe(repeated.contextVersion + 1);
          finalGate!.release();
          await mutate;
          expect(await disconnected).toMatchObject({
            status: 'finished',
            result: { stop: 'not-started' },
          });
          expect(await readFile(path, 'utf8')).toBe('new');
          expect((await currentRows()).rows[0]?.phase).toBe('released');
        } finally {
          finalGate?.release();
          prepareFinalRead.mockRestore();
        }
        latest = await active.acquire(writer, randomUUID());
        lateCommit.release();
        await expect(lostOrdering).rejects.toMatchObject({ statusCode: 409 });
        expect((await currentRows()).rows[0]?.generation).toBe(
          latest.generation,
        );
      } finally {
        lateCommit.release();
      }

      let secondRunStarted = false;
      const secondRun = active.execute(
        writer,
        {
          ...input,
          generation: latest.generation,
          commandId: randomUUID(),
          request: {
            tool: 'shell',
            script: 'printf ready; while :; do :; done',
          },
        },
        () => {
          secondRunStarted = true;
        },
      );
      void secondRun.catch(() => {});
      await expect.poll(() => secondRunStarted).toBe(true);
      const missingRevocation = commits.arm();
      const revocationId = randomUUID();
      let revocationReads = 0;
      await expect(
        active.changeAuthority(
          revocationId,
          ({ who }) => who.authSessionId === writer.who.authSessionId,
          async (tx) =>
            tx
              .delete(schema.session)
              .where(eq(schema.session.id, writer.who.authSessionId)),
          async (tx) => {
            if (++revocationReads === 1) {
              throw new Error('Synthetic first confirmation failure');
            }
            return (
              await tx
                .select({ id: schema.session.id })
                .from(schema.session)
                .where(eq(schema.session.id, writer.who.authSessionId))
            ).length === 0
              ? 'committed'
              : 'unknown';
          },
        ),
      ).rejects.toThrow('commit could not be confirmed');
      expect(missingRevocation.entered).toBe(true);
      expect(await secondRun).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      const reconciliation = commits.arm(false);
      const firstRead = active.reconcileAuthorityChange(revocationId);
      void firstRead.catch(() => {});
      try {
        await expect.poll(() => reconciliation.entered).toBe(true);
        const repeatedRead = active.reconcileAuthorityChange(revocationId);
        reconciliation.release();
        expect(await Promise.all([firstRead, repeatedRead])).toEqual([
          true,
          true,
        ]);
        expect(revocationReads).toBe(2);
      } finally {
        reconciliation.release();
      }
      expect((await currentRows()).rows).toEqual([
        { generation: latest.generation, phase: 'released', run_id: null },
      ]);
      await expect(active.acquire(writer, randomUUID())).rejects.toMatchObject({
        statusCode: 401,
      });

      await active.close();
      broker = undefined;
      const shortTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set ticket_digest=$1 where singleton and generation is null',
            [createHash('sha256').update(shortTicket).digest('hex')],
          )
        ).rowCount,
      ).toBe(1);
      const short = await createWriteHandoff(
        lab.databaseUrl,
        shortTicket,
        trees,
        git,
        1800,
      );
      broker = short;
      const timed = await short.acquire(next, randomUUID());
      let expiryRunStarted = false;
      const expiryRun = short.execute(
        next,
        {
          ...input,
          generation: timed.generation,
          commandId: randomUUID(),
          request: {
            tool: 'shell',
            script: 'printf running; while :; do :; done',
          },
        },
        () => {
          expiryRunStarted = true;
        },
      );
      void expiryRun.catch(() => {});
      await expect.poll(() => expiryRunStarted).toBe(true);
      expect(await expiryRun).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed' },
      });
      await expect
        .poll(async () => (await currentRows()).rows[0]?.phase)
        .toBe('released');

      const retained = await short.acquire(next, randomUUID());
      const marker = join(scope.control, 'isolated-execution');
      await mkdir(marker, { mode: 0o700 });
      await writeFile(
        join(marker, 'fixture'),
        'Synthetic stopped-but-retained marker',
      );
      const failed = await short.execute(next, {
        ...file,
        generation: retained.generation,
        commandId: randomUUID(),
        request: { ...file.request, text: 'must remain absent' },
      });
      expect(failed).toMatchObject({
        status: 'unknown',
        result: { stop: 'not-started', marker: 'retained' },
      });
      expect(await short.release(next, retained.generation, randomUUID())).toBe(
        'draining',
      );
      await expect(short.acquire(next, randomUUID())).rejects.toMatchObject({
        statusCode: 409,
      });
      const closing = short.close();
      expect(short.close()).toBe(closing);
      await expect(closing).rejects.toThrow('confirmed stopped');
      broker = undefined;

      const owner = (
        await lab.owner.query<{ generation: string }>(
          'select generation from rdws_authority.owner where singleton',
        )
      ).rows[0]!;
      expect(owner.generation).toBeTruthy();
      const coldTicket = randomBytes(32).toString('hex');
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set generation=null,proof_digest=null,ticket_digest=$1 where singleton and generation=$2',
            [
              createHash('sha256').update(coldTicket).digest('hex'),
              owner.generation,
            ],
          )
        ).rowCount,
      ).toBe(1);
      const cold = await createWriteHandoff(
        lab.databaseUrl,
        coldTicket,
        trees,
        git,
      );
      broker = cold;
      await expect(cold.acquire(next, randomUUID())).rejects.toMatchObject({
        statusCode: 409,
      });
      expect((await currentRows()).rows).toEqual([
        {
          generation: retained.generation,
          phase: 'draining',
          run_id: failed.runId,
        },
      ]);
      expect(await readFile(path, 'utf8')).toBe('new');
      expect(await readFile(join(marker, 'fixture'), 'utf8')).toBe(
        'Synthetic stopped-but-retained marker',
      );
    } finally {
      commits.restore();
      try {
        await broker?.close();
      } finally {
        await trees?.close();
        await mirrors?.close();
        await database.pool.end();
        await fixture?.close();
        await lab.close();
      }
    }
  },
  60_000,
);
