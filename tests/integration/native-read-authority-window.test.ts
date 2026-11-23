import { execFileSync, fork, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer as httpsServer } from 'node:https';
import { connect, createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import {
  acquireAuthority,
  connectDatabase,
  releaseAuthority,
  schema,
} from '@rdws/db';
import { DemandWorktrees } from '@rdws/orchestrator';
import { RepositoryMirrors } from '@rdws/syncer/mirror';
import { hashPassword } from 'better-auth/crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { Pool as PgPool, type PoolClient } from 'pg';
import { authorityDatabase } from '../helpers/authority-database.ts';
import { fixtureGit, httpsGitFixture } from '../helpers/https-git.ts';
import { modelTlsCertificate } from '../helpers/model-tls.ts';
import {
  createOwnedWriteHandoff,
  type ReadsWindow,
  type WriteHandoffScope as Scope,
} from '../../apps/server/src/modules/write-handoff.ts';

// §11.20.26 L15 / A-05 / A-08 on the page authorization window of the T07
// read loopback. The assembly is the §11.20.25 one (one-shot managed
// PostgreSQL, programmatically managed handoff armed with ReadsWindow,
// loopback TLS 1.3 supplier, independent PG observer). The injection point is
// the interval between the window authorization re-check (T1: the final
// confirmation statement has executed) and the synchronous first write (T2):
// the fault patch holds the confirmation answer before it returns.

const header = 'read-authority-loopback-fixture';
const bodyText = 'generation'.repeat(512);

type Reader = {
  userId: string;
  sessionId: string;
  nativeSessionId: string;
};

type Waiter = { pid: number; blockers: number[]; query: string };

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

// Holds the window's final confirmation answer (after T1, before T2).
function createFaultPatch() {
  const state = {
    fault: null as { kind: 'hold-after-confirm' } | null,
    held: false,
    windowPid: 0,
    release: () => {},
  };
  function install(pool: PgPool) {
    const connectPool = pool.connect.bind(pool);
    const wrapClient = (client: PoolClient) => {
      if ((client as { rdwsReadPatched?: boolean }).rdwsReadPatched)
        return client;
      (client as { rdwsReadPatched?: boolean }).rdwsReadPatched = true;
      const raw = client.query.bind(client) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      client.query = ((...params: unknown[]) => {
        const input = params[0] as string | { text: string };
        const text = typeof input === 'string' ? input : input.text;
        if (
          state.fault?.kind === 'hold-after-confirm' &&
          text.includes('txid_current()')
        ) {
          const gate = new Promise<void>((resolve) => {
            state.release = resolve;
          });
          return raw(...params).then((result) =>
            raw('select pg_backend_pid() as pid').then((pidResult) => {
              state.windowPid = (
                pidResult as { rows: { pid: number }[] }
              ).rows[0]!.pid;
              state.held = true;
              return gate.then(() => result);
            }),
          );
        }
        return raw(...params);
      }) as typeof client.query;
      return client;
    };
    pool.connect = ((...args: unknown[]) => {
      if (typeof args[0] === 'function') {
        const callback = args[0] as (error: Error, client?: PoolClient) => void;
        const wrapped = (error: Error, client?: PoolClient) => {
          if (client) wrapClient(client);
          callback(error, client);
        };
        return Reflect.apply(connectPool, pool, [wrapped]);
      }
      const opened = Reflect.apply(
        connectPool,
        pool,
        args,
      ) as Promise<PoolClient>;
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

async function assemble() {
  const disposable = await authorityDatabase(dockerHost);
  const root = await mkdtemp(join(tmpdir(), 'rdws-read-window-'));
  const certificate = await modelTlsCertificate(root, '127.0.0.1');
  const projectId = 'poc';
  const requirementId = randomUUID();
  const password = randomBytes(24).toString('hex');
  const owner = disposable.owner;
  await owner.query(
    "insert into project(id,name) values($1,'Read window fixture')",
    [projectId],
  );
  const watching = new PgPool({ connectionString: disposable.databaseUrl });
  watching.on('error', () => {});

  const supplier = { requests: [] as { attempt: string; body: Buffer }[] };
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
  const tapSockets = new Set<Socket>();
  let target = 0;
  const tap = createServer((incoming) => {
    const outgoing = connect(target, '127.0.0.1');
    tapSockets.add(incoming);
    tapSockets.add(outgoing);
    incoming.on('data', (bytes) => outgoing.write(bytes));
    outgoing.on('data', (bytes) => incoming.write(bytes));
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
  const readsWindow: ReadsWindow = {
    destination: 'https://127.0.0.1:' + tapPort + '/v1/read-loopback',
    ca: certificate.cert.toString('utf8'),
    header,
  };

  const origin = disposable.childEnv.RDWS_ORIGIN;
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
    return new Promise<string>((resolve, reject) => {
      child.stderr?.on('data', (bytes) => {
        diagnostics += bytes.toString();
      });
      child.once('exit', (code) => {
        if (!notices.length)
          reject(
            new Error(
              'Read window sign-in child exited: ' +
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
          username: 'read_' + base.tag,
          password,
        },
        () => {
          const started = Date.now();
          const poll = () => {
            const report = notices[0] as
              | { status: number; sessionId?: string; userId?: string }
              | undefined;
            if (report) {
              try {
                expect(report.status).toBe(200);
                expect(report.userId).toBe(base.userId);
                resolve(report.sessionId!);
              } catch (error) {
                reject(error as Error);
              }
              return;
            }
            if (Date.now() - started > 10_000) {
              const exited = once(child, 'exit');
              child.kill('SIGKILL');
              void exited.then(() =>
                reject(new Error('Read window sign-in child did not report')),
              );
              return;
            }
            setTimeout(poll, 100);
          };
          poll();
        },
      );
    });
  }

  // A reader holds a project role and the matching requirement participant
  // role (no project admin), so both L15 components are load-bearing.
  async function createReader(index: number) {
    const userId = randomUUID();
    const nativeSessionId = randomUUID();
    const tag = index.toString(36) + randomUUID().slice(0, 8);
    await owner.query(
      "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Read window reader',$2,$3,true,false)",
      [userId, tag + '@read.fixture', 'read_' + tag],
    );
    await owner.query(
      "insert into auth_account(id,account_id,provider_id,user_id,password) values($1,$2,'credential',$2,$3)",
      [randomUUID(), userId, await hashPassword(password)],
    );
    await owner.query('insert into project_member values($1,$2,$3)', [
      projectId,
      userId,
      'tester',
    ]);
    await owner.query('insert into requirement_participant values($1,$2,$3)', [
      requirementId,
      userId,
      'tester',
    ]);
    await owner.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [nativeSessionId, requirementId, userId],
    );
    const sessionId = await signIn({ userId, tag });
    return { userId, sessionId, nativeSessionId };
  }

  const git = await httpsGitFixture(projectId);
  const mirrors = new RepositoryMirrors(git.root);
  const trees = new DemandWorktrees(git.root, mirrors);
  const leadId = randomUUID();
  await owner.query(
    "insert into auth_user(id,name,email,username,active,platform_admin) values($1,'Read window lead','lead@read.fixture','read_lead',true,false)",
    [leadId],
  );
  await owner.query(
    "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,'Read window fixture','','',$3,$3)",
    [requirementId, projectId, leadId],
  );
  const readers: Reader[] = [];
  for (let index = 0; index < 12; index++)
    readers.push(await createReader(index));
  const execution = await (async () => {
    try {
      await writeFile(join(git.work, 'read-doc.txt'), bodyText);
      await fixtureGit(['-C', git.work, 'add', '--', 'read-doc.txt']);
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
  const closedLogins = new Set<string>();
  const handoff = createOwnedWriteHandoff(
    database,
    authority!,
    trees,
    gitPath,
    undefined,
    (authSessionId) => closedLogins.has(authSessionId),
    false,
    true,
    readsWindow,
  );

  return {
    lab: disposable,
    patch,
    handoff,
    pool: database.pool,
    supplier,
    supplierServer: server,
    tapSockets,
    tap,
    projectId,
    requirementId,
    readers,
    closedLogins,
    signIns,
    async close() {
      await handoff.stopReadsEgress();
      await handoff.close().catch(() => {});
      await releaseAuthority(database.pool, authority!).catch(() => {});
      await database.pool.end().catch(() => {});
      for (const socket of tapSockets) socket.destroy();
      await new Promise<void>((resolve) => tap.close(() => resolve()));
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await trees.close().catch(() => {});
      await mirrors.close().catch(() => {});
      await watching.end().catch(() => {});
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

const scopeOf = (reader: Reader): Scope => ({
  projectId: assembly.projectId,
  requirementId: assembly.requirementId,
  sessionId: reader.nativeSessionId,
  who: { userId: reader.userId, authSessionId: reader.sessionId },
});

const readDoc = (reader: Reader, signal?: AbortSignal, live?: () => boolean) =>
  assembly.handoff.readWorktree(
    scopeOf(reader),
    { repositoryId: 'app', path: 'read-doc.txt' },
    undefined,
    signal,
    live,
  );

const attemptRows = async (userId: string) =>
  (
    await observer.query(
      "select result from command_receipt where actor_id=$1 and operation='worktree.read.window' order by created_at",
      [userId],
    )
  ).rows as {
    result: { state?: string; witnessedAt?: number; wire?: string };
  }[];

// The first conflicting row lock of the writer's actual path: the account
// deactivation's UPDATE, or — on the product path, which first takes the
// requirement row FOR UPDATE — the participant DELETE.
async function lockWaiter(pattern: string): Promise<Waiter | undefined> {
  const until = Date.now() + 5_000;
  for (;;) {
    const { rows } = await observer.query(
      "select pid, pg_blocking_pids(pid) as blockers, query from pg_stat_activity where wait_event_type='Lock' and query ilike $1",
      ['%' + pattern + '%'],
    );
    if (rows[0]) return rows[0] as unknown as Waiter;
    if (Date.now() > until) return undefined;
    await delay(15);
  }
}

// Opens a read and parks it between T1 and T2.
async function park(
  reader: Reader,
  signal?: AbortSignal,
  live?: () => boolean,
) {
  assembly.patch.state.held = false;
  assembly.patch.state.fault = { kind: 'hold-after-confirm' };
  const pending = readDoc(reader, signal, live).catch(
    (error: unknown) => error,
  );
  try {
    await expect
      .poll(() => assembly.patch.state.held, { timeout: 5_000 })
      .toBe(true);
    expect(assembly.patch.state.windowPid).toBeGreaterThan(0);
  } catch (error) {
    assembly.patch.state.release();
    assembly.patch.state.fault = null;
    throw error;
  }
  return {
    pid: assembly.patch.state.windowPid,
    pending,
    async release() {
      assembly.patch.state.release();
      assembly.patch.state.fault = null;
    },
  };
}

type BypassResult = { observed: string[]; committedAt: Date };

// A direct-SQL writer that bypasses the in-process barrier: one transaction
// on the proof-bound writer pool. Its conflicting statement blocks on the
// window's row lock; once it returns — the window has committed and released
// its locks — the writer reads the attempt row before committing.
async function bypassWriter(
  reader: Reader,
  prepare: string | undefined,
  conflicting: (writer: PoolClient) => Promise<unknown>,
): Promise<BypassResult> {
  const writer = await assembly.pool.connect();
  try {
    await writer.query('begin');
    if (prepare) await writer.query(prepare, [assembly.requirementId]);
    await conflicting(writer);
    const seen = await writer.query(
      "select result->>'state' as state from command_receipt where actor_id=$1 and operation='worktree.read.window'",
      [reader.userId],
    );
    const committedAt = new Date();
    await writer.query('commit');
    return {
      observed: seen.rows.map((row) => row.state as string),
      committedAt,
    };
  } catch (error) {
    await writer.query('rollback').catch(() => {});
    throw error;
  } finally {
    writer.release();
  }
}

describe.runIf(process.platform === 'darwin')(
  '§11.20.26 L15 page-window authority components and the armed re-check',
  () => {
    beforeAll(async () => {
      assembly = await assemble();
      observer = new PgPool({
        connectionString: assembly.lab.databaseUrl,
      });
    }, 180_000);
    afterAll(async () => {
      await observer?.end().catch(() => {});
      await assembly?.close().catch(() => {});
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

    test('L15 bypass writer: account deactivation after T1 blocks on the auth_user row, commits after the kernel witness, one page frame', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      let deactivation: Promise<BypassResult> | undefined;
      try {
        // Single-statement account deactivation on the proof-bound writer.
        deactivation = bypassWriter(reader, undefined, (writer) =>
          writer.query('update auth_user set active=false where id=$1', [
            reader.userId,
          ]),
        );
        const waiter = await lockWaiter('update auth_user');
        expect(waiter, 'the writer waits on the window row lock').toBeDefined();
        expect(waiter!.query).toContain('update auth_user');
        expect(waiter!.blockers).toContain(parked.pid);
        const idle = await observer.query(
          'select state from pg_stat_activity where pid=$1',
          [parked.pid],
        );
        expect(idle.rows[0]?.state).toBe('idle in transaction');
        await parked.release();
        const page = await parked.pending;
        expect(page).toMatchObject({ text: bodyText });
        const { observed, committedAt } = await deactivation;
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result?.state).toBe('submitted');
        // Strict order by causality: the writer's conflicting statement only
        // returned after the window committed, so it already saw the
        // submitted row; its commit clock is not earlier than the witness.
        expect(observed).toEqual(['submitted']);
        expect(committedAt.getTime()).toBeGreaterThanOrEqual(
          rows[0]!.result!.witnessedAt!,
        );
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
        expect(assembly.supplier.requests.at(-1)!.body.toString()).toBe(
          bodyText,
        );
      } finally {
        await parked.release();
        await deactivation?.catch(() => {});
      }
    });

    test('L15 bypass writer: participation removal after T1 blocks on the participant row, commits after the kernel witness, one page frame', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      let removal: Promise<BypassResult> | undefined;
      try {
        // Product path: the requirement row FOR UPDATE is not a conflicting
        // lock (A-08); the writer first blocks on the participant DELETE.
        removal = bypassWriter(
          reader,
          'select id from requirement where id=$1 for update',
          (writer) =>
            writer.query(
              'delete from requirement_participant where requirement_id=$1 and user_id=$2',
              [assembly.requirementId, reader.userId],
            ),
        );
        const waiter = await lockWaiter('delete from requirement_participant');
        expect(waiter, 'the writer waits on the window row lock').toBeDefined();
        expect(waiter!.blockers).toContain(parked.pid);
        await parked.release();
        const page = await parked.pending;
        expect(page).toMatchObject({ text: bodyText });
        const { observed, committedAt } = await removal;
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result?.state).toBe('submitted');
        expect(observed).toEqual(['submitted']);
        expect(committedAt.getTime()).toBeGreaterThanOrEqual(
          rows[0]!.result!.witnessedAt!,
        );
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
      } finally {
        await parked.release();
        await removal?.catch(() => {});
      }
    });

    test('L15 barrier writer: account deactivation through beginAuthorityChange closes out not-sent after a visible row-lock wait', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      const change = assembly.handoff.changeAuthority(
        randomUUID(),
        ({ who }) => who.userId === reader.userId,
        (tx) =>
          tx
            .update(schema.user)
            .set({ active: false })
            .where(eq(schema.user.id, reader.userId)),
        async () => 'committed',
      );
      try {
        const waiter = await lockWaiter('update "auth_user"');
        expect(waiter, 'the writer waits on the window row lock').toBeDefined();
        expect(waiter!.blockers).toContain(parked.pid);
        await parked.release();
        expect(await parked.pending).toMatchObject({ statusCode: 503 });
        await change;
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result).toMatchObject({
          state: 'zero-write',
          wire: 'not-sent',
        });
        expect(assembly.supplier.requests).toHaveLength(baseline);
      } finally {
        await parked.release();
        await change.catch(() => {});
      }
    });

    test('L15 barrier writer: participation removal through beginAuthorityChange closes out not-sent after a visible row-lock wait', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      const change = assembly.handoff.changeAuthority(
        randomUUID(),
        ({ who }) => who.userId === reader.userId,
        (tx) =>
          tx
            .delete(schema.requirementParticipant)
            .where(eq(schema.requirementParticipant.userId, reader.userId)),
        async () => 'committed',
      );
      try {
        const waiter = await lockWaiter(
          'delete from "requirement_participant"',
        );
        expect(waiter, 'the writer waits on the window row lock').toBeDefined();
        expect(waiter!.blockers).toContain(parked.pid);
        await parked.release();
        expect(await parked.pending).toMatchObject({ statusCode: 503 });
        await change;
        const rows = await attemptRows(reader.userId);
        expect(rows).toHaveLength(1);
        expect(rows[0]!.result).toMatchObject({
          state: 'zero-write',
          wire: 'not-sent',
        });
        expect(assembly.supplier.requests).toHaveLength(baseline);
      } finally {
        await parked.release();
        await change.catch(() => {});
      }
    });

    test('A-08: an ordinary requirement write during the window is neither blocked nor a gate waiter and the page is certified', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      try {
        const started = Date.now();
        await assembly.pool.query(
          'update requirement set title=$2 where id=$1',
          [assembly.requirementId, 'Ordinary write ' + randomUUID()],
        );
        expect(Date.now() - started).toBeLessThan(1_000);
        const waiting = await observer.query(
          'select count(*)::int as waiters from pg_stat_activity where wait_event_type=$1 and $2 = any(pg_blocking_pids(pid))',
          ['Lock', parked.pid],
        );
        expect(waiting.rows[0]!.waiters).toBe(0);
        await parked.release();
        const page = await parked.pending;
        expect(page).toMatchObject({ text: bodyText });
        const rows = await attemptRows(reader.userId);
        expect(rows[0]!.result?.state).toBe('submitted');
        expect(assembly.supplier.requests).toHaveLength(baseline + 1);
      } finally {
        await parked.release();
      }
    });

    test('A-05: a fence, a login close, the read abort signal and a run that is no longer current between T1 and T2 close out not-sent with zero frames', async () => {
      for (const cause of [
        'fence',
        'login',
        'abort',
        'run-not-current',
      ] as const) {
        const reader = assembly.readers.shift()!;
        const baseline = assembly.supplier.requests.length;
        const controller = new AbortController();
        // The FD3 request's run liveness (A-02): a cancelled or released run
        // turns false before the window is released.
        let current = true;
        const parked = await park(reader, controller.signal, () => current);
        const fence =
          cause === 'fence'
            ? assembly.handoff.beginAuthorityChange(
                ({ who }) => who.userId === reader.userId,
              )
            : undefined;
        if (cause === 'login') assembly.closedLogins.add(reader.sessionId);
        if (cause === 'abort') controller.abort();
        if (cause === 'run-not-current') current = false;
        try {
          await parked.release();
          expect(await parked.pending).toMatchObject({ statusCode: 503 });
          const rows = await attemptRows(reader.userId);
          expect(rows.at(-1)!.result).toMatchObject({
            state: 'zero-write',
            wire: 'not-sent',
          });
          expect(assembly.supplier.requests).toHaveLength(baseline);
        } finally {
          await parked.release();
          assembly.closedLogins.delete(reader.sessionId);
          await fence?.committed();
        }
      }
    });

    test('A-05: shutdown between T1 and T2 closes out not-sent with zero frames', async () => {
      const reader = assembly.readers.shift()!;
      const baseline = assembly.supplier.requests.length;
      const parked = await park(reader);
      try {
        assembly.handoff.stopAdmission();
        await parked.release();
        expect(await parked.pending).toMatchObject({ statusCode: 503 });
        const rows = await attemptRows(reader.userId);
        expect(rows.at(-1)!.result).toMatchObject({
          state: 'zero-write',
          wire: 'not-sent',
        });
        expect(assembly.supplier.requests).toHaveLength(baseline);
      } finally {
        await parked.release();
      }
    });
  },
);
