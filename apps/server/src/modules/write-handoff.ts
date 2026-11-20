import { randomBytes, randomUUID } from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  acquireAuthority,
  releaseAuthority,
  schema,
  connectDatabase,
} from '@rdws/db';
import { runMacosWorktree, type ExecutionRequest } from '@rdws/dsh/execution';
import {
  runSupervisedMacosWorktree,
  type ExecutionProofBinding,
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
};
type RunResult = Awaited<ReturnType<typeof runMacosWorktree>>;
type ExecutionProof = {
  stage: 'reserved' | 'armed';
  binding: ExecutionProofBinding;
};
type ExecutionReceipt =
  | { status: 'reserved'; runId: string; proof?: ExecutionProof }
  | CompletedExecution;
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
  );
  let shutdown: Promise<void> | undefined;
  async function stop() {
    try {
      await handoff.close();
      await releaseAuthority(database.pool, owned);
    } finally {
      await database.pool.end();
    }
  }
  return { ...handoff, close: () => (shutdown ??= stop()) };
}

export function createOwnedWriteHandoff(
  { pool, db }: Database,
  authority: string,
  worktrees: DemandWorktrees,
  gitPath: string,
  leaseMs = leaseDuration,
  loginClosed: (id: string) => boolean = () => false,
  supervisedExecution = false,
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

  async function transaction<T>(
    work: (
      tx: Queries,
      deadline: number,
      confirmConnection: () => void,
    ) => Promise<T>,
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
      await query('begin');
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
      takeovers.has(requirementId)
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
    read: (tx: Queries) => Promise<T>,
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
        result: await read(tx),
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
    await finish(tx, takeoverKey(scope, commandId), outcome);
    if (request.phase === 'initial') request.assertCurrent();
    requireLiveLogin(scope);
    if (stopping || fences.size || Math.min(expiresAt, deadline) <= Date.now())
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
        )
          tracked.confirmed = true;
        else await drain(scope.requirementId, proposed.generation);
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
            async arm() {
              await transaction(async (tx, deadline) => {
                const { validBefore } = await liveRun(tx, deadline);
                await assertProof(tx, 'reserved');
                await finish(tx, value, {
                  status: 'reserved',
                  runId,
                  proof: { ...proof, stage: 'armed' },
                });
                allowed(validBefore, scope);
                signal.throwIfAborted();
              });
              proof.stage = 'armed';
            },
          },
        )
      : runMacosWorktree(verifyScope, gitPath, input.request, {
          signal,
          onOutput,
          authorizeStart,
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
        (
          await db
            .select({ id: leases.requirementId })
            .from(leases)
            .where(
              sql`${leases.takeover} is not null or ${leases.runId} is not null`,
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
    readStatus,
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
    },
    close,
  };
}
