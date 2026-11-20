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
import type { DemandWorktrees } from '@rdws/orchestrator';
import type { RequirementWriteAuthority } from '@rdws/contracts';
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
type ExecutionReceipt =
  { status: 'reserved'; runId: string } | CompletedExecution;
type CompletedExecution = {
  status: 'finished' | 'unknown';
  runId: string;
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
  work?: Promise<ReleaseState>;
};
type WriteCommand =
  | { type: 'acquire'; commandId: string }
  | { type: 'release'; commandId: string; generation: string };
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
    return fences.size > 0 || releaseFences.has(requirementId);
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
          phase: old.runId ? 'draining' : 'released',
          updatedAt: new Date(),
        })
        .where(
          and(
            eq(leases.requirementId, requirementId),
            eq(leases.generation, generation),
          ),
        );
      return old.runId;
    });
    if (!runId) {
      forget(requirementId, generation);
      return 'released' as const;
    }
    const running = executions.get(runId);
    running?.controller.abort();
    await running?.done.catch(() => {});
    const settlement = settlements.get(runId);
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
      const phase = !safe
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
      await finish(tx, receipt, outcome);
      return phase === 'released';
    });
    if (released) forget(scope.requirementId, generation);
    settlements.delete(runId);
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

  async function acquire(scope: Scope, commandId: string) {
    let proposed: Grant | undefined;
    const issued = await transaction(async (tx, deadline) => {
      const snapshot = await context(tx, scope);
      const old = await lockedLease(tx, scope.requirementId);
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
        (old && (old.phase !== 'released' || old.runId))
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
      command.type === 'acquire'
        ? scope
        : { scope, generation: command.generation },
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

  async function checkCommand(scope: Scope, command: WriteCommand) {
    requireLiveLogin(scope);
    const { generation, validBefore } = await readTransaction(async (tx) => {
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
        generation: await recordedGeneration(tx, scope, command),
        validBefore: reader.expiresAt.getTime(),
      };
    });
    requireLiveLogin(scope);
    if (validBefore <= Date.now()) businessError(401, '登录已失效，请重新登录');
    return generation
      ? { state: 'recorded' as const, generation }
      : { state: 'unrecorded' as const };
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

  async function release(scope: Scope, generation: string, commandId: string) {
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
    const request = { scope, generation, commandId, uncertain: false };
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
    let candidate: { runId: string; receipt: ReceiptValue } | undefined;
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
      await finish(tx, receipt.value, { status: 'reserved', runId });
      candidate = { runId, receipt: receipt.value };
      return {
        kind: 'launch',
        runId,
        value: receipt.value,
        plan: plan.repositories,
      } as const;
    }).catch(async (error: unknown) => {
      if (error instanceof UnknownWriteCommit && candidate) {
        const { runId, receipt } = candidate;
        const settlement: Settlement = {
          scope,
          generation: input.generation,
          receipt,
          unconfirmedReservation: true,
          outcome: {
            status: 'finished',
            runId,
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

    const { runId, value, plan } = reservation;
    const controller = new AbortController();
    const signal = callSignal
      ? AbortSignal.any([controller.signal, callSignal])
      : controller.signal;
    let started = false;
    let confirmed = false;
    const done = runMacosWorktree(
      () =>
        worktrees.executionScope(
          scope.projectId,
          scope.requirementId,
          plan,
          input.repositoryId,
        ),
      gitPath,
      input.request,
      {
        signal,
        onOutput,
        async authorizeStart(start) {
          await transaction(async (tx, deadline, confirmConnection) => {
            const snapshot = await context(tx, scope);
            const row = await lockedLease(tx, scope.requirementId);
            if (
              !sameHolder(row, scope, input.generation) ||
              row.runId !== runId ||
              row.phase !== 'held' ||
              row.contextVersion !== snapshot.requirement.contextVersion
            )
              businessError(409, '当前执行的写入资格已失效');
            allowed(
              Math.min(deadline, snapshot.validBefore, row.expiresAt.getTime()),
              scope,
            );
            confirmConnection();
            beforeCallStart?.(snapshot.requirement.contextVersion);
            signal.throwIfAborted();
            start();
            started = true;
          });
          confirmed = true;
        },
      },
    )
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
      const states = await Promise.allSettled(
        [...holdings.values()].map(({ scope, grant }) =>
          drain(scope.requirementId, grant.generation),
        ),
      );
      if (
        releaseFences.size > 0 ||
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
  ): Promise<RequirementWriteAuthority> {
    const deadline = Date.now() + 1800;
    const { reader, lease, holder } = await readTransaction(async (tx) => {
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
      let holder: Awaited<ReturnType<typeof business.writeContext>> | undefined;
      if (lease?.phase === 'held') {
        try {
          holder = await business.writeContext(
            tx,
            { userId: lease.ownerId, authSessionId: lease.authSessionId },
            projectId,
            requirementId,
            lease.nativeSessionId,
            false,
          );
        } catch (error) {
          const status = (error as { statusCode?: number }).statusCode;
          if (status !== 401 && status !== 403 && status !== 404) throw error;
        }
      }
      return { reader, lease, holder };
    });
    assertReader();
    const now = Date.now();
    if (reader.expiresAt.getTime() <= now)
      businessError(401, '登录已失效，请重新登录');
    if (deadline <= now) businessError(503, '写权状态读取超时');

    const tracked = holdings.get(requirementId);
    if (
      !stopping &&
      !fenced(requirementId) &&
      !tracked &&
      (!lease || (lease.phase === 'released' && !lease.runId))
    )
      return { state: 'idle' };
    if (
      !tracked?.confirmed ||
      !sameHolder(lease, tracked.scope, tracked.grant.generation) ||
      tracked.grant.contextVersion !== lease.contextVersion ||
      tracked.grant.expiresAt !== lease.expiresAt.getTime()
    )
      return { state: 'unconfirmed' };
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
      return { state: 'stopping' };
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
      holder.requirement.contextVersion !== lease.contextVersion ||
      awaitingSettlement ||
      (lease.runId && (!running || execution.controller.signal.aborted))
    )
      return { state: 'unconfirmed' };
    const expiresAt = Math.min(lease.expiresAt.getTime(), holder.validBefore);
    if (expiresAt <= now) return { state: 'unconfirmed' };
    if (
      lease.ownerId !== who.userId ||
      lease.authSessionId !== who.authSessionId
    )
      return { state: 'held' };
    return {
      state: 'held',
      holder: {
        sessionId: lease.nativeSessionId,
        generation: lease.generation,
        expiresAt,
      },
    };
  }

  return {
    readStatus,
    checkCommand: (scope: Scope, command: WriteCommand) =>
      admit(() =>
        checkCommand(structuredClone(scope), structuredClone(command)),
      ),
    assertWireLease(scope: Scope, generation: string, contextVersion: number) {
      const tracked = confirmedHolding(scope, generation);
      if (!tracked || tracked.grant.contextVersion !== contextVersion)
        businessError(409, '当前会话没有可用的写入资格');
      allowed(tracked.grant.expiresAt, scope);
    },
    acquire: (scope: Scope, commandId: string) =>
      admit(() => acquire(structuredClone(scope), commandId)),
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
    release: (scope: Scope, generation: string, commandId: string) =>
      admit(() => release(structuredClone(scope), generation, commandId)),
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
