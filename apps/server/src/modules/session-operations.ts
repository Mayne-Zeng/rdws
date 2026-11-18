import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { and, eq, isNull } from 'drizzle-orm';
import { schema, type connectDatabase } from '@rdws/db';
import type { SessionOperationResult } from '@rdws/contracts';
import type { NativeWebHost } from '@rdws/dsh/web';
import { isRecord, type Grant } from '@rdws/dsh/access';
import { forkBoundary, sessionRpc } from '@rdws/dsh/sessions';
import {
  businessError,
  digestOf,
  type Actor,
  type createBusiness,
} from './business.ts';
type Database = ReturnType<typeof connectDatabase>['db'];
type Operation = typeof schema.sessionOperation.$inferSelect;
export function createSessionOperations(
  db: Database,
  business: ReturnType<typeof createBusiness>,
  native: NativeWebHost,
) {
  const generation = randomUUID(),
    active = new Set<string>();
  const table = schema.sessionOperation;
  const result = (row: Operation): SessionOperationResult => ({
    commandId: row.commandId,
    status: row.status as SessionOperationResult['status'],
    ...(row.status === 'mapped' ? { sessionId: row.nativeSessionId! } : {}),
    ...(row.status === 'rejected'
      ? { error: '原操作已拒绝且未执行，可重新发起。' }
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
      work: Parameters<typeof business.sessionTransaction<T>>[3],
    ) {
      await options.current();
      return business.sessionTransaction(
        who,
        requirementId,
        sourceSessionId,
        async (tx, item) => {
          options.assertOpen();
          const value = await work(tx, item);
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
        try {
          if (sourceSessionId) {
            const identity = await native.control('session.inspect', {
              requirementId,
              sessionId: sourceSessionId,
            });
            if (
              identity.cwd !== prepared.cwd ||
              identity.workspaceId !== prepared.workspaceId
            )
              businessError(409, '会话工作区不匹配，派生未执行');
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
        const frozen = {
          workspaceId: prepared.workspaceId,
          cwd: prepared.cwd,
          ...(atSeq === undefined ? {} : { atSeq }),
          requestDigest: digestOf(
            sourceSessionId
              ? { sessionId: sourceSessionId, atSeq, allowMigration: false }
              : { workspaceId: prepared.workspaceId },
          ),
        };
        const dispatched = await authorized(async (tx) => {
          const [entry] = await tx
            .update(table)
            .set({
              status: 'dispatched',
              frozen,
              generation,
              updatedAt: new Date(),
            })
            .where(and(eq(table.id, row.id), eq(table.status, 'reserved')))
            .returning();
          return entry;
        });
        if (!dispatched) {
          const [existing] = await db
            .select()
            .from(table)
            .where(eq(table.id, row.id));
          await options.current();
          return result(existing!);
        }
        row = dispatched;
        try {
          await options.current();
          const value = await sessionRpc(
            native,
            sourceSessionId
              ? { ...prepared.grant, purpose: 'fork', sourceSessionId, atSeq }
              : { ...prepared.grant, purpose: 'create' },
            'session/' + operation,
            sourceSessionId
              ? { sessionId: sourceSessionId, atSeq, allowMigration: false }
              : { workspaceId: frozen.workspaceId },
          );
          if (
            !value ||
            typeof value !== 'object' ||
            !('sessionId' in value) ||
            typeof value.sessionId !== 'string' ||
            !/^session-[a-zA-Z0-9-]+$/.test(value.sessionId)
          )
            throw new Error('Invalid Native child identity');
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
        row.frozen.requestDigest !==
          digestOf(
            sourceSessionId
              ? {
                  sessionId: sourceSessionId,
                  atSeq: row.frozen.atSeq,
                  allowMigration: false,
                }
              : { workspaceId: row.frozen.workspaceId },
          )
      )
        businessError(409, '原操作参数无法核实，请联系管理员核对');
      await options.prepare();
      const identity = await native.control('session.inspect', {
        requirementId,
        sessionId: row.nativeSessionId,
      });
      if (
        !row.frozen ||
        identity.cwd !== row.frozen.cwd ||
        identity.workspaceId !== row.frozen.workspaceId
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
          mapping.ownerId !== who.userId
        )
          businessError(409, '会话归属冲突，请核对原操作');
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
