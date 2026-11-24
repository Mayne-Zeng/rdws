import { randomBytes, randomUUID } from 'node:crypto';
import { and, asc, eq, gt, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  acquireAuthority,
  releaseAuthority,
  schema,
  connectDatabase,
} from '@rdws/db';
import {
  maxOutputBudgetBytes,
  readGitMacosWorktree,
  runMacosWorktree,
  type ExecutionRequest,
} from '@rdws/dsh/execution';
import {
  readSupervisedStop,
  runSupervisedMacosWorktree,
  type ExecutionProofBinding,
  type ExecutionProofLocation,
  type SupervisedStopProof,
} from '@rdws/dsh/execution/supervised';
import type { DemandWorktrees } from '@rdws/orchestrator';
import type {
  RequirementWriteAuthority,
  WriteAuthorityCommand as WriteCommand,
  WriteTakeoverState,
} from '@rdws/contracts';
import {
  businessError,
  createBusiness,
  digestOf,
  type Actor,
} from './business.ts';
import { createWorktreeReads } from './worktree-reads.ts';
import {
  createAuthorityWindows,
  windowAttemptKey,
} from './failure-boundary-window.ts';
import { createWindowedReadEgress } from './windowed-read-egress.ts';
import {
  checkedWriteTransaction,
  type WriteTransaction,
} from './checked-write-transaction.ts';
import {
  recordDeliverySnapshotRow,
  type DeliverySnapshotPath,
} from './delivery-snapshot.ts';

type Database = ReturnType<typeof connectDatabase>;
type Queries = Pick<Database['db'], 'select' | 'insert' | 'update' | 'delete'>;
type Lease = typeof schema.requirementWriteLease.$inferSelect;
export type WriteHandoffScope = {
  who: Actor;
  projectId: string;
  requirementId: string;
  sessionId: string;
};
type Scope = WriteHandoffScope;
type Invocation = {
  generation: string;
  commandId: string;
  repositoryId: string;
  request: ExecutionRequest;
  // §11.20.27 W10: the bounded output budget of a write tool Shell call.
  outputLimitBytes?: number;
};
type RunResult = Awaited<ReturnType<typeof runMacosWorktree>>;
type ExecutionProof = {
  stage: 'reserved' | 'armed';
  binding: ExecutionProofBinding;
  location?: ExecutionProofLocation;
};
type ColdStop = {
  runId: string;
  generation: string;
  ownerGeneration: string;
  outcome: SupervisedStopProof['outcome'];
};
type ExecutionReceipt = (
  | { status: 'reserved'; runId: string; proof?: ExecutionProof }
  | CompletedExecution
) & { coldStop?: ColdStop };
type CompletedExecution = {
  status: 'finished' | 'unknown';
  runId: string;
  proof?: ExecutionProof;
  result: Pick<RunResult, 'stop' | 'marker' | 'status' | 'exitCode'>;
};
type ReceiptValue = typeof schema.commandReceipt.$inferInsert;
type Settlement = {
  scope: Scope;
  generation: string;
  receipt: ReceiptValue;
  outcome: CompletedExecution;
  unconfirmedReservation?: true;
};
type Grant = { generation: string; expiresAt: number; contextVersion: number };
type IssuedGrant = Grant & { ownerGeneration: string };
type OnOutput = NonNullable<Parameters<typeof runMacosWorktree>[3]>['onOutput'];
type BeforeCallStart = (contextVersion: number) => void;
type Running = {
  requirementId: string;
  generation: string;
  controller: AbortController;
  done: Promise<ExecutionReceipt>;
};
type Holding = {
  scope: Scope;
  grant: Grant;
  commandId: string;
  timer: NodeJS.Timeout;
  confirmed: boolean;
  unknownCommit?: true;
};
type ReleaseRequest = { scope: Scope; generation: string; commandId: string };
type ReleaseState = 'released' | 'draining';
type PendingRelease = ReleaseRequest & {
  uncertain: boolean;
  assertCurrent: () => void;
  work?: Promise<ReleaseState>;
};
type TakeoverTarget = NonNullable<Lease['takeover']>;
type Takeover = {
  scope: Scope;
  commandId: string;
  previousGeneration: string | null;
  assertCurrent: () => void;
  proposed?: Grant;
  phase: 'initial' | 'verify-initial' | 'draining' | 'verify-final';
  work?: Promise<void>;
  rerun?: true;
  timer?: NodeJS.Timeout;
  failures: number;
};
type AuthorityResolution = 'committed' | 'rolled-back' | 'unknown';
type AuthorityConfirmation = (tx: Queries) => Promise<AuthorityResolution>;

const leases = schema.requirementWriteLease;
const leaseDuration = 30 * 60 * 1000;

class UnknownWriteCommit extends Error {}
class SupersededRelease extends Error {}

function checkLocalExecution(leaseMs: number) {
  if (
    process.platform !== 'darwin' ||
    !Number.isSafeInteger(leaseMs) ||
    leaseMs < 1 ||
    leaseMs > leaseDuration
  )
    throw new Error(
      'Isolated write handoff requires a macOS owner and a bounded lease',
    );
}

export async function validateWriteHandoffDatabase({ pool }: Database) {
  const configuration = await pool.query<{ ready: boolean }>(`
    select current_setting('fsync') = 'on' and not pg_is_in_recovery()
      and not has_table_privilege(current_user, 'public.requirement_write_lease', 'DELETE,TRUNCATE')
      and (select count(distinct t.tgrelid) = 12 from pg_trigger t join pg_class c on c.oid=t.tgrelid
        where c.relnamespace='public'::regnamespace and t.tgenabled='A' and t.tgtype=62
          and t.tgname='rdws_authority_writer'
          and t.tgfoid='rdws_authority.check_writer()'::regprocedure
          and c.relname in ('auth_user','auth_session','auth_account','auth_verification','project',
            'project_member','requirement','requirement_participant','native_session','task',
            'command_receipt','requirement_write_lease')) as ready`);
  if (configuration.rows[0]?.ready !== true)
    throw new Error(
      'Isolated write handoff database protection could not be confirmed',
    );
}

export async function createWriteHandoff(
  connectionString: string,
  ticket: string,
  worktrees: DemandWorktrees,
  gitPath: string,
  leaseMs = leaseDuration,
  readSnapshots = false,
  readsWindow?: ReadsWindow,
) {
  checkLocalExecution(leaseMs);
  const database = connectDatabase(
    connectionString,
    randomBytes(32).toString('hex'),
    3_000,
  );
  let authority: string | null;
  try {
    await validateWriteHandoffDatabase(database);
    authority = await acquireAuthority(database.pool, true, ticket);
    if (!authority)
      throw new Error(
        'Isolated write handoff requires a managed database owner',
      );
  } catch (error) {
    await database.pool.end();
    throw error;
  }
  const owned = authority;
  const handoff = createOwnedWriteHandoff(
    database,
    owned,
    worktrees,
    gitPath,
    leaseMs,
    undefined,
    false,
    readSnapshots,
    readsWindow,
  );
  let shutdown: Promise<void> | undefined;
  async function stop() {
    try {
      await handoff.close();
      await handoff.stopReadsEgress();
      await releaseAuthority(database.pool, owned);
    } finally {
      await database.pool.end();
    }
  }
  return { ...handoff, close: () => (shutdown ??= stop()) };
}

// §11.20.25 assembly-level switch for the checked authorization window on the
// trusted read outbound. Absent (the default), the read path keeps the exact
// §11.20.24 behavior.
export type ReadsWindow = {
  destination: string;
  ca: string;
  header: string;
};

