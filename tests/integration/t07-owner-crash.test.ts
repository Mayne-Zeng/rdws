import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  readFile,
  readdir,
  writeFile,
} from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import type { WriteAuthorityCommand } from '@rdws/contracts';
import {
  readSupervisedStop,
  type ExecutionProofBinding,
} from '@rdws/dsh/execution/supervised';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { buildApp } from '@rdws/server';
import { hashPassword } from 'better-auth/crypto';
import { expect, test, vi } from 'vitest';
import type {
  OwnerBoot,
  OwnerCommand,
  OwnerReport,
} from '../fixtures/t07-paused-owner.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';

function isolatedOwner(boot: OwnerBoot) {
  const child = fork(
    new URL('../fixtures/t07-paused-owner.ts', import.meta.url),
    {
      env: {
        PATH: process.env.PATH,
        RDWS_MODE: 'test',
        RDWS_NATIVE_MODEL_EGRESS: 'paused',
        RDWS_HOME: boot.root,
      },
      execArgv: ['--import', 'tsx'],
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
    },
  );
  const reports: OwnerReport[] = [];
  child.on('message', (report: OwnerReport) => reports.push(report));
  const exited = once(child, 'close');
  void exited.catch(() => {});
  child.send(boot);

  function send(command: OwnerCommand) {
    return new Promise<void>((resolve, reject) => {
      child.send(command, (error) => (error ? reject(error) : resolve()));
    });
  }
  async function address() {
    await expect
      .poll(() => reports[0]?.kind, { timeout: 7_000 })
      .toBe('listening');
    const report = reports[0];
    if (
      report?.kind !== 'listening' ||
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(report.address)
    )
      throw new Error('Unexpected isolated BFF address');
    return report.address;
  }
  async function waitForExit() {
    await expect
      .poll(() => child.exitCode !== null || child.signalCode !== null, {
        timeout: 7_000,
      })
      .toBe(true);
    return exited;
  }
  return { child, reports, send, address, waitForExit };
}

function processIdentity(pid: number) {
  const [parent, group, state, ...started] = execFileSync(
    '/bin/ps',
    [
      '-o',
      'ppid=',
      '-o',
      'pgid=',
      '-o',
      'state=',
      '-o',
      'lstart=',
      '-p',
      String(pid),
    ],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
  )
    .trim()
    .split(/\s+/);
  expect(state).toMatch(/^[^Z]/);
  expect(started).not.toHaveLength(0);
  return {
    parent: Number(parent),
    group: Number(group),
    started: started.join(' '),
  };
}

function disappeared(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return true;
  }
}

async function fingerprint(root: string) {
  const files = (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((file) => file.isFile())
    .map((file) => join(file.parentPath, file.name))
    .sort();
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(relative(root, file)).update('\0');
    hash.update(
      createHash('sha256')
        .update(await readFile(file))
        .digest(),
    );
  }
  return hash.digest('hex');
}

test.skipIf(process.platform !== 'darwin')(
  'supervised proof mode rejects the mediated Native tool assembly',
  () => {
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    try {
      expect(() =>
        buildApp({
          databaseUrl: 'postgresql://127.0.0.1/rdws_test',
          origin: 'http://127.0.0.1:5317',
          secret: randomBytes(32).toString('hex'),
          authorityTicket: randomBytes(32).toString('hex'),
          isolatedWrite: {
            gitPath: '/usr/bin/git',
            fixtureTool: true,
            supervisedExecution: true,
          },
        }),
      ).toThrow('Isolated write handoff requires a managed macOS test BFF');
    } finally {
      vi.unstubAllEnvs();
    }
  },
);

