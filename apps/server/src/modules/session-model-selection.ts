import { randomUUID } from 'node:crypto';
import { schema, type connectDatabase } from '@rdws/db';
import { isRecord } from '@rdws/dsh/access';
import { and, eq, sql } from 'drizzle-orm';
import {
  businessError,
  requireSavedChildModel,
  digestOf,
  type Actor,
  type createBusiness,
} from './business.ts';
import type {
  CheckedWriteTransaction,
  WriteTransaction,
} from './checked-write-transaction.ts';

const selections = schema.sessionModelSelection;
const dispatches = schema.sessionPromptDispatch;
const firstWrites = schema.sessionModelFirstWrite;
const receipts = schema.commandReceipt;

export type SessionModelPilot = {
  projectId: string;
  provider: string;
  defaultModel: string;
  models: ReadonlySet<string>;
};

export async function validateSessionModelStorage(
  { pool }: ReturnType<typeof connectDatabase>,
  databaseFixture: string,
) {
  const { rows } = await pool.query<{ ready: boolean }>(
    `
    select current_user = 'rdws_test_app' and current_database() = 'rdws_test'
      and current_setting('rdws.fixture_instance', true) = $1
      and current_setting('fsync') = 'on' and not pg_is_in_recovery()
      and (select count(distinct c.oid) = 2 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        join pg_catalog.pg_trigger t on t.tgrelid=c.oid
        where n.nspname='public' and c.relkind='r'
          and c.relname in ('session_model_selection','session_prompt_dispatch')
          and t.tgname='rdws_authority_writer' and t.tgtype=62 and t.tgenabled='A'
          and t.tgfoid=pg_catalog.to_regprocedure('rdws_authority.check_writer()')
          and pg_catalog.has_table_privilege(current_user,c.oid,'SELECT')
          and pg_catalog.has_table_privilege(current_user,c.oid,'INSERT')
          and pg_catalog.has_table_privilege(current_user,c.oid,'UPDATE')
          and not pg_catalog.has_table_privilege(current_user,c.oid,'DELETE,TRUNCATE'))
      and exists(select 1 from pg_catalog.pg_class c
        join pg_catalog.pg_namespace n on n.oid=c.relnamespace
        join pg_catalog.pg_trigger t on t.tgrelid=c.oid
        where n.nspname='public' and c.relkind='r' and c.relname='session_model_first_write'
          and t.tgname='rdws_authority_writer' and t.tgtype=62 and t.tgenabled='A'
          and t.tgfoid=pg_catalog.to_regprocedure('rdws_authority.check_writer()')
          and pg_catalog.has_table_privilege(current_user,c.oid,'SELECT')
          and not pg_catalog.has_table_privilege(current_user,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE')
          and not exists(select 1 from pg_catalog.pg_attribute a
            where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped
              and (pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'INSERT')
                  <> (a.attname not in ('state','created_at','submitted_at'))
                or pg_catalog.has_column_privilege(current_user,c.oid,a.attnum,'UPDATE')
                  <> (a.attname in ('state','submitted_at'))))) as ready`,
    [databaseFixture],
  );
  if (rows[0]?.ready !== true)
    throw new Error(
      'Session model pilot database protection could not be confirmed',
    );
}

export type ModelSessionScope = {
  who: Actor;
  projectId: string;
  requirementId: string;
  sessionId: string;
};
export type SavedSessionModel = {
  provider: string;
  model: string;
  revision: string;
};
export type SessionModelOptions = {
  provider: string;
  models: ReadonlySet<string>;
  isCurrent(): boolean;
};
export type PromptDispatch = typeof dispatches.$inferSelect;
export type NativePromptTicket = {
  hostGeneration: string;
  peerNonce: string;
  expiresAt: number;
};

function available(
  options: SessionModelOptions,
  model: Pick<SavedSessionModel, 'provider' | 'model'>,
) {
  if (!options.isCurrent()) businessError(503, '会话模型目录暂不可用');
  if (options.provider !== model.provider || !options.models.has(model.model))
    businessError(409, '已选模型当前不可用，请重新选择后发送');
}

