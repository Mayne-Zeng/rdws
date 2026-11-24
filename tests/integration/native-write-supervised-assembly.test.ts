import { execFileSync, fork } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { hashPassword } from 'better-auth/crypto';
import {
  readSupervisedStop,
  type ExecutionProofBinding,
} from '@rdws/dsh/execution/supervised';
import { expect, test } from 'vitest';
import type {
  OwnerBoot,
  OwnerCommand,
  OwnerReport,
} from '../fixtures/t07-paused-owner.ts';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';

// §11.20.27 A segment, first step and W15 (supervised side): the supervised
// protocol is co-assembled with the mediated write tools. A model-writable
// test process is driven straight through the Broker; while it runs the BFF
// is SIGKILLed and an independent ps is the evidence.
//   legacy: without supervision the test process outlives the BFF, keeps
//     its tree write permission and has no platform deadline — the W15
//     criterion is false for it (the red light; RDWS_W15_EXPECT_SUPERVISED=1
//     turns that into a failing run).
//   supervised: the supervisor stops the process on the IPC disconnect,
//     the process group is gone (ESRCH), the durable stop proof is
//     published, and the requirement stays read-only until the cold start
//     consumes the proof and settles the original execution.
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
  const send = (command: OwnerCommand) =>
    new Promise<void>((resolve, reject) => {
      child.send(command, (error) => (error ? reject(error) : resolve()));
    });
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

type Identity = { pid: number; group: number; started: string };
// Independent ps evidence: the process running the test file, with its
// group and start time, so that a reused pid is never mistaken for it.
function testProcess(match: string): Identity | undefined {
  const listing = execFileSync(
    '/bin/ps',
    ['-axo', 'pid=,pgid=,lstart=,command='],
    { encoding: 'utf8' },
  );
  for (const row of listing.split('\n')) {
    if (!row.includes(match)) continue;
    const tokens = row.trim().split(/\s+/);
    const [pid, group] = tokens;
    const started = tokens.slice(2, 7).join(' ');
    if (pid && group && started)
      return { pid: Number(pid), group: Number(group), started };
  }
  return undefined;
}
function gone(pid: number) {
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    return true;
  }
}
async function fingerprint(directory: string) {
  const hash = createHash('sha256');
  for (const file of (
    await readdir(directory, { recursive: true, withFileTypes: true })
  )
    .filter((entry) => entry.isFile())
    .map((entry) => join(entry.parentPath, entry.name))
    .sort()) {
    hash.update(relative(directory, file) + '\0');
    hash.update(await readFile(file));
  }
  return hash.digest('hex');
}

const slowTest = `
import { existsSync, writeFileSync } from 'node:fs';
import { test } from 'node:test';
// A model-written test that keeps running and keeps writing inside the
// tree until the fixture says stop; it has no deadline of its own.
test('long running', async () => {
  writeFileSync('fixture-running', String(process.pid) + '\\n');
  let beats = 0;
  while (!existsSync('fixture-stop')) {
    writeFileSync('fixture-heartbeat', String(++beats) + '\\n');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
});
`;