test
  .skipIf(process.platform !== 'darwin')
  .each([
    'legacy',
    'supervised',
    'armed',
    'rollback-go',
    'lose-go',
    'failed',
    'shutdown',
    'no-proof',
    'expired-go',
    'queued-go',
    'disconnect-before-go',
    'bad-scope',
    'ack-lost',
    'output-failed',
  ] as const)(
  'a crashed BFF leaves independently verifiable execution evidence (%s)',
  async (mode) => {
    const endpoint = execFileSync(
      'docker',
      [
        'context',
        'inspect',
        '--format',
        '{{(index .Endpoints "docker").Host}}',
      ],
      { encoding: 'utf8' },
    ).trim();
    const dockerHost = process.env.DOCKER_CONTEXT
      ? endpoint
      : process.env.DOCKER_HOST || endpoint;
    if (!dockerHost.startsWith('unix:///'))
      throw new Error('Owner crash fixture requires a local Docker socket');
    const lab = await authorityDatabase(dockerHost);
    const children: ReturnType<typeof isolatedOwner>[] = [];
    let git: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let gitPrepared = false;
    let old: ReturnType<typeof isolatedOwner> | undefined;
    let stopFile: string | undefined;
    let requested = false;
    let executionPid: number | undefined;
    let executionStopped = false;
    let pausedSupervisor: { pid: number; started: string } | undefined;
    function resumeSupervisor() {
      if (!pausedSupervisor) return;
      const { pid, started } = pausedSupervisor;
      expect(processIdentity(pid)).toMatchObject({ group: pid, started });
      expect(process.kill(pid, 'SIGCONT')).toBe(true);
      pausedSupervisor = undefined;
    }
    const projectId = 'poc';
    const requirementId = randomUUID();
    const sessionId = randomUUID();
    const idleRequirement = randomUUID();
    const idleSession = randomUUID();
    const userId = randomUUID();
    const commandId = randomUUID();
    const ticket = () => randomBytes(32).toString('hex');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const owner = async () =>
      (
        await lab.owner.query<{
          generation: string | null;
          spent: boolean;
          proof_digest: string | null;
        }>(
          'select generation,ticket_digest is null as spent,proof_digest from rdws_authority.owner where singleton',
        )
      ).rows[0]!;
    const retained = async () => ({
      lease: (
        await lab.owner.query(
          'select * from requirement_write_lease where requirement_id=$1',
          [requirementId],
        )
      ).rows[0],
      receipts: (
        await lab.owner.query(
          'select operation,command_id,digest,result from command_receipt where scope=$1 order by operation,command_id',
          ['requirement:' + requirementId],
        )
      ).rows,
    });

    try {
      const password = ticket();
      await lab.owner.query(
        "insert into project(id,name) values ($1,'Crash fixture')",
        [projectId],
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture lead','crash@fixture.invalid','fixture_crash',true)",
        [userId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), userId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values($1,$2,'developer')",
        [projectId, userId],
      );
      for (const [demand, session] of [
        [requirementId, sessionId],
        [idleRequirement, idleSession],
      ]) {
        await lab.owner.query(
          "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Crash fixture','','',$3,$3)",
          [demand, projectId, userId],
        );
        await lab.owner.query(
          "insert into requirement_participant values($1,$2,'developer')",
          [demand, userId],
        );
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
          [session, demand, userId],
        );
      }

      git = await httpsGitFixture(projectId);
      const root = git.root;
      const mirrors = new RepositoryMirrors(root);
      const trees = new DemandWorktrees(root, mirrors);
      const execution = await (async () => {
        try {
          await writeFile(join(git!.work, 'sample.txt'), 'baseline');
          await fixtureGit(['-C', git!.work, 'add', '--', 'sample.txt']);
          await git!.commit();
          await git!.update();
          expect(
            await mirrors.sync(
              projectId,
              'app',
              'fixture',
              randomUUID(),
              (publish) => publish(),
            ),
          ).toMatchObject({ status: 'succeeded' });
          const plan = (await mirrors.captureBaselines(projectId)).map(
            (entry) => ({
              ...entry,
              branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
              worktreePath: 'worktrees/' + entry.repositoryId,
              gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
            }),
          );
          await trees.prepare(projectId, requirementId, plan);
          await lab.owner.query(
            'insert into requirement_worktree_plan values($1,$2)',
            [requirementId, JSON.stringify(plan)],
          );
          return await trees.executionScope(
            projectId,
            requirementId,
            plan,
            'app',
          );
        } finally {
          try {
            await trees.close();
          } finally {
            await mirrors.close();
          }
        }
      })();
      gitPrepared = true;
      const sources = join(root, 'projects', projectId, 'sources');
      const sample = join(execution.tree, 'sample.txt');
      const marker = join(
        execution.control,
        'isolated-execution',
        'owner.json',
      );
      stopFile = join(execution.tree, 'fixture-stop');
      const intact = async () =>
        Promise.all([fingerprint(sources), fingerprint(execution.store)]);
      const before = await intact();
      const initialTicket = ticket();
      expect(
        (
          await lab.owner.query(
            'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
            [digest(initialTicket)],
          )
        ).rowCount,
      ).toBe(1);

      const origin = lab.childEnv.RDWS_ORIGIN;
      const boot: Omit<OwnerBoot, 'ticket'> = {
        root,
        origin,
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET,
        ...(mode !== 'legacy' && { supervisedExecution: true as const }),
        ...(mode === 'armed' && { fault: 'hold-armed' as const }),
        ...((mode === 'expired-go' || mode === 'queued-go') && {
          fault: 'hold-armed' as const,
          observeGo: true as const,
        }),
        ...((mode === 'rollback-go' || mode === 'lose-go') && { fault: mode }),
        ...(mode === 'disconnect-before-go' && {
          fault: mode,
          observeGo: true as const,
        }),
        ...(mode === 'ack-lost' && { dropStopAck: true as const }),
        ...(mode === 'output-failed' && {
          outputFailure: true as const,
          fault: 'hold-armed' as const,
        }),
        gitPath: execFileSync('/usr/bin/which', ['git'], {
          encoding: 'utf8',
        }).trim(),
      };
      const start = (startupTicket: string) => {
        const run = isolatedOwner({ ...boot, ticket: startupTicket });
        children.push(run);
        return run;
      };
      old = start(initialTicket);
      const firstAddress = await old.address();
      const login = await fetch(firstAddress + '/api/auth/sign-in/username', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'fixture_crash', password }),
        redirect: 'error',
        signal: AbortSignal.timeout(2_500),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      await login.text();
      expect(Boolean(cookie)).toBe(true);
      const observed = await fetch(firstAddress + '/api/auth/get-session', {
        headers: { cookie },
        redirect: 'error',
        signal: AbortSignal.timeout(2_500),
      });
      expect(observed.status).toBe(200);
      const {
        session: { id: authSessionId },
        user,
      } = (await observed.json()) as {
        session: { id: string };
        user: { id: string };
      };
      expect(user.id).toBe(userId);
      const headers = {
        origin,
        cookie,
        'x-rdws-edit-session': authSessionId,
        'content-type': 'application/json',
      };
      function command(
        address: string,
        demand: string,
        session: string,
        input: WriteAuthorityCommand,
        check = false,
      ) {
        return fetch(
          `${address}/api/requirements/${demand}/sessions/${session}/write-authority/${check ? 'check' : 'commands'}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(input),
            redirect: 'error',
            signal: AbortSignal.timeout(2_500),
          },
        );
      }
      const first = { type: 'acquire' as const, commandId: randomUUID() };
      const grant = await command(
        firstAddress,
        requirementId,
        sessionId,
        first,
      );
      expect(grant.status).toBe(200);
      const { generation } = (await grant.json()) as { generation: string };
      const originalOwner = await owner();
      expect({
        generation: originalOwner.generation,
        spent: originalOwner.spent,
      }).toEqual({
        generation: expect.any(String),
        spent: true,
      });
      expect(/^[a-f0-9]{64}$/.test(originalOwner.proof_digest ?? '')).toBe(
        true,
      );
      const oldPid = old.child.pid!;
      const issuedAt = performance.now();
      const ready = join(execution.control, 'ready');
      const readyBefore =
        mode === 'bad-scope' ? await readFile(ready) : undefined;
      if (readyBefore)
        await writeFile(ready, 'synthetic unverified worktree readiness');
      requested = true;
      await old.send({
        kind: 'execute',
        commandId,
        generation,
        ...(mode === 'failed' && { exitCode: 7 as const }),
        scope: {
          projectId,
          requirementId,
          sessionId,
          who: { userId, authSessionId },
        },
      });
      if (readyBefore) {
        try {
          await expect
            .poll(
              async () =>
                (await retained()).receipts.find(
                  ({ command_id }) => command_id === commandId,
                )?.result,
            )
            .toMatchObject({
              status: 'finished',
              proof: { stage: 'reserved' },
              result: {
                stop: 'not-started',
                status: 'rejected',
                marker: 'none',
              },
            });
          expect((await retained()).lease).toMatchObject({
            phase: 'held',
            run_id: null,
          });
          expect(await readFile(sample, 'utf8')).toBe('baseline');
          await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          executionStopped = true;
        } finally {
          await writeFile(ready, readyBefore);
        }
        await old.send({ kind: 'stop' });
        expect(await old.waitForExit()).toEqual([0, null]);
        return;
      }
      let binding: ExecutionProofBinding | undefined;
      if (mode !== 'legacy') {
        await expect
          .poll(
            async () =>
              (await retained()).receipts.find(
                ({ command_id }) => command_id === commandId,
              )?.result?.proof,
            { timeout: 1800 },
          )
          .toMatchObject({
            stage: 'armed',
            binding: {
              commandId,
              generation,
              requirementId,
              ownerGeneration: originalOwner.generation,
            },
          });
        const saved = await retained();
        const receipt = saved.receipts.find(
          ({ command_id }) => command_id === commandId,
        )!;
        binding = receipt.result.proof.binding as ExecutionProofBinding;
        expect(binding).toEqual({
          version: 1,
          runId: saved.lease.run_id,
          generation,
          ownerGeneration: originalOwner.generation,
          projectId,
          requirementId,
          repositoryId: 'app',
          actorId: userId,
          commandId,
          receiptDigest: receipt.digest,
        });
        if (mode === 'armed') {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'fault-entered'),
            )
            .toBe(true);
          expect(await readFile(sample, 'utf8')).toBe('baseline');
          await expect(
            readFile(join(execution.tree, 'fixture-running')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(old.child.kill('SIGKILL')).toBe(true);
          expect(await old.waitForExit()).toEqual([null, 'SIGKILL']);
          await expect
            .poll(() => readSupervisedStop(execution.runtimeRoot, binding!))
            .toMatchObject({
              binding,
              outcome: { stop: 'not-started', status: 'aborted' },
            });
          executionStopped = true;
          expect(await retained()).toEqual(saved);
          await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(sample, 'utf8')).toBe('baseline');
          expect(await intact()).toEqual(before);
          return;
        }
        if (mode === 'disconnect-before-go') {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'backend-held'),
            )
            .toBe(true);
          const held = old.reports.find(({ kind }) => kind === 'backend-held');
          if (held?.kind !== 'backend-held')
            throw new Error('Execution backend is not held');
          const { pid } = held;
          expect(
            (
              await lab.admin.query<{ terminated: boolean }>(
                'select pg_terminate_backend($1) as terminated',
                [pid],
              )
            ).rows,
          ).toEqual([{ terminated: true }]);
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'backend-disconnected'),
            )
            .toBe(true);
          await old.send({ kind: 'release-fault' });
          await expect
            .poll(() => readSupervisedStop(execution.runtimeRoot, binding!))
            .toMatchObject({
              binding,
              outcome: { stop: 'not-started', status: 'aborted' },
            });
          expect(old.reports.some(({ kind }) => kind === 'go-sent')).toBe(
            false,
          );
          await expect
            .poll(async () => (await retained()).lease.run_id)
            .toBeNull();
          executionStopped = true;
          await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(sample, 'utf8')).toBe('baseline');
          await expect(
            readFile(join(execution.tree, 'fixture-running')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await intact()).toEqual(before);
          return;
        }
        if (mode === 'expired-go' || mode === 'queued-go') {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'fault-entered'),
            )
            .toBe(true);
          const { supervisorPid } = JSON.parse(
            await readFile(
              join(execution.control, `execution-${binding.runId}.armed.json`),
              'utf8',
            ),
          ) as { supervisorPid: number };
          const identity = processIdentity(supervisorPid);
          expect(identity).toMatchObject({
            parent: oldPid,
            group: supervisorPid,
          });
          expect(process.kill(supervisorPid, 'SIGSTOP')).toBe(true);
          pausedSupervisor = { pid: supervisorPid, started: identity.started };
          await old.send({ kind: 'release-fault' });
          await expect
            .poll(() => old!.reports.some(({ kind }) => kind === 'go-sent'))
            .toBe(true);
          const go = old.reports.find(({ kind }) => kind === 'go-sent');
          if (go?.kind !== 'go-sent')
            throw new Error('Execution GO was not observed');
          expect(await readFile(sample, 'utf8')).toBe('baseline');
          if (mode === 'queued-go') {
            expect(old.child.kill('SIGKILL')).toBe(true);
            expect(await old.waitForExit()).toEqual([null, 'SIGKILL']);
          } else {
            await new Promise((resolve) =>
              setTimeout(
                resolve,
                Math.max(0, go.validBefore - Date.now() + 25),
              ),
            );
          }
          resumeSupervisor();
          await expect
            .poll(() => readSupervisedStop(execution.runtimeRoot, binding!), {
              timeout: 4000,
            })
            .toMatchObject({ binding, supervisorPid });
          const stopped = (await readSupervisedStop(
            execution.runtimeRoot,
            binding,
          ))!;
          if (mode === 'expired-go') {
            expect(stopped.outcome).toEqual({
              stop: 'not-started',
              status: 'rejected',
              exitCode: null,
            });
            expect(await readFile(sample, 'utf8')).toBe('baseline');
            await expect
              .poll(async () => (await retained()).lease.run_id)
              .toBeNull();
          } else {
            expect(await retained()).toEqual(saved);
            const written = await readFile(sample, 'utf8');
            if (stopped.outcome.stop === 'not-started')
              expect(written).toBe('baseline');
            else expect(['baseline', 'baseline|started']).toContain(written);
          }
          executionStopped = true;
          await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await intact()).toEqual(before);
          return;
        }
        if (mode === 'output-failed') {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'fault-entered'),
            )
            .toBe(true);
          await old.send({ kind: 'release-fault' });
          await expect
            .poll(() => readSupervisedStop(execution.runtimeRoot, binding!))
            .toMatchObject({
              outcome: { stop: 'confirmed', status: 'failed' },
            });
          await expect
            .poll(async () => (await retained()).lease.run_id)
            .toBeNull();
          expect(old.child.exitCode).toBeNull();
          executionStopped = true;
          expect(await readFile(sample, 'utf8')).toBe('baseline|started');
          return;
        }
      }
      let observedPid: number | undefined;
      await expect
        .poll(
          async () => {
            try {
              const value = (
                await readFile(join(execution.tree, 'fixture-running'), 'utf8')
              ).trim();
              if (/^[1-9][0-9]*$/.test(value)) observedPid = Number(value);
              return Number.isSafeInteger(observedPid) && observedPid! > 1;
            } catch (error) {
              if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
                throw error;
              return false;
            }
          },
          { timeout: 3_000 },
        )
        .toBe(true);
      const pid = observedPid!;
      const identity = processIdentity(pid);
      const supervisor = binding
        ? JSON.parse(
            await readFile(
              join(execution.control, `execution-${binding.runId}.armed.json`),
              'utf8',
            ),
          )
        : undefined;
      if (binding)
        expect(supervisor).toEqual({
          binding,
          supervisorPid: expect.any(Number),
        });
      expect(identity).toMatchObject({
        parent: supervisor?.supervisorPid ?? oldPid,
        group: pid,
      });
      executionPid = pid;
      expect(await readFile(sample, 'utf8')).toBe('baseline|started');
      const markerBytes = await readFile(marker, 'utf8');
      expect(JSON.parse(markerBytes)).toEqual({
        launcherPid: supervisor?.supervisorPid ?? oldPid,
        runId: binding?.runId ?? expect.any(String),
      });
      const persisted = await retained();
      if (binding) {
        const proofFile = join(
          execution.control,
          `execution-${binding.runId}.stopped.json`,
        );
        if (mode === 'no-proof') {
          const collision = 'synthetic unmatched record';
          await writeFile(proofFile, collision, { mode: 0o600, flag: 'wx' });
          await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
          await expect
            .poll(
              async () =>
                (await retained()).receipts.find(
                  ({ command_id }) => command_id === commandId,
                )?.result,
            )
            .toMatchObject({
              status: 'unknown',
              result: { stop: 'unconfirmed' },
            });
          expect(disappeared(pid)).toBe(true);
          expect(disappeared(-pid)).toBe(true);
          executionStopped = true;
          expect((await retained()).lease).toMatchObject({
            run_id: binding.runId,
            phase: 'draining',
          });
          expect(await readFile(proofFile, 'utf8')).toBe(collision);
          expect(
            await readSupervisedStop(execution.runtimeRoot, binding),
          ).toBeUndefined();
          await old.send({ kind: 'stop' });
          expect(await old.waitForExit()).toEqual([1, null]);
          expect((await owner()).generation).toBe(originalOwner.generation);
          expect(await intact()).toEqual(before);
          return;
        }
        if (mode === 'ack-lost') {
          await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'stop-ack-dropped'),
            )
            .toBe(true);
          await expect
            .poll(() => readSupervisedStop(execution.runtimeRoot, binding!))
            .toMatchObject({
              binding,
              outcome: { stop: 'confirmed', status: 'ok' },
            });
          await expect
            .poll(
              async () =>
                (await retained()).receipts.find(
                  ({ command_id }) => command_id === commandId,
                )?.result,
            )
            .toMatchObject({
              status: 'unknown',
              result: { stop: 'unconfirmed' },
            });
          expect((await retained()).lease).toMatchObject({
            run_id: binding.runId,
            phase: 'draining',
          });
          expect((await owner()).generation).toBe(originalOwner.generation);
          expect(disappeared(pid) && disappeared(-pid)).toBe(true);
          executionStopped = true;
          await old.send({ kind: 'stop' });
          expect(await old.waitForExit()).toEqual([1, null]);
          expect((await owner()).generation).toBe(originalOwner.generation);
          return;
        }
        if (mode === 'supervised') {
          expect(old.child.kill('SIGKILL')).toBe(true);
          expect(await old.waitForExit()).toEqual([null, 'SIGKILL']);
        } else if (mode === 'rollback-go' || mode === 'lose-go') {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'fault-entered'),
            )
            .toBe(true);
          expect(processIdentity(pid)).toEqual(identity);
          await old.send({ kind: 'release-fault' });
          await expect
            .poll(() =>
              old!.reports.find(({ kind }) => kind === 'fault-completed'),
            )
            .toEqual({
              kind: 'fault-completed',
              command: mode === 'rollback-go' ? 'ROLLBACK' : 'COMMIT',
            });
        } else if (mode === 'failed') {
          await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
        } else {
          await old.send({ kind: 'stop' });
          expect(await old.waitForExit()).toEqual([0, null]);
        }
        await expect
          .poll(() => readSupervisedStop(execution.runtimeRoot, binding!), {
            timeout: 4_000,
          })
          .toMatchObject({
            binding,
            supervisorPid: supervisor.supervisorPid,
            outcome: {
              stop: 'confirmed',
              status: mode === 'failed' ? 'failed' : 'aborted',
              exitCode: mode === 'failed' ? 7 : null,
            },
          });
        expect(disappeared(pid)).toBe(true);
        expect(disappeared(-pid)).toBe(true);
        executionStopped = true;
        await expect(lstat(marker)).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(sample, 'utf8')).toBe('baseline|started');
        await expect(
          lstat(join(execution.control, 'forbidden-proof-write')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await intact()).toEqual(before);
        expect(
          await readSupervisedStop(execution.runtimeRoot, {
            ...binding,
            generation: randomUUID(),
          }),
        ).toBeUndefined();
        expect(
          await readSupervisedStop(execution.runtimeRoot, {
            ...binding,
            commandId: randomUUID(),
          }),
        ).toBeUndefined();
        if (mode === 'supervised') {
          const otherRun = randomUUID();
          expect(
            await readSupervisedStop(execution.runtimeRoot, {
              ...binding,
              runId: otherRun,
            }),
          ).toBeUndefined();
          await copyFile(
            proofFile,
            join(execution.control, `execution-${otherRun}.stopped.json`),
            constants.COPYFILE_EXCL,
          );
          expect(
            await readSupervisedStop(execution.runtimeRoot, {
              ...binding,
              runId: otherRun,
            }),
          ).toBeUndefined();
        }
        if (mode === 'supervised') {
          expect(await retained()).toEqual(persisted);
          expect((await owner()).generation).toBe(originalOwner.generation);
        } else {
          const finalStatus =
            mode === 'rollback-go' || mode === 'lose-go'
              ? 'unknown'
              : 'finished';
          await expect
            .poll(
              async () =>
                (await retained()).receipts.find(
                  ({ command_id }) => command_id === commandId,
                )?.result,
            )
            .toMatchObject({
              status: finalStatus,
              proof: { binding, stage: 'armed' },
              result: { stop: 'confirmed' },
            });
          expect((await retained()).lease.run_id).toBeNull();
        }
        return;
      }
      expect(persisted.lease).toMatchObject({
        generation,
        phase: 'held',
        run_id: expect.any(String),
        auth_session_id: authSessionId,
        native_session_id: sessionId,
      });
      expect(persisted.receipts).toContainEqual(
        expect.objectContaining({
          operation: 'write.execute',
          command_id: commandId,
          result: { status: 'reserved', runId: persisted.lease.run_id },
        }),
      );
      await expect
        .poll(
          async () => {
            try {
              return (
                await lab.owner.query(
                  'select run_id from requirement_write_lease where requirement_id=$1 for update nowait',
                  [requirementId],
                )
              ).rows[0]?.run_id;
            } catch (error) {
              if ((error as { code?: string }).code !== '55P03') throw error;
            }
          },
          { timeout: 2_500 },
        )
        .toBe(persisted.lease.run_id);
      expect(performance.now() - issuedAt).toBeLessThan(10_000);
      expect(old.child.exitCode).toBeNull();
      expect(old.child.signalCode).toBeNull();
      expect(old.child.kill('SIGKILL')).toBe(true);
      expect(await old.waitForExit()).toEqual([null, 'SIGKILL']);
      const orphan = processIdentity(pid);
      expect(orphan.parent).not.toBe(oldPid);
      expect(orphan).toMatchObject({
        group: identity.group,
        started: identity.started,
      });

      async function admissionDenials() {
        return (await lab.logs())
          .split('\n')
          .filter((line) =>
            /\bERROR:\s+Runtime authority admission denied\s*$/.test(line),
          ).length;
      }
      const denialsBefore = await admissionDenials();
      const refused = start(initialTicket);
      expect(await refused.waitForExit()).toEqual([1, null]);
      expect(refused.reports.map(({ kind }) => kind)).toContain(
        'authority-denied',
      );
      expect(refused.reports.map(({ kind }) => kind)).not.toContain(
        'listening',
      );
      expect(processIdentity(pid)).toEqual(orphan);
      await expect
        .poll(admissionDenials, { timeout: 1_000 })
        .toBe(denialsBefore + 1);
      const currentOwner = await owner();
      expect(currentOwner.generation).toBe(originalOwner.generation);
      expect(currentOwner.spent).toBe(true);
      expect(currentOwner.proof_digest === originalOwner.proof_digest).toBe(
        true,
      );
      expect(await retained()).toEqual(persisted);
      expect(await readFile(marker, 'utf8')).toBe(markerBytes);
      expect(await readFile(sample, 'utf8')).toBe('baseline|started');
      expect(await intact()).toEqual(before);

      await writeFile(stopFile, '', { mode: 0o600, flag: 'wx' });
      await expect
        .poll(() => disappeared(pid) && disappeared(-pid), { timeout: 4_000 })
        .toBe(true);
      executionStopped = true;
      const nextTicket = ticket();
      const recovery = await lab.owner.connect();
      try {
        await recovery.query('begin');
        await recovery.query("set local synchronous_commit='on'");
        expect(
          (
            await recovery.query(
              'update rdws_authority.owner set generation=null,proof_digest=null,ticket_digest=$1 where singleton and managed and generation=$2 and proof_digest=$3 and ticket_digest is null',
              [
                digest(nextTicket),
                originalOwner.generation,
                originalOwner.proof_digest,
              ],
            )
          ).rowCount,
        ).toBe(1);
        expect((await recovery.query('commit')).command).toBe('COMMIT');
      } catch (error) {
        await recovery.query('rollback');
        throw error;
      } finally {
        recovery.release();
      }

      const next = start(nextTicket);
      const nextAddress = await next.address();
      const replacement = await owner();
      expect({
        generation: replacement.generation,
        spent: replacement.spent,
      }).toEqual({
        generation: expect.any(String),
        spent: true,
      });
      expect(replacement.generation).not.toBe(originalOwner.generation);
      expect(
        replacement.proof_digest !== null &&
          replacement.proof_digest !== originalOwner.proof_digest,
      ).toBe(true);
      const state = await fetch(
        `${nextAddress}/api/requirements/${requirementId}/write-authority`,
        { headers, redirect: 'error', signal: AbortSignal.timeout(2_500) },
      );
      expect(state.status).toBe(200);
      expect(await state.json()).toEqual({
        state: 'unconfirmed',
        actionsEnabled: true,
      });
      const prior = await command(
        nextAddress,
        requirementId,
        sessionId,
        first,
        true,
      );
      expect(prior.status).toBe(200);
      expect(await prior.json()).toEqual({
        ...first,
        state: 'recorded',
        generation,
      });
      const replay = await command(
        nextAddress,
        requirementId,
        sessionId,
        first,
      );
      expect(replay.status).toBe(409);
      expect(await replay.json()).toEqual({
        error: '原写入资格已失效，请重新申请',
      });
      const fresh = { type: 'acquire' as const, commandId: randomUUID() };
      const denied = await command(
        nextAddress,
        requirementId,
        sessionId,
        fresh,
      );
      expect(denied.status).toBe(409);
      expect(await denied.json()).toEqual({
        error: '已有写会话或进程尚待停稳',
      });
      const freshCheck = await command(
        nextAddress,
        requirementId,
        sessionId,
        fresh,
        true,
      );
      expect(freshCheck.status).toBe(200);
      expect(await freshCheck.json()).toEqual({
        ...fresh,
        state: 'unrecorded',
      });
      const takeover = { type: 'takeover' as const, commandId: randomUUID() };
      const coldTakeover = await command(
        nextAddress,
        requirementId,
        sessionId,
        takeover,
      );
      expect(coldTakeover.status).toBe(409);
      expect(
        (await command(nextAddress, requirementId, sessionId, takeover, true))
          .status,
      ).toBe(200);

      const admitted = await command(
        nextAddress,
        idleRequirement,
        idleSession,
        { type: 'acquire', commandId: randomUUID() },
      );
      expect(admitted.status).toBe(200);
      const idleGrant = (await admitted.json()) as {
        state: string;
        generation: string;
      };
      expect(idleGrant).toMatchObject({
        state: 'acquired',
        generation: expect.any(String),
      });
      const released = await command(
        nextAddress,
        idleRequirement,
        idleSession,
        {
          type: 'release',
          commandId: randomUUID(),
          generation: idleGrant.generation,
        },
      );
      expect(released.status).toBe(200);
      expect(await released.json()).toMatchObject({
        state: 'released',
        generation: idleGrant.generation,
      });
      await next.send({ kind: 'stop' });
      expect(await next.waitForExit()).toEqual([1, null]);
      expect(next.reports).not.toContainEqual({ kind: 'stopped' });
      const retainedOwner = await owner();
      expect(retainedOwner.generation).toBe(replacement.generation);
      expect(retainedOwner.spent).toBe(true);
      expect(retainedOwner.proof_digest === replacement.proof_digest).toBe(
        true,
      );
      expect(await retained()).toEqual(persisted);
      expect(await readFile(marker, 'utf8')).toBe(markerBytes);
      expect(await readFile(sample, 'utf8')).toBe('baseline|started');
      expect(await intact()).toEqual(before);
    } finally {
      resumeSupervisor();
      let stopped = false;
      const fixtureLabel = `${basename(lab.root)} / ${git ? basename(git.root) : 'no Git fixture'}`;
      try {
        const shutdown = Promise.allSettled(
          children.map(async (run) => {
            if (
              run.child.connected &&
              run.child.exitCode === null &&
              run.child.signalCode === null
            ) {
              if (run.reports.some(({ kind }) => kind === 'listening'))
                await run.send({ kind: 'stop' });
              else run.child.disconnect();
            }
            await run.waitForExit();
          }),
        );
        if (requested && !executionStopped && stopFile) {
          await writeFile(stopFile, '', { mode: 0o600, flag: 'wx' }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            },
          );
        }
        expect(
          (await shutdown).map((result) => result.status),
          `BFF teardown was not confirmed. Retaining ${fixtureLabel}.`,
        ).toEqual(children.map(() => 'fulfilled'));
        if (
          requested &&
          !executionStopped &&
          !old?.reports.some(({ kind }) => kind === 'stopped')
        ) {
          expect(
            executionPid,
            `Execution identity was not confirmed. Retaining ${fixtureLabel}.`,
          ).toBeDefined();
          await expect
            .poll(
              () => disappeared(executionPid!) && disappeared(-executionPid!),
              {
                timeout: 28_000,
                message: `Execution is not confirmed stopped. Retaining ${fixtureLabel}.`,
              },
            )
            .toBe(true);
        }
        stopped = true;
      } finally {
        try {
          if (git && !gitPrepared)
            console.warn(
              `Git preparation was not confirmed. Retaining ${basename(git.root)}.`,
            );
          await git?.close({ preserveRoot: !gitPrepared || !stopped });
        } finally {
          if (stopped) await lab.close();
          else await Promise.allSettled([lab.owner.end(), lab.admin.end()]);
        }
      }
    }
  },
  65_000,
);
