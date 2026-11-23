import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { sql } from 'drizzle-orm';
import { acquireAuthority, connectDatabase, releaseAuthority } from '@rdws/db';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
import { Pool as PgPool, type PoolClient } from 'pg';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import { checkedWriteTransaction } from '../../apps/server/src/modules/checked-write-transaction.ts';
import {
  createAuthorityWindows,
  windowAttemptKey,
  WindowSealed,
  type WindowWitness,
} from '../../apps/server/src/modules/failure-boundary-window.ts';
type WriteTransaction = Parameters<
  Parameters<ReturnType<typeof checkedWriteTransaction>>[0]
>[0];
import { createWindowedReadEgress } from '../../apps/server/src/modules/windowed-read-egress.ts';
import {
  createOwnedWriteHandoff,
  type ReadsWindow,
} from '../../apps/server/src/modules/write-handoff.ts';

// Deterministic arm-round injection (FB-B1/R2-M1). The pinned model-wire
// primitive normalizes a partial write and a non-EAGAIN writeSync failure
// (EPIPE, ECONNRESET) to one 'indeterminate' outcome, and both depend on
// kernel timing on loopback. Like authorizeModelWireAttempt(attempt, () =>
// 'indeterminate'), the outcome is injected at the primitive boundary; the
// real primitive runs untouched whenever no outcome is armed.
const wire = vi.hoisted(() => ({
  outcome: undefined as 'submitted' | 'not-sent' | 'indeterminate' | undefined,
}));
vi.mock('@rdws/dsh/host/model-wire', async (original) => {
  const actual = await original<typeof import('@rdws/dsh/host/model-wire')>();
  return {
    ...actual,
    submitModelPrefix: (...args: Parameters<typeof actual.submitModelPrefix>) =>
      wire.outcome ?? actual.submitModelPrefix(...args),
  };
});

// §11.20.25 T07 read loopback isolation assembly: one-shot managed
// PostgreSQL, programmatically managed handoff, loopback TLS 1.3 supplier
// behind an independent TCP observer, independent PG observer connections,
// real sign-in and real seat/login revocations.
//
// FAILURE_BOUNDARY_WINDOW=off runs the same assertions against the
// §11.20.24 fence assembly without the mechanism; that run is the red
// evidence (outbound without a coverage certificate).

const windowedAssembly = process.env.FAILURE_BOUNDARY_WINDOW !== 'off';
const header = 'window-loopback-fixture';
const bodyText = 'boundary'.repeat(512);
// FB-B6 two-page file: the first page is exactly one 16 KiB page and the
// continuation carries the remaining tail; both pages cross the window.
const largePageBytes = 16 * 1024;
const largeBodyText =
  'boundary'.repeat(largePageBytes / 'boundary'.length) +
  '\nsecond page\n' +
  'tail'.repeat(100);

type Reader = {
  userId: string;
  sessionId: string;
  nativeSessionId: string;
  revokeSeat: () => Promise<{ committedAt: Date }>;
};

const worktreeRead = async (
  reader: Reader,
  request: { repositoryId: string; path: string } | { cursor: string } = {
    repositoryId: 'app',
    path: 'window-doc.txt',
  },
) =>
  assembly.handoff.readWorktree(
    {
      projectId: assembly.projectId,
      requirementId: assembly.requirementId,
      sessionId: reader.nativeSessionId,
      who: {
        userId: reader.userId,
        authSessionId: reader.sessionId,
      },
    },
    request,
  );

const attemptRows = async (userId: string) =>
  (
    await observer.query(
      "select command_id, result from command_receipt where actor_id=$1 and operation='worktree.read.window' order by created_at",
      [userId],
    )
  ).rows as {
    command_id: string;
    result: { state?: string; witnessedAt?: number };
  }[];

const seatWaiter = async () => {
  for (;;) {
    const { rows } = await observer.query(
      'select pid, pg_blocking_pids(pid) as blockers, query from pg_stat_activity where wait_event_type=' +
        "'Lock'" +
        ' and query ilike ' +
        "'%delete from project_member%'",
    );
    if (rows[0])
      return rows[0] as unknown as {
        pid: number;
        blockers: number[];
        query: string;
      };
    await delay(15);
  }
};

function dockerEndpoint() {
  const endpoint = execFileSync(
    'docker',
    ['context', 'inspect', '--format', '{{(index .Endpoints "docker").Host}}'],
    { encoding: 'utf8' },
  ).trim();
  const dockerHost = process.env.DOCKER_CONTEXT
    ? endpoint
    : process.env.DOCKER_HOST || endpoint;
  if (!dockerHost.startsWith('unix:///'))
    throw new Error('Window fixture requires a local Docker socket');
  return dockerHost;
}

type PatchFault =
  | { kind: 'pause-before-window' }
  | { kind: 'hold-authorize'; onHeld: (pid: number) => void }
  | { kind: 'hold-commit'; onHeld: () => void }
  | { kind: 'lose-commit' }
  | { kind: 'kill-before-commit'; strike: (pid: number) => Promise<void> }
  | { kind: 'lose-prepare-commit' };

