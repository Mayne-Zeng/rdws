import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
  copyFile,
  lstat,
  mkdir,
  readFile,
  readdir,
  rename,
  rmdir,
  unlink,
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
  '§11.20.27 the supervised protocol is co-assembled with the mediated Native tool; the fixture tool still never joins the read snapshots and the write tools require supervision',
  () => {
    // §11.20.22 banned the co-assembly for its round; §11.20.27 A segment
    // lifts it (W15 takes the supervised evidence instead of this guard).
    // The guards run before any database connection is made.
    vi.stubEnv('RDWS_MODE', 'test');
    vi.stubEnv('RDWS_NATIVE_MODEL_EGRESS', 'mediated');
    const assembly =
      (isolatedWrite: Parameters<typeof buildApp>[0]['isolatedWrite']) => () =>
        buildApp({
          databaseUrl: 'postgresql://127.0.0.1/rdws_test',
          origin: 'http://127.0.0.1:5317',
          secret: randomBytes(32).toString('hex'),
          authorityTicket: randomBytes(32).toString('hex'),
          isolatedWrite,
        });
    try {
      // Lifted: supervision and the mediated fixture tool assemble; the
      // next guard the assembly meets is the model policy, not the ban.
      expect(
        assembly({
          gitPath: '/usr/bin/git',
          fixtureTool: true,
          supervisedExecution: true,
        }),
      ).toThrow('Mediated Native egress policy and mode must be set together');
      // Still refused: the constant fixture tool with the read snapshots.
      expect(
        assembly({
          gitPath: '/usr/bin/git',
          fixtureTool: true,
          supervisedExecution: true,
          readSnapshots: true,
        }),
      ).toThrow('Isolated write handoff requires a managed macOS test BFF');
      // The write tools exist only in the supervised assembly.
      expect(
        assembly({
          gitPath: '/usr/bin/git',
          fleetCommands: true,
          readSnapshots: true,
          writeTools: { repositoryId: 'app' },
        }),
      ).toThrow('Isolated write tools require the supervised assembly');
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
    'cold-pending',
    'cold-rollback',
    'cold-lost-commit',
    'cold-restart',
    'cold-revoked',
    'cold-unknown',
    'cold-no-location',
    'cold-sync-failure',
    'cold-race',
    'read-revoke',
    'read-shutdown',
    'read-unknown',
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
    const reader = randomUUID(),
      readerSession = randomUUID();
    const commandId = randomUUID();
    const takeoverSession = randomUUID();
    const takeoverId = randomUUID();
    const pendingTakeover =
      mode === 'cold-pending' ||
      mode === 'cold-rollback' ||
      mode === 'cold-lost-commit' ||
      mode === 'cold-restart' ||
      mode === 'cold-revoked' ||
      mode === 'cold-sync-failure';
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
        "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Fixture lead','crash@fixture.invalid','fixture_crash',true,$2)",
        [userId, mode === 'read-revoke'],
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

      if (pendingTakeover)
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
          [takeoverSession, requirementId, userId],
        );
      if (mode === 'read-revoke') {
        await lab.owner.query(
          "insert into auth_user(id,name,email,username,active) values($1,'Fixture reader','read@fixture.invalid','fixture_read',true)",
          [reader],
        );
        await lab.owner.query(
          "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
          [randomUUID(), reader, await hashPassword(password)],
        );
        await lab.owner.query(
          "insert into project_member values($1,$2,'project_admin')",
          [projectId, reader],
        );
        await lab.owner.query(
          'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
          [readerSession, requirementId, reader],
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
        ...((mode === 'read-revoke' ||
          mode === 'read-shutdown' ||
          mode === 'read-unknown') && {
          readSnapshots: true as const,
        }),
        ...((mode === 'read-shutdown' || mode === 'read-unknown') && {
          holdReadWorker: true as const,
        }),
        ...(mode === 'read-unknown' && { denyReadStop: true as const }),
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
        ...(mode === 'cold-unknown' && { dropStopAck: true as const }),
        ...(pendingTakeover && {
          fault: 'hold-takeover' as const,
          faultCommand: takeoverId,
        }),
        ...(mode === 'output-failed' && {
          outputFailure: true as const,
          fault: 'hold-armed' as const,
        }),
        gitPath: execFileSync('/usr/bin/which', ['git'], {
          encoding: 'utf8',
        }).trim(),
      };
      const start = (startupTicket: string, overrides?: Partial<OwnerBoot>) => {
        const run = isolatedOwner({
          ...boot,
          ...overrides,
          ticket: startupTicket,
        });
        children.push(run);
        return run;
      };
      async function replaceOwner(
        previous: Awaited<ReturnType<typeof owner>>,
        overrides?: Partial<OwnerBoot>,
      ) {
        const nextTicket = ticket();
        const connection = await lab.owner.connect();
        try {
          await connection.query('begin');
          await connection.query("set local synchronous_commit='on'");
          expect(
            (
              await connection.query(
                'update rdws_authority.owner set generation=null,proof_digest=null,ticket_digest=$1 where singleton and managed and generation=$2 and proof_digest=$3 and ticket_digest is null',
                [
                  digest(nextTicket),
                  previous.generation,
                  previous.proof_digest,
                ],
              )
            ).rowCount,
          ).toBe(1);
          expect((await connection.query('commit')).command).toBe('COMMIT');
        } catch (error) {
          await connection.query('rollback');
          throw error;
        } finally {
          connection.release();
        }
        const replacement = start(nextTicket, {
          fault: undefined,
          faultCommand: undefined,
          dropStopAck: undefined,
          ...overrides,
        });
        await replacement.address();
        expect((await owner()).generation).not.toBe(previous.generation);
        return replacement;
      }
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
      if (mode === 'read-revoke') {
        await writeFile(
          join(execution.tree, 'source-doc.txt'),
          'x'.repeat(32768),
        );
        const loginReader = await fetch(
          firstAddress + '/api/auth/sign-in/username',
          {
            method: 'POST',
            headers: { origin, 'content-type': 'application/json' },
            body: JSON.stringify({ username: 'fixture_read', password }),
          },
        );
        expect(loginReader.status).toBe(200);
        const cookie = loginReader.headers
          .getSetCookie()
          .map((part) => part.split(';')[0])
          .join('; ');
        const identity = await fetch(firstAddress + '/api/auth/get-session', {
          headers: { cookie },
        });
        const selected = await identity.json();
        expect(selected.user.id).toBe(reader);
        const scope = {
          projectId,
          requirementId,
          sessionId: readerSession,
          who: { userId: reader, authSessionId: selected.session.id as string },
        };
        const request = { repositoryId: 'app', path: 'source-doc.txt' };
        await old.send({ kind: 'read', scope, request });
        await expect
          .poll(() => old!.reports.some(({ kind }) => kind === 'read-result'))
          .toBe(true);
        const firstRead = old.reports.find(
          ({ kind }) => kind === 'read-result',
        );
        if (firstRead?.kind !== 'read-result')
          throw new Error('Initial source read did not return');
        expect(firstRead.result).toMatchObject({
          totalBytes: 32768,
          truncated: true,
          text: 'x'.repeat(16384),
          cursor: expect.any(String),
        });
        const seat = (enabled: boolean) =>
          fetch(firstAddress + '/api/management/commands', {
            method: 'POST',
            headers: {
              origin,
              cookie: headers.cookie,
              'content-type': 'application/json',
            },
            body: JSON.stringify({
              kind: 'project.admin',
              projectId,
              username: 'fixture_read',
              commandId: randomUUID(),
              enabled,
            }),
          });
        await old.send({ kind: 'read', scope, request, holdDelivery: true });
        try {
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'read-delivery-held'),
            )
            .toBe(true);
          const removed = await seat(false);
          expect(removed.status, await removed.clone().text()).toBe(200);
          expect(await removed.json()).toMatchObject({ changed: true });
          expect(
            (
              await lab.owner.query(
                'select role from project_member where project_id=$1 and user_id=$2',
                [projectId, reader],
              )
            ).rows,
          ).toEqual([]);
        } finally {
          await old.send({ kind: 'release-read' });
        }
        await expect
          .poll(() => old!.reports.find(({ kind }) => kind === 'read-failed'))
          .toEqual({ kind: 'read-failed', status: 409 });
        const restored = await seat(true);
        expect(restored.status).toBe(200);
        expect(await restored.json()).toMatchObject({ changed: true });
        await old.send({
          kind: 'read',
          scope,
          request: { cursor: firstRead.result.cursor! },
        });
        await expect
          .poll(() => old!.reports.filter(({ kind }) => kind === 'read-failed'))
          .toEqual([
            { kind: 'read-failed', status: 409 },
            { kind: 'read-failed', status: 403 },
          ]);
        await old.send({ kind: 'read', scope, request });
        await expect
          .poll(
            () =>
              old!.reports.filter(({ kind }) => kind === 'read-result').length,
          )
          .toBe(2);
        await old.send({ kind: 'stop' });
        expect(await old.waitForExit()).toEqual([0, null]);
        expect((await owner()).generation).toBeNull();
        return;
      }
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
        ...((mode === 'failed' || mode === 'cold-unknown') && {
          exitCode: 7 as const,
        }),
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
          await replaceOwner(originalOwner);
          await expect
            .poll(async () => (await retained()).lease)
            .toMatchObject({ generation, phase: 'released', run_id: null });
          expect(
            (await retained()).receipts.find(
              ({ command_id }) => command_id === commandId,
            )?.result,
          ).toMatchObject({
            status: 'reserved',
            coldStop: { outcome: { stop: 'not-started', status: 'aborted' } },
          });
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
      const originalTakeover = {
        type: 'takeover' as const,
        commandId: takeoverId,
      };
      if (pendingTakeover) {
        void command(
          firstAddress,
          requirementId,
          takeoverSession,
          originalTakeover,
        )
          .then((response) => response.text())
          .catch(() => {});
        await expect
          .poll(() => old!.reports.some(({ kind }) => kind === 'fault-entered'))
          .toBe(true);
        expect((await retained()).lease).toMatchObject({
          phase: 'draining',
          run_id: binding?.runId,
        });
        expect(process.kill(-pid, 0)).toBe(true);
      }
      if (mode === 'cold-unknown') {
        await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
        await expect
          .poll(
            async () =>
              (await retained()).receipts.find(
                ({ command_id }) => command_id === commandId,
              )?.result?.status,
          )
          .toBe('unknown');
      }
      const persisted = await retained();
      if (binding) {
        if (mode === 'read-shutdown' || mode === 'read-unknown') {
          await old.send({
            kind: 'read',
            scope: {
              projectId,
              requirementId,
              sessionId,
              who: { userId, authSessionId },
            },
            request: { repositoryId: 'app', path: 'sample.txt' },
          });
          await expect
            .poll(() =>
              old!.reports.some(({ kind }) => kind === 'read-worker-held'),
            )
            .toBe(true);
          const heldRead = old.reports.find(
            ({ kind }) => kind === 'read-worker-held',
          );
          if (heldRead?.kind !== 'read-worker-held')
            throw new Error('Read worker was not held');
          const readIdentity = processIdentity(heldRead.pid);
          expect(readIdentity).toMatchObject({
            parent: oldPid,
            group: heldRead.pid,
          });
          expect((await owner()).generation).toBe(originalOwner.generation);
          await old.send({ kind: 'stop' });
          if (mode === 'read-unknown') {
            try {
              await expect
                .poll(
                  () => old!.reports.some(({ kind }) => kind === 'failed'),
                  { timeout: 4000 },
                )
                .toBe(true);
              expect(processIdentity(heldRead.pid)).toEqual(readIdentity);
              expect((await owner()).generation).toBe(originalOwner.generation);
            } finally {
              expect(processIdentity(heldRead.pid)).toEqual(readIdentity);
              expect(process.kill(-heldRead.pid, 'SIGKILL')).toBe(true);
            }
          }
          expect(await old.waitForExit()).toEqual([
            mode === 'read-unknown' ? 1 : 0,
            null,
          ]);
          expect(old.reports).toContainEqual({
            kind: 'read-failed',
            status: mode === 'read-unknown' ? 503 : 409,
          });
          expect(old.reports.some(({ kind }) => kind === 'read-result')).toBe(
            false,
          );
          expect(disappeared(heldRead.pid) && disappeared(-heldRead.pid)).toBe(
            true,
          );
          expect(disappeared(pid) && disappeared(-pid)).toBe(true);
          executionStopped = true;
          expect((await owner()).generation).toBe(
            mode === 'read-unknown' ? originalOwner.generation : null,
          );
          return;
        }
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
        if (mode === 'supervised' || mode.startsWith('cold-')) {
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
              status:
                mode === 'failed' || mode === 'cold-unknown'
                  ? 'failed'
                  : 'aborted',
              exitCode: mode === 'failed' || mode === 'cold-unknown' ? 7 : null,
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
        if (mode === 'supervised' || mode.startsWith('cold-')) {
          expect(await retained()).toEqual(persisted);
          expect((await owner()).generation).toBe(originalOwner.generation);
          const originalRow = persisted.receipts.find(
            ({ command_id }) => command_id === commandId,
          )!;
          const lookup = async (key: string) =>
            (await retained()).receipts.find(
              ({ command_id }) => command_id === key,
            )?.result;
          if (mode === 'cold-no-location') {
            const migration = await lab.owner.connect();
            try {
              await migration.query('begin');
              await migration.query(
                'alter table command_receipt disable trigger rdws_authority_writer',
              );
              expect(
                (
                  await migration.query(
                    "update command_receipt set result = result #- '{proof,location}' where actor_id=$1 and command_id=$2 and scope=$3 and operation='write.execute'",
                    [userId, commandId, 'requirement:' + requirementId],
                  )
                ).rowCount,
              ).toBe(1);
              await migration.query(
                'alter table command_receipt enable always trigger rdws_authority_writer',
              );
              await migration.query('commit');
            } catch (error) {
              await migration.query('rollback');
              throw error;
            } finally {
              migration.release();
            }
          }
          let restore: (() => Promise<void>) | undefined;
          if (mode === 'cold-pending') {
            const moved = execution.control + '-original';
            await rename(execution.control, moved);
            await mkdir(execution.control, { mode: 0o700 });
            await copyFile(
              join(moved, basename(proofFile)),
              proofFile,
              constants.COPYFILE_EXCL,
            );
            restore = async () => {
              await unlink(proofFile);
              await rmdir(execution.control);
              await rename(moved, execution.control);
            };
          } else if (mode === 'cold-revoked') {
            const moved = proofFile + '.waiting';
            await rename(proofFile, moved);
            restore = () => rename(moved, proofFile);
          }
          let current: ReturnType<typeof isolatedOwner>;
          try {
            current = await replaceOwner(
              originalOwner,
              mode === 'cold-rollback'
                ? { fault: 'rollback-cold', faultCommand: commandId }
                : mode === 'cold-lost-commit'
                  ? { fault: 'lose-cold', faultCommand: commandId }
                  : mode === 'cold-restart'
                    ? { fault: 'hold-cold', faultCommand: commandId }
                    : mode === 'cold-sync-failure'
                      ? { denyProofSync: true }
                      : mode === 'cold-race'
                        ? {
                            holdProofSync: true,
                            fault: 'lose-cold',
                            faultCommand: commandId,
                            holdLogin: authSessionId,
                          }
                        : undefined,
            );
            if (restore || mode === 'cold-no-location') {
              await expect
                .poll(async () =>
                  /command_receipt[^\n]*->>'runId'/.test(await lab.logs()),
                )
                .toBe(true);
              expect((await retained()).lease).toEqual(persisted.lease);
              const address = await current.address();
              const idle = await command(
                address,
                idleRequirement,
                idleSession,
                { type: 'takeover', commandId: randomUUID() },
              );
              expect(idle.status).toBe(200);
              const { generation: idleGeneration } = await idle.json();
              expect(
                (
                  await command(address, idleRequirement, idleSession, {
                    type: 'release',
                    commandId: randomUUID(),
                    generation: idleGeneration,
                  })
                ).status,
              ).toBe(200);
              if (mode === 'cold-no-location') {
                expect(await lookup(commandId)).not.toHaveProperty('coldStop');
                await current.send({ kind: 'stop' });
                expect(await current.waitForExit()).toEqual([1, null]);
                expect((await retained()).lease).toEqual(persisted.lease);
                return;
              }
              if (mode === 'cold-revoked') {
                const response = await fetch(address + '/api/auth/sign-out', {
                  method: 'POST',
                  headers,
                  body: '{}',
                });
                expect(response.status).toBe(200);
                await response.text();
                expect(
                  (
                    await lab.owner.query(
                      'select id from auth_session where id=$1',
                      [authSessionId],
                    )
                  ).rowCount,
                ).toBe(0);
              }
            }
          } finally {
            await restore?.();
          }

          if (mode === 'cold-race') {
            const address = await current.address();
            await expect
              .poll(() =>
                current.reports.some(({ kind }) => kind === 'proof-sync-held'),
              )
              .toBe(true);
            const trying = command(address, requirementId, sessionId, {
              type: 'takeover',
              commandId: randomUUID(),
            });
            void trying.catch(() => {});
            try {
              await expect
                .poll(() =>
                  current.reports.some(({ kind }) => kind === 'login-held'),
                )
                .toBe(true);
              await current.send({ kind: 'release-fault' });
              await expect
                .poll(
                  () =>
                    current.reports.filter(
                      ({ kind }) => kind === 'proof-sync-completed',
                    ).length,
                )
                .toBeGreaterThanOrEqual(1);
              expect(
                current.reports.some(({ kind }) => kind === 'fault-entered'),
              ).toBe(false);
              expect((await retained()).lease).toEqual(persisted.lease);
            } finally {
              await current.send({ kind: 'release-login' });
            }
            const rejected = await trying;
            expect(rejected.status).toBe(409);
            await rejected.text();
          }
          if (
            mode === 'cold-rollback' ||
            mode === 'cold-lost-commit' ||
            mode === 'cold-race'
          ) {
            await expect
              .poll(() =>
                current.reports.some(({ kind }) => kind === 'fault-entered'),
              )
              .toBe(true);
            expect((await retained()).lease).toEqual(persisted.lease);
            if (mode === 'cold-race') {
              const competing = await command(
                await current.address(),
                requirementId,
                sessionId,
                { type: 'takeover', commandId: randomUUID() },
              );
              expect(competing.status).toBe(409);
              await competing.text();
            }
            await current.send({ kind: 'release-fault' });
            await expect
              .poll(() =>
                current.reports.find(({ kind }) => kind === 'fault-completed'),
              )
              .toEqual({
                kind: 'fault-completed',
                command: mode === 'cold-rollback' ? 'ROLLBACK' : 'COMMIT',
              });
          }
          if (mode === 'cold-sync-failure') {
            await expect
              .poll(() =>
                current.reports.some(
                  ({ kind }) => kind === 'proof-sync-denied',
                ),
              )
              .toBe(true);
            expect((await retained()).lease).toEqual(persisted.lease);
            expect(await lookup(commandId)).not.toHaveProperty('coldStop');
            await current.send({ kind: 'release-fault' });
          }
          const actualStop = await readSupervisedStop(
            execution.runtimeRoot,
            binding,
          );
          await expect
            .poll(() => lookup(commandId))
            .toEqual({
              ...originalRow.result,
              coldStop: {
                runId: binding.runId,
                generation,
                ownerGeneration: originalOwner.generation,
                outcome: actualStop!.outcome,
              },
            });
          if (mode === 'cold-restart') {
            await expect
              .poll(() =>
                current.reports.some(({ kind }) => kind === 'fault-entered'),
              )
              .toBe(true);
            expect((await retained()).lease).toMatchObject({
              generation,
              phase: 'draining',
              run_id: null,
            });
            const beforeResume = await owner();
            expect(current.child.kill('SIGKILL')).toBe(true);
            expect(await current.waitForExit()).toEqual([null, 'SIGKILL']);
            current = await replaceOwner(beforeResume, {
              fault: 'hold-grant',
              faultCommand: takeoverId,
            });
            await expect
              .poll(() =>
                current.reports.some(({ kind }) => kind === 'fault-entered'),
              )
              .toBe(true);
            const held = (await retained()).lease;
            expect(held).toMatchObject({
              phase: 'held',
              native_session_id: takeoverSession,
              run_id: null,
            });
            const issued = await owner();
            expect(current.child.kill('SIGKILL')).toBe(true);
            expect(await current.waitForExit()).toEqual([null, 'SIGKILL']);
            current = await replaceOwner(issued);
            await expect
              .poll(async () => (await retained()).lease)
              .toMatchObject({
                generation: held.generation,
                phase: 'released',
                run_id: null,
              });
            const check = await command(
              await current.address(),
              requirementId,
              takeoverSession,
              originalTakeover,
            );
            expect(await check.json()).toMatchObject({
              state: 'acquired',
              generation: held.generation,
            });
            expect((await retained()).lease.phase).toBe('released');
            return;
          }
          if (mode === 'cold-revoked') {
            await expect
              .poll(() => lookup(takeoverId))
              .toEqual({ state: 'cancelled' });
            expect((await retained()).lease).toMatchObject({
              generation,
              phase: 'released',
              run_id: null,
            });
            return;
          }
          const address = await current.address();
          const publicWriteStatus = async () => {
            const response = await fetch(
              `${address}/api/requirements/${requirementId}/write-authority`,
              { headers, signal: AbortSignal.timeout(2500) },
            );
            expect(response.status).toBe(200);
            return response.json();
          };
          if (pendingTakeover) {
            await expect
              .poll(() => lookup(takeoverId))
              .toMatchObject({
                state: 'acquired',
                generation: expect.any(String),
              });
            const taken = (await retained()).lease;
            expect(taken).toMatchObject({
              phase: 'held',
              native_session_id: takeoverSession,
              run_id: null,
            });
            await expect.poll(publicWriteStatus).toMatchObject({
              state: 'held',
              holder: { generation: taken.generation },
            });
            const replay = await command(
              address,
              requirementId,
              takeoverSession,
              originalTakeover,
            );
            expect(await replay.json()).toMatchObject({
              state: 'acquired',
              generation: taken.generation,
            });
          } else {
            await expect
              .poll(async () => (await retained()).lease)
              .toMatchObject({ generation, phase: 'released', run_id: null });
            await expect
              .poll(publicWriteStatus)
              .toMatchObject({ state: 'idle', canTakeover: true });
            const grant = await command(address, requirementId, sessionId, {
              type: 'takeover',
              commandId: randomUUID(),
            });
            expect(grant.status).toBe(200);
            expect(await grant.json()).toMatchObject({ state: 'acquired' });
          }
          if (mode !== 'cold-unknown')
            await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
          const modern = (await retained()).lease;
          expect(modern.generation).not.toBe(generation);
          if (mode === 'supervised') {
            const confirmed = randomUUID();
            const repeat = await command(address, requirementId, sessionId, {
              type: 'takeover',
              commandId: confirmed,
            });
            expect(await repeat.json()).toMatchObject({
              state: 'acquired',
              generation: modern.generation,
            });
            expect(await lookup(confirmed)).not.toHaveProperty(
              'ownerGeneration',
            );
            const completedProof = await lookup(commandId);
            await current.send({
              kind: 'execute',
              generation,
              commandId,
              scope: {
                projectId,
                requirementId,
                sessionId,
                who: { userId, authSessionId },
              },
            });
            await expect
              .poll(() =>
                current.reports.some(({ kind }) => kind === 'execution-ended'),
              )
              .toBe(true);
            expect(await lookup(commandId)).toEqual(completedProof);
            expect(await readFile(sample, 'utf8')).toBe('baseline|started');
          }
          const nextWrite = randomUUID();
          await current.send({
            kind: 'execute',
            generation: modern.generation,
            commandId: nextWrite,
            scope: {
              projectId,
              requirementId,
              sessionId: pendingTakeover ? takeoverSession : sessionId,
              who: { userId, authSessionId },
            },
          });
          await expect
            .poll(() => lookup(nextWrite), { timeout: 4_000 })
            .toMatchObject({
              status: 'finished',
              result: { status: 'ok', stop: 'confirmed' },
            });
          expect(await readFile(sample, 'utf8')).toBe(
            'baseline|started|started',
          );
          expect(await intact()).toEqual(before);
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