function dispatchKey(scope: ModelSessionScope, requestId: string) {
  return and(
    eq(dispatches.nativeSessionId, scope.sessionId),
    eq(dispatches.requestId, requestId),
    eq(dispatches.projectId, scope.projectId),
    eq(dispatches.requirementId, scope.requirementId),
    eq(dispatches.actorId, scope.who.userId),
  );
}

export function createSessionModelSelection(
  business: Pick<ReturnType<typeof createBusiness>, 'lockModelSession'>,
  checked: CheckedWriteTransaction,
) {
  function scoped<T>(
    scope: ModelSessionScope,
    current: () => void,
    work: (tx: WriteTransaction, expiry: number, isFork: boolean) => Promise<T>,
  ) {
    return checked(async (tx, assertConnection) => {
      await tx.execute(
        sql`set local transaction_timeout='2400ms'; set local lock_timeout='650ms'; set local statement_timeout='950ms'; set local synchronous_commit='on'`,
      );
      const { expiry, isFork } = await business.lockModelSession(
        tx,
        scope.who,
        scope.projectId,
        scope.requirementId,
        scope.sessionId,
      );
      const assert = () => {
        assertConnection();
        current();
        if (expiry <= Date.now()) businessError(401, '登录已失效，请重新登录');
      };
      assert();
      const result = await work(tx, expiry, isFork);
      assert();
      return result;
    });
  }

  async function readSelection(tx: WriteTransaction, sessionId: string) {
    const [row] = await tx
      .select({
        provider: selections.provider,
        model: selections.model,
        revision: selections.revision,
      })
      .from(selections)
      .where(eq(selections.nativeSessionId, sessionId));
    return row ?? null;
  }

  function read(scope: ModelSessionScope, current: () => void) {
    return scoped(scope, current, async (tx) => {
      const evidence = tx
        .select({ state: firstWrites.state })
        .from(firstWrites)
        .innerJoin(
          dispatches,
          and(
            eq(dispatches.nativeSessionId, firstWrites.nativeSessionId),
            eq(dispatches.requestId, firstWrites.selectionRequestId),
            eq(dispatches.projectId, firstWrites.projectId),
            eq(dispatches.requirementId, firstWrites.requirementId),
            eq(dispatches.provider, firstWrites.provider),
            eq(dispatches.model, firstWrites.model),
            eq(dispatches.selectionRevision, firstWrites.selectionRevision),
            eq(dispatches.hostGeneration, firstWrites.hostGeneration),
          ),
        )
        .where(
          and(
            eq(firstWrites.nativeSessionId, selections.nativeSessionId),
            eq(firstWrites.projectId, scope.projectId),
            eq(firstWrites.requirementId, scope.requirementId),
            eq(firstWrites.provider, selections.provider),
            eq(firstWrites.model, selections.model),
            eq(firstWrites.selectionRevision, selections.revision),
            eq(dispatches.actorId, scope.who.userId),
          ),
        )
        .orderBy(sql`(${firstWrites.state} = 'submitted') desc`)
        .limit(1);
      const [row] = await tx
        .select({
          provider: selections.provider,
          model: selections.model,
          revision: selections.revision,
          firstWrite: sql<'prepared' | 'submitted' | null>`(${evidence})`,
        })
        .from(selections)
        .where(eq(selections.nativeSessionId, scope.sessionId));
      if (!row) return { selection: null, firstWrite: null };
      const { firstWrite, ...selection } = row;
      return { selection, firstWrite };
    });
  }

  async function save(
    scope: ModelSessionScope,
    input: {
      commandId: string;
      provider: string;
      model: string;
      supersedes?: unknown;
    },
    current: () => void,
    readOptions: () => Promise<SessionModelOptions>,
  ) {
    const selected = { provider: input.provider, model: input.model };
    let replaced: string[] = [];
    if (input.supersedes !== undefined) {
      const ids = input.supersedes;
      if (
        !Array.isArray(ids) ||
        ids.length < 1 ||
        ids.length > 32 ||
        ids.some(
          (id) =>
            typeof id !== 'string' ||
            !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[0-9a-f]{12}$/.test(id) ||
            id === input.commandId,
        ) ||
        new Set(ids).size !== ids.length
      )
        businessError(400, '替代的选模命令格式不正确');
      replaced = [...ids].sort();
    }
    const key = {
      actorId: scope.who.userId,
      scope: 'session:' + scope.sessionId,
      operation: 'model.select',
      commandId: input.commandId,
      digest: digestOf(
        replaced.length ? { ...selected, supersedes: replaced } : selected,
      ),
    };
    const condition = and(
      eq(receipts.actorId, key.actorId),
      eq(receipts.scope, key.scope),
      eq(receipts.operation, key.operation),
      eq(receipts.commandId, key.commandId),
    );
    async function priorSave(tx: WriteTransaction) {
      const [receipt] = await tx
        .select({ digest: receipts.digest, result: receipts.result })
        .from(receipts)
        .where(condition);
      if (!receipt) return undefined;
      if (
        isRecord(receipt.result) &&
        typeof receipt.result.supersededBy === 'string'
      )
        businessError(409, '原保存已被后续选模命令替代');
      if (receipt.digest !== key.digest)
        businessError(409, '操作标识已用于不同内容，请重新发起');
      const value = receipt.result;
      if (
        !isRecord(value) ||
        value.provider !== selected.provider ||
        value.model !== selected.model ||
        typeof value.revision !== 'string' ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value.revision)
      )
        businessError(503, '原选模操作尚未确认');
      return { ...selected, revision: value.revision };
    }
    const prior = await scoped(scope, current, priorSave);
    if (prior) return prior;
    const options = await readOptions();
    return scoped(scope, current, async (tx) => {
      const saved = await priorSave(tx);
      if (saved) return saved;
      available(options, selected);
      const result = { ...selected, revision: randomUUID() };
      await tx
        .insert(selections)
        .values({ nativeSessionId: scope.sessionId, ...result })
        .onConflictDoUpdate({
          target: selections.nativeSessionId,
          set: { ...result, updatedAt: new Date() },
        });
      await tx.insert(receipts).values({ ...key, result });
      if (replaced.length) {
        const terminal = { supersededBy: input.commandId };
        await tx
          .insert(receipts)
          .values(
            replaced.map((commandId) => ({
              ...key,
              commandId,
              digest: digestOf(terminal),
              result: terminal,
            })),
          )
          .onConflictDoNothing();
      }
      if (!options.isCurrent()) businessError(503, '会话模型目录暂不可用');
      return result;
    });
  }

  async function promptRecord(
    tx: WriteTransaction,
    scope: ModelSessionScope,
    input: { requestId: string; inputDigest: string },
  ) {
    const [row] = await tx
      .select()
      .from(dispatches)
      .where(dispatchKey(scope, input.requestId));
    if (row && row.inputDigest !== input.inputDigest)
      businessError(409, '消息标识已用于不同输入，请重新发起');
    return row;
  }
  function readPrompt(
    scope: ModelSessionScope,
    input: { requestId: string; inputDigest: string },
    current: () => void,
  ) {
    return scoped(scope, current, async (tx, _expiry, isFork) => {
      const prior = await promptRecord(tx, scope, input);
      if (!prior && isFork)
        await requireSavedChildModel(
          tx,
          scope.who.userId,
          scope.sessionId,
          await readSelection(tx, scope.sessionId),
        );
      return prior;
    });
  }
  async function reservePrompt(
    scope: ModelSessionScope,
    input: { requestId: string; inputDigest: string },
    current: () => void,
    readOptions: () => Promise<SessionModelOptions>,
    defaultModel: SavedSessionModel,
  ) {
    const row = await readPrompt(scope, input, current);
    if (row) return row;
    const options = await readOptions();
    return scoped(scope, current, async (tx, _expiry, isFork) => {
      const prior = await promptRecord(tx, scope, input);
      if (prior) return prior;
      const saved = await readSelection(tx, scope.sessionId);
      if (isFork)
        await requireSavedChildModel(
          tx,
          scope.who.userId,
          scope.sessionId,
          saved,
        );
      const selected = saved ?? defaultModel;
      available(options, selected);
      const [reserved] = await tx
        .insert(dispatches)
        .values({
          nativeSessionId: scope.sessionId,
          projectId: scope.projectId,
          requirementId: scope.requirementId,
          actorId: scope.who.userId,
          authSessionId: scope.who.authSessionId,
          ...input,
          provider: selected.provider,
          model: selected.model,
          selectionRevision: selected.revision,
        })
        .returning();
      if (!options.isCurrent()) businessError(503, '会话模型目录暂不可用');
      return reserved!;
    });
  }

  function freezePrompt(
    scope: ModelSessionScope,
    requestId: string,
    ticket: NativePromptTicket,
    options: SessionModelOptions,
    current: () => void,
  ) {
    return scoped(scope, current, async (tx, expiry, isFork) => {
      const condition = and(
        dispatchKey(scope, requestId),
        eq(dispatches.authSessionId, scope.who.authSessionId),
        eq(dispatches.state, 'reserved'),
      );
      const [reserved] = await tx.select().from(dispatches).where(condition);
      if (!reserved) businessError(409, '原消息只能核对，不能再次派发');
      if (isFork)
        await requireSavedChildModel(tx, scope.who.userId, scope.sessionId, {
          provider: reserved.provider,
          model: reserved.model,
          revision: reserved.selectionRevision,
        });
      available(options, reserved);
      if (ticket.expiresAt <= Date.now() || ticket.expiresAt > expiry)
        businessError(409, '原生派发票据已失效');
      const [frozen] = await tx
        .update(dispatches)
        .set({
          state: 'pending',
          hostGeneration: ticket.hostGeneration,
          peerNonce: ticket.peerNonce,
          leaseExpiresAt: new Date(ticket.expiresAt),
          updatedAt: new Date(),
        })
        .where(condition)
        .returning();
      if (!frozen) businessError(409, '原消息只能核对，不能再次派发');
      if (!options.isCurrent()) businessError(503, '会话模型目录暂不可用');
      return frozen;
    });
  }

  function confirmPrompt(
    scope: ModelSessionScope,
    original: PromptDispatch,
    observed: { sequence: number; messageId: string },
    current: () => void,
  ) {
    return scoped(scope, current, async (tx) => {
      if (
        !original.hostGeneration ||
        !original.peerNonce ||
        original.nativeSessionId !== scope.sessionId ||
        original.projectId !== scope.projectId ||
        original.requirementId !== scope.requirementId ||
        original.actorId !== scope.who.userId
      )
        businessError(409, '原消息没有可核对的派发票据');
      const condition = and(
        dispatchKey(scope, original.requestId),
        eq(dispatches.authSessionId, original.authSessionId),
        eq(dispatches.hostGeneration, original.hostGeneration),
        eq(dispatches.peerNonce, original.peerNonce),
        eq(dispatches.inputDigest, original.inputDigest),
        eq(dispatches.provider, original.provider),
        eq(dispatches.model, original.model),
        eq(dispatches.selectionRevision, original.selectionRevision),
      );
      const [confirmed] = await tx
        .update(dispatches)
        .set({
          state: 'accepted',
          acceptedSeq: observed.sequence,
          acceptedMessageId: observed.messageId,
          updatedAt: new Date(),
        })
        .where(and(condition, eq(dispatches.state, 'pending')))
        .returning();
      if (confirmed) return confirmed;
      const [saved] = await tx.select().from(dispatches).where(condition);
      if (
        saved?.state !== 'accepted' ||
        saved.acceptedSeq !== observed.sequence ||
        saved.acceptedMessageId !== observed.messageId
      )
        businessError(409, '原消息的接纳证据不一致');
      return saved;
    });
  }

  return { read, save, readPrompt, reservePrompt, freezePrompt, confirmPrompt };
}