function createFaultPatch() {
  const state = {
    fault: null as PatchFault | null,
    windowPid: 0,
    attemptId: '',
    prepareSeen: false,
    releaseAuthorize: () => {},
    releaseCommit: () => {},
  };
  function install(pool: PgPool) {
    const connect = pool.connect.bind(pool);
    const wrapClient = (client: PoolClient) => {
      // Pool clients are checked out repeatedly; wrapping must stay
      // idempotent or each checkout stacks another patch layer.
      if ((client as { rdwsWindowPatched?: boolean }).rdwsWindowPatched)
        return client;
      (client as { rdwsWindowPatched?: boolean }).rdwsWindowPatched = true;
      const raw = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      let prepared = false;
      let windowed = false;
      client.query = ((...params: unknown[]) => {
        const input = params[0] as
          string | { text: string; values?: unknown[] };
        const text = typeof input === 'string' ? input : input.text;
        const values = typeof input === 'string' ? undefined : input.values;
        if (text.startsWith('begin')) {
          // Pool clients are reused across transactions; stale flags from a
          // previous window must not re-arm faults on unrelated commits.
          windowed = false;
          prepared = false;
        }
        if (text.includes('insert into "command_receipt"')) {
          prepared = true;
          state.prepareSeen = true;
        }
        if (text.includes('txid_current()')) {
          windowed = true;
          if (Array.isArray(values)) state.attemptId = String(values[0] ?? '');
          void raw('select pg_backend_pid() as pid').then(
            (result) => {
              state.windowPid = (
                result as { rows: { pid: number }[] }
              ).rows[0]!.pid;
            },
            () => {},
          );
        }
        const fault = state.fault;
        if (
          text.startsWith('begin') &&
          fault?.kind === 'pause-before-window' &&
          state.prepareSeen
        )
          return assembly.lab.pause().then(() => raw(...params));
        if (text === 'commit' && fault) {
          if (fault.kind === 'lose-prepare-commit' && prepared && !windowed)
            return raw(...params).then(() => {
              throw new Error('Prepare commit reply was lost');
            });
          if (windowed && fault.kind === 'hold-commit') {
            const gate = new Promise<void>((resolve) => {
              state.releaseCommit = resolve;
            });
            fault.onHeld();
            return gate.then(() => raw(...params));
          }
          if (windowed && fault.kind === 'lose-commit')
            return raw(...params).then(() => {
              throw new Error('Windowed commit reply was lost');
            });
          if (windowed && fault.kind === 'kill-before-commit')
            return raw('select pg_backend_pid() as pid').then((result) => {
              const pid = (result as { rows: { pid: number }[] }).rows[0]!.pid;
              return fault.strike(pid).then(() => raw(...params));
            });
        }
        if (
          fault?.kind === 'hold-authorize' &&
          text.includes('project_member') &&
          text.includes('for share')
        ) {
          const gate = new Promise<void>((resolve) => {
            state.releaseAuthorize = resolve;
          });
          return raw(...params).then((result) =>
            raw('select pg_backend_pid() as pid').then((pidResult) => {
              const pid = (pidResult as { rows: { pid: number }[] }).rows[0]!
                .pid;
              fault.onHeld(pid);
              return gate.then(() => result);
            }),
          );
        }
        return raw(...params);
      }) as typeof client.query;
      return client;
    };
    pool.connect = ((...args: unknown[]) => {
      // pg-pool's own query path connects with a callback; drizzle connects
      // with a promise. Wrap the client in both styles.
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error, client?: PoolClient) => void;
        const wrapped = (error: Error, client?: PoolClient) => {
          if (client) wrapClient(client);
          callback(error, client);
        };
        return Reflect.apply(connect, pool, [wrapped]);
      }
      const opened = Reflect.apply(connect, pool, args) as Promise<PoolClient>;
      return opened.then((client) => {
        wrapClient(client);
        return client;
      });
    }) as typeof pool.connect;
  }
  return { state, install };
}

const dockerHost = dockerEndpoint();

let assembly!: Awaited<ReturnType<typeof assemble>>;
let observer!: import('pg').Pool;
let verifier!: ReturnType<typeof createAuthorityWindows>;