export function createOwnedWriteHandoff(
  { pool, db }: Database,
  authority: string,
  worktrees: DemandWorktrees,
  gitPath: string,
  leaseMs = leaseDuration,
  loginClosed: (id: string) => boolean = () => false,
  supervisedExecution = false,
  readSnapshots = false,
  readsWindow?: ReadsWindow,
) {
  checkLocalExecution(leaseMs);
  if (!authority)
    throw new Error('Write handoff requires a managed database owner');

  const business = createBusiness(db);
  const { reserve, finish, receiptKey, readReceipt } = business.writeReceipts;
  const holdings = new Map<string, Holding>();
  const executions = new Map<string, Running>();
  const settlements = new Map<string, Settlement>();
  const fences = new Set<symbol>();
  const releaseFences = new Map<string, PendingRelease>();
  const takeovers = new Map<string, Takeover>();
  const coldFences = new Set<string>();
  const pendingCalls = new Set<string>();
  type AuthorityChange = {
    phase: 'changing' | 'unknown' | 'committed';
    fence: ReturnType<typeof beginAuthorityChange>;
    confirm: AuthorityConfirmation;
    recovery?: Promise<boolean>;
  };
  const authorityChanges = new Map<string, AuthorityChange>();
  const operations = new Set<Promise<unknown>>();
  let stopping = false;
  type ColdTransition = {
    old: Lease;
    result?: {
      receipt: typeof schema.commandReceipt.$inferSelect;
      stop: ColdStop;
    };
  };
  const uncertainCold = new Map<string, ColdTransition>();
  let recoveryTimer: NodeJS.Timeout | undefined;
  let recoveryWork: Promise<void> | undefined;
  let recoveryCursor: string | undefined;
  const readsEgress = readsWindow
    ? createWindowedReadEgress(readsWindow)
    : undefined;
  const windows = readsWindow
    ? createAuthorityWindows(checkedWriteTransaction(pool))
    : undefined;
  // §11.20.26 windowAuthorize extension point (the "window-checked authority
  // objects" reserved by §11.20.25): the page window locks every component of
  // the read's authority generation G. Lock order follows withModelAuthority's
  // identity()→scope() — session→user→member→(requirement)→participant→
  // nativeSession — so a writer taking the same rows in the same order never
  // waits in a cycle against the window. Participation and account state are
  // judged by the FOR SHARE read-back itself.
  //
  // A-08: the requirement row is re-read for existence without a lock. It has
  // no delete path and never changes id or projectId, so a row lock adds no
  // guarantee, while ordinary business writes on the same requirement (which
  // take that row FOR UPDATE) would become gate waiters and turn concurrent
  // page reads into false 503s. The participation-removal writer therefore
  // blocks on its first conflicting lock, the participant row DELETE.
  async function windowAuthorize(
    tx: WriteTransaction,
    scope: Scope,
    repositoryId: string,
  ) {
    await business.authorizeRequirement(
      scope.who,
      scope.requirementId,
      scope.projectId,
      'reader',
      tx,
      scope.sessionId,
    );
    const [session] = await tx
      .select({
        expiresAt: schema.session.expiresAt,
        authEpoch: schema.session.authEpoch,
      })
      .from(schema.session)
      .where(
        and(
          eq(schema.session.id, scope.who.authSessionId),
          eq(schema.session.userId, scope.who.userId),
        ),
      )
      .for('share');
    if (!session || session.expiresAt <= new Date())
      businessError(401, '登录已失效，请重新登录');
    const [account] = await tx
      .select({ active: schema.user.active, authEpoch: schema.user.authEpoch })
      .from(schema.user)
      .where(eq(schema.user.id, scope.who.userId))
      .for('share');
    if (!account?.active || account.authEpoch !== session.authEpoch)
      businessError(401, '账号已停用');
    const roles = await tx
      .select({ role: schema.projectMember.role })
      .from(schema.projectMember)
      .where(
        and(
          eq(schema.projectMember.projectId, scope.projectId),
          eq(schema.projectMember.userId, scope.who.userId),
        ),
      )
      .orderBy(asc(schema.projectMember.role))
      .for('share');
    if (!roles.length) businessError(403, '无权执行当前需求操作');
    const [demand] = await tx
      .select({ id: schema.requirement.id })
      .from(schema.requirement)
      .where(
        and(
          eq(schema.requirement.id, scope.requirementId),
          eq(schema.requirement.projectId, scope.projectId),
        ),
      );
    if (!demand) businessError(404, '需求不存在');
    const participants = await tx
      .select({
        userId: schema.requirementParticipant.userId,
        role: schema.requirementParticipant.role,
      })
      .from(schema.requirementParticipant)
      .where(
        eq(schema.requirementParticipant.requirementId, scope.requirementId),
      )
      .orderBy(
        asc(schema.requirementParticipant.userId),
        asc(schema.requirementParticipant.role),
      )
      .for('share');
    if (
      !participants.some(
        (participant) =>
          participant.userId === scope.who.userId &&
          roles.some((role) => role.role === participant.role),
      ) &&
      !roles.some((role) => role.role === 'project_admin')
    )
      businessError(403, '无权访问当前需求');
    const [owned] = await tx
      .select({ id: schema.nativeSession.id })
      .from(schema.nativeSession)
      .where(
        and(
          eq(schema.nativeSession.id, scope.sessionId),
          eq(schema.nativeSession.requirementId, scope.requirementId),
          eq(schema.nativeSession.ownerId, scope.who.userId),
        ),
      )
      .for('share');
    if (!owned) businessError(403, '只能核对本人会话的写权操作');
    // Read-only insert-only table (SELECT-only for the application role, row
    // locks would need UPDATE privilege): re-read without a lock.
    const [plan] = await tx
      .select({ repositories: schema.requirementWorktreePlan.repositories })
      .from(schema.requirementWorktreePlan)
      .where(
        eq(schema.requirementWorktreePlan.requirementId, scope.requirementId),
      );
    if (
      !(plan?.repositories as { repositoryId: string }[] | undefined)?.some(
        (entry) => entry.repositoryId === repositoryId,
      )
    )
      businessError(403, '仓库不在需求工作树范围内');
    return session.expiresAt.getTime();
  }
  const windowedRead =
    readsEgress && windows
      ? async (input: {
          scope: Scope;
          repositoryId: string;
          snapshotId: string;
          sha256: string;
          body: Buffer;
          expiresAt: number;
          live: {
            signal: AbortSignal;
            validBefore: number;
            live?: () => boolean;
          };
        }) => {
          const attemptId = randomUUID();
          const key = windowAttemptKey({
            userId: input.scope.who.userId,
            requirementId: input.scope.requirementId,
            attemptId,
            digest: digestOf({
              repositoryId: input.repositoryId,
              snapshotId: input.snapshotId,
              sha256: input.sha256,
            }),
          });
          const prepared = await readsEgress.frame({
            attemptId,
            body: input.body,
          });
          // The login deadline read under lock by the authorization re-check
          // (T1) reaches the armed callback (T2) through this slot.
          let loginValidBefore = 0;
          try {
            await windows.prepare(key);
            const outcome = await windows.open({
              key,
              authorize: async (tx) => {
                loginValidBefore = await windowAuthorize(
                  tx,
                  input.scope,
                  input.repositoryId,
                );
              },
              // §11.20.26 A-05: the armed callback re-checks, in the same
              // event-loop turn and before the synchronous first write, the
              // shortest deadline (login, snapshot, read), the read's abort
              // signal and the fence / shutdown / login-closed state. Any
              // failure is a provable not-sent outcome that closes out as a
              // zero-write (503, no page) through the existing path.
              arm: () => {
                if (
                  Math.min(
                    loginValidBefore,
                    input.live.validBefore,
                    input.expiresAt,
                  ) <= Date.now() ||
                  input.live.signal.aborted ||
                  // The FD3 request deadline (its abort signal) and the run
                  // still being current: a cancelled or released run is a
                  // provable not-sent.
                  (input.live.live && !input.live.live()) ||
                  stopping ||
                  fences.size > 0 ||
                  loginClosed(input.scope.who.authSessionId)
                )
                  return {
                    acceptedBytes: 0,
                    witnessedAt: Date.now(),
                    wire: 'not-sent' as const,
                  };
                return prepared.arm();
              },
            });
            // Zero-write and sealed close-outs release the prepared
            // connection through the single catch-path abort below.
            if (outcome.state === 'zero-write')
              businessError(503, '读取出站窗口零写收尾，请重新读取');
            if (outcome.state === 'sealed')
              businessError(503, '读取出站已封存，请重新读取');
            await prepared.finish();
          } catch (error) {
            prepared.abort();
            throw error;
          }
        }
      : undefined;
  const reads = readSnapshots
    ? createWorktreeReads(
        worktrees,
        (scope, repositoryId, current) =>
          readForCommand(scope, current, async (tx, validBefore) => {
            const [plan] = await tx
              .select({
                repositories: schema.requirementWorktreePlan.repositories,
              })
              .from(schema.requirementWorktreePlan)
              .where(
                eq(
                  schema.requirementWorktreePlan.requirementId,
                  scope.requirementId,
                ),
              );
            if (
              !plan?.repositories.some(
                (entry) => entry.repositoryId === repositoryId,
              )
            )
              businessError(403, '仓库不在需求工作树范围内');
            return { repositories: plan.repositories, validBefore };
          }),
        (scope) => {
          requireLiveLogin(scope);
          if (stopping) businessError(409, '当前读取已失效');
          if (fences.size) businessError(409, '当前权限变更尚待确认');
        },
        windowedRead,
      )
    : undefined;

  async function transaction<T>(
    work: (
      tx: Queries,
      deadline: number,
      confirmConnection: () => void,
    ) => Promise<T>,
    readCommitted = false,
  ) {
    const connection = await pool.connect();
    const deadline = Date.now() + 1800;
    let committed = false;
    let disconnected = false;
    const lost = () => {
      disconnected = true;
    };
    const confirmConnection = () => {
      if (disconnected) throw new Error('Write handoff connection was lost');
    };
    connection.on('error', lost);
    const query = (text: string) => {
      const config = { text, query_timeout: 2400 };
      return connection.query(config);
    };
    try {
      await query(
        readCommitted ? 'begin isolation level read committed' : 'begin',
      );
      await query(
        "set local synchronous_commit='on'; set local transaction_timeout='2400ms'; set local lock_timeout='650ms'; set local statement_timeout='950ms'",
      );
      await query('update auth_session set id=id where false');
      const value = await work(
        drizzle(connection, { schema }),
        deadline,
        confirmConnection,
      );
      confirmConnection();
      let command: string;
      try {
        command = (await query('commit')).command;
      } catch {
        throw new UnknownWriteCommit(
          'Write handoff commit could not be confirmed',
        );
      }
      if (command !== 'COMMIT')
        throw new Error('Write handoff transaction rolled back');
      committed = true;
      return value;
    } finally {
      connection.release(!committed);
      connection.off('error', lost);
    }
  }

  // The trusted read path only ever receives the actor's identity fields.
  function readScope(scope: Scope) {
    return {
      projectId: scope.projectId,
      requirementId: scope.requirementId,
      sessionId: scope.sessionId,
      who: {
        userId: scope.who.userId,
        authSessionId: scope.who.authSessionId,
      },
    };
  }

  function requireLiveLogin(scope: Scope) {
    if (loginClosed(scope.who.authSessionId))
      businessError(401, '登录已失效，请重新登录');
  }

  function context(tx: Queries, scope: Scope) {
    requireLiveLogin(scope);
    return business.writeContext(
      tx,
      scope.who,
      scope.projectId,
      scope.requirementId,
      scope.sessionId,
    );
  }

  function allowed(deadline: number, scope: Scope) {
    requireLiveLogin(scope);
    if (stopping || fenced(scope.requirementId) || !(Date.now() < deadline))
      businessError(409, '写入授权正在变更或已到期');
  }

  function fenced(requirementId: string) {
    return (
      fences.size > 0 ||
      releaseFences.has(requirementId) ||
      takeovers.has(requirementId) ||
      coldFences.has(requirementId)
    );
  }

  async function lockedLease(tx: Queries, requirementId: string) {
    const [row] = await tx
      .select()
      .from(leases)
      .where(eq(leases.requirementId, requirementId))
      .for('update');
    return row;
  }

  function sameHolder(
    row: Lease | undefined,
    scope: Scope,
    generation: string,
  ): row is Lease {
    return (
      !!row &&
      row.generation === generation &&
      row.projectId === scope.projectId &&
      row.nativeSessionId === scope.sessionId &&
      row.ownerId === scope.who.userId &&
      row.authSessionId === scope.who.authSessionId
    );
  }

  // §11.20.27 write binding: listeners told when a write generation of a
  // scope becomes the confirmed holding (acquire and takeover alike), which
  // is when the command set of that generation is registered.
  const grantListeners = new Set<(scope: Scope, grant: Grant) => void>();
  function announceGrant(scope: Scope, grant: Grant) {
    for (const listener of grantListeners)
      Promise.resolve()
        .then(() => listener(structuredClone(scope), { ...grant }))
        .catch(() => {});
  }

  // The confirmed holding of this very session, when it is still usable
  // (live login, no fence, not stopping, not expired); undefined otherwise.
  function currentHolding(scope: Scope) {
    const tracked = holdings.get(scope.requirementId);
    if (
      !tracked?.confirmed ||
      tracked.scope.projectId !== scope.projectId ||
      tracked.scope.sessionId !== scope.sessionId ||
      tracked.scope.who.userId !== scope.who.userId ||
      tracked.scope.who.authSessionId !== scope.who.authSessionId
    )
      return undefined;
    try {
      allowed(tracked.grant.expiresAt, scope);
    } catch {
      return undefined;
    }
    return {
      generation: tracked.grant.generation,
      contextVersion: tracked.grant.contextVersion,
      expiresAt: tracked.grant.expiresAt,
    };
  }

  function confirmedHolding(scope: Scope, generation: string) {
    const tracked = holdings.get(scope.requirementId);
    if (
      tracked?.confirmed &&
      tracked.grant.generation === generation &&
      tracked.scope.projectId === scope.projectId &&
      tracked.scope.sessionId === scope.sessionId &&
      tracked.scope.who.userId === scope.who.userId &&
      tracked.scope.who.authSessionId === scope.who.authSessionId
    )
      return tracked;
  }

  function forget(requirementId: string, generation: string) {
    const tracked = holdings.get(requirementId);
    if (tracked?.grant.generation !== generation) return;
    clearTimeout(tracked.timer);
    holdings.delete(requirementId);
  }

  async function drain(requirementId: string, generation: string) {
    abortExecution(requirementId, generation);
    const runId = await transaction(async (tx) => {
      await tx
        .select({ id: schema.requirement.id })
        .from(schema.requirement)
        .where(eq(schema.requirement.id, requirementId))
        .for('update');
      const old = await lockedLease(tx, requirementId);
      if (!old || old.generation !== generation || old.phase === 'released')
        return null;
      await tx
        .update(leases)
        .set({
          phase: old.runId || old.takeover ? 'draining' : 'released',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leases.requirementId, requirementId),
            eq(leases.generation, generation),
          ),
        );
      return { runId: old.runId, takeover: !!old.takeover };
    });
    if (!runId?.runId) {
      if (runId?.takeover) return 'draining' as const;
      forget(requirementId, generation);
      return 'released' as const;
    }
    const running = executions.get(runId.runId);
    running?.controller.abort();
    await running?.done.catch(() => {});
    const settlement = settlements.get(runId.runId);
    if (settlement) await persistSettlement(settlement);
    const [state] = await db
      .select({ phase: leases.phase })
      .from(leases)
      .where(
        and(
          eq(leases.requirementId, requirementId),
          eq(leases.generation, generation),
        ),
      );
    return state?.phase === 'draining'
      ? ('draining' as const)
      : ('released' as const);
  }

  async function persistSettlement(settlement: Settlement) {
    const { scope, generation, receipt, outcome } = settlement;
    const { runId, result } = outcome;
    const safe = result.stop !== 'unconfirmed' && result.marker !== 'retained';
    const released = await transaction(async (tx) => {
      const old = await lockedLease(tx, scope.requirementId);
      const table = schema.commandReceipt;
      const [saved] = await tx
        .select()
        .from(table)
        .where(
          and(
            eq(table.actorId, receipt.actorId),
            eq(table.scope, receipt.scope),
            eq(table.operation, receipt.operation),
            eq(table.commandId, receipt.commandId),
          ),
        );
      if (!saved && settlement.unconfirmedReservation) {
        await tx.insert(table).values({ ...receipt, result: outcome });
        return false;
      }
      const prior = saved?.result as ExecutionReceipt | undefined;
      if (saved?.digest !== receipt.digest || prior?.runId !== runId)
        businessError(409, '当前执行结算已失效');
      if (prior.status !== 'reserved')
        return !sameHolder(old, scope, generation) || old.phase === 'released';
      if (
        !sameHolder(old, scope, generation) ||
        old.runId !== runId ||
        old.phase === 'released'
      )
        businessError(409, '当前执行结算已失效');
      const phase =
        !safe || old.takeover
          ? 'draining'
          : old.phase === 'draining'
            ? 'released'
            : 'held';
      await tx
        .update(leases)
        .set({ phase, runId: safe ? null : runId, updatedAt: new Date() })
        .where(
          and(
            eq(leases.requirementId, scope.requirementId),
            eq(leases.generation, generation),
            eq(leases.runId, runId),
            eq(leases.phase, old.phase),
          ),
        );
      if (
        outcome.proof &&
        (!prior.proof ||
          digestOf(prior.proof.binding) !== digestOf(outcome.proof.binding))
      )
        businessError(409, '原执行证明尚未确认');
      await finish(
        tx,
        receipt,
        prior.proof ? { ...outcome, proof: prior.proof } : outcome,
      );
      return phase === 'released';
    });
    if (released) forget(scope.requirementId, generation);
    settlements.delete(runId);
    const takeover = takeovers.get(scope.requirementId);
    if (
      safe &&
      takeover?.phase === 'draining' &&
      takeover.previousGeneration === generation
    )
      if (takeover.work) takeover.rerun = true;
      else void reconcileTakeover(takeover);
    return outcome;
  }

  function abortExecution(requirementId: string, generation: string) {
    for (const execution of executions.values())
      if (
        execution.requirementId === requirementId &&
        execution.generation === generation
      )
        execution.controller.abort();
  }

  function propose(scope: Scope, grant: Grant, commandId: string) {
    const previous = holdings.get(scope.requirementId);
    if (previous) clearTimeout(previous.timer);
    const timer = scheduleExpiry(
      scope.requirementId,
      grant,
      Math.max(0, grant.expiresAt - Date.now()),
      0,
    );
    holdings.set(scope.requirementId, {
      scope,
      grant,
      commandId,
      timer,
      confirmed: false,
    });
  }

  function scheduleExpiry(
    requirementId: string,
    grant: Grant,
    delay: number,
    retries: number,
  ): NodeJS.Timeout {
    return setTimeout(() => {
      if (stopping) return;
      const active = holdings.get(requirementId);
      if (active?.grant.generation !== grant.generation) return;
      void track(drain(requirementId, grant.generation)).catch(() => {
        if (!stopping && holdings.get(requirementId) === active && retries < 3)
          active.timer = scheduleExpiry(
            requirementId,
            grant,
            250 * 2 ** retries,
            retries + 1,
          );
      });
    }, delay).unref();
  }

  async function acquire(
    scope: Scope,
    commandId: string,
    assertCurrent: () => void,
  ) {
    let proposed: Grant | undefined;
    const issued = await transaction(async (tx, deadline) => {
      const snapshot = await context(tx, scope);
      const old = await lockedLease(tx, scope.requirementId);
      assertCurrent();
      const receipt = await reserve(
        tx,
        scope.who,
        'requirement:' + scope.requirementId,
        'write.acquire',
        commandId,
        scope,
      );
      if ('result' in receipt) {
        const grant = receipt.result as IssuedGrant;
        if (
          grant.ownerGeneration !== authority ||
          !sameHolder(old, scope, grant.generation) ||
          old.phase !== 'held' ||
          grant.contextVersion !== snapshot.requirement.contextVersion
        )
          businessError(409, '原写入资格已失效，请重新申请');
        allowed(
          Math.min(deadline, snapshot.validBefore, grant.expiresAt),
          scope,
        );
        assertCurrent();
        return { grant, snapshot };
      }
      const tracked = holdings.get(scope.requirementId);
      const retryingRolledBackAcquire =
        tracked?.unknownCommit &&
        !tracked.confirmed &&
        tracked.commandId === commandId &&
        digestOf(tracked.scope) === digestOf(scope);
      if (
        (tracked && !retryingRolledBackAcquire) ||
        (old && (old.phase !== 'released' || old.runId || old.takeover))
      )
        businessError(409, '已有写会话或进程尚待停稳');
      const expiresAt = Math.min(snapshot.validBefore, Date.now() + leaseMs);
      allowed(Math.min(deadline, expiresAt), scope);
      const grant = {
        generation: randomUUID(),
        expiresAt,
        contextVersion: snapshot.requirement.contextVersion,
      };
      const values = {
        requirementId: scope.requirementId,
        projectId: scope.projectId,
        ownerId: scope.who.userId,
        authSessionId: scope.who.authSessionId,
        nativeSessionId: scope.sessionId,
        generation: grant.generation,
        phase: 'held' as const,
        expiresAt: new Date(grant.expiresAt),
        contextVersion: grant.contextVersion,
        runId: null,
        updatedAt: new Date(),
      };
      await tx
        .insert(leases)
        .values(values)
        .onConflictDoUpdate({ target: leases.requirementId, set: values });
      await finish(tx, receipt.value, { ...grant, ownerGeneration: authority });
      assertCurrent();
      allowed(Math.min(deadline, expiresAt), scope);
      proposed = grant;
      propose(scope, grant, commandId);
      return { grant, snapshot };
    }).catch((error: unknown) => {
      const tracked = holdings.get(scope.requirementId);
      if (proposed && tracked?.grant.generation === proposed.generation) {
        if (error instanceof UnknownWriteCommit) tracked.unknownCommit = true;
        else forget(scope.requirementId, proposed.generation);
      }
      throw error;
    });
    const { generation, expiresAt, contextVersion } = issued.grant;
    const tracked = holdings.get(scope.requirementId);
    if (tracked?.grant.generation !== generation)
      businessError(409, '原写入资格已失效，请重新申请');
    allowed(expiresAt, scope);
    assertCurrent();
    tracked.confirmed = true;
    announceGrant(scope, { generation, expiresAt, contextVersion });
    return {
      generation,
      expiresAt,
      contextVersion,
      requirement: issued.snapshot.requirement,
      tasks: issued.snapshot.tasks,
    };
  }

  function commandKey(scope: Scope, command: WriteCommand) {
    return receiptKey(
      scope.who,
      'requirement:' + scope.requirementId,
      'write.' + command.type,
      command.commandId,
      command.type === 'release'
        ? { scope, generation: command.generation }
        : scope,
    );
  }

  async function recordedGeneration(
    tx: Queries,
    scope: Scope,
    command: WriteCommand,
  ) {
    const row = await readReceipt(tx, commandKey(scope, command));
    if (!row) return;
    const result = row.result as { generation?: unknown } | null;
    if (
      typeof result?.generation !== 'string' ||
      (command.type === 'release' && result.generation !== command.generation)
    )
      businessError(409, '原写权回执无法核实');
    return result.generation;
  }

  function readTransaction<T>(work: Parameters<typeof db.transaction<T>>[0]) {
    return db.transaction(
      async (tx) => {
        await tx.execute(sql`set local transaction_timeout='2400ms'`);
        await tx.execute(sql`set local statement_timeout='950ms'`);
        return work(tx);
      },
      { isolationLevel: 'repeatable read', accessMode: 'read only' },
    );
  }

  async function readForCommand<T>(
    scope: Scope,
    assertCurrent: () => void,
    read: (tx: Queries, validBefore: number) => Promise<T>,
  ) {
    requireLiveLogin(scope);
    assertCurrent();
    const { result, validBefore } = await readTransaction(async (tx) => {
      const reader = await business.authorizeRequirement(
        scope.who,
        scope.requirementId,
        scope.projectId,
        'reader',
        tx,
        scope.sessionId,
      );
      const [owned] = await tx
        .select({ id: schema.nativeSession.id })
        .from(schema.nativeSession)
        .where(
          and(
            eq(schema.nativeSession.id, scope.sessionId),
            eq(schema.nativeSession.ownerId, scope.who.userId),
          ),
        );
      if (!owned) businessError(403, '只能核对本人会话的写权操作');
      return {
        result: await read(tx, reader.expiresAt.getTime()),
        validBefore: reader.expiresAt.getTime(),
      };
    });
    requireLiveLogin(scope);
    if (validBefore <= Date.now()) businessError(401, '登录已失效，请重新登录');
    assertCurrent();
    return result;
  }

  async function checkCommand(
    scope: Scope,
    command: WriteCommand,
    assertCurrent: () => void,
  ) {
    if (command.type === 'takeover') {
      const result = await readForCommand(scope, assertCurrent, (tx) =>
        readTakeover(tx, scope, command.commandId),
      );
      return result ?? { state: 'unrecorded' as const };
    }
    const generation = await readForCommand(scope, assertCurrent, (tx) =>
      recordedGeneration(tx, scope, command),
    );
    return generation
      ? { state: 'recorded' as const, generation }
      : { state: 'unrecorded' as const };
  }

  function takeoverKey(scope: Scope, commandId: string) {
    return commandKey(scope, { type: 'takeover', commandId });
  }

  async function readTakeover(
    tx: Queries,
    scope: Scope,
    commandId: string,
  ): Promise<WriteTakeoverState | undefined> {
    const receipt = await readReceipt(tx, takeoverKey(scope, commandId));
    if (!receipt) return;
    const value = receipt.result as Partial<WriteTakeoverState> | null;
    if (value?.state === 'pending' || value?.state === 'cancelled')
      return { state: value.state };
    if (value?.state === 'acquired' && typeof value.generation === 'string')
      return { state: 'acquired', generation: value.generation };
    return businessError(409, '原写权回执无法核实');
  }

  function targetFor({ scope, commandId }: Takeover): TakeoverTarget {
    return { ...scope.who, sessionId: scope.sessionId, commandId };
  }

  function matchesTakeover(
    old: Lease | undefined,
    request: Takeover,
  ): old is Lease {
    return (
      !!old &&
      old.projectId === request.scope.projectId &&
      old.generation === request.previousGeneration &&
      old.phase === 'draining' &&
      !!old.takeover &&
      digestOf(old.takeover) === digestOf(targetFor(request))
    );
  }

  async function lockRequirement(tx: Queries, scope: Scope) {
    await tx
      .select({ id: schema.requirement.id })
      .from(schema.requirement)
      .where(
        and(
          eq(schema.requirement.id, scope.requirementId),
          eq(schema.requirement.projectId, scope.projectId),
        ),
      )
      .for('update');
  }

  async function assignTakeover(
    tx: Queries,
    request: Takeover,
    snapshot: Awaited<ReturnType<typeof context>>,
    deadline: number,
  ) {
    const { scope, commandId } = request;
    const expiresAt = Math.min(snapshot.validBefore, Date.now() + leaseMs);
    requireLiveLogin(scope);
    if (
      stopping ||
      fences.size ||
      releaseFences.has(scope.requirementId) ||
      coldFences.has(scope.requirementId) ||
      takeovers.get(scope.requirementId) !== request ||
      Math.min(expiresAt, deadline) <= Date.now()
    )
      businessError(409, '写入授权正在变更或已到期');
    if (request.phase === 'initial') request.assertCurrent();
    const grant = {
      generation: randomUUID(),
      expiresAt,
      contextVersion: snapshot.requirement.contextVersion,
    };
    const values = {
      requirementId: scope.requirementId,
      projectId: scope.projectId,
      ownerId: scope.who.userId,
      authSessionId: scope.who.authSessionId,
      nativeSessionId: scope.sessionId,
      generation: grant.generation,
      phase: 'held' as const,
      expiresAt: new Date(expiresAt),
      contextVersion: grant.contextVersion,
      runId: null,
      takeover: null,
      updatedAt: new Date(),
    };
    await tx
      .insert(leases)
      .values(values)
      .onConflictDoUpdate({ target: leases.requirementId, set: values });
    const outcome = {
      state: 'acquired',
      generation: grant.generation,
    } as const;
    await finish(tx, takeoverKey(scope, commandId), {
      ...outcome,
      ownerGeneration: authority,
    });
    if (request.phase === 'initial') request.assertCurrent();
    requireLiveLogin(scope);
    if (
      stopping ||
      fences.size ||
      coldFences.has(scope.requirementId) ||
      Math.min(expiresAt, deadline) <= Date.now()
    )
      businessError(409, '写入授权正在变更或已到期');
    request.proposed = grant;
    propose(scope, grant, commandId);
    return outcome;
  }

  async function prepareTakeover(
    request: Takeover,
  ): Promise<WriteTakeoverState> {
    const { scope, commandId, previousGeneration } = request;
    return transaction(async (tx, deadline) => {
      const snapshot = await context(tx, scope);
      const old = await lockedLease(tx, scope.requirementId);
      const prior = await readTakeover(tx, scope, commandId);
      if (prior) {
        if (prior.state === 'pending' && !matchesTakeover(old, request))
          businessError(409, '原接手状态尚待确认');
        return prior;
      }
      if (
        (old?.generation ?? null) !== previousGeneration ||
        old?.takeover ||
        stopping ||
        fences.size ||
        releaseFences.has(scope.requirementId) ||
        coldFences.has(scope.requirementId) ||
        takeovers.get(scope.requirementId) !== request ||
        Math.min(deadline, snapshot.validBefore) <= Date.now()
      )
        businessError(409, '写入状态正在变更，请重新核对');
      request.assertCurrent();
      const tracked = holdings.get(scope.requirementId);
      if ((!old || old.phase === 'released') && !tracked) {
        await reserve(
          tx,
          scope.who,
          'requirement:' + scope.requirementId,
          'write.takeover',
          commandId,
          scope,
        );
        return assignTakeover(tx, request, snapshot, deadline);
      }
      if (
        !old ||
        old.phase !== 'held' ||
        !tracked?.confirmed ||
        !sameHolder(old, tracked.scope, tracked.grant.generation)
      )
        businessError(409, '旧执行尚待确认');
      await reserve(
        tx,
        scope.who,
        'requirement:' + scope.requirementId,
        'write.takeover',
        commandId,
        scope,
      );
      if (
        sameHolder(old, scope, old.generation) &&
        old.contextVersion === snapshot.requirement.contextVersion &&
        old.expiresAt.getTime() > Date.now()
      ) {
        const outcome = {
          state: 'acquired',
          generation: old.generation,
        } as const;
        await finish(tx, takeoverKey(scope, commandId), outcome);
        return outcome;
      }
      await tx
        .update(leases)
        .set({
          phase: 'draining',
          takeover: targetFor(request),
          updatedAt: new Date(),
        })
        .where(eq(leases.requirementId, scope.requirementId));
      const outcome = { state: 'pending' } as const;
      await finish(tx, takeoverKey(scope, commandId), {
        ...outcome,
        previousGeneration,
        previousOwnerGeneration: authority,
      });
      request.assertCurrent();
      requireLiveLogin(scope);
      if (fences.size || Math.min(deadline, snapshot.validBefore) <= Date.now())
        businessError(409, '写入状态正在变更，请重新核对');
      return outcome;
    });
  }

  async function verifyTakeover(request: Takeover) {
    return transaction(async (tx) => {
      const snapshot = request.proposed
        ? await takeoverContext(tx, request.scope)
        : undefined;
      if (!snapshot) await lockRequirement(tx, request.scope);
      const old = await lockedLease(tx, request.scope.requirementId);
      const outcome = await readTakeover(tx, request.scope, request.commandId);
      if ((outcome?.state === 'pending') !== matchesTakeover(old, request))
        businessError(409, '原接手状态尚待确认');
      if (
        request.proposed &&
        outcome?.state === 'acquired' &&
        outcome.generation !== request.proposed.generation
      )
        businessError(409, '原写入资格尚待确认');
      const enable =
        outcome?.state === 'acquired' &&
        sameHolder(old, request.scope, outcome.generation) &&
        old.phase === 'held' &&
        snapshot?.requirement.contextVersion === old.contextVersion &&
        snapshot.validBefore > Date.now();
      return { outcome, enable };
    });
  }

  async function takeoverContext(tx: Queries, scope: Scope) {
    if (stopping) return;
    try {
      return await context(tx, scope);
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status !== 401 && status !== 403 && status !== 404) throw error;
    }
  }

  async function finalizeTakeover(
    request: Takeover,
  ): Promise<WriteTakeoverState> {
    const { scope, commandId, previousGeneration } = request;
    if (!previousGeneration) return businessError(409, '原接手状态尚待确认');
    await drain(scope.requirementId, previousGeneration);
    return transaction(async (tx, deadline) => {
      const snapshot = await takeoverContext(tx, scope);
      if (!snapshot) await lockRequirement(tx, scope);
      const old = await lockedLease(tx, scope.requirementId);
      const result = await readTakeover(tx, scope, commandId);
      if (result?.state !== 'pending' || !matchesTakeover(old, request))
        businessError(409, '原接手状态尚待确认');
      if (old.runId) return result;
      if (
        snapshot &&
        !stopping &&
        !loginClosed(scope.who.authSessionId) &&
        snapshot.validBefore > Date.now()
      )
        return assignTakeover(tx, request, snapshot, deadline);
      const outcome = { state: 'cancelled' } as const;
      await tx
        .update(leases)
        .set({ phase: 'released', takeover: null, updatedAt: new Date() })
        .where(eq(leases.requirementId, scope.requirementId));
      await finish(tx, takeoverKey(scope, commandId), outcome);
      return outcome;
    });
  }

  async function settleTakeover(
    request: Takeover,
    outcome?: WriteTakeoverState,
    enable = true,
  ) {
    const { scope, proposed, previousGeneration } = request;
    if (proposed) {
      const tracked = holdings.get(scope.requirementId);
      if (
        outcome?.state === 'acquired' &&
        outcome.generation === proposed.generation
      ) {
        if (
          enable &&
          !stopping &&
          !loginClosed(scope.who.authSessionId) &&
          proposed.expiresAt > Date.now() &&
          tracked?.grant.generation === proposed.generation
        ) {
          tracked.confirmed = true;
          announceGrant(tracked.scope, tracked.grant);
        } else await drain(scope.requirementId, proposed.generation);
      } else forget(scope.requirementId, proposed.generation);
      request.proposed = undefined;
    }
    if (outcome?.state === 'cancelled' && previousGeneration)
      forget(scope.requirementId, previousGeneration);
    clearTimeout(request.timer);
    if (takeovers.get(scope.requirementId) === request)
      takeovers.delete(scope.requirementId);
  }

  function reconcileTakeover(request: Takeover) {
    if (request.work) return request.work;
    clearTimeout(request.timer);
    request.work ??= track(
      (async () => {
        try {
          let outcome: WriteTakeoverState | undefined;
          if (
            request.phase === 'verify-initial' ||
            request.phase === 'verify-final'
          ) {
            const verified = await verifyTakeover(request);
            outcome = verified.outcome;
            if (outcome?.state !== 'pending')
              return await settleTakeover(request, outcome, verified.enable);
            if (request.proposed)
              forget(request.scope.requirementId, request.proposed.generation);
            request.proposed = undefined;
            request.phase = 'draining';
          }
          outcome = await finalizeTakeover(request);
          if (outcome.state !== 'pending') {
            request.phase = 'verify-final';
            await settleTakeover(request, outcome);
          }
        } catch (error) {
          if (error instanceof UnknownWriteCommit)
            request.phase = 'verify-final';
          else if (request.phase === 'draining' && request.proposed) {
            forget(request.scope.requirementId, request.proposed.generation);
            request.proposed = undefined;
          }
          if (!stopping) {
            request.timer = setTimeout(
              () => {
                void reconcileTakeover(request);
              },
              250 * 2 ** Math.min(request.failures++, 4),
            ).unref();
          }
        }
      })(),
    ).finally(() => {
      request.work = undefined;
      if (
        request.rerun &&
        !stopping &&
        takeovers.get(request.scope.requirementId) === request
      ) {
        request.rerun = undefined;
        void reconcileTakeover(request);
      }
    });
    return request.work;
  }

  async function takeover(
    scope: Scope,
    commandId: string,
    assertCurrent: () => void,
  ) {
    const { prior, old, validBefore } = await readTransaction(async (tx) => {
      const { validBefore } = await business.writeContext(
        tx,
        scope.who,
        scope.projectId,
        scope.requirementId,
        scope.sessionId,
        false,
      );
      const prior = await readTakeover(tx, scope, commandId);
      const [old] = await tx
        .select()
        .from(leases)
        .where(eq(leases.requirementId, scope.requirementId));
      return { prior, old, validBefore };
    });
    requireLiveLogin(scope);
    assertCurrent();
    const request: Takeover = {
      scope,
      commandId,
      previousGeneration: old?.generation ?? null,
      assertCurrent,
      phase: 'initial',
      failures: 0,
    };
    const existing = takeovers.get(scope.requirementId);
    if (
      existing &&
      digestOf(targetFor(existing)) === digestOf(targetFor(request))
    ) {
      if (existing.phase !== 'initial' && !existing.work && !stopping) {
        existing.failures = 0;
        await reconcileTakeover(existing);
      }
      if (prior) return prior;
      businessError(409, '原接手状态尚待确认');
    }
    if (prior && prior.state !== 'pending') return prior;
    if (supervisedExecution && prior?.state === 'pending')
      businessError(409, '原接手状态尚待确认');
    allowed(validBefore, scope);
    if (prior?.state === 'pending' && !matchesTakeover(old, request))
      businessError(409, '原接手状态尚待确认');
    takeovers.set(scope.requirementId, request);
    const outcome = await prepareTakeover(request).catch(
      async (error: unknown) => {
        if (error instanceof UnknownWriteCommit) {
          request.phase = 'verify-initial';
          void reconcileTakeover(request);
        } else await settleTakeover(request);
        throw error;
      },
    );
    if (outcome.state === 'pending') {
      request.phase = 'draining';
      void reconcileTakeover(request);
    } else {
      request.phase = 'verify-final';
      try {
        await settleTakeover(request, outcome);
      } catch (error) {
        void reconcileTakeover(request);
        throw error;
      }
    }
    return outcome;
  }

  function leaseScope(row: Lease): Scope {
    return {
      projectId: row.projectId,
      requirementId: row.requirementId,
      sessionId: row.nativeSessionId,
      who: { userId: row.ownerId, authSessionId: row.authSessionId },
    };
  }

  function exactColdLease(
    row: Lease | undefined,
    old: Lease,
    runId = old.runId,
    phase = old.phase,
  ) {
    return (
      sameHolder(row, leaseScope(old), old.generation) &&
      row.requirementId === old.requirementId &&
      row.runId === runId &&
      row.phase === phase &&
      row.contextVersion === old.contextVersion &&
      row.expiresAt.getTime() === old.expiresAt.getTime() &&
      digestOf(row.takeover ?? null) === digestOf(old.takeover ?? null)
    );
  }

  const ownerGenerationPattern =
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
  function previousOwner(value: unknown): value is string {
    return (
      typeof value === 'string' &&
      ownerGenerationPattern.test(value) &&
      value !== authority
    );
  }

  async function coldGrant(tx: Queries, old: Lease) {
    const table = schema.commandReceipt;
    const rows = await tx
      .select()
      .from(table)
      .where(
        and(
          eq(table.actorId, old.ownerId),
          eq(table.scope, 'requirement:' + old.requirementId),
          eq(table.digest, digestOf(leaseScope(old))),
          sql`${table.operation} in ('write.acquire','write.takeover')`,
          sql`${table.result}->>'generation' = ${old.generation} and ${table.result}->>'ownerGeneration' is not null`,
        ),
      )
      .limit(2);
    const grant = rows[0]?.result as
      { ownerGeneration?: unknown; state?: unknown } | undefined;
    if (
      rows.length === 1 &&
      previousOwner(grant?.ownerGeneration) &&
      (rows[0]?.operation === 'write.acquire' || grant.state === 'acquired')
    )
      return grant.ownerGeneration;
  }

  async function executionBeforeCold(old: Lease) {
    const table = schema.commandReceipt;
    const rows = await db
      .select()
      .from(table)
      .where(
        and(
          eq(table.actorId, old.ownerId),
          eq(table.scope, 'requirement:' + old.requirementId),
          eq(table.operation, 'write.execute'),
          sql`${table.result}->>'runId' = ${old.runId}`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) return;
    const receipt = rows[0]!;
    const prior = receipt.result as ExecutionReceipt | undefined;
    const proof = prior?.proof;
    const binding = proof?.binding;
    if (
      (prior?.status !== 'reserved' && prior?.status !== 'unknown') ||
      prior.coldStop ||
      proof?.stage !== 'armed' ||
      !proof.location ||
      !binding ||
      binding.version !== 1 ||
      binding.runId !== old.runId ||
      binding.generation !== old.generation ||
      !previousOwner(binding.ownerGeneration) ||
      binding.projectId !== old.projectId ||
      binding.requirementId !== old.requirementId ||
      binding.actorId !== old.ownerId ||
      binding.commandId !== receipt.commandId ||
      binding.receiptDigest !== receipt.digest
    )
      return;
    const [plan] = await db
      .select({ repositories: schema.requirementWorktreePlan.repositories })
      .from(schema.requirementWorktreePlan)
      .where(
        eq(schema.requirementWorktreePlan.requirementId, old.requirementId),
      );
    if (
      !plan?.repositories.some(
        ({ repositoryId }) => repositoryId === binding.repositoryId,
      )
    )
      return;
    const proofResult = await readSupervisedStop(
      await worktrees.executionRoot(),
      binding,
      proof.location,
    );
    if (!proofResult) return;
    const stop: ColdStop = {
      runId: binding.runId,
      generation: old.generation,
      ownerGeneration: binding.ownerGeneration,
      outcome: proofResult.outcome,
    };
    return { receipt, stop };
  }

  async function settleCold({ old, result }: ColdTransition) {
    return transaction(async (tx) => {
      await lockRequirement(tx, leaseScope(old));
      const row = await lockedLease(tx, old.requirementId);
      if (
        stopping ||
        !row ||
        !exactColdLease(row, old) ||
        holdings.has(old.requirementId) ||
        takeovers.has(old.requirementId)
      )
        return false;
      if (result) {
        const { receipt, stop } = result;
        if ((await coldGrant(tx, old)) !== stop.ownerGeneration) return false;
        const exact = await readReceipt(tx, receipt);
        if (!exact || digestOf(exact.result) !== digestOf(receipt.result))
          return false;
        const repositoryId = (exact.result as ExecutionReceipt).proof?.binding
          .repositoryId;
        const [plan] = await tx
          .select({ repositories: schema.requirementWorktreePlan.repositories })
          .from(schema.requirementWorktreePlan)
          .where(
            eq(schema.requirementWorktreePlan.requirementId, old.requirementId),
          );
        if (
          !repositoryId ||
          !plan?.repositories.some(
            (repository) => repository.repositoryId === repositoryId,
          )
        )
          return false;
        await finish(tx, receipt, {
          ...(receipt.result as ExecutionReceipt),
          coldStop: stop,
        });
      } else if (
        old.runId ||
        old.takeover ||
        old.phase !== 'held' ||
        !(await coldGrant(tx, old))
      )
        return false;
      await tx
        .update(leases)
        .set({
          runId: null,
          phase: row.takeover ? 'draining' : 'released',
          updatedAt: new Date(),
        })
        .where(eq(leases.requirementId, old.requirementId));
      return true;
    }, true);
  }

  async function verifyCold({ old, result }: ColdTransition) {
    return transaction(async (tx) => {
      await lockRequirement(tx, leaseScope(old));
      const row = await lockedLease(tx, old.requirementId);
      const original = exactColdLease(row, old);
      const settled = exactColdLease(
        row,
        old,
        null,
        old.takeover ? 'draining' : 'released',
      );
      if (result) {
        const receipt = await readReceipt(tx, result.receipt);
        if (!receipt) return;
        const saved = receipt.result as ExecutionReceipt;
        if (
          digestOf(saved) ===
          digestOf({
            ...(result.receipt.result as ExecutionReceipt),
            coldStop: result.stop,
          })
        ) {
          if (settled) return 'committed' as const;
          if (row && row.generation !== old.generation)
            return 'superseded' as const;
        }
        if (original && digestOf(saved) === digestOf(result.receipt.result))
          return 'original' as const;
      } else if (await coldGrant(tx, old)) {
        if (settled) return 'committed' as const;
        if (original) return 'original' as const;
      }
    }, true);
  }

  async function adoptColdTakeover(old: Lease) {
    if (
      !old.takeover ||
      old.runId ||
      old.phase !== 'draining' ||
      stopping ||
      takeovers.has(old.requirementId)
    )
      return;
    const { userId, authSessionId, sessionId, commandId } = old.takeover;
    const scope: Scope = {
      projectId: old.projectId,
      requirementId: old.requirementId,
      sessionId,
      who: { userId, authSessionId },
    };
    const request: Takeover = {
      scope,
      commandId,
      previousGeneration: old.generation,
      assertCurrent: () => {},
      phase: 'draining',
      failures: 0,
    };
    const valid = await transaction(async (tx) => {
      await lockRequirement(tx, scope);
      const lease = await lockedLease(tx, scope.requirementId);
      if (!exactColdLease(lease, old) || !matchesTakeover(lease, request))
        return false;
      const receipt = await readReceipt(tx, takeoverKey(scope, commandId));
      const saved = receipt?.result as
        | {
            state?: unknown;
            previousGeneration?: unknown;
            previousOwnerGeneration?: unknown;
          }
        | undefined;
      return (
        saved?.state === 'pending' &&
        saved.previousGeneration === old.generation &&
        previousOwner(saved.previousOwnerGeneration) &&
        (await coldGrant(tx, old)) === saved.previousOwnerGeneration
      );
    }, true);
    if (valid && !stopping && !takeovers.has(old.requirementId)) {
      takeovers.set(old.requirementId, request);
      return request;
    }
  }

  async function finishColdTransition(
    transition: ColdTransition,
    settled: boolean,
  ) {
    const { old } = transition;
    const request =
      settled && old.takeover
        ? await adoptColdTakeover({ ...old, runId: null, phase: 'draining' })
        : undefined;
    uncertainCold.delete(old.requirementId);
    coldFences.delete(old.requirementId);
    if (request) void reconcileTakeover(request);
  }

  function canBeginCold(requirementId: string) {
    return (
      !stopping &&
      !holdings.has(requirementId) &&
      !takeovers.has(requirementId) &&
      !coldFences.has(requirementId)
    );
  }

  async function recoverColdRow(old: Lease) {
    if (!canBeginCold(old.requirementId)) return;
    if (!old.runId && old.takeover) {
      const request = await adoptColdTakeover(old);
      if (request) void reconcileTakeover(request);
      return;
    }
    if (!old.runId && old.phase !== 'held') return;
    const result = old.runId ? await executionBeforeCold(old) : undefined;
    if (!canBeginCold(old.requirementId) || (old.runId && !result)) return;
    const transition = { old, result };
    coldFences.add(old.requirementId);
    try {
      await finishColdTransition(transition, await settleCold(transition));
    } catch (error) {
      if (error instanceof UnknownWriteCommit)
        uncertainCold.set(old.requirementId, transition);
      else coldFences.delete(old.requirementId);
    }
  }

  async function scanCold() {
    const attempts = Math.min(uncertainCold.size, 8);
    for (let index = 0; index < attempts; index++) {
      if (stopping) return;
      const [requirementId, transition] = uncertainCold.entries().next().value!;
      uncertainCold.delete(requirementId);
      uncertainCold.set(requirementId, transition);
      await verifyCold(transition)
        .then(async (settled) => {
          if (settled !== undefined)
            await finishColdTransition(transition, settled === 'committed');
        })
        .catch(() => {});
    }
    const rows = await db
      .select()
      .from(leases)
      .where(
        and(
          recoveryCursor ? gt(leases.requirementId, recoveryCursor) : undefined,
          or(
            isNotNull(leases.runId),
            isNotNull(leases.takeover),
            eq(leases.phase, 'held'),
          ),
        ),
      )
      .orderBy(leases.requirementId)
      .limit(24);
    for (const row of rows) {
      if (stopping) return;
      await recoverColdRow(row).catch(() => {});
    }
    recoveryCursor =
      rows.length === 24 ? rows.at(-1)?.requirementId : undefined;
  }

  function startStopRecovery() {
    if (!supervisedExecution || stopping || recoveryWork || recoveryTimer)
      return;
    recoveryWork = track(scanCold())
      .catch(() => {})
      .finally(() => {
        recoveryWork = undefined;
        if (!stopping)
          recoveryTimer = setTimeout(() => {
            recoveryTimer = undefined;
            startStopRecovery();
          }, 400).unref();
      });
  }

  async function recordRelease(request: PendingRelease, recovering: boolean) {
    const { scope, generation, commandId } = request;
    const command = { type: 'release', generation, commandId } as const;
    return transaction(async (tx, deadline) => {
      let validBefore = Infinity;
      if (recovering) {
        await tx
          .select({ id: schema.requirement.id })
          .from(schema.requirement)
          .where(
            and(
              eq(schema.requirement.id, scope.requirementId),
              eq(schema.requirement.projectId, scope.projectId),
            ),
          )
          .for('update');
      } else validBefore = (await context(tx, scope)).validBefore;
      const old = await lockedLease(tx, scope.requirementId);
      if (await recordedGeneration(tx, scope, command)) {
        if (!sameHolder(old, scope, generation) || old.phase === 'released')
          return 'released' as const;
        if (old.phase === 'draining') return recovering ? 'drain' : 'draining';
        businessError(409, '原释放状态尚待确认');
      }
      if (!sameHolder(old, scope, generation) || old.phase === 'released')
        throw new SupersededRelease();
      const expiresAt = old.expiresAt.getTime();
      const assertCurrent = () => {
        if (recovering) return;
        request.assertCurrent();
        requireLiveLogin(scope);
        if (
          stopping ||
          fences.size ||
          releaseFences.get(scope.requirementId) !== request ||
          confirmedHolding(scope, generation)?.grant.expiresAt !== expiresAt ||
          Math.min(validBefore, expiresAt, deadline) <= Date.now()
        )
          businessError(409, '原写入资格已失效');
      };
      assertCurrent();
      const receipt = await reserve(
        tx,
        scope.who,
        'requirement:' + scope.requirementId,
        'write.release',
        commandId,
        { scope, generation },
      );
      await tx
        .update(leases)
        .set({
          phase: old.runId ? 'draining' : 'released',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leases.requirementId, scope.requirementId),
            eq(leases.generation, generation),
          ),
        );
      await finish(tx, receipt.value, { generation });
      assertCurrent();
      return old.runId ? ('drain' as const) : ('released' as const);
    });
  }

  function clearRelease(request: PendingRelease) {
    if (releaseFences.get(request.scope.requirementId) === request)
      releaseFences.delete(request.scope.requirementId);
  }

  async function finishRelease(
    request: PendingRelease,
    recovering: boolean,
  ): Promise<ReleaseState> {
    const { scope, generation } = request;
    try {
      const recorded = await recordRelease(request, recovering);
      const state =
        recorded === 'drain'
          ? await drain(scope.requirementId, generation)
          : recorded;
      if (recorded === 'released') forget(scope.requirementId, generation);
      clearRelease(request);
      return state;
    } catch (error) {
      if (error instanceof SupersededRelease) {
        clearRelease(request);
        businessError(409, '原写代已失效，未能确认释放回执');
      }
      if (error instanceof UnknownWriteCommit) {
        request.uncertain = true;
        abortExecution(scope.requirementId, generation);
        if (!recovering) await finishRelease(request, true).catch(() => {});
      } else if (!recovering) clearRelease(request);
      throw error;
    }
  }

  function runRelease(request: PendingRelease) {
    return (request.work ??= finishRelease(request, request.uncertain).finally(
      () => {
        request.work = undefined;
      },
    ));
  }

  async function release(
    scope: Scope,
    generation: string,
    commandId: string,
    assertCurrent: () => void,
  ) {
    requireLiveLogin(scope);
    const command = { type: 'release', generation, commandId } as const;
    const { receipt, lease, validBefore } = await readTransaction(
      async (tx) => {
        const { validBefore } = await business.writeContext(
          tx,
          scope.who,
          scope.projectId,
          scope.requirementId,
          scope.sessionId,
          false,
        );
        const receipt = await recordedGeneration(tx, scope, command);
        const [lease] = await tx
          .select()
          .from(leases)
          .where(eq(leases.requirementId, scope.requirementId));
        return { receipt, lease, validBefore };
      },
    );
    requireLiveLogin(scope);
    if (validBefore <= Date.now()) businessError(401, '登录已失效，请重新登录');
    const live =
      sameHolder(lease, scope, generation) && lease.phase !== 'released';
    assertCurrent();
    const existing = releaseFences.get(scope.requirementId);
    if (
      existing?.generation === generation &&
      existing.commandId === commandId &&
      digestOf(existing.scope) === digestOf(scope)
    ) {
      if (existing.work) return existing.work;
      if (existing.uncertain) return runRelease(existing);
    }
    if (receipt) {
      if (!live) return 'released' as const;
      if (lease.phase === 'draining') return 'draining' as const;
      businessError(409, '原释放状态尚待确认');
    }
    const tracked = confirmedHolding(scope, generation);
    if (
      !live ||
      !tracked ||
      tracked.grant.expiresAt !== lease.expiresAt.getTime()
    )
      businessError(409, '仅当前持有会话可以释放写入');
    allowed(Math.min(validBefore, lease.expiresAt.getTime()), scope);
    const request = {
      scope,
      generation,
      commandId,
      uncertain: false,
      assertCurrent,
    };
    releaseFences.set(scope.requirementId, request);
    return runRelease(request);
  }

  async function execute(
    scope: Scope,
    input: Invocation,
    onOutput?: OnOutput,
    callSignal?: AbortSignal,
    beforeCallStart?: BeforeCallStart,
  ) {
    const saved = [...settlements.values()].find(
      ({ receipt }) =>
        receipt.actorId === scope.who.userId &&
        receipt.scope === 'requirement:' + scope.requirementId &&
        receipt.commandId === input.commandId,
    );
    if (saved) {
      await transaction((tx) => context(tx, scope));
      if (saved.receipt.digest !== digestOf({ scope, input }))
        businessError(409, '操作标识已用于不同内容，请重新发起');
      return persistSettlement(saved);
    }
    let candidate:
      | { runId: string; receipt: ReceiptValue; proof?: ExecutionProof }
      | undefined;
    if (
      input.outputLimitBytes !== undefined &&
      (!Number.isSafeInteger(input.outputLimitBytes) ||
        input.outputLimitBytes < 1 ||
        input.outputLimitBytes > maxOutputBudgetBytes)
    )
      businessError(403, '输出预算不正确');
    const reservation = await transaction(async (tx, deadline) => {
      const snapshot = await context(tx, scope);
      const row = await lockedLease(tx, scope.requirementId);
      const receipt = await reserve(
        tx,
        scope.who,
        'requirement:' + scope.requirementId,
        'write.execute',
        input.commandId,
        { scope, input },
      );
      if ('result' in receipt)
        return {
          kind: 'replay',
          replay: receipt.result as ExecutionReceipt,
        } as const;
      const tracked = holdings.get(scope.requirementId);
      if (
        !sameHolder(row, scope, input.generation) ||
        row.phase !== 'held' ||
        row.runId ||
        tracked?.grant.generation !== input.generation ||
        !tracked.confirmed ||
        row.contextVersion !== snapshot.requirement.contextVersion
      )
        businessError(409, '当前会话没有可用的写入资格');
      const [plan] = await tx
        .select()
        .from(schema.requirementWorktreePlan)
        .where(
          eq(schema.requirementWorktreePlan.requirementId, scope.requirementId),
        );
      if (
        !plan?.repositories.some(
          ({ repositoryId }) => repositoryId === input.repositoryId,
        )
      )
        businessError(403, '仓库不在需求工作树范围内');
      allowed(
        Math.min(deadline, snapshot.validBefore, row.expiresAt.getTime()),
        scope,
      );
      const runId = randomUUID();
      const proof: ExecutionProof | undefined = supervisedExecution
        ? {
            stage: 'reserved',
            binding: {
              version: 1,
              runId,
              generation: input.generation,
              ownerGeneration: authority,
              projectId: scope.projectId,
              requirementId: scope.requirementId,
              repositoryId: input.repositoryId,
              actorId: scope.who.userId,
              commandId: input.commandId,
              receiptDigest: receipt.value.digest,
            },
          }
        : undefined;
      await tx
        .update(leases)
        .set({ runId, updatedAt: new Date() })
        .where(
          and(
            eq(leases.requirementId, scope.requirementId),
            eq(leases.generation, input.generation),
            isNull(leases.runId),
          ),
        );
      await finish(tx, receipt.value, {
        status: 'reserved',
        runId,
        ...(proof && { proof }),
      });
      candidate = { runId, receipt: receipt.value, proof };
      return {
        kind: 'launch',
        runId,
        value: receipt.value,
        plan: plan.repositories,
        proof,
      } as const;
    }).catch(async (error: unknown) => {
      if (error instanceof UnknownWriteCommit && candidate) {
        const { runId, receipt, proof } = candidate;
        const settlement: Settlement = {
          scope,
          generation: input.generation,
          receipt,
          unconfirmedReservation: true,
          outcome: {
            status: 'finished',
            runId,
            ...(proof && { proof }),
            result: {
              status: 'aborted',
              stop: 'not-started',
              marker: 'none',
              exitCode: null,
            },
          },
        };
        settlements.set(runId, settlement);
        await persistSettlement(settlement).catch(() => {});
      }
      throw error;
    });
    if (reservation.kind === 'replay') {
      const prior = reservation.replay;
      const settlement = settlements.get(prior.runId);
      return settlement ? persistSettlement(settlement) : prior;
    }

    const { runId, value, plan, proof } = reservation;
    const controller = new AbortController();
    const signal = callSignal
      ? AbortSignal.any([controller.signal, callSignal])
      : controller.signal;
    let started = false;
    let confirmed = false;
    const verifyScope = () =>
      worktrees.executionScope(
        scope.projectId,
        scope.requirementId,
        plan,
        input.repositoryId,
      );
    async function liveRun(tx: Queries, deadline: number) {
      const snapshot = await context(tx, scope);
      const row = await lockedLease(tx, scope.requirementId);
      if (
        !sameHolder(row, scope, input.generation) ||
        row.runId !== runId ||
        row.phase !== 'held' ||
        row.contextVersion !== snapshot.requirement.contextVersion
      )
        businessError(409, '当前执行的写入资格已失效');
      const validBefore = Math.min(
        deadline,
        snapshot.validBefore,
        row.expiresAt.getTime(),
      );
      allowed(validBefore, scope);
      return {
        contextVersion: snapshot.requirement.contextVersion,
        validBefore,
      };
    }
    async function assertProof(tx: Queries, stage: ExecutionProof['stage']) {
      const receipt = await readReceipt(tx, value);
      const current = receipt?.result as ExecutionReceipt | undefined;
      if (
        !proof ||
        current?.status !== 'reserved' ||
        current.runId !== runId ||
        current.proof?.stage !== stage ||
        digestOf(current.proof.binding) !== digestOf(proof.binding)
      )
        businessError(409, '原执行证明尚未确认');
      if (
        stage === 'armed' &&
        (!proof.location ||
          !current.proof.location ||
          digestOf(current.proof.location) !== digestOf(proof.location))
      )
        businessError(409, '原执行证明目录尚未确认');
    }
    async function authorizeStart(start: (validBefore: number) => void) {
      await transaction(async (tx, deadline, confirmConnection) => {
        const { contextVersion, validBefore } = await liveRun(tx, deadline);
        if (proof) await assertProof(tx, 'armed');
        confirmConnection();
        allowed(validBefore, scope);
        beforeCallStart?.(contextVersion);
        signal.throwIfAborted();
        if (proof) started = true;
        start(validBefore);
        started = true;
      });
      confirmed = true;
    }
    const running = proof
      ? runSupervisedMacosWorktree(
          verifyScope,
          gitPath,
          input.request,
          proof.binding,
          {
            signal,
            onOutput,
            authorizeStart,
            ...(input.outputLimitBytes !== undefined && {
              outputLimitBytes: input.outputLimitBytes,
            }),
            async arm(location) {
              await transaction(async (tx, deadline) => {
                const { validBefore } = await liveRun(tx, deadline);
                await assertProof(tx, 'reserved');
                await finish(tx, value, {
                  status: 'reserved',
                  runId,
                  proof: { ...proof, stage: 'armed', location },
                });
                allowed(validBefore, scope);
                signal.throwIfAborted();
              });
              proof.stage = 'armed';
              proof.location = location;
            },
          },
        )
      : runMacosWorktree(verifyScope, gitPath, input.request, {
          signal,
          onOutput,
          authorizeStart,
          ...(input.outputLimitBytes !== undefined && {
            outputLimitBytes: input.outputLimitBytes,
          }),
        });
    const done = running
      .then(
        async ({
          stop,
          marker,
          status,
          exitCode,
        }): Promise<ExecutionReceipt> => {
          const safe = stop !== 'unconfirmed' && marker !== 'retained';
          const outcome: CompletedExecution = {
            status: safe && (!started || confirmed) ? 'finished' : 'unknown',
            runId,
            ...(proof && { proof }),
            result: { stop, marker, status, exitCode },
          };
          const settlement = {
            scope,
            generation: input.generation,
            receipt: value,
            outcome,
          };
          settlements.set(runId, settlement);
          return persistSettlement(settlement);
        },
      )
      .finally(() => executions.delete(runId));
    executions.set(runId, {
      requirementId: scope.requirementId,
      generation: input.generation,
      controller,
      done,
    });
    return done;
  }

  function beginAuthorityChange(matches: (scope: Scope) => boolean) {
    if (stopping) businessError(503, '写入协调正在关闭');
    const token = Symbol();
    fences.add(token);
    reads?.revoke(matches);
    const captured = [...holdings.values()].filter(({ scope }) =>
      matches(scope),
    );
    return {
      generations: captured.map(({ scope, grant }) => ({
        requirementId: scope.requirementId,
        generation: grant.generation,
      })),
      rolledBack: () => fences.delete(token),
      uncertain() {
        for (const { scope, grant } of captured)
          abortExecution(scope.requirementId, grant.generation);
      },
      async committed(recheck = false) {
        const results = await Promise.allSettled(
          captured.map(async ({ scope, grant }) => {
            if (recheck) {
              try {
                await transaction((tx) => context(tx, scope));
                return;
              } catch (error) {
                const status = (error as { statusCode?: number }).statusCode;
                if (status !== 401 && status !== 403 && status !== 404) {
                  abortExecution(scope.requirementId, grant.generation);
                  throw error;
                }
              }
            }
            await drain(scope.requirementId, grant.generation);
          }),
        );
        const failed = results.find((result) => result.status === 'rejected');
        if (failed) throw failed.reason;
        fences.delete(token);
      },
    };
  }

  async function changeAuthority<T>(
    operationId: string,
    matches: (scope: Scope) => boolean,
    change: (tx: Queries) => Promise<T>,
    confirm: AuthorityConfirmation,
  ) {
    if (typeof confirm !== 'function')
      throw new Error('Authority changes require same-command confirmation');
    if (authorityChanges.has(operationId))
      businessError(409, '请先核对原权限变更');
    const fence = beginAuthorityChange(matches);
    const operation: AuthorityChange = { phase: 'changing', fence, confirm };
    authorityChanges.set(operationId, operation);
    let result: T;
    try {
      result = await transaction(change);
    } catch (error) {
      if (error instanceof UnknownWriteCommit) {
        operation.phase = 'unknown';
        fence.uncertain();
        await reconcileAuthorityChange(operationId).catch(() => false);
      } else {
        fence.rolledBack();
        authorityChanges.delete(operationId);
      }
      throw error;
    }
    operation.phase = 'committed';
    await reconcileAuthorityChange(operationId);
    return result;
  }

  function reconcileAuthorityChange(operationId: string): Promise<boolean> {
    const operation = authorityChanges.get(operationId);
    if (!operation) return Promise.resolve(true);
    if (operation.phase === 'changing') return Promise.resolve(false);
    return (operation.recovery ??= finishAuthorityChange(
      operationId,
      operation,
    ).finally(() => {
      operation.recovery = undefined;
    }));
  }

  async function finishAuthorityChange(
    operationId: string,
    operation: AuthorityChange,
  ) {
    if (operation.phase === 'unknown') {
      const resolution = await transaction(operation.confirm).catch(
        () => 'unknown',
      );
      if (resolution === 'unknown') return false;
      if (resolution === 'rolled-back') {
        operation.fence.rolledBack();
        if (authorityChanges.get(operationId) === operation)
          authorityChanges.delete(operationId);
        return true;
      }
      operation.phase = 'committed';
    }
    await operation.fence.committed();
    if (authorityChanges.get(operationId) === operation)
      authorityChanges.delete(operationId);
    return true;
  }

  let shutdown: Promise<void> | undefined;

  async function stop() {
    stopping = true;
    clearTimeout(recoveryTimer);
    reads?.stop();
    try {
      for (const execution of executions.values()) execution.controller.abort();
      await Promise.allSettled(operations);
      await Promise.allSettled([...releaseFences.values()].map(runRelease));
      for (const request of takeovers.values()) clearTimeout(request.timer);
      await Promise.allSettled([...takeovers.values()].map(reconcileTakeover));
      const states = await Promise.allSettled(
        [...holdings.values()].map(({ scope, grant }) =>
          drain(scope.requirementId, grant.generation),
        ),
      );
      if (
        releaseFences.size > 0 ||
        takeovers.size > 0 ||
        coldFences.size > 0 ||
        (reads && !reads.stopped()) ||
        (
          await db
            .select({ id: leases.requirementId })
            .from(leases)
            .where(
              or(
                isNotNull(leases.takeover),
                isNotNull(leases.runId),
                supervisedExecution ? eq(leases.phase, 'held') : undefined,
              ),
            )
            .limit(1)
        ).length > 0 ||
        states.some(
          (state) => state.status === 'rejected' || state.value !== 'released',
        )
      )
        throw new Error(
          'Isolated write execution could not be confirmed stopped',
        );
    } finally {
      for (const { timer } of holdings.values()) clearTimeout(timer);
    }
  }

  function close() {
    return (shutdown ??= stop());
  }

  function track<T>(operation: Promise<T>): Promise<T> {
    operations.add(operation);
    return operation.finally(() => operations.delete(operation));
  }

  async function admit<T>(operation: () => Promise<T>) {
    if (stopping) businessError(503, '写入协调正在关闭');
    return track(operation());
  }

  async function submit(
    scope: Scope,
    input: Invocation,
    onOutput?: OnOutput,
    signal?: AbortSignal,
    beforeCallStart?: BeforeCallStart,
  ) {
    const key = digestOf([
      scope.requirementId,
      scope.who.userId,
      input.commandId,
    ]);
    if (pendingCalls.has(key)) businessError(409, '原执行正在处理，请稍后核对');
    pendingCalls.add(key);
    try {
      return await execute(scope, input, onOutput, signal, beforeCallStart);
    } finally {
      pendingCalls.delete(key);
    }
  }

  async function readStatus(
    who: Actor,
    projectId: string,
    requirementId: string,
    assertReader: () => void,
    actionsEnabled = false,
  ): Promise<RequirementWriteAuthority> {
    const deadline = Date.now() + 1800;
    const { reader, lease, holder, applicant } = await readTransaction(
      async (tx) => {
        const reader = await business.authorizeRequirement(
          who,
          requirementId,
          projectId,
          'reader',
          tx,
        );
        const [lease] = await tx
          .select()
          .from(leases)
          .where(
            and(
              eq(leases.projectId, projectId),
              eq(leases.requirementId, requirementId),
            ),
          );
        async function eligible(actor: Actor, sessionId: string) {
          try {
            return await business.writeContext(
              tx,
              actor,
              projectId,
              requirementId,
              sessionId,
              false,
            );
          } catch (error) {
            const status = (error as { statusCode?: number }).statusCode;
            if (status !== 401 && status !== 403 && status !== 404) throw error;
          }
        }
        const holder =
          lease?.phase === 'held'
            ? await eligible(
                { userId: lease.ownerId, authSessionId: lease.authSessionId },
                lease.nativeSessionId,
              )
            : undefined;
        const [owned] = actionsEnabled
          ? await tx
              .select({ id: schema.nativeSession.id })
              .from(schema.nativeSession)
              .where(
                and(
                  eq(schema.nativeSession.requirementId, requirementId),
                  eq(schema.nativeSession.ownerId, who.userId),
                ),
              )
              .limit(1)
          : [];
        const applicant = owned ? await eligible(who, owned.id) : undefined;
        return { reader, lease, holder, applicant };
      },
    );
    assertReader();
    const now = Date.now();
    if (reader.expiresAt.getTime() <= now)
      businessError(401, '登录已失效，请重新登录');
    if (deadline <= now) businessError(503, '写权状态读取超时');

    const tracked = holdings.get(requirementId);
    const hints = actionsEnabled ? { actionsEnabled: true as const } : {};
    const mayTakeover =
      applicant &&
      applicant.validBefore > now &&
      !loginClosed(who.authSessionId) &&
      !stopping &&
      !fenced(requirementId) &&
      !lease?.takeover;
    const takeoverHint =
      mayTakeover &&
      lease?.phase === 'held' &&
      tracked?.confirmed &&
      sameHolder(lease, tracked.scope, tracked.grant.generation) &&
      (!lease.runId ||
        executions.has(lease.runId) ||
        settlements.has(lease.runId))
        ? { canTakeover: true as const }
        : {};
    if (
      !stopping &&
      !fenced(requirementId) &&
      !tracked &&
      (!lease || (lease.phase === 'released' && !lease.runId))
    )
      return {
        ...hints,
        state: 'idle',
        ...(mayTakeover && {
          canAcquire: true as const,
          canTakeover: true as const,
        }),
      };
    if (
      !tracked?.confirmed ||
      !sameHolder(lease, tracked.scope, tracked.grant.generation) ||
      tracked.grant.contextVersion !== lease.contextVersion ||
      tracked.grant.expiresAt !== lease.expiresAt.getTime()
    )
      return { ...hints, ...takeoverHint, state: 'unconfirmed' };
    const execution = lease.runId ? executions.get(lease.runId) : undefined;
    const running =
      execution?.requirementId === requirementId &&
      execution.generation === lease.generation;
    const settlement = lease.runId ? settlements.get(lease.runId) : undefined;
    if (
      lease.phase === 'draining' &&
      running &&
      execution.controller.signal.aborted &&
      settlement?.outcome.status !== 'unknown'
    )
      return { ...hints, state: 'stopping' };
    const awaitingSettlement = [...settlements.values()].some(
      ({ scope, generation }) =>
        scope.requirementId === requirementId &&
        generation === lease.generation,
    );
    if (
      lease.phase !== 'held' ||
      stopping ||
      fenced(requirementId) ||
      loginClosed(lease.authSessionId) ||
      !holder ||
      awaitingSettlement ||
      (lease.runId && (!running || execution.controller.signal.aborted))
    )
      return { ...hints, state: 'unconfirmed' };
    const expiresAt = Math.min(lease.expiresAt.getTime(), holder.validBefore);
    if (expiresAt <= now)
      return { ...hints, ...takeoverHint, state: 'unconfirmed' };
    const own =
      lease.ownerId === who.userId && lease.authSessionId === who.authSessionId;
    const target = own
      ? {
          sessionId: lease.nativeSessionId,
          generation: lease.generation,
          expiresAt,
        }
      : undefined;
    const release = actionsEnabled && target ? { releaseTarget: target } : {};
    if (holder.requirement.contextVersion !== lease.contextVersion)
      return { ...hints, ...takeoverHint, ...release, state: 'unconfirmed' };
    return {
      ...hints,
      ...takeoverHint,
      ...release,
      state: 'held',
      ...(target && { holder: target }),
    };
  }

  return {
    startStopRecovery,
    readStatus,
    stopReadsEgress: () => readsEgress?.close() ?? Promise.resolve(),
    readsEgressStats: () => readsEgress?.stats(),
    readWorktree: (
      scope: Scope,
      request: Parameters<NonNullable<typeof reads>['read']>[1],
      assertCurrent = () => {},
      signal?: AbortSignal,
      live?: () => boolean,
    ) =>
      admit(() => {
        if (!reads) businessError(503, '当前读取暂不可用');
        return reads.read(
          readScope(scope),
          structuredClone(request),
          assertCurrent,
          signal,
          live,
        );
      }),
    // §11.20.26 metadata entry: one managed whole-file read registers the
    // single snapshot K and the first-page cursor without any page outbound.
    readWorktreeStat: (
      scope: Scope,
      request: { repositoryId: string; path: string },
      assertCurrent = () => {},
      signal?: AbortSignal,
      live?: () => boolean,
    ) =>
      admit(() => {
        if (!reads) businessError(503, '当前读取暂不可用');
        return reads.stat(
          readScope(scope),
          structuredClone(request),
          assertCurrent,
          signal,
          live,
        );
      }),
    // §11.20.26 long-line continuation registration (the Host probe reports
    // the displayed prefix of a line the locked read annotated as truncated).
    readWorktreeSegment: (
      scope: Scope,
      request: { snapshotId: string; line: number; prefix: string },
      assertCurrent = () => {},
      signal?: AbortSignal,
      live?: () => boolean,
    ) =>
      admit(() => {
        if (!reads) businessError(503, '当前读取暂不可用');
        return reads.segment(
          readScope(scope),
          structuredClone(request),
          assertCurrent,
          signal,
          live,
        );
      }),
    // §11.20.26: a registered long-line segment of this very scope.
    readWorktreeSegmentLive: (scope: Scope, segment: string) =>
      !!reads && reads.registered(readScope(scope), segment),
    // §11.23 S1: the append-only write of one recorded delivery
    // snapshot. Before the write, the commit hash is read back through
    // the restricted read-only Git chain (a fresh broker execution of
    // the fixed head query under the same scope and generation); the
    // row records the read-back value, carries the same commandId as
    // the write.execute receipt, and a replay answers with the
    // original row (原键回查) without executing again.
    recordDeliverySnapshot: (
      scope: Scope,
      input: {
        repositoryId: string;
        generation: string;
        commitHash: string;
        parentHead: string;
        paths: DeliverySnapshotPath[];
        messageSha256: string;
        commandId: string;
      },
    ) =>
      admit(async (): Promise<{ snapshot: unknown; replay: boolean }> => {
        const tracked = confirmedHolding(scope, input.generation);
        if (!tracked || !tracked.confirmed)
          businessError(409, '当前会话没有可用的写入资格');
        const replayed = await transaction(async (tx) => {
          const [existing] = await tx
            .select()
            .from(schema.requirementDeliverySnapshot)
            .where(
              and(
                eq(
                  schema.requirementDeliverySnapshot.repositoryId,
                  input.repositoryId,
                ),
                eq(
                  schema.requirementDeliverySnapshot.commitHash,
                  input.commitHash,
                ),
              ),
            );
          return existing;
        });
        if (replayed) {
          if (
            replayed.requirementId !== scope.requirementId ||
            replayed.commandId !== input.commandId
          )
            businessError(409, '提交哈希已记录为其他快照');
          return { snapshot: replayed, replay: true };
        }
        let readBackStdout = '';
        const readBack = await execute(
          scope,
          {
            generation: input.generation,
            commandId: input.commandId + '-head',
            repositoryId: input.repositoryId,
            request: { tool: 'git', operation: 'head' },
          },
          ({ stream, chunk }) => {
            if (stream === 'stdout') readBackStdout += chunk.toString('utf8');
          },
        );
        if (
          readBack.status !== 'finished' ||
          readBack.result.status !== 'ok' ||
          readBack.result.stop !== 'confirmed'
        )
          businessError(502, '提交哈希回读未能确认');
        const stdout = readBackStdout.trim();
        if (stdout !== input.commitHash)
          businessError(502, '提交哈希回读与提交结果不一致');
        return transaction(async (tx) => {
          const [plan] = await tx
            .select()
            .from(schema.requirementWorktreePlan)
            .where(
              eq(
                schema.requirementWorktreePlan.requirementId,
                scope.requirementId,
              ),
            );
          const repository = plan?.repositories.find(
            ({ repositoryId: id }) => id === input.repositoryId,
          );
          if (!repository) businessError(403, '仓库不在需求工作树范围内');
          const { snapshot, replay } = await recordDeliverySnapshotRow(tx, {
            requirementId: scope.requirementId,
            repositoryId: input.repositoryId,
            commitHash: input.commitHash,
            parentHead: input.parentHead,
            baseCommit: repository.baseCommit,
            paths: input.paths,
            messageSha256: input.messageSha256,
            commandId: input.commandId,
            committedBy: scope.who.userId,
            generation: input.generation,
          });
          return { snapshot, replay };
        });
      }),
    // §11.23 D1/D3: the read-only Git query of the changes view. Any
    // permitted reader of the requirement may sample the fixed status,
    // diff and head queries; the path never reserves a write execution
    // and never touches the control marker, so a reader does not
    // contend with an in-flight write.
    readWorktreeGit: (
      scope: Scope,
      request: { repositoryId: string; operation: 'status' | 'diff' | 'head' },
      signal?: AbortSignal,
    ) =>
      admit(() => {
        if (
          request.operation !== 'status' &&
          request.operation !== 'diff' &&
          request.operation !== 'head'
        )
          businessError(400, '只读 Git 查询不支持该操作');
        return (async () => {
          const [plan] = await db
            .select()
            .from(schema.requirementWorktreePlan)
            .where(
              eq(
                schema.requirementWorktreePlan.requirementId,
                scope.requirementId,
              ),
            );
          if (
            !plan?.repositories.some(
              ({ repositoryId: id }) => id === request.repositoryId,
            )
          )
            businessError(403, '仓库不在需求工作树范围内');
          const execution = await worktrees.executionScope(
            scope.projectId,
            scope.requirementId,
            plan.repositories,
            request.repositoryId,
          );
          return readGitMacosWorktree(
            () => Promise.resolve(execution),
            gitPath,
            { operation: request.operation },
            { signal },
          );
        })();
      }),
    // §11.20.27 W18: the tree and runtime root of one repository of the
    // requirement, for the prefix rewriting of an output.
    executionLocations: (scope: Scope, repositoryId: string) =>
      admit(async () => {
        const [plan] = await db
          .select()
          .from(schema.requirementWorktreePlan)
          .where(
            eq(
              schema.requirementWorktreePlan.requirementId,
              scope.requirementId,
            ),
          );
        if (
          !plan?.repositories.some(
            ({ repositoryId: id }) => id === repositoryId,
          )
        )
          businessError(403, '仓库不在需求工作树范围内');
        const execution = await worktrees.executionScope(
          scope.projectId,
          scope.requirementId,
          plan.repositories,
          repositoryId,
        );
        return { tree: execution.tree, runtimeRoot: execution.runtimeRoot };
      }),
    // §11.20.27 W10: the continuation snapshot of a Shell output.
    registerOutputSnapshot: (
      scope: Scope,
      repositoryId: string,
      bytes: Buffer,
      from: number,
      assertCurrent = () => {},
    ) =>
      admit(() => {
        if (!reads) businessError(503, '当前读取暂不可用');
        return reads.register(
          readScope(scope),
          repositoryId,
          bytes,
          from,
          assertCurrent,
        );
      }),
    // §11.20.27: the parent's own managed whole-file read, without pages or
    // window egress (the command set of a write generation).
    readWorktreeBytes: (
      scope: Scope,
      request: { repositoryId: string; path: string },
      assertCurrent = () => {},
      signal?: AbortSignal,
      live?: () => boolean,
    ) =>
      admit(() => {
        if (!reads) businessError(503, '当前读取暂不可用');
        return reads.bytes(
          readScope(scope),
          structuredClone(request),
          assertCurrent,
          signal,
          live,
        );
      }),
    confirmCommandScope: (scope: Scope, assertCurrent: () => void) =>
      admit(() =>
        readForCommand(
          structuredClone(scope),
          assertCurrent,
          async () => undefined,
        ),
      ),
    checkCommand: (
      scope: Scope,
      command: WriteCommand,
      assertCurrent = () => {},
    ) =>
      admit(() =>
        checkCommand(
          structuredClone(scope),
          structuredClone(command),
          assertCurrent,
        ),
      ),
    assertWireLease(scope: Scope, generation: string, contextVersion: number) {
      const tracked = confirmedHolding(scope, generation);
      if (!tracked || tracked.grant.contextVersion !== contextVersion)
        businessError(409, '当前会话没有可用的写入资格');
      allowed(tracked.grant.expiresAt, scope);
    },
    // §11.20.27: the confirmed write generation of this very session.
    writeHolding: (scope: Scope) => currentHolding(structuredClone(scope)),
    watchGrants(listener: (scope: Scope, grant: Grant) => void) {
      grantListeners.add(listener);
      return () => {
        grantListeners.delete(listener);
      };
    },
    acquire: (scope: Scope, commandId: string, assertCurrent = () => {}) =>
      admit(() => acquire(structuredClone(scope), commandId, assertCurrent)),
    takeover: (scope: Scope, commandId: string, assertCurrent = () => {}) =>
      admit(() => takeover(structuredClone(scope), commandId, assertCurrent)),
    execute: (
      scope: Scope,
      input: Invocation,
      onOutput?: OnOutput,
      signal?: AbortSignal,
      beforeCallStart?: BeforeCallStart,
    ) =>
      admit(() =>
        submit(
          structuredClone(scope),
          structuredClone(input),
          onOutput,
          signal,
          beforeCallStart,
        ),
      ),
    release: (
      scope: Scope,
      generation: string,
      commandId: string,
      assertCurrent = () => {},
    ) =>
      admit(() =>
        release(structuredClone(scope), generation, commandId, assertCurrent),
      ),
    beginAuthorityChange,
    changeAuthority: <T>(
      operationId: string,
      matches: (scope: Scope) => boolean,
      change: (tx: Queries) => Promise<T>,
      confirm: AuthorityConfirmation,
    ) => admit(() => changeAuthority(operationId, matches, change, confirm)),
    reconcileAuthorityChange: (operationId: string) =>
      admit(() => reconcileAuthorityChange(operationId)),
    stopAdmission() {
      stopping = true;
      reads?.stop();
    },
    close,
  };
}
