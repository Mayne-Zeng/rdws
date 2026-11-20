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

function expectOwnedShell(pid: number) {
  expect(pid).toBeGreaterThan(1);
  const [parent, group] = execFileSync(
    '/bin/ps',
    ['-o', 'ppid=', '-o', 'pgid=', '-p', String(pid)],
    { encoding: 'utf8' },
  )
    .trim()
    .split(/\s+/)
    .map(Number);
  expect(parent).toBe(process.pid);
  expect(group).toBe(pid);
}

async function isolatedShellPid(stdout: () => string) {
  await expect.poll(stdout).toMatch(/fixture-pid:[1-9][0-9]*\n/);
  const pid = Number(/fixture-pid:([1-9][0-9]*)\n/.exec(stdout())![1]);
  expectOwnedShell(pid);
  return pid;
}

function controlledCommits() {
  let next:
    | {
        lose: boolean;
        rollback?: 'settlement' | 'any';
        takeover?: {
          commandId: string;
          state: 'pending' | 'acquired' | 'reserved';
        };
        delayLoss?: true;
        entered: boolean;
        wait: Promise<void>;
        release: () => void;
      }
    | undefined;
  let finalRead: FinalReadGate | undefined;
  let settling:
    | {
        afterCommit: boolean;
        entered: boolean;
        wait: Promise<void>;
        release: () => void;
      }
    | undefined;
  let pausedSession: ReturnType<typeof pauseQuery> | undefined;
  let pausedReceipt:
    (ReturnType<typeof pauseQuery> & { commandId: string }) | undefined;
  let pausedPendingRead:
    (ReturnType<typeof pauseQuery> & { commandId: string }) | undefined;
  function pauseQuery() {
    let release!: () => void;
    const wait = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { entered: false, wait, release };
  }
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
      let matchingTakeover = false;
      let readingPending = false;
      let writingReceipt = false;
      client.query = ((...parameters: unknown[]) => {
        const input = parameters[0] as
          string | { text: string; values?: unknown[] };
        const sql = typeof input === 'string' ? input : input.text;
        const values = Array.isArray(parameters[1])
          ? parameters[1]
          : typeof input === 'string'
            ? []
            : input.values;
        const hold =
          sql?.startsWith('select "id" from "native_session"') && pausedSession
            ? pausedSession
            : sql?.startsWith('update "command_receipt"') &&
                pausedReceipt &&
                values?.includes(pausedReceipt.commandId)
              ? pausedReceipt
              : undefined;
        if (hold) {
          if (hold === pausedSession) pausedSession = undefined;
          else pausedReceipt = undefined;
          return Reflect.apply(query, client, parameters).then(
            async (result: unknown) => {
              hold.entered = true;
              await hold.wait;
              return result;
            },
          );
        }
        if (sql?.includes("synchronous_commit='on'")) brokerTransaction = true;
        if (sql?.startsWith('update "command_receipt"')) writingReceipt = true;
        if (
          pausedPendingRead &&
          sql?.startsWith('select ') &&
          sql.includes('from "command_receipt"') &&
          values?.includes(pausedPendingRead.commandId)
        )
          readingPending = true;
        if (
          next?.takeover &&
          sql?.startsWith('update "command_receipt"') &&
          values?.includes(next.takeover.commandId) &&
          values.some(
            (value) =>
              typeof value === 'string' &&
              value.startsWith(
                next!.takeover!.state === 'reserved'
                  ? '{"status":"reserved"'
                  : `{"state":"${next!.takeover!.state}"`,
              ),
          )
        )
          matchingTakeover = true;
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
          readingPending &&
          !writingReceipt &&
          pausedPendingRead
        ) {
          const gate = pausedPendingRead;
          pausedPendingRead = undefined;
          return Reflect.apply(query, client, parameters).then(
            async (result: unknown) => {
              gate.entered = true;
              await gate.wait;
              return result;
            },
          );
        }
        if (sql === 'commit' && completingExecution && settling) {
          const gate = settling;
          settling = undefined;
          if (gate.afterCommit)
            return Reflect.apply(query, client, parameters).then(
              async (result: unknown) => {
                gate.entered = true;
                await gate.wait;
                return result;
              },
            );
          gate.entered = true;
          return gate.wait.then(() => Reflect.apply(query, client, parameters));
        }
        if (
          sql === 'commit' &&
          brokerTransaction &&
          next &&
          (!next.takeover || matchingTakeover) &&
          (next.rollback !== 'settlement' || completingExecution)
        ) {
          const gate = next;
          next = undefined;
          return Reflect.apply(
            query,
            client,
            gate.rollback ? ['rollback'] : parameters,
          ).then(async (result: unknown) => {
            gate.entered = true;
            if (gate.delayLoss) await gate.wait;
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
    arm(lose = true, rollback?: 'settlement' | 'any') {
      if (next) throw new Error('A commit gate is already armed');
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (rollback) release();
      return (next = {
        lose,
        rollback,
        entered: false,
        wait,
        release,
      });
    },
    armTakeover(
      commandId: string,
      state: 'pending' | 'acquired' | 'reserved',
      rollback?: 'any',
      reply: 'lose' | 'hold' | 'hold-then-lose' = 'lose',
    ) {
      if (next) throw new Error('A commit gate is already armed');
      const pause = pauseQuery();
      return (next = {
        ...pause,
        lose: reply !== 'hold',
        ...(reply === 'hold-then-lose' && { delayLoss: true as const }),
        rollback,
        takeover: { commandId, state },
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
    holdSettlement(afterCommit = false) {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      return (settling = { afterCommit, entered: false, wait, release });
    },
    holdSession() {
      return (pausedSession = pauseQuery());
    },
    holdReceipt(commandId: string) {
      return (pausedReceipt = { ...pauseQuery(), commandId });
    },
    holdPendingRead(commandId: string) {
      return (pausedPendingRead = { ...pauseQuery(), commandId });
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
      await lab.owner.query(
        "insert into project_member values ($1,$2,'tester')",
        [projectId, unassigned.who.userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values ($1,$2,'tester')",
        [requirementId, unassigned.who.userId],
      );
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
      await lab.owner.query(
        "insert into requirement_participant values ($1,$2,'developer')",
        [differentRequirement, lead.who.userId],
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
      const siblingPlan = plan.map((entry) => ({
        ...entry,
        branch: 'rdws/' + differentRequirement + '/' + entry.repositoryId,
      }));
      await trees.prepare(projectId, differentRequirement, siblingPlan);
      await lab.owner.query(
        'insert into requirement_worktree_plan values ($1,$2)',
        [differentRequirement, JSON.stringify(siblingPlan)],
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
      const noTask = await active.acquire(unassigned, randomUUID());
      expect(noTask.generation).toEqual(expect.any(String));
      expect(noTask.tasks).toMatchObject([
        { id: taskId, assigneeId: worker.who.userId },
      ]);
      expect(
        await active.release(unassigned, noTask.generation, randomUUID()),
      ).toBe('released');
      for (const denied of [
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
      const originalAcquire = {
        type: 'acquire' as const,
        commandId: candidateIds[winningIndex]!,
      };
      expect(await active.checkCommand(writer, originalAcquire)).toEqual({
        state: 'recorded',
        generation,
      });
      await expect(
        active.checkCommand(alternate, originalAcquire),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        active.checkCommand(
          { ...next, sessionId: writer.sessionId },
          originalAcquire,
        ),
      ).rejects.toMatchObject({ statusCode: 403 });
      const siblingScope = {
        ...lead,
        who: {
          ...lead.who,
          authSessionId: alternateLogins.get(lead.who.userId)!,
        },
        requirementId: differentRequirement,
        sessionId: differentSession,
      };
      const firstSibling = await active.acquire(siblingScope, randomUUID());
      const siblingRelease = {
        type: 'release' as const,
        commandId: randomUUID(),
        generation: firstSibling.generation,
      };
      const releaseRollback = commits.arm(false, 'any');
      await expect(
        active.release(
          siblingScope,
          siblingRelease.generation,
          siblingRelease.commandId,
        ),
      ).rejects.toThrow('transaction rolled back');
      expect(releaseRollback.entered).toBe(true);
      expect(await active.checkCommand(siblingScope, siblingRelease)).toEqual({
        state: 'unrecorded',
      });
      active.assertWireLease(
        siblingScope,
        firstSibling.generation,
        firstSibling.contextVersion,
      );
      expect(
        await active.release(
          siblingScope,
          siblingRelease.generation,
          siblingRelease.commandId,
        ),
      ).toBe('released');
      const rolledBackAcquire = commits.arm(true, 'any');
      const siblingAcquire = {
        type: 'acquire' as const,
        commandId: randomUUID(),
      };
      await expect(
        active.acquire(siblingScope, siblingAcquire.commandId),
      ).rejects.toThrow('commit could not be confirmed');
      expect(rolledBackAcquire.entered).toBe(true);
      expect(await active.checkCommand(siblingScope, siblingAcquire)).toEqual({
        state: 'unrecorded',
      });
      await expect(
        active.acquire(siblingScope, randomUUID()),
      ).rejects.toMatchObject({ statusCode: 409 });
      const activeSibling = await active.acquire(
        siblingScope,
        siblingAcquire.commandId,
      );

      const cancelledWrite = {
        generation,
        commandId: randomUUID(),
        repositoryId: 'app',
        request: {
          tool: 'file' as const,
          operation: 'write' as const,
          path: 'sample.txt',
          text: 'cancelled write must stay absent',
        },
      };
      const reservation = commits.arm(false);
      const cancelReservation = new AbortController();
      const duringReservation = active.execute(
        writer,
        cancelledWrite,
        undefined,
        cancelReservation.signal,
      );
      void duringReservation.catch(() => {});
      try {
        await expect.poll(() => reservation.entered).toBe(true);
        const [reserved] = (await currentRows()).rows;
        expect(reserved).toMatchObject({ generation, phase: 'held' });
        expect(reserved?.run_id).toBeTruthy();
        cancelReservation.abort();
        reservation.release();
        const terminal = await duringReservation;
        expect(terminal).toMatchObject({
          runId: reserved!.run_id,
          status: 'finished',
          result: { status: 'aborted', stop: 'not-started', marker: 'none' },
        });
        expect(await active.execute(writer, cancelledWrite)).toEqual(terminal);
        expect(await readFile(path, 'utf8')).toBe('isolated baseline');
        expect((await currentRows()).rows).toEqual([
          { generation, phase: 'held', run_id: null },
        ]);
      } finally {
        reservation.release();
      }

      const alreadyAborted = { ...cancelledWrite, commandId: randomUUID() };
      const beforeSubmission = await active.execute(
        writer,
        alreadyAborted,
        undefined,
        AbortSignal.abort(),
      );
      expect(beforeSubmission).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'not-started', marker: 'none' },
      });
      expect(await active.execute(writer, alreadyAborted)).toEqual(
        beforeSubmission,
      );
      expect(await readFile(path, 'utf8')).toBe('isolated baseline');

      const verifyScope = trees.executionScope.bind(trees);
      let startGate: ReturnType<typeof commits.holdFinalRead> | undefined;
      const prepareStart = vi
        .spyOn(trees, 'executionScope')
        .mockImplementationOnce(async (...args) => {
          const verified = await verifyScope(...args);
          startGate = commits.holdFinalRead();
          return verified;
        });
      const cancelStart = new AbortController();
      const startInput = { ...cancelledWrite, commandId: randomUUID() };
      const startLocked = active.execute(
        writer,
        startInput,
        undefined,
        cancelStart.signal,
      );
      void startLocked.catch(() => {});
      try {
        await expect.poll(() => startGate?.pid).toBeGreaterThan(0);
        cancelStart.abort();
        startGate!.release();
        const terminal = await startLocked;
        expect(terminal).toMatchObject({
          status: 'finished',
          result: {
            status: 'aborted',
            stop: 'not-started',
            marker: 'released',
          },
        });
        expect(await active.execute(writer, startInput)).toEqual(terminal);
        expect(await readFile(path, 'utf8')).toBe('isolated baseline');
        expect((await currentRows()).rows).toEqual([
          { generation, phase: 'held', run_id: null },
        ]);
      } finally {
        startGate?.release();
        prepareStart.mockRestore();
      }

      const previous = new AbortController();
      const previousInput = {
        ...cancelledWrite,
        commandId: randomUUID(),
        request: { ...cancelledWrite.request, text: 'isolated baseline' },
      };
      const previousReceipt = await active.execute(
        writer,
        previousInput,
        undefined,
        previous.signal,
      );
      expect(previousReceipt).toMatchObject({
        status: 'finished',
        result: { status: 'ok', stop: 'confirmed' },
      });
      const cancelExecution = new AbortController();
      const executionInput = {
        ...cancelledWrite,
        commandId: randomUUID(),
        request: {
          tool: 'shell' as const,
          script: 'printf "fixture-pid:%s\\n" "$$"; while :; do :; done',
        },
      };
      let stdout = '';
      const execution = active.execute(
        writer,
        executionInput,
        ({ stream, chunk }) => {
          if (stream === 'stdout') stdout += chunk.toString();
        },
        cancelExecution.signal,
      );
      void execution.catch(() => {});
      try {
        const pid = await isolatedShellPid(() => stdout);
        const duplicate = new AbortController();
        await expect(
          active.execute(writer, executionInput, undefined, duplicate.signal),
        ).rejects.toMatchObject({ statusCode: 409 });
        duplicate.abort();
        previous.abort();
        expect(await active.execute(writer, previousInput)).toEqual(
          previousReceipt,
        );
        expect(process.kill(pid, 0)).toBe(true);
        expect(process.kill(-pid, 0)).toBe(true);
        await expect(active.acquire(next, randomUUID())).rejects.toMatchObject({
          statusCode: 409,
        });
        const [occupied] = (await currentRows()).rows;
        expect(occupied).toMatchObject({ generation, phase: 'held' });
        expect(occupied?.run_id).toBeTruthy();
        cancelExecution.abort();
        const terminal = await execution;
        expect(terminal).toMatchObject({
          runId: occupied!.run_id,
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed', marker: 'released' },
        });
        for (const target of [pid, -pid])
          expect(() => process.kill(target, 0)).toThrow(
            expect.objectContaining({ code: 'ESRCH' }),
          );
        expect(await active.execute(writer, executionInput)).toEqual(terminal);
        expect((await currentRows()).rows).toEqual([
          { generation, phase: 'held', run_id: null },
        ]);
        await expect(active.acquire(next, randomUUID())).rejects.toMatchObject({
          statusCode: 409,
        });
      } finally {
        cancelExecution.abort();
      }

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
      const readStatus = (handoff = active) =>
        handoff.readStatus(next.who, projectId, requirementId, () => {});
      expect(await readStatus()).toEqual({ state: 'held' });
      await expect(active.acquire(next, randomUUID())).rejects.toMatchObject({
        statusCode: 409,
      });
      const slowAuthorization = commits.holdSession();
      const refused = active.release(next, generation, randomUUID());
      void refused.catch(() => {});
      try {
        await expect.poll(() => slowAuthorization.entered).toBe(true);
        active.assertWireLease(
          writer,
          generation,
          winning.value.contextVersion,
        );
      } finally {
        slowAuthorization.release();
      }
      await expect(refused).rejects.toMatchObject({ statusCode: 409 });

      const releaseId = randomUUID();
      const originalRelease = {
        type: 'release' as const,
        commandId: releaseId,
        generation,
      };
      const missingRelease = commits.arm();
      const stopSettlement = commits.holdSettlement();
      const release = active.release(writer, generation, releaseId);
      void release.catch(() => {});
      try {
        await expect.poll(() => stopSettlement.entered).toBe(true);
        expect(await readStatus()).toEqual({ state: 'stopping' });
        expect(await active.checkCommand(writer, originalRelease)).toEqual({
          state: 'recorded',
          generation,
        });
        expect(
          await active.execute(siblingScope, {
            generation: activeSibling.generation,
            commandId: randomUUID(),
            repositoryId: 'app',
            request: {
              tool: 'file',
              operation: 'write',
              path: 'scope-status.txt',
              text: 'sibling write',
            },
          }),
        ).toMatchObject({
          status: 'finished',
          result: { status: 'ok', stop: 'confirmed' },
        });
      } finally {
        stopSettlement.release();
      }
      await expect(release).rejects.toThrow('commit could not be confirmed');
      expect(missingRelease.entered).toBe(true);
      const firstReceipt = await running;
      expect(firstReceipt).toMatchObject({
        status: 'finished',
        result: { status: 'aborted', stop: 'confirmed', marker: 'released' },
      });
      expect((await currentRows()).rows).toEqual([
        { generation, phase: 'released', run_id: null },
      ]);
      expect(await readStatus()).toEqual({ state: 'idle' });
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
      const oldReplay = active.release(writer, generation, releaseId);
      void oldReplay.catch(() => {});
      active.assertWireLease(next, second.generation, second.contextVersion);
      expect(await oldReplay).toBe('released');
      await expect(
        active.checkCommand(writer, {
          ...originalRelease,
          generation: second.generation,
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      expect(
        await active.release(
          siblingScope,
          activeSibling.generation,
          randomUUID(),
        ),
      ).toBe('released');
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
      const settlementAck = commits.holdSettlement(true);
      const confirmedFile = active.execute(next, file);
      void confirmedFile.catch(() => {});
      try {
        await expect.poll(() => settlementAck.entered).toBe(true);
        expect((await currentRows()).rows[0]).toMatchObject({
          phase: 'held',
          generation: second.generation,
          run_id: null,
        });
        expect(await readStatus()).toEqual({ state: 'unconfirmed' });
      } finally {
        settlementAck.release();
      }
      expect(await confirmedFile).toMatchObject({
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
      const rolledBackSettlement = commits.arm(false, 'settlement');
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
      const cancelQueued = new AbortController();
      const queuedInput = {
        ...file,
        commandId: randomUUID(),
        request: { ...file.request, text: 'queued write must stay absent' },
      };
      const queued = active.execute(
        next,
        queuedInput,
        undefined,
        cancelQueued.signal,
      );
      void queued.catch(() => {});
      try {
        await expect.poll(() => preflightChecked).toBe(true);
        cancelQueued.abort();
        const [beforeRelease] = (await currentRows()).rows;
        expect(beforeRelease).toMatchObject({
          generation: second.generation,
          phase: 'held',
        });
        expect(beforeRelease?.run_id).toBeTruthy();
        const releasing = active.release(next, second.generation, randomUUID());
        void releasing.catch(() => {});
        await expect
          .poll(async () => (await currentRows()).rows[0]?.phase)
          .toBe('draining');
        finishPreflight();
        expect(await releasing).toBe('released');
        const terminal = await queued;
        expect(terminal).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'not-started' },
        });
        expect(await active.execute(next, queuedInput)).toEqual(terminal);
        expect((await currentRows()).rows).toEqual([
          { generation: second.generation, phase: 'released', run_id: null },
        ]);
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

      let secondRunOutput = '';
      const secondRun = active.execute(
        writer,
        {
          ...input,
          generation: latest.generation,
          commandId: randomUUID(),
          request: {
            tool: 'shell',
            script: 'printf "fixture-pid:%s\\n" "$$"; while :; do :; done',
          },
        },
        ({ stream, chunk }) => {
          if (stream === 'stdout') secondRunOutput += chunk.toString();
        },
      );
      void secondRun.catch(() => {});
      const secondPid = await isolatedShellPid(() => secondRunOutput);
      const [activeRow] = (await currentRows()).rows;
      expect(await active.release(writer, generation, releaseId)).toBe(
        'released',
      );
      expect(process.kill(-secondPid, 0)).toBe(true);
      expect((await currentRows()).rows).toEqual([activeRow]);
      expect(
        await active.readStatus(writer.who, projectId, requirementId, () => {}),
      ).toMatchObject({
        state: 'held',
        holder: { generation: latest.generation },
      });
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

      {
        const previous = await active.acquire(next, randomUUID());
        let handoffOutput = '';
        const oldInvocation = {
          ...input,
          generation: previous.generation,
          commandId: randomUUID(),
          request: {
            tool: 'shell' as const,
            script: 'printf "fixture-pid:%s\\n" "$$"; while :; do :; done',
          },
        };
        const oldWork = active.execute(
          next,
          oldInvocation,
          ({ stream, chunk }) => {
            if (stream === 'stdout') handoffOutput += chunk.toString();
          },
        );
        void oldWork.catch(() => {});
        const incumbentPid = await isolatedShellPid(() => handoffOutput);
        const rolledBack = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const lostRollback = commits.armTakeover(
          rolledBack.commandId,
          'pending',
          'any',
        );
        await expect(
          active.takeover(unassigned, rolledBack.commandId),
        ).rejects.toThrow('commit could not be confirmed');
        expect(lostRollback.entered).toBe(true);
        await expect
          .poll(() => readStatus(active))
          .toEqual({
            state: 'held',
            holder: expect.objectContaining({
              generation: previous.generation,
            }),
          });
        expect(process.kill(-incumbentPid, 0)).toBe(true);
        expect(await active.checkCommand(unassigned, rolledBack)).toEqual({
          state: 'unrecorded',
        });

        const switchCommand = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const lostIntent = commits.armTakeover(
          switchCommand.commandId,
          'pending',
        );
        const heldSettlement = commits.holdSettlement(true);
        try {
          await expect(
            active.takeover(unassigned, switchCommand.commandId),
          ).rejects.toThrow('commit could not be confirmed');
          expect(lostIntent.entered).toBe(true);
          await expect.poll(() => heldSettlement.entered).toBe(true);
          expect((await currentRows()).rows).toEqual([
            {
              generation: previous.generation,
              phase: 'draining',
              run_id: null,
            },
          ]);
          expect(await active.checkCommand(unassigned, switchCommand)).toEqual({
            state: 'pending',
          });
          await expect(
            active.takeover(alternate, randomUUID()),
          ).rejects.toMatchObject({ statusCode: 409 });
          await expect(
            active.execute(next, {
              ...file,
              generation: previous.generation,
              commandId: randomUUID(),
            }),
          ).rejects.toMatchObject({ statusCode: 409 });
        } finally {
          heldSettlement.release();
        }
        expect(await oldWork).toMatchObject({
          status: 'finished',
          result: { status: 'aborted', stop: 'confirmed' },
        });
        expect(() => process.kill(-incumbentPid, 0)).toThrow(
          expect.objectContaining({ code: 'ESRCH' }),
        );
        await expect
          .poll(() => active.checkCommand(unassigned, switchCommand))
          .toMatchObject({ state: 'acquired', generation: expect.any(String) });
        const completed = await active.checkCommand(unassigned, switchCommand);
        if (completed.state !== 'acquired')
          throw new Error('Expected confirmed takeover');
        expect(
          await active.takeover(unassigned, switchCommand.commandId),
        ).toEqual(completed);
        expect((await currentRows()).rows).toEqual([
          { generation: completed.generation, phase: 'held', run_id: null },
        ]);

        const finalCommand = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const lostGrant = commits.armTakeover(
          finalCommand.commandId,
          'acquired',
        );
        expect(await active.takeover(next, finalCommand.commandId)).toEqual({
          state: 'pending',
        });
        await expect.poll(() => lostGrant.entered).toBe(true);
        await expect
          .poll(() => active.checkCommand(next, finalCommand))
          .toMatchObject({ state: 'acquired', generation: expect.any(String) });
        const finalGrant = await active.checkCommand(next, finalCommand);
        if (finalGrant.state !== 'acquired')
          throw new Error('Expected recovered takeover');
        await expect
          .poll(() => readStatus(active))
          .toMatchObject({
            state: 'held',
            holder: { generation: finalGrant.generation },
          });
        expect(
          await active.takeover(unassigned, switchCommand.commandId),
        ).toEqual(completed);
        expect((await currentRows()).rows[0]?.generation).toBe(
          finalGrant.generation,
        );

        const retryFinal = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const rolledBackGrant = commits.armTakeover(
          retryFinal.commandId,
          'acquired',
          'any',
        );
        expect(await active.takeover(unassigned, retryFinal.commandId)).toEqual(
          { state: 'pending' },
        );
        await expect.poll(() => rolledBackGrant.entered).toBe(true);
        await expect
          .poll(() => active.checkCommand(unassigned, retryFinal))
          .toMatchObject({ state: 'acquired', generation: expect.any(String) });
        const retriedGrant = await active.checkCommand(unassigned, retryFinal);
        if (retriedGrant.state !== 'acquired')
          throw new Error('Expected reacquired takeover');
        await expect
          .poll(() =>
            active.readStatus(
              unassigned.who,
              projectId,
              requirementId,
              () => {},
            ),
          )
          .toMatchObject({
            state: 'held',
            holder: { generation: retriedGrant.generation },
          });

        let failingOutput = '';
        const failedExecution = active.execute(
          unassigned,
          {
            ...oldInvocation,
            generation: retriedGrant.generation,
            commandId: randomUUID(),
            request: {
              tool: 'shell',
              script:
                'printf "fixture-pid:%s\\n" "$$"; while [ ! -f finish-with-error ]; do :; done; exit 7',
            },
          },
          ({ stream, chunk }) => {
            if (stream === 'stdout') failingOutput += chunk.toString();
          },
        );
        void failedExecution.catch(() => {});
        const failingPid = await isolatedShellPid(() => failingOutput);
        const afterFailure = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const heldIntent = commits.armTakeover(
          afterFailure.commandId,
          'pending',
          undefined,
          'hold',
        );
        const afterFailureRequest = active.takeover(
          next,
          afterFailure.commandId,
        );
        void afterFailureRequest.catch(() => {});
        try {
          await expect.poll(() => heldIntent.entered).toBe(true);
          expect(process.kill(-failingPid, 0)).toBe(true);
          await writeFile(join(scope.tree, 'finish-with-error'), 'fixture', {
            flag: 'wx',
            mode: 0o600,
          });
          expect(await failedExecution).toMatchObject({
            status: 'finished',
            result: { status: 'failed', exitCode: 7, stop: 'confirmed' },
          });
          expect((await currentRows()).rows[0]).toMatchObject({
            generation: retriedGrant.generation,
            phase: 'draining',
            run_id: null,
          });
        } finally {
          heldIntent.release();
        }
        expect(await afterFailureRequest).toEqual({ state: 'pending' });
        await expect
          .poll(() => active.checkCommand(next, afterFailure))
          .toMatchObject({ state: 'acquired', generation: expect.any(String) });
        await expect
          .poll(() => readStatus(active))
          .toMatchObject({
            state: 'held',
            holder: { sessionId: next.sessionId },
          });

        const reserving = {
          ...file,
          generation: (await currentRows()).rows[0]!.generation as string,
          commandId: randomUUID(),
          request: {
            ...file.request,
            path: 'must-not-start.txt',
            text: 'unexpected write',
          },
        };
        const reservationGate = commits.armTakeover(
          reserving.commandId,
          'reserved',
          undefined,
          'hold',
        );
        const reservedWork = active.execute(next, reserving);
        void reservedWork.catch(() => {});
        const lateRun = { type: 'takeover' as const, commandId: randomUUID() };
        const pendingRead = commits.holdPendingRead(lateRun.commandId);
        let originalView = true;
        try {
          await expect.poll(() => reservationGate.entered).toBe(true);
          expect(
            await active.takeover(unassigned, lateRun.commandId, () => {
              if (!originalView)
                throw new Error(
                  'Synthetic original HTTP observation invalidated',
                );
            }),
          ).toEqual({ state: 'pending' });
          await expect.poll(() => pendingRead.entered).toBe(true);
          originalView = false;
          reservationGate.release();
          expect(await reservedWork).toMatchObject({
            status: 'finished',
            result: { stop: 'not-started' },
          });
          await expect(
            readFile(join(scope.tree, 'must-not-start.txt')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await active.checkCommand(unassigned, lateRun)).toEqual({
            state: 'pending',
          });
        } finally {
          reservationGate.release();
          pendingRead.release();
        }
        await expect
          .poll(() => active.checkCommand(unassigned, lateRun))
          .toMatchObject({ state: 'acquired', generation: expect.any(String) });
        const moveBack = { type: 'takeover' as const, commandId: randomUUID() };
        expect(await active.takeover(next, moveBack.commandId)).toEqual({
          state: 'pending',
        });
        await expect
          .poll(() => active.checkCommand(next, moveBack))
          .toMatchObject({ state: 'acquired' });
        await expect
          .poll(() => readStatus(active))
          .toMatchObject({
            state: 'held',
            holder: { sessionId: next.sessionId },
          });

        const withdrawn = {
          type: 'takeover' as const,
          commandId: randomUUID(),
        };
        const revokeGate = commits.armTakeover(
          withdrawn.commandId,
          'pending',
          undefined,
          'hold',
        );
        const withdrawRequest = active.takeover(
          unassigned,
          withdrawn.commandId,
        );
        void withdrawRequest.catch(() => {});
        try {
          await expect.poll(() => revokeGate.entered).toBe(true);
          await active.changeAuthority(
            randomUUID(),
            ({ who }) => who.userId === unassigned.who.userId,
            (tx) =>
              tx
                .delete(schema.requirementParticipant)
                .where(
                  sql`${schema.requirementParticipant.requirementId}=${requirementId} and ${schema.requirementParticipant.userId}=${unassigned.who.userId} and ${schema.requirementParticipant.role}='developer'`,
                ),
            async () => 'committed',
          );
          expect(await active.checkCommand(unassigned, withdrawn)).toEqual({
            state: 'pending',
          });
        } finally {
          revokeGate.release();
        }
        expect(await withdrawRequest).toEqual({ state: 'pending' });
        await expect
          .poll(() => active.checkCommand(unassigned, withdrawn))
          .toEqual({ state: 'cancelled' });
        expect(await readStatus(active)).toEqual({ state: 'idle' });
        await expect(
          active.takeover(unassigned, randomUUID()),
        ).rejects.toMatchObject({ statusCode: 403 });
      }

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
      const beforeExpired = await short.acquire(next, randomUUID());
      const expiringSwitch = {
        type: 'takeover' as const,
        commandId: randomUUID(),
      };
      const expiringAck = commits.armTakeover(
        expiringSwitch.commandId,
        'acquired',
        undefined,
        'hold-then-lose',
      );
      try {
        expect(
          await short.takeover(alternate, expiringSwitch.commandId),
        ).toEqual({ state: 'pending' });
        await expect.poll(() => expiringAck.entered).toBe(true);
        const expired = await short.checkCommand(alternate, expiringSwitch);
        if (expired.state !== 'acquired')
          throw new Error('Expected persisted takeover grant');
        expect(expired.generation).not.toBe(beforeExpired.generation);
        await expect
          .poll(async () => (await currentRows()).rows[0], { timeout: 4_000 })
          .toMatchObject({ generation: expired.generation, phase: 'released' });
      } finally {
        expiringAck.release();
      }
      await expect.poll(() => readStatus(short)).toEqual({ state: 'idle' });
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

      const expiringIdle = await short.acquire(next, randomUUID());
      const expiryStop = commits.holdFinalRead();
      try {
        await expect
          .poll(() => expiryStop.pid, { timeout: 4_000 })
          .toEqual(expect.any(Number));
        expect(Date.now()).toBeGreaterThanOrEqual(expiringIdle.expiresAt);
        expect((await currentRows()).rows[0]).toMatchObject({
          generation: expiringIdle.generation,
          phase: 'held',
        });
        expect(await readStatus(short)).toEqual({ state: 'unconfirmed' });
      } finally {
        expiryStop.release();
      }
      await expect.poll(() => readStatus(short)).toEqual({ state: 'idle' });

      const untilCutoff = await short.acquire(next, randomUUID());
      const deadlineCommand = {
        type: 'release' as const,
        generation: untilCutoff.generation,
        commandId: randomUUID(),
      };
      const receiptWrite = commits.holdReceipt(deadlineCommand.commandId);
      const overdueRelease = short.release(
        next,
        deadlineCommand.generation,
        deadlineCommand.commandId,
      );
      void overdueRelease.catch(() => {});
      try {
        await expect.poll(() => receiptWrite.entered).toBe(true);
        await new Promise((resolve) =>
          setTimeout(
            resolve,
            Math.max(0, untilCutoff.expiresAt - Date.now() + 5),
          ),
        );
      } finally {
        receiptWrite.release();
      }
      await expect(overdueRelease).rejects.toMatchObject({ statusCode: 409 });
      expect(await short.checkCommand(next, deadlineCommand)).toEqual({
        state: 'unrecorded',
      });
      await expect.poll(() => readStatus(short)).toEqual({ state: 'idle' });

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
      expect(await readStatus(short)).toEqual({ state: 'unconfirmed' });
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
      expect(await readStatus(cold)).toEqual({ state: 'unconfirmed' });
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

      const sibling = {
        ...lead,
        requirementId: differentRequirement,
        sessionId: differentSession,
        who: {
          ...lead.who,
          authSessionId: alternateLogins.get(lead.who.userId)!,
        },
      };
      const siblingWorktree = await trees.executionScope(
        projectId,
        differentRequirement,
        siblingPlan,
        'app',
      );
      const siblingGrant = await cold.acquire(sibling, randomUUID());
      const uncertainStopInput = {
        ...executionInput,
        generation: siblingGrant.generation,
        commandId: randomUUID(),
      };
      const cancelUnconfirmed = new AbortController();
      let siblingOutput = '';
      const uncertainStop = cold.execute(
        sibling,
        uncertainStopInput,
        ({ stream, chunk }) => {
          if (stream === 'stdout') siblingOutput += chunk.toString();
        },
        cancelUnconfirmed.signal,
      );
      void uncertainStop.catch(() => {});
      const pid = await isolatedShellPid(() => siblingOutput);
      const sendSignal = process.kill.bind(process);
      const groupStopped = () => {
        try {
          sendSignal(-pid, 0);
          return false;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          return true;
        }
      };
      let interrupted = false;
      let cleanupError: unknown;
      const pauseStop = vi
        .spyOn(process, 'kill')
        .mockImplementation((target, signal) => {
          if (target === -pid && signal === 'SIGKILL') {
            interrupted = true;
            return true;
          }
          return sendSignal(target, signal);
        });
      try {
        cancelUnconfirmed.abort();
        const terminal = await uncertainStop;
        expect(interrupted).toBe(true);
        expect(sendSignal(-pid, 0)).toBe(true);
        expect(terminal).toMatchObject({
          status: 'unknown',
          result: {
            status: 'aborted',
            stop: 'unconfirmed',
            marker: 'retained',
          },
        });
        expect(
          (
            await database.pool.query(
              'select generation,phase,run_id from requirement_write_lease where requirement_id=$1',
              [differentRequirement],
            )
          ).rows,
        ).toEqual([
          {
            generation: siblingGrant.generation,
            phase: 'draining',
            run_id: terminal.runId,
          },
        ]);
        expect(await cold.execute(sibling, uncertainStopInput)).toEqual(
          terminal,
        );
        await expect(
          cold.execute(sibling, {
            ...uncertainStopInput,
            commandId: randomUUID(),
          }),
        ).rejects.toMatchObject({ statusCode: 409 });
        expect(
          (
            await lstat(join(siblingWorktree.control, 'isolated-execution'))
          ).isDirectory(),
        ).toBe(true);
      } finally {
        pauseStop.mockRestore();
        if (interrupted) {
          try {
            if (!groupStopped()) {
              expectOwnedShell(pid);
              sendSignal(-pid, 'SIGKILL');
            }
          } catch (error) {
            cleanupError = error;
          }
          try {
            await expect.poll(groupStopped).toBe(true);
          } catch (error) {
            cleanupError ??= error;
          }
        }
      }
      if (cleanupError) throw cleanupError;
      await expect(cold.close()).rejects.toThrow('confirmed stopped');
      broker = undefined;
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