async function assemble() {
  const disposable = await authorityDatabase(dockerHost);
  const root = await mkdtemp(join(tmpdir(), 'rdws-window-'));
  const certificate = await modelTlsCertificate(root, '127.0.0.1');
  const supplierKeyPath = join(root, 'supplier-key.pem');
  const supplierCertPath = join(root, 'supplier-cert.pem');
  await writeFile(supplierKeyPath, certificate.key);
  await writeFile(supplierCertPath, certificate.cert);
  const projectId = 'poc';
  const requirementId = randomUUID();
  const password = randomBytes(24).toString('hex');
  const owner = disposable.owner;
  await owner.query(
    "insert into project(id,name) values($1,'Window fixture')",
    [projectId],
  );
  const watching = new PgPool({ connectionString: disposable.databaseUrl });
  watching.on('error', () => {});

  const supplier = {
    requests: [] as { attempt: string; body: Buffer }[],
    connections: 0,
  };
  const server = httpsServer(
    {
      key: certificate.key,
      cert: certificate.cert,
      minVersion: 'TLSv1.3',
      maxVersion: 'TLSv1.3',
    },
    (incoming, response) => {
      const parts: Buffer[] = [];
      incoming.on('data', (part) => parts.push(part));
      incoming.on('end', () => {
        supplier.requests.push({
          attempt: String(incoming.headers['x-rdws-window-attempt'] ?? ''),
          body: Buffer.concat(parts),
        });
        response.end('window-supplier-ok');
      });
    },
  );
  server.on('secureConnection', () => supplier.connections++);
  const tapState = { bytes: 0, connections: 0, resetOnResponse: false };
  const tapSockets = new Set<Socket>();
  let target = 0;
  const tap = createServer((incoming) => {
    const outgoing = connect(target, '127.0.0.1');
    tapSockets.add(incoming);
    tapSockets.add(outgoing);
    tapState.connections++;
    incoming.on('data', (bytes) => {
      tapState.bytes += bytes.length;
      outgoing.write(bytes);
    });
    outgoing.on('data', (bytes) => {
      if (tapState.resetOnResponse) {
        tapState.resetOnResponse = false;
        incoming.resetAndDestroy();
        outgoing.destroy();
        return;
      }
      incoming.write(bytes);
    });
    const drop = () => {
      tapSockets.delete(incoming);
      tapSockets.delete(outgoing);
    };
    incoming.once('close', drop);
    outgoing.once('close', drop);
    incoming.on('error', () => {});
    outgoing.on('error', () => {});
  });
  const listen = (listening: Server | import('node:https').Server) =>
    new Promise<number>((resolve, reject) => {
      listening.once('error', reject);
      listening.listen(0, '127.0.0.1', () => {
        resolve((listening.address() as { port: number }).port);
      });
    });
  const supplierPort = await listen(server as unknown as Server);
  target = supplierPort;
  const tapPort = await listen(tap);
  const destination = 'https://127.0.0.1:' + tapPort + '/v1/read-loopback';

  const origin = disposable.childEnv.RDWS_ORIGIN;
  // Every sign-in child is tracked so close() can prove none outlives the run.
  const signIns: ChildProcess[] = [];

  function signIn(base: { userId: string; tag: string }) {
    let diagnostics = '';
    const child = fork(
      new URL('../fixtures/window-auth-server.ts', import.meta.url),
      {
        env: { PATH: process.env.PATH },
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      },
    );
    signIns.push(child);
    const notices: Record<string, unknown>[] = [];
    child.on('message', (value: Record<string, unknown>) =>
      notices.push(value),
    );
    return new Promise<{ sessionId: string; userId: string }>(
      (resolve, reject) => {
        child.stderr?.on('data', (bytes) => {
          diagnostics += bytes.toString();
        });
        child.once('exit', (code) => {
          if (!notices.length)
            reject(
              new Error(
                'Window sign-in child exited: ' +
                  code +
                  ' ' +
                  diagnostics.slice(-400),
              ),
            );
        });
        void child.send(
          {
            databaseUrl: disposable.databaseUrl,
            secret: disposable.childEnv.BETTER_AUTH_SECRET,
            origin,
            username: 'window_' + base.tag,
            password,
          },
          () => {
            const started = Date.now();
            const poll = () => {
              if (notices[0]) {
                const report = notices[0] as {
                  status: number;
                  sessionId?: string;
                  userId?: string;
                };
                try {
                  expect(report.status).toBe(200);
                  expect(report.userId).toBe(base.userId);
                  resolve({
                    sessionId: report.sessionId!,
                    userId: report.userId!,
                  });
                } catch (error) {
                  reject(error as Error);
                }
                return;
              }
              if (Date.now() - started > 10_000) {
                // Failure path: kill and wait so no child outlives the run.
                const exited = once(child, 'exit');
                child.kill('SIGKILL');
                void exited.then(() =>
                  reject(new Error('Window sign-in child did not report')),
                );
                return;
              }
              setTimeout(poll, 100);
            };
            poll();
          },
        );
      },
    );
  }

  async function attachReader(base: {
    userId: string;
    nativeSessionId: string;
  }) {
    await owner.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [base.nativeSessionId, requirementId, base.userId],
    );
  }

  async function createReader(tag: string) {
    const userId = randomUUID();
    const nativeSessionId = randomUUID();
    await owner.query(
      "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Window reader',$2,$3,true,false)",
      [userId, tag + '@window.fixture', 'window_' + tag],
    );
    await owner.query(
      "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
      [randomUUID(), userId, await hashPassword(password)],
    );
    await owner.query('insert into project_member values($1,$2,$3)', [
      projectId,
      userId,
      'project_admin',
    ]);
    return { userId, tag, nativeSessionId };
  }

  async function admit(): Promise<Reader> {
    return readyReaders.pop()!;
  }

  const pendingReaders: {
    userId: string;
    tag: string;
    nativeSessionId: string;
  }[] = [];
  const readyReaders: Reader[] = [];

  async function activateReader(base: {
    userId: string;
    tag: string;
    nativeSessionId: string;
  }): Promise<Reader> {
    const { userId, nativeSessionId } = base;
    const identity = await signIn(base);
    expect(identity.userId).toBe(userId);
    return {
      userId,
      sessionId: identity.sessionId,
      nativeSessionId,
      // The seat delete runs through the managed runtime's own proof-bound
      // pool — exactly the authorized writer production revocations use —
      // and blocks on the window's FOR SHARE of the member row.
      revokeSeat: async () => {
        const deleted = await database.pool.query(
          'delete from project_member where project_id=$1 and user_id=$2 returning clock_timestamp() as committed_at',
          [projectId, userId],
        );
        return { committedAt: new Date(deleted.rows[0]!.committed_at) };
      },
    };
  }

  const git = await httpsGitFixture(projectId);
  const mirrors = new RepositoryMirrors(git.root);
  const trees = new DemandWorktrees(git.root, mirrors);
  const leadBase = await createReader('lead' + randomUUID().slice(0, 6));
  await owner.query(
    "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Window fixture','','',$3,$3)",
    [requirementId, projectId, leadBase.userId],
  );
  await attachReader(leadBase);
  const lead = await activateReader(leadBase);
  void lead;
  for (let index = 0; index < 18; index++) {
    const base = await createReader('r' + index + randomUUID().slice(0, 5));
    await attachReader(base);
    pendingReaders.push(base);
  }
  // Real sign-ins happen while the runtime authority is still unowned; the
  // auth sessions are the same rows the trusted read path and its
  // revocation checks consume afterwards.
  while (pendingReaders.length) {
    const reader = await activateReader(pendingReaders.pop()!).catch(
      (error) => {
        throw new Error(
          'window sign-in failed: ' +
            String(error) +
            ' pending=' +
            pendingReaders.length,
        );
      },
    );
    readyReaders.push(reader);
  }
  const execution = await (async () => {
    try {
      await writeFile(join(git.work, 'window-doc.txt'), bodyText);
      await writeFile(join(git.work, 'window-large.txt'), largeBodyText);
      await fixtureGit(['-C', git.work, 'add', '--', 'window-doc.txt']);
      await fixtureGit(['-C', git.work, 'add', '--', 'window-large.txt']);
      await git.commit();
      await git.update();
      expect(
        await mirrors.sync(
          projectId,
          'app',
          'fixture',
          randomUUID(),
          (publish) => publish(),
        ),
      ).toMatchObject({ status: 'succeeded' });
      const baselines = await mirrors.captureBaselines(projectId);
      const plan = baselines.map((entry) => ({
        ...entry,
        branch: 'rdws/' + requirementId + '/' + entry.repositoryId,
        worktreePath: 'worktrees/' + entry.repositoryId,
        gitStorePath: '.gitstore/' + entry.repositoryId + '.git',
      }));
      await trees.prepare(projectId, requirementId, plan);
      await owner.query('insert into requirement_worktree_plan values($1,$2)', [
        requirementId,
        JSON.stringify(plan),
      ]);
      return await trees.executionScope(projectId, requirementId, plan, 'app');
    } finally {
      try {
        await trees.close();
      } finally {
        await mirrors.close();
      }
    }
  })();
  void execution;
  const gitPath = execFileSync('/usr/bin/which', ['git'], {
    encoding: 'utf8',
  }).trim();

  const patch = createFaultPatch();
  const proof = randomBytes(32).toString('hex');
  const database = connectDatabase(disposable.databaseUrl, proof, 3_000, true);
  patch.install(database.pool);
  const startupTicket = randomBytes(32).toString('hex');
  expect(
    (
      await owner.query(
        'update rdws_authority.owner set managed=true,ticket_digest=$1 where singleton and generation is null',
        [createHash('sha256').update(startupTicket).digest('hex')],
      )
    ).rowCount,
  ).toBe(1);
  const authority = await acquireAuthority(database.pool, true, startupTicket);
  expect(authority).toBeTruthy();
  const readsWindow: ReadsWindow | undefined = windowedAssembly
    ? { destination, ca: certificate.cert.toString('utf8'), header }
    : undefined;
  // Programmatic managed handoff: lease default, no login fence, no
  // supervised execution, read snapshots on, window only when armed.
  const handoff = createOwnedWriteHandoff(
    database,
    authority!,
    trees,
    gitPath,
    undefined,
    undefined,
    false,
    true,
    readsWindow,
  );

  return {
    lab: disposable,
    proof,
    supplierKeyPath,
    supplierCertPath,
    patch,
    handoff,
    pool: database.pool,
    supplier,
    supplierServer: server,
    tapState,
    destination,
    certificate,
    admit,
    requirementId,
    projectId,
    trees,
    mirrors,
    watching,
    root,
    tapSockets,
    signIns,
    async close() {
      await handoff.stopReadsEgress();
      await handoff.close().catch(() => {});
      await releaseAuthority(database.pool, authority!).catch(() => {});
      await database.pool.end().catch(() => {});
      for (const socket of tapSockets) socket.destroy();
      await new Promise<void>((resolve) => tap.close(() => resolve()));
      // Killed writers leave half-open supplier connections that would keep
      // a graceful close pending forever.
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await trees.close().catch(() => {});
      await mirrors.close().catch(() => {});
      await watching.end().catch(() => {});
      // Sign-in children exit on their own once they report; any that are
      // still alive (failed or interrupted sign-ins) is killed and reaped.
      for (const child of signIns) {
        if (child.exitCode !== null || child.signalCode !== null) continue;
        const exited = once(child, 'exit');
        child.kill('SIGKILL');
        await exited;
      }
      await disposable.close().catch(() => {});
      await rm(root, { recursive: true, force: true });
    },
  };
}
describe.runIf(process.platform === 'darwin')(
  '§11.20.25 failure boundary window on the T07 read loopback',
  () => {
    beforeAll(async () => {
      assembly = await assemble();
      // A previously killed run may have left the fixture instance paused.
      await assembly.lab.resume().catch(() => {});
      observer = assembly.watching;
      verifier = createAuthorityWindows(checkedWriteTransaction(assembly.pool));
    });
    // FB-R3B-02: the hook keeps its own 120 s budget so a loaded machine
    // cannot time out the one-shot instance reclaim (config hookTimeout 30 s).
    afterAll(async () => {
      await assembly?.close().catch(() => {});
      // FB-R2B-02/F1: no sign-in child outlives the run.
      for (const child of assembly?.signIns ?? []) {
        let alive = true;
        try {
          process.kill(child.pid!, 0);
        } catch {
          alive = false;
        }
        expect(alive).toBe(false);
      }
    }, 120_000);

    test('A9 positive control: one certified complete loopback body', async () => {
      const reader = await assembly.admit();
      const before = assembly.handoff.readsEgressStats()!;
      const page = await worktreeRead(reader);
      expect(page).toMatchObject({
        totalBytes: bodyText.length,
        truncated: false,
        text: bodyText,
      });
      const baseline = assembly.supplier.requests.length;
      expect(baseline).toBeGreaterThanOrEqual(1);
      expect(assembly.supplier.requests.at(-1)!.body.toString()).toBe(bodyText);
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result?.state).toBe('submitted');
      // FB-R2B-01: the delivery releases its connection once the frame is on
      // the wire; no socket lingers until egress.close().
      await expect
        .poll(() => assembly.handoff.readsEgressStats()?.live)
        .toBe(0);
      expect(assembly.handoff.readsEgressStats()).toMatchObject({
        connections: before.connections + 1,
        armed: before.armed + 1,
        discarded: before.discarded,
        live: 0,
      });
    });

    test('A9 continuation: the second page of a file crosses its own certified window', async () => {
      // FB-B6: FD3 pages never bypass the window. The continuation page is a
      // separate outbound attempt with its own certificate, and the supplier
      // receives each page body exactly once in order.
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      const before = assembly.handoff.readsEgressStats()!;
      const first = await worktreeRead(reader, {
        repositoryId: 'app',
        path: 'window-large.txt',
      });
      expect(first).toMatchObject({
        from: 0,
        through: largePageBytes,
        totalBytes: largeBodyText.length,
        truncated: true,
        text: largeBodyText.slice(0, largePageBytes),
      });
      const cursor = first.cursor;
      expect(cursor).toBeTruthy();
      const second = await worktreeRead(reader, { cursor: cursor! });
      expect(second).toMatchObject({
        from: largePageBytes,
        through: largeBodyText.length,
        totalBytes: largeBodyText.length,
        truncated: false,
        text: largeBodyText.slice(largePageBytes),
      });
      // One coverage certificate per page; without the window the pages
      // still leave but no certificate exists (red: missing evidence).
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(2);
      expect(rows.map(({ result }) => result?.state)).toEqual([
        'submitted',
        'submitted',
      ]);
      expect(
        assembly.supplier.requests
          .slice(baseline)
          .map(({ body }) => body.toString()),
      ).toEqual([
        largeBodyText.slice(0, largePageBytes),
        largeBodyText.slice(largePageBytes),
      ]);
      // One connection per page, both released once their frame is on the
      // wire (the 16 KiB first page delivers its remainder after the
      // certificate, then releases).
      await expect
        .poll(() => assembly.handoff.readsEgressStats()?.live)
        .toBe(0);
      expect(assembly.handoff.readsEgressStats()).toMatchObject({
        connections: before.connections + 2,
        armed: before.armed + 2,
        discarded: before.discarded,
        live: 0,
      });
    });

    test('A1 phase 4: instance silent loss keeps the window closed with zero egress', async () => {
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      const before = assembly.handoff.readsEgressStats()!;
      assembly.patch.state.prepareSeen = false;
      assembly.patch.state.fault = { kind: 'pause-before-window' };
      const started = Date.now();
      try {
        await expect(worktreeRead(reader)).rejects.toMatchObject({
          statusCode: 503,
        });
        const elapsed = Date.now() - started;
        expect(elapsed).toBeGreaterThanOrEqual(2_800);
        expect(elapsed).toBeLessThan(9_000);
      } finally {
        assembly.patch.state.fault = null;
        await assembly.lab.resume().catch(() => {});
      }
      expect(assembly.supplier.requests).toHaveLength(baseline);
      // Zero arming: no writeSync reached the kernel (egress counters frozen)
      // and the sealed close-out aborted the prepared frame exactly once.
      expect(assembly.handoff.readsEgressStats()).toMatchObject({
        armed: before.armed,
        acceptedBytes: before.acceptedBytes,
        discarded: before.discarded + 1,
      });
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result?.state).toBe('prepared');
      const key = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId: rows[0]!.command_id,
        digest: 'any',
      });
      expect(await verifier.readBack(key)).toMatchObject({
        state: 'prepared',
      });
    });

    test('A2 phase 5: lost prepare commit keeps the occupation and refuses a second preparation row', async () => {
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      const key = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId: randomUUID(),
        digest: 'a2',
      });
      assembly.patch.state.fault = { kind: 'lose-prepare-commit' };
      try {
        await expect(verifier.prepare(key)).rejects.toThrow();
      } finally {
        assembly.patch.state.fault = null;
      }
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result?.state).toBe('prepared');
      expect(assembly.supplier.requests).toHaveLength(baseline);
      await expect(verifier.prepare(key)).rejects.toThrow();
      expect(await attemptRows(reader.userId)).toHaveLength(1);
      expect(assembly.supplier.requests).toHaveLength(baseline);
    });

    test('A3 phase 2: in-window revocation is blocked and commits strictly after the kernel witness', async () => {
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      let held = false;
      assembly.patch.state.fault = {
        kind: 'hold-commit',
        onHeld: () => {
          held = true;
        },
      };
      let revocation: { committedAt: Date } | undefined;
      try {
        const pending = worktreeRead(reader).catch(() => 'failed');
        await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
        await expect
          .poll(() => assembly.patch.state.windowPid)
          .toBeGreaterThan(0);
        const seat = reader.revokeSeat().then((value) => {
          revocation = value;
          return value;
        });
        const waiter = await seatWaiter();
        expect(waiter.blockers).toContain(assembly.patch.state.windowPid);
        expect(waiter.query).toContain('delete from project_member');
        const idle = await observer.query(
          'select state from pg_stat_activity where pid=$1',
          [assembly.patch.state.windowPid],
        );
        expect(idle.rows[0]?.state).toBe('idle in transaction');
        assembly.patch.state.releaseCommit();
        const page = await pending;
        expect(page).toMatchObject({ text: bodyText });
        await seat;
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result?.state).toBe('submitted');
        expect(revocation!.committedAt.getTime()).toBeGreaterThan(
          rows[0]!.result!.witnessedAt!,
        );
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
        expect(assembly.supplier.requests.at(-1)!.body.toString()).toBe(
          bodyText,
        );
      } finally {
        assembly.patch.state.releaseCommit();
        assembly.patch.state.fault = null;
      }
    });

    test('A4 phase 3: a waiter at the gate plus a backend termination produce zero writes', async () => {
      for (const variant of ['gate', 'terminate'] as const) {
        const reader = await assembly.admit();
        const baseline = assembly.supplier.requests.length;
        let held = false;
        assembly.patch.state.fault = {
          kind: 'hold-authorize',
          onHeld: () => {
            held = true;
          },
        };
        try {
          const pending = worktreeRead(reader).catch(() => 'failed');
          await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
          const seat = reader.revokeSeat();
          const waiter = await seatWaiter();
          if (variant === 'gate') {
            assembly.patch.state.releaseAuthorize();
          } else {
            await observer.query('select pg_terminate_backend($1)', [
              waiter.blockers[0]!,
            ]);
          }
          expect(await pending).toBe('failed');
          await seat;
          expect(assembly.supplier.requests).toHaveLength(baseline);
          const rows = await attemptRows(reader.userId);
          expect(
            rows.every(({ result }) => result?.state !== 'submitted'),
          ).toBe(true);
          expect(
            rows.some(({ result }) => result?.state === 'zero-write'),
          ).toBe(variant === 'gate');
        } finally {
          assembly.patch.state.releaseAuthorize();
          assembly.patch.state.fault = null;
        }
      }
    });

    test('A5 phase 6: silent connection loss seals once while the server ends the window at 2400ms', async () => {
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      let held = false;
      assembly.patch.state.fault = {
        kind: 'hold-commit',
        onHeld: () => {
          held = true;
        },
      };
      try {
        const started = Date.now();
        const pending = worktreeRead(reader).catch(() => 'failed');
        await expect.poll(() => held, { timeout: 5_000 }).toBe(true);
        expect(await pending).toBe('failed');
        await expect
          .poll(async () => {
            const { rows } = await observer.query(
              'select state from pg_stat_activity where pid=$1',
              [assembly.patch.state.windowPid],
            );
            return rows[0]?.state ?? 'gone';
          })
          .toBe('gone');
        expect(Date.now() - started).toBeGreaterThan(2_000);
      } finally {
        assembly.patch.state.fault = null;
      }
      expect(assembly.supplier.requests).toHaveLength(baseline + 1);
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result?.state).toBe('prepared');
      const before = JSON.stringify(rows);
      await delay(400);
      expect(JSON.stringify(await attemptRows(reader.userId))).toBe(before);
      expect(assembly.supplier.requests).toHaveLength(baseline + 1);
    });

    test('A6 phases 7 and 10: lost commit answers stay sealed with zero replay', async () => {
      let afterPhase7: number | undefined;
      {
        const reader = await assembly.admit();
        const baseline = assembly.supplier.requests.length;
        assembly.patch.state.fault = {
          kind: 'kill-before-commit',
          strike: async (pid) => {
            await observer.query('select pg_terminate_backend($1)', [pid]);
          },
        };
        try {
          await expect(worktreeRead(reader)).rejects.toMatchObject({
            statusCode: 503,
          });
        } finally {
          assembly.patch.state.fault = null;
        }
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result?.state).toBe('prepared');
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
        await delay(300);
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
        afterPhase7 = assembly.supplier.requests.length;
      }
      {
        const reader = await assembly.admit();
        assembly.patch.state.fault = { kind: 'lose-commit' };
        try {
          await expect(worktreeRead(reader)).rejects.toMatchObject({
            statusCode: 503,
          });
        } finally {
          assembly.patch.state.fault = null;
        }
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result?.state).toBe('submitted');
        expect(assembly.supplier.requests).toHaveLength((afterPhase7 ?? 0) + 1);
      }
    });

    test('A7 phase 8: process death kills both sockets and leaves no continuation', async () => {
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      const child = fork(
        new URL('../fixtures/failure-boundary-driver.ts', import.meta.url),
        {
          env: {
            PATH: process.env.PATH,
            RDWS_MODE: 'test',
            RDWS_HOME: assembly.lab.root,
          },
          execArgv: ['--import', 'tsx'],
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        },
      );
      const notices: { kind: string; attemptId?: string }[] = [];
      child.on('message', (value: { kind: string; attemptId?: string }) =>
        notices.push(value),
      );
      const exited = once(child, 'close');
      child.send({
        databaseUrl: assembly.lab.databaseUrl,
        destination: assembly.destination,
        ca: assembly.certificate.cert.toString('utf8'),
        header,
        userId: reader.userId,
        requirementId: assembly.requirementId,
        body: bodyText,
        proof: assembly.proof,
      });
      await expect
        .poll(() => notices.some(({ kind }) => kind === 'witnessed'), {
          timeout: 12_000,
        })
        .toBe(true);
      const witnessed = notices.find(
        ({ kind }) => kind === 'witnessed',
      ) as unknown as { attemptId: string; witness: WindowWitness };
      expect(witnessed.witness.acceptedBytes).toBeGreaterThan(0);
      child.kill('SIGKILL');
      await exited;
      const delivered = assembly.supplier.requests.length;
      expect(delivered).toBeGreaterThanOrEqual(baseline + 1);
      await delay(600);
      expect(assembly.supplier.requests).toHaveLength(delivered);
      const rows = await attemptRows(reader.userId);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.result?.state).toBe('prepared');
      const key = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId: witnessed.attemptId,
        digest: 'driver',
      });
      expect(await verifier.readBack(key)).toMatchObject({
        state: 'prepared',
      });
      // A killed writer's kernel may still flush in-flight bytes; take the
      // stabilized count right before the forbidden re-preparation.
      const stable = assembly.supplier.requests.length;
      await expect(verifier.prepare(key)).rejects.toThrow();
      expect(assembly.supplier.requests).toHaveLength(stable);
    });

    test('A8 phase 9: peer rejection, post-write RST and silent peer loss stay single-shot', async () => {
      const reader = await assembly.admit();
      const egress = createWindowedReadEgress({
        destination: 'https://127.0.0.1:1/v1/read-loopback',
        ca: assembly.certificate.cert.toString('utf8'),
        header,
      });
      try {
        await expect(
          egress.frame({ attemptId: randomUUID(), body: Buffer.from('x') }),
        ).rejects.toThrow();
      } finally {
        await egress.close();
      }
      expect(await attemptRows(reader.userId)).toHaveLength(0);
      // Post-write RST: the supplier resets the moment the request body
      // lands; the certificate still closes because the window commit is
      // independent of the supplier connection.
      {
        const post = await assembly.admit();
        const child = fork(
          new URL('../fixtures/window-supplier.ts', import.meta.url),
          [assembly.supplierKeyPath, assembly.supplierCertPath],
          {
            env: { PATH: process.env.PATH },
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        const notices: { kind: string; bytes?: number }[] = [];
        child.on('message', (value: { kind: string; bytes?: number }) =>
          notices.push(value),
        );
        try {
          await expect
            .poll(() => notices.some(({ kind }) => kind === 'ready'), {
              timeout: 12_000,
            })
            .toBe(true);
          const port = (
            notices.find(({ kind }) => kind === 'ready') as unknown as {
              port: number;
            }
          ).port;
          child.send({ kind: 'rst-once' });
          const egress = createWindowedReadEgress({
            destination: 'https://127.0.0.1:' + port + '/v1/read-loopback',
            ca: assembly.certificate.cert.toString('utf8'),
            header,
          });
          const attemptId = randomUUID();
          const key = windowAttemptKey({
            userId: post.userId,
            requirementId: assembly.requirementId,
            attemptId,
            digest: 'a8b-rst',
          });
          const frame = await egress.frame({
            attemptId,
            body: Buffer.from(bodyText),
          });
          await verifier.prepare(key);
          const outcome = await verifier.open({
            key,
            authorize: async (tx: WriteTransaction) => {
              await tx.execute(sql`select 1`);
            },
            arm: () => frame.arm(),
          });
          expect(outcome).toMatchObject({ state: 'certified' });
          await frame.finish().then(
            () => 'clean',
            () => 'reset',
          );
          await expect
            .poll(() => notices.some(({ kind }) => kind === 'reset'), {
              timeout: 5_000,
            })
            .toBe(true);
          const reset = notices.find(
            ({ kind }) => kind === 'reset',
          ) as unknown as { bytes: number };
          expect(reset.bytes).toBe(bodyText.length);
          expect(await verifier.readBack(key)).toMatchObject({
            state: 'submitted',
          });
          await delay(400);
          // Zero retry: the reset notice stays the only peer event.
          expect(notices.filter(({ kind }) => kind !== 'ready')).toHaveLength(
            1,
          );
          await egress.close();
        } finally {
          child.kill('SIGKILL');
        }
      }
      {
        const half = await assembly.admit();
        const child = fork(
          new URL('../fixtures/window-supplier.ts', import.meta.url),
          [assembly.supplierKeyPath, assembly.supplierCertPath],
          {
            env: { PATH: process.env.PATH },
            execArgv: ['--import', 'tsx'],
            stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
          },
        );
        const notices: { kind: string }[] = [];
        child.on('message', (value: { kind: string }) => notices.push(value));
        try {
          await expect
            .poll(() => notices.some(({ kind }) => kind === 'ready'), {
              timeout: 12_000,
            })
            .toBe(true);
          const port = (
            notices.find(({ kind }) => kind === 'ready') as unknown as {
              port: number;
            }
          ).port;
          const egress = createWindowedReadEgress({
            destination: 'https://127.0.0.1:' + port + '/v1/read-loopback',
            ca: assembly.certificate.cert.toString('utf8'),
            header,
          });
          const attemptId = randomUUID();
          const key = windowAttemptKey({
            userId: half.userId,
            requirementId: assembly.requirementId,
            attemptId,
            digest: 'half-open',
          });
          const frame = await egress.frame({
            attemptId,
            body: Buffer.from(bodyText),
          });
          await verifier.prepare(key);
          const outcome = await verifier.open({
            key,
            authorize: async (tx: WriteTransaction) => {
              await tx.execute(sql`select 1`);
            },
            arm: () => frame.arm(),
          });
          expect(outcome).toMatchObject({ state: 'certified' });
          child.kill('SIGSTOP');
          await frame.finish();
          // The frozen peer may or may not have processed the single body
          // before the freeze; what must hold is that nothing is ever sent
          // again (zero retry, zero continuation).
          await delay(500);
          const processed = notices.filter(
            ({ kind }) => kind === 'request',
          ).length;
          await delay(500);
          expect(notices.filter(({ kind }) => kind === 'request')).toHaveLength(
            processed,
          );
          expect(await verifier.readBack(key)).toMatchObject({
            state: 'submitted',
          });
          await egress.close();
        } finally {
          child.kill('SIGKILL');
        }
      }
    });

    test('A8 phase 9 arm round: an indeterminate kernel write seals instead of closing out as zero-write', async () => {
      // FB-B1/R2-M1: a partial write or an EPIPE landing between the barrier
      // and the arming write leaves coverage in doubt. The pinned primitive
      // normalizes both to 'indeterminate'; the window must keep the row
      // prepared and the occupation taken, never record a zero-write.
      const reader = await assembly.admit();
      const baseline = assembly.supplier.requests.length;
      const attemptId = randomUUID();
      const key = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId,
        digest: 'a8-indeterminate',
      });
      const egress = createWindowedReadEgress({
        destination: assembly.destination,
        ca: assembly.certificate.cert.toString('utf8'),
        header,
      });
      wire.outcome = 'indeterminate';
      try {
        const direct = await egress.frame({
          attemptId: randomUUID(),
          body: Buffer.from(bodyText),
        });
        expect(() => direct.arm()).toThrow(WindowSealed);
        direct.abort();
        const frame = await egress.frame({
          attemptId,
          body: Buffer.from(bodyText),
        });
        await verifier.prepare(key);
        const outcome = await verifier.open({
          key,
          authorize: async (tx: WriteTransaction) => {
            await tx.execute(sql`select 1`);
          },
          arm: () => frame.arm(),
        });
        frame.abort();
        expect(outcome).toEqual({
          state: 'sealed',
          reason: 'certificate-lost',
        });
        expect(await verifier.readBack(key)).toMatchObject({
          state: 'prepared',
        });
        await expect(verifier.prepare(key)).rejects.toThrow();
        expect(await attemptRows(reader.userId)).toMatchObject([
          { command_id: attemptId, result: { state: 'prepared' } },
        ]);
        expect(assembly.supplier.requests).toHaveLength(baseline);
        expect(egress.stats()).toMatchObject({
          armed: 0,
          acceptedBytes: 0,
          discarded: 2,
        });
      } finally {
        wire.outcome = undefined;
        await egress.close();
      }
    });

    test('A8 phase 9 window layer: an indeterminate witness seals while a provable not-sent closes out as zero-write', async () => {
      // F3: the window's own defense, reached without the egress arm callback.
      // An arming callback that returns wire 'indeterminate' without throwing
      // must still seal (row prepared, occupation kept); only the provable
      // 'not-sent' outcome closes out as zero-write (FB-B1/R2-M1).
      const reader = await assembly.admit();
      const sealed = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId: randomUUID(),
        digest: 'window-indeterminate',
      });
      await verifier.prepare(sealed);
      expect(
        await verifier.open({
          key: sealed,
          authorize: async (tx: WriteTransaction) => {
            await tx.execute(sql`select 1`);
          },
          arm: () => ({
            acceptedBytes: 0,
            witnessedAt: Date.now(),
            wire: 'indeterminate',
          }),
        }),
      ).toEqual({ state: 'sealed', reason: 'certificate-lost' });
      expect(await verifier.readBack(sealed)).toMatchObject({
        state: 'prepared',
      });
      await expect(verifier.prepare(sealed)).rejects.toThrow();
      const notSent = windowAttemptKey({
        userId: reader.userId,
        requirementId: assembly.requirementId,
        attemptId: randomUUID(),
        digest: 'window-not-sent',
      });
      await verifier.prepare(notSent);
      expect(
        await verifier.open({
          key: notSent,
          authorize: async (tx: WriteTransaction) => {
            await tx.execute(sql`select 1`);
          },
          arm: () => ({
            acceptedBytes: 0,
            witnessedAt: Date.now(),
            wire: 'not-sent',
          }),
        }),
      ).toEqual({
        state: 'zero-write',
        reason: 'transport-not-sent',
        waiters: 0,
      });
      expect(await verifier.readBack(notSent)).toMatchObject({
        state: 'zero-write',
        result: { wire: 'not-sent' },
      });
      expect(await attemptRows(reader.userId)).toMatchObject([
        { command_id: sealed.commandId, result: { state: 'prepared' } },
        { command_id: notSent.commandId, result: { state: 'zero-write' } },
      ]);
    });

    test('A10: the atomic segment has no await and the mutated variant turns red', async () => {
      const source = await readFile(
        new URL(
          '../../apps/server/src/modules/failure-boundary-window.ts',
          import.meta.url,
        ),
        'utf8',
      );
      const begin = source.indexOf('// window-atomic-segment-begin');
      const end = source.indexOf('// window-atomic-segment-end');
      expect(begin).toBeGreaterThan(0);
      expect(end).toBeGreaterThan(begin);
      const segment = source.slice(begin, end);
      expect(segment).not.toMatch(/\bawait\b/);

      // FB-R3B-01: the ordering evidence is same-process happens-before —
      // whether the kernel witness was taken after this process had observed
      // the revocation COMMIT receipt — instead of comparing a PostgreSQL
      // clock_timestamp against the host Date.now() (sub-millisecond margin
      // across two clocks, observed flaky under load).
      const run = async (gap: boolean) => {
        const reader = await assembly.admit();
        const baseline = assembly.supplier.requests.length;
        const attemptId = randomUUID();
        const key = windowAttemptKey({
          userId: reader.userId,
          requirementId: assembly.requirementId,
          attemptId,
          digest: 'a10-mutation',
        });
        const egress = createWindowedReadEgress({
          destination: assembly.destination,
          ca: assembly.certificate.cert.toString('utf8'),
          header,
        });
        try {
          const frame = await egress.frame({
            attemptId,
            body: Buffer.from(bodyText),
          });
          await verifier.prepare(key);
          let witness: WindowWitness | undefined;
          let receiptObserved = false;
          let armAfterReceipt: boolean | undefined;
          let onGap: (() => void) | undefined;
          const reached = new Promise<void>((resolve) => {
            onGap = resolve;
          });
          let resumeGap: (() => void) | undefined;
          const gate = new Promise<void>((resolve) => {
            resumeGap = resolve;
          });
          const consumer = async (tx: WriteTransaction) => {
            await tx.execute(
              sql`set local transaction_timeout='2400ms'; set local lock_timeout='650ms'; set local statement_timeout='950ms'; set local synchronous_commit='on'`,
            );
            // The consumer still locks the seat row, so the queued
            // revocation waits on this transaction until the backend dies.
            await tx.execute(
              sql`select * from project_member where project_id = ${assembly.projectId} and user_id = ${reader.userId} for share`,
            );
            const answer = (await tx.execute(sql`
              select
                (select count(*)::int from pg_locks
                  where locktype = 'transactionid'
                    and transactionid = txid_current()::text::xid
                    and not granted) as waiters,
                (select true from command_receipt
                  where command_id = ${key.commandId}
                    and scope = ${key.scope}
                    and operation = ${key.operation}
                    and actor_id = ${key.actorId}
                  for share) as attempt
            `)) as { rows: { waiters: number; attempt: boolean }[] };
            expect(answer.rows[0]!.waiters).toBe(0);
            expect(answer.rows[0]!.attempt).toBe(true);
            onGap!();
            // The mutation: an await between the final answer and writeSync.
            if (gap) await gate;
            armAfterReceipt = receiptObserved;
            witness = frame.arm();
            return witness;
          };
          const pending = checkedWriteTransaction(assembly.pool)(consumer).then(
            () => 'committed',
            () => 'sealed',
          );
          await reached;
          const seat = reader.revokeSeat();
          if (gap) {
            const waiter = await seatWaiter();
            await observer.query('select pg_terminate_backend($1)', [
              waiter.blockers[0]!,
            ]);
          }
          // The DELETE resolves only once its COMMIT receipt is back.
          await seat;
          receiptObserved = true;
          if (gap) resumeGap!();
          const final = await pending;
          await expect
            .poll(() => assembly.supplier.requests.length)
            .toBe(baseline + 1);
          return {
            armAfterReceipt,
            final,
            acceptedBytes: witness!.acceptedBytes,
            rows: await attemptRows(reader.userId),
          };
        } finally {
          await egress.close();
        }
      };
      // Real segment shape (no await): the witness is taken in the same turn
      // as the final answer, before this process could observe any
      // revocation receipt — the invariant below is green.
      const real = await run(false);
      expect(real).toMatchObject({
        armAfterReceipt: false,
        final: 'committed',
      });
      expect(real.rows).toMatchObject([{ result: { state: 'prepared' } }]);
      // Await-inserted mutant: the revocation COMMIT receipt is observed
      // while the consumer is parked on the gate, then the witness is taken —
      // "the kernel witness precedes any observed in-window revocation
      // commit" (armAfterReceipt === false) is red for this variant.
      const mutant = await run(true);
      expect(mutant).toMatchObject({
        armAfterReceipt: true,
        final: 'sealed',
      });
      expect(mutant.acceptedBytes).toBeGreaterThan(0);
      expect(mutant.rows).toMatchObject([{ result: { state: 'prepared' } }]);
    });
  },
);
