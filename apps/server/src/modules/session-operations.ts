import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import type { SessionOperationResult } from '@rdws/contracts';
import { isDemandPreset, type NativeWebHost } from '@rdws/dsh/web';
import { isRecord, type Grant } from '@rdws/dsh/access';
import { forkBoundary, sessionRpc } from '@rdws/dsh/sessions';
import { readForkModelPrefix } from './fork-model-evidence.ts';
import {
  recordForkSource,
  recordForkChild,
  type ForkKey,
} from './fork-model-receipt.ts';
import {
  businessError,
  digestOf,
  type Actor,
  type createBusiness,
} from './business.ts';
type Database = ReturnType<typeof connectDatabase>['db'];
type Operation = typeof schema.sessionOperation.$inferSelect;
type Frozen = NonNullable<Operation['frozen']>;
const presetRejections = {
  'preset-unavailable':
    '原操作未执行。绑定或来源的能力版本未能装载，请联系管理员核对后重试。',
  'preset-unapproved': '原操作未执行。能力版本的审核已失效，请核对需求模板。',
  'preset-paused': '原操作未执行。使用能力模板的新会话当前暂停，请联系管理员。',
};
function nativeRequest(frozen: Frozen, sourceSessionId?: string) {
  return sourceSessionId
    ? { sessionId: sourceSessionId, atSeq: frozen.atSeq, allowMigration: false }
    : {
        workspaceId: frozen.workspaceId,
        ...(frozen.agentPreset ? { agentPreset: frozen.agentPreset } : {}),
      };
}
function frozenDigest(frozen: Frozen, sourceSessionId?: string) {
  const request = nativeRequest(frozen, sourceSessionId);
  return digestOf(
    frozen.dispatchVersion === 1
      ? { request, agentPreset: frozen.agentPreset }
      : request,
  );
}
export function createSessionOperations(
  db: Database,
  business: ReturnType<typeof createBusiness>,
  native: NativeWebHost,
  proveForkModel = false,
) {
  const generation = randomUUID(),
    active = new Set<string>();
  const table = schema.sessionOperation;
  const presetsPaused = process.env.RDWS_PAUSE_PRESET_CREATION === '1';
  const result = (row: Operation): SessionOperationResult => ({
    commandId: row.commandId,
    status: row.status as SessionOperationResult['status'],
    ...(row.status === 'mapped' ? { sessionId: row.nativeSessionId! } : {}),
    ...(row.status === 'rejected'
      ? {
          error: row.frozen?.rejection
            ? presetRejections[row.frozen.rejection]
            : '原操作已拒绝且未执行，可重新发起。',
        }
      : {}),
  });
  async function execute(
    who: Actor,
    requirementId: string,
    commandId: string,
    sourceSessionId: string | undefined,
    options: {
      current: () => Promise<void>;
      assertOpen: () => void;
      prepare: () => Promise<{
        workspaceId: string;
        cwd: string;
        grant: Omit<Grant, 'aud' | 'issuedAt' | 'expiresAt' | 'nonce'>;
      }>;
      mapped: () => Promise<void>;
      validateReturn: () => Promise<void>;
    },
  ) {
    const operation = sourceSessionId ? 'fork' : 'create';
    const digest = digestOf({
      operation,
      sourceSessionId: sourceSessionId ?? null,
    });
    async function authorized<T>(
      work: Parameters<typeof business.sessionTransaction<T>>[4],
    ) {
      await options.current();
      return business.sessionTransaction(
        who,
        requirementId,
        native.projectId,
        sourceSessionId,
        async (tx, item, expiresAt) => {
          options.assertOpen();
          const value = await work(tx, item, expiresAt);
          options.assertOpen();
          return value;
        },
      );
    }
    let row = await authorized(async (tx) => {
      const key = and(
        eq(table.actorId, who.userId),
        eq(table.requirementId, requirementId),
        eq(table.operation, operation),
        eq(table.commandId, commandId),
      );
      await tx
        .insert(table)
        .values({
          id: randomUUID(),
          actorId: who.userId,
          requirementId,
          operation,
          commandId,
          digest,
          sourceSessionId,
        })
        .onConflictDoNothing();
      const [entry] = await tx.select().from(table).where(key);
      if (!entry || entry.digest !== digest)
        businessError(409, '该操作标识已用于不同会话，请核对原操作');
      return entry;
    });
    const update = async (values: Partial<typeof table.$inferInsert>) => {
      const [next] = await db
        .update(table)
        .set({ ...values, updatedAt: new Date() })
        .where(eq(table.id, row.id))
        .returning();
      if (!next) throw new Error('Session operation disappeared');
      row = next;
      return next;
    };
    const orphan = join(
      native.runtimeHome,
      'state',
      'exports',
      'session-operation-' + row.id + '.json',
    );
    async function remember(nativeSessionId: string) {
      try {
        row = await update({ nativeSessionId, status: 'native-created' });
        return true;
      } catch {
        await mkdir(join(native.runtimeHome, 'state', 'exports'), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(
          orphan,
          JSON.stringify({ operationId: row.id, sessionId: nativeSessionId }),
          { mode: 0o600, flag: 'wx' },
        );
        return false;
      }
    }
    async function mappedResult() {
      await options.current();
      await options.mapped();
      await options.validateReturn();
      return result(row);
    }
    if (row.status === 'rejected') return result(row);
    if (row.status === 'mapped') {
      return mappedResult();
    }
    if (active.has(row.id)) return result(row);
    active.add(row.id);
    let observedFork:
      { key: ForkKey; childId: string; sourceDigest: string } | undefined;
    try {
      if (row.status === 'dispatched' || row.status === 'unknown') {
        const saved = await readFile(orphan, 'utf8')
          .then((text) => JSON.parse(text) as unknown)
          .catch(() => undefined);
        if (
          isRecord(saved) &&
          saved.operationId === row.id &&
          typeof saved.sessionId === 'string' &&
          /^session-[a-zA-Z0-9-]+$/.test(saved.sessionId)
        )
          row = await update({
            nativeSessionId: saved.sessionId,
            status: 'native-created',
          });
        if (row.status !== 'native-created') {
          await db
            .update(table)
            .set({ status: 'unknown', updatedAt: new Date() })
            .where(
              and(
                eq(table.id, row.id),
                eq(table.status, 'dispatched'),
                isNull(table.nativeSessionId),
              ),
            );
          const [current] = await db
            .select()
            .from(table)
            .where(eq(table.id, row.id));
          row = current!;
          if (row.status === 'unknown') return result(row);
          if (row.status === 'mapped') {
            return mappedResult();
          }
        }
      }
      if (row.status === 'reserved') {
        const prepared = await options.prepare();
        let atSeq: number | undefined;
        let agentPreset: string | null = null;
        try {
          if (sourceSessionId) {
            const identity = await native.control('session.preset', {
              requirementId,
              sessionId: sourceSessionId,
            });
            if (
              identity.cwd !== prepared.cwd ||
              identity.workspaceId !== prepared.workspaceId
            )
              businessError(409, '会话工作区不匹配，派生未执行');
            if (typeof identity.agentPreset === 'string')
              agentPreset = identity.agentPreset;
            atSeq = await forkBoundary(native, prepared.grant, sourceSessionId);
            if (atSeq === undefined)
              businessError(409, '当前会话没有已结束的轮次，暂不能派生');
          }
        } catch (error) {
          if ((error as { statusCode?: number }).statusCode !== 409)
            throw error;
          row = await authorized(async (tx) => {
            await tx
              .update(table)
              .set({ status: 'rejected', updatedAt: new Date() })
              .where(and(eq(table.id, row.id), eq(table.status, 'reserved')));
            const [entry] = await tx
              .select()
              .from(table)
              .where(eq(table.id, row.id));
            return entry!;
          });
          return {
            ...result(row),
            ...(row.status === 'rejected'
              ? { error: (error as Error).message }
              : {}),
          };
        }
        let inherited:
          Awaited<ReturnType<typeof native.presets.read>> | undefined;
        let rejection: Frozen['rejection'];
        if (sourceSessionId && isDemandPreset(agentPreset)) {
          try {
            inherited = await native.presets.read(agentPreset, requirementId);
          } catch {
            rejection = 'preset-unavailable';
          }
        }
        const candidate = sourceSessionId
          ? undefined
          : await authorized(business.sessionTemplate);
        if (candidate?.approved === false) rejection = 'preset-unapproved';
        if (!rejection && presetsPaused && (candidate || inherited))
          rejection = 'preset-paused';
        if (!rejection) {
          try {
            if (candidate) {
              agentPreset = (
                await native.preparePreset(requirementId, candidate.selection)
              ).id;
            } else if (inherited) {
              await native.ensurePreset(requirementId, inherited.id);
            }
          } catch {
            rejection = 'preset-unavailable';
          }
        }
        const frozen: Frozen = {
          workspaceId: prepared.workspaceId,
          cwd: prepared.cwd,
          ...(atSeq === undefined ? {} : { atSeq }),
          dispatchVersion: 1,
          agentPreset,
        };
        frozen.requestDigest = frozenDigest(frozen, sourceSessionId);
        const forkKey: ForkKey | undefined =
          proveForkModel && sourceSessionId && atSeq !== undefined
            ? {
                actorId: who.userId,
                projectId: native.projectId,
                requirementId,
                sourceSessionId,
                cut: atSeq,
                operationId: row.id,
                commandId,
              }
            : undefined;
        const prefix =
          forkKey &&
          (await readForkModelPrefix(
            native,
            prepared.grant,
            forkKey.sourceSessionId,
            forkKey.cut,
          ));
        const dispatched = await authorized(async (tx, item, expiresAt) => {
          if (item.nativeWorkspaceId !== frozen.workspaceId) return;
          let failure = rejection;
          if (sourceSessionId) {
            if (
              inherited &&
              !(await business.approvedTemplateReferences(
                tx,
                inherited.capabilities,
              ))
            )
              failure = 'preset-unapproved';
          } else {
            const current = await business.sessionTemplate(tx, item);
            if (digestOf(current?.selection) !== digestOf(candidate?.selection))
              return;
            if (current?.approved === false) failure = 'preset-unapproved';
            else if (candidate?.approved === false) return;
          }
          const [entry] = await tx
            .update(table)
            .set({
              status: failure ? 'rejected' : 'dispatched',
              frozen: failure ? { ...frozen, rejection: failure } : frozen,
              generation,
              updatedAt: new Date(),
            })
            .where(and(eq(table.id, row.id), eq(table.status, 'reserved')))
            .returning();
          if (!entry) return;
          options.assertOpen();
          if (expiresAt <= Date.now())
            businessError(401, '登录已失效，请重新登录');
          const ticket = failure
            ? undefined
            : native.ticket(
                sourceSessionId
                  ? {
                      ...prepared.grant,
                      purpose: 'fork',
                      sourceSessionId,
                      atSeq,
                      agentPreset,
                    }
                  : { ...prepared.grant, purpose: 'create', agentPreset },
                expiresAt,
              );
          const sourceDigest =
            ticket && forkKey && prefix
              ? await recordForkSource(tx, forkKey, prefix)
              : undefined;
          return { entry, ticket, sourceDigest };
        });
        if (!dispatched) {
          const [existing] = await db
            .select()
            .from(table)
            .where(eq(table.id, row.id));
          await options.current();
          return result(existing!);
        }
        row = dispatched.entry;
        if (!dispatched.ticket) return result(row);
        try {
          options.assertOpen();
          const value = await sessionRpc(
            native,
            dispatched.ticket,
            'session/' + operation,
            nativeRequest(frozen, sourceSessionId),
          );
          if (
            !value ||
            typeof value !== 'object' ||
            !('sessionId' in value) ||
            typeof value.sessionId !== 'string' ||
            !/^session-[a-zA-Z0-9-]+$/.test(value.sessionId)
          )
            throw new Error('Invalid Native child identity');
          if (forkKey && dispatched.sourceDigest)
            observedFork = {
              key: forkKey,
              childId: value.sessionId,
              sourceDigest: dispatched.sourceDigest,
            };
          if (!(await remember(value.sessionId)))
            return { ...result(row), status: 'unknown' };
        } catch (error) {
          const known = (error as { nativeSessionId?: string }).nativeSessionId;
          if (known) {
            const persisted = await remember(known);
            await options.current();
            return persisted
              ? result(row)
              : { ...result(row), status: 'unknown' };
          }
          if (row.status === 'dispatched')
            row = await update({ status: 'unknown' });
          await options.current();
          if ((error as { statusCode?: number }).statusCode) throw error;
          return result(row);
        }
      }
      await options.current();
      if (
        row.frozen?.requestDigest &&
        row.frozen.requestDigest !== frozenDigest(row.frozen, sourceSessionId)
      )
        businessError(409, '原操作参数无法核实，请联系管理员核对');
      await options.prepare();
      const identity = await native.control(
        row.frozen?.dispatchVersion === 1
          ? 'session.preset'
          : 'session.inspect',
        {
          requirementId,
          sessionId: row.nativeSessionId,
        },
      );
      if (
        !row.frozen ||
        identity.cwd !== row.frozen.cwd ||
        identity.workspaceId !== row.frozen.workspaceId ||
        (row.frozen.dispatchVersion === 1 &&
          (row.frozen.agentPreset
            ? identity.agentPreset !== row.frozen.agentPreset
            : isDemandPreset(identity.agentPreset)))
      )
        businessError(409, '新会话工作区无法核实，请核对原操作');
      row = await authorized(async (tx) => {
        await tx
          .insert(schema.nativeSession)
          .values({
            id: row.nativeSessionId!,
            requirementId,
            ownerId: who.userId,
            sourceSessionId,
            sourceThroughSeq: row.frozen!.atSeq,
          })
          .onConflictDoNothing();
        const [mapping] = await tx
          .select()
          .from(schema.nativeSession)
          .where(eq(schema.nativeSession.id, row.nativeSessionId!));
        if (
          mapping?.requirementId !== requirementId ||
          mapping.ownerId !== who.userId ||
          (proveForkModel &&
            (mapping.sourceSessionId !== (sourceSessionId ?? null) ||
              mapping.sourceThroughSeq !== (row.frozen!.atSeq ?? null)))
        )
          businessError(409, '会话归属冲突，请核对原操作');
        if (
          observedFork &&
          mapping.id === observedFork.childId &&
          mapping.sourceSessionId === observedFork.key.sourceSessionId &&
          mapping.sourceThroughSeq === observedFork.key.cut
        )
          await recordForkChild(
            tx,
            observedFork.key,
            mapping.id,
            observedFork.sourceDigest,
          );
        const [entry] = await tx
          .update(table)
          .set({ status: 'mapped', updatedAt: new Date() })
          .where(eq(table.id, row.id))
          .returning();
        return entry!;
      });
      return mappedResult();
    } finally {
      active.delete(row.id);
    }
  }
  return { execute };
}