test
  .skipIf(process.platform !== 'darwin')
  .each(['legacy', 'supervised', 'takeover-crash'] as const)(
  '§11.20.27 W15 a BFF killed during a write tool execution: %s assembly',
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
      throw new Error('The fixture requires a local Docker socket');
    const lab = await authorityDatabase(dockerHost);
    const ownContainer = lab.containerName;
    const children: ReturnType<typeof isolatedOwner>[] = [];
    let git: Awaited<ReturnType<typeof httpsGitFixture>> | undefined;
    let gitPrepared = false;
    let stopped = false;
    let stopFile: string | undefined;
    let identity: Identity | undefined;
    const projectId = 'poc';
    const requirementId = randomUUID();
    const sessionId = randomUUID();
    const userId = randomUUID();
    // The second developer of W17: the takeover that is draining when the
    // BFF is killed.
    const otherId = randomUUID();
    const otherSession = randomUUID();
    const commandId = randomUUID();
    const takeoverId = randomUUID();
    const ticket = () => randomBytes(32).toString('hex');
    const digest = (value: string) =>
      createHash('sha256').update(value).digest('hex');
    const owner = async () =>
      (
        await lab.owner.query<{
          generation: string | null;
          proof_digest: string | null;
        }>(
          'select generation,proof_digest from rdws_authority.owner where singleton',
        )
      ).rows[0]!;
    const lease = async () =>
      (
        await lab.owner.query(
          'select * from requirement_write_lease where requirement_id=$1',
          [requirementId],
        )
      ).rows[0];
    const receipt = async () =>
      (
        await lab.owner.query(
          'select result from command_receipt where scope=$1 and command_id=$2',
          ['requirement:' + requirementId, commandId],
        )
      ).rows[0]?.result as
        | {
            status: string;
            runId?: string;
            proof?: { binding: ExecutionProofBinding };
            coldStop?: unknown;
          }
        | undefined;
    try {
      const password = ticket();
      await lab.owner.query(
        "insert into project(id,name) values ($1,'Write supervised fixture')",
        [projectId],
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Fixture dev','dev@fixture.invalid','fixture_dev',true)",
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
      await lab.owner.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Write supervised fixture','','',$3,$3)",
        [requirementId, projectId, userId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, userId],
      );
      await lab.owner.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
        [sessionId, requirementId, userId],
      );
      await lab.owner.query(
        "insert into auth_user(id,name,email,username,active) values($1,'Other dev','other@fixture.invalid','fixture_other',true)",
        [otherId],
      );
      await lab.owner.query(
        "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
        [randomUUID(), otherId, await hashPassword(password)],
      );
      await lab.owner.query(
        "insert into project_member values($1,$2,'developer')",
        [projectId, otherId],
      );
      await lab.owner.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [requirementId, otherId],
      );
      await lab.owner.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
        [otherSession, requirementId, otherId],
      );
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
      const intact = async () =>
        Promise.all([fingerprint(sources), fingerprint(execution.store)]);
      const before = await intact();
      // The test file the model would have written.
      await writeFile(join(execution.tree, 'slow.test.mjs'), slowTest, {
        mode: 0o644,
      });
      stopFile = join(execution.tree, 'fixture-stop');
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
      const boot: OwnerBoot = {
        root,
        origin,
        databaseUrl: lab.databaseUrl,
        secret: lab.childEnv.BETTER_AUTH_SECRET,
        // The supervised co-assembly of §11.20.27 (the §11.20.22 ban lifted).
        ...(mode !== 'legacy' && { supervisedExecution: true }),
        // W17: the takeover is held inside its draining transaction, so the
        // old test process is still running when the BFF is killed.
        ...(mode === 'takeover-crash' && {
          fault: 'hold-takeover' as const,
          faultCommand: takeoverId,
        }),
        gitPath: execFileSync('/usr/bin/which', ['git'], {
          encoding: 'utf8',
        }).trim(),
        ticket: initialTicket,
      };
      const start = (startupTicket: string) => {
        const run = isolatedOwner({ ...boot, ticket: startupTicket });
        children.push(run);
        return run;
      };
      const old = start(initialTicket);
      const address = await old.address();
      const login = await fetch(address + '/api/auth/sign-in/username', {
        method: 'POST',
        headers: { origin, 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'fixture_dev', password }),
        redirect: 'error',
        signal: AbortSignal.timeout(2_500),
      });
      expect(login.status).toBe(200);
      const cookie = login.headers
        .getSetCookie()
        .map((value) => value.split(';')[0])
        .join('; ');
      await login.text();
      const observed = await fetch(address + '/api/auth/get-session', {
        headers: { cookie },
        redirect: 'error',
        signal: AbortSignal.timeout(2_500),
      });
      const { session } = (await observed.json()) as {
        session: { id: string };
      };
      const headers = {
        origin,
        cookie,
        'x-rdws-edit-session': session.id,
        'content-type': 'application/json',
      };
      const command = (base: string, input: unknown, check = false) =>
        fetch(
          `${base}/api/requirements/${requirementId}/sessions/${sessionId}/write-authority/${check ? 'check' : 'commands'}`,
          {
            method: 'POST',
            headers,
            body: JSON.stringify(input),
            redirect: 'error',
            signal: AbortSignal.timeout(2_500),
          },
        );
      const first = { type: 'acquire' as const, commandId: randomUUID() };
      const grant = await command(address, first);
      expect(grant.status).toBe(200);
      const { generation } = (await grant.json()) as { generation: string };
      const originalOwner = await owner();
      // Broker-driven long-running test process (the write tool execution).
      await old.send({
        kind: 'execute',
        scope: {
          projectId,
          requirementId,
          sessionId,
          who: { userId, authSessionId: session.id },
        },
        generation,
        commandId,
        testPath: 'slow.test.mjs',
      });
      await expect
        .poll(
          async () => {
            try {
              return /^\d+\n$/.test(
                await readFile(join(execution.tree, 'fixture-running'), 'utf8'),
              );
            } catch {
              return false;
            }
          },
          { timeout: 5_000 },
        )
        .toBe(true);
      // Independent ps: the test process, its group and start time.
      await expect
        .poll(() => testProcess('slow.test.mjs'), { timeout: 3_000 })
        .toBeDefined();
      identity = testProcess('slow.test.mjs')!;
      const beats = async () =>
        Number(
          (
            await readFile(join(execution.tree, 'fixture-heartbeat'), 'utf8')
          ).trim(),
        );
      const firstBeat = await beats();
      await delay(120);
      expect(await beats()).toBeGreaterThan(firstBeat);
      const saved = await receipt();
      const binding = saved?.proof?.binding;
      if (mode !== 'legacy') expect(saved?.status).toBe('reserved');
      // W17: the second developer takes over while the test process still
      // runs; the takeover drains the old generation and is pending.
      let otherIdentity: { cookie: string; session: string } | undefined;
      if (mode === 'takeover-crash') {
        const otherLogin = await fetch(address + '/api/auth/sign-in/username', {
          method: 'POST',
          headers: { origin, 'content-type': 'application/json' },
          body: JSON.stringify({ username: 'fixture_other', password }),
          redirect: 'error',
          signal: AbortSignal.timeout(2_500),
        });
        expect(otherLogin.status).toBe(200);
        const otherCookie = otherLogin.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
        await otherLogin.text();
        const otherObserved = await fetch(address + '/api/auth/get-session', {
          headers: { cookie: otherCookie },
          redirect: 'error',
          signal: AbortSignal.timeout(2_500),
        });
        const other = (await otherObserved.json()) as {
          session: { id: string };
        };
        otherIdentity = { cookie: otherCookie, session: other.session.id };
        void fetch(
          `${address}/api/requirements/${requirementId}/sessions/${otherSession}/write-authority/commands`,
          {
            method: 'POST',
            headers: {
              origin,
              cookie: otherCookie,
              'x-rdws-edit-session': other.session.id,
              'content-type': 'application/json',
            },
            body: JSON.stringify({ type: 'takeover', commandId: takeoverId }),
            redirect: 'error',
            signal: AbortSignal.timeout(2_500),
          },
        )
          .then((response) => response.text())
          .catch(() => {});
        await expect
          .poll(() => old.reports.some(({ kind }) => kind === 'fault-entered'))
          .toBe(true);
        expect(await lease()).toMatchObject({
          phase: 'draining',
          run_id: saved!.runId,
        });
        expect(testProcess('slow.test.mjs')).toEqual(identity);
      }

      expect(old.child.kill('SIGKILL')).toBe(true);
      expect(await old.waitForExit()).toEqual([null, 'SIGKILL']);
      const killedAt = Date.now();
      const w15 = async () => {
        // The supervised criterion: the process and its group are gone and
        // the durable stop proof is published.
        await expect
          .poll(() => identity && gone(identity.pid) && gone(-identity.group), {
            timeout: 4_000,
            message: 'the test process outlived the BFF',
          })
          .toBe(true);
        expect(testProcess('slow.test.mjs')).toBeUndefined();
        expect(binding).toBeDefined();
        await expect
          .poll(() => readSupervisedStop(execution.runtimeRoot, binding!), {
            timeout: 4_000,
          })
          .toMatchObject({
            binding,
            outcome: { stop: 'confirmed' },
          });
      };
      if (mode !== 'legacy' || process.env.RDWS_W15_EXPECT_SUPERVISED === '1') {
        await w15();
        // Read-only until the cold start settles the original execution.
        // W17: the takeover reference and the draining phase persist, the
        // new generation was never granted (the lease still names the old
        // generation and the old session), and the second developer never
        // ran anything: at most one actual writer, the stopped old one.
        expect(await lease()).toMatchObject({
          phase: mode === 'takeover-crash' ? 'draining' : 'held',
          generation,
          native_session_id: sessionId,
          run_id: binding!.runId,
          ...(mode === 'takeover-crash' && { takeover: expect.any(Object) }),
        });
        expect(
          (
            await lab.owner.query(
              "select count(*)::int as count from command_receipt where scope=$1 and actor_id=$2 and operation='write.execute'",
              ['requirement:' + requirementId, otherId],
            )
          ).rows[0],
        ).toEqual({ count: 0 });
        // Cold start: a new BFF consumes the proof and settles it.
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
                  originalOwner.generation,
                  originalOwner.proof_digest,
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
        const next = start(nextTicket);
        const nextAddress = await next.address();
        if (mode === 'takeover-crash') {
          // The cold start settles the old execution and continues the
          // persistent pending takeover: only then is the new generation
          // granted, to the second developer's session.
          await expect
            .poll(
              async () => {
                const row = await lease();
                return row?.run_id === null && row.phase === 'held'
                  ? row
                  : undefined;
              },
              {
                timeout: 10_000,
                message: 'the cold start did not continue the takeover',
              },
            )
            .toMatchObject({ phase: 'held', native_session_id: otherSession });
          const modern = await lease();
          expect(modern.generation).not.toBe(generation);
          const asOther = await fetch(
            `${nextAddress}/api/requirements/${requirementId}/sessions/${otherSession}/write-authority/commands`,
            {
              method: 'POST',
              headers: {
                origin,
                cookie: otherIdentity!.cookie,
                'x-rdws-edit-session': otherIdentity!.session,
                'content-type': 'application/json',
              },
              body: JSON.stringify({
                type: 'release',
                commandId: randomUUID(),
                generation: modern.generation,
              }),
              redirect: 'error',
              signal: AbortSignal.timeout(2_500),
            },
          );
          expect(asOther.status, await asOther.text()).toBe(200);
        } else
          await expect
            .poll(
              async () => {
                const row = await lease();
                return row?.phase === 'released' && row.run_id === null;
              },
              {
                timeout: 8_000,
                message: 'the cold start did not settle the execution',
              },
            )
            .toBe(true);
        expect((await receipt())?.coldStop).toMatchObject({
          generation,
          outcome: { stop: 'confirmed' },
        });
        // Before the settlement a fresh acquisition was refused; now the
        // requirement is writable again by a new generation.
        const fresh = { type: 'acquire' as const, commandId: randomUUID() };
        const again = await command(nextAddress, fresh);
        expect(again.status).toBe(200);
        const nextGeneration = (await again.json()) as { generation: string };
        expect(nextGeneration.generation).not.toBe(generation);
        const released = await command(nextAddress, {
          type: 'release',
          commandId: randomUUID(),
          generation: nextGeneration.generation,
        });
        expect(released.status).toBe(200);
        await next.send({ kind: 'stop' });
        expect(await next.waitForExit()).toEqual([0, null]);
        stopped = true;
      } else {
        // The red light, recorded: without supervision the test process
        // outlives the BFF and T06's own 10 s deadline with it, keeps its
        // tree write permission, and no proof is published.
        await delay(Math.max(0, 10_500 - (Date.now() - killedAt)));
        expect(testProcess('slow.test.mjs')).toEqual(identity);
        const laterBeat = await beats();
        await delay(120);
        expect(await beats()).toBeGreaterThan(laterBeat);
        expect(saved?.proof).toBeUndefined();
        expect(saved?.runId).toEqual(expect.any(String));
        expect(
          await readSupervisedStop(execution.runtimeRoot, {
            version: 1,
            runId: saved!.runId!,
            generation,
            ownerGeneration: originalOwner.generation!,
            projectId,
            requirementId,
            repositoryId: 'app',
            actorId: userId,
            commandId,
            receiptDigest: '0'.repeat(64),
          }),
        ).toBeUndefined();
        expect(await lease()).toMatchObject({
          phase: 'held',
          run_id: saved?.runId,
        });
        // The fixture ends the orphan itself; nothing else stops it.
        await writeFile(stopFile!, '', { mode: 0o600, flag: 'wx' });
        await expect
          .poll(() => gone(identity!.pid) && gone(-identity!.group), {
            timeout: 5_000,
          })
          .toBe(true);
      }
      expect(await intact()).toEqual(before);
      expect(await readFile(join(execution.tree, 'sample.txt'), 'utf8')).toBe(
        'baseline',
      );
    } finally {
      const fixtureLabel = `${basename(lab.root)} / ${git ? basename(git.root) : 'no Git fixture'}`;
      try {
        if (stopFile)
          await writeFile(stopFile, '', { mode: 0o600, flag: 'wx' }).catch(
            (error: NodeJS.ErrnoException) => {
              if (error.code !== 'EEXIST') throw error;
            },
          );
        const shutdown = await Promise.allSettled(
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
        expect(shutdown.map(({ status }) => status)).toEqual(
          children.map(() => 'fulfilled'),
        );
        if (identity)
          await expect
            .poll(() => gone(identity!.pid) && gone(-identity!.group), {
              timeout: 28_000,
              message: `Execution is not confirmed stopped. Retaining ${fixtureLabel}.`,
            })
            .toBe(true);
        expect(testProcess('slow.test.mjs')).toBeUndefined();
        stopped = true;
      } finally {
        try {
          await git?.close({ preserveRoot: !gitPrepared || !stopped });
        } finally {
          if (stopped) await lab.close();
          else await Promise.allSettled([lab.owner.end(), lab.admin.end()]);
        }
      }
      // Residue: no container of this run, no process of the test file.
      expect(
        execFileSync('docker', ['ps', '-a', '--format', '{{.Names}}'], {
          encoding: 'utf8',
        }),
      ).not.toContain(ownContainer);
      expect(testProcess('slow.test.mjs')).toBeUndefined();
    }
  },
  60_000,
);
