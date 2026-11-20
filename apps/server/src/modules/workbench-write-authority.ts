import { randomUUID } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import { schema } from '@rdws/db';
import {
  businessError,
  digestOf,
  withWriteMutation,
  type Actor,
} from './business.ts';
import type {
  createOwnedWriteHandoff,
  WriteHandoffScope,
} from './write-handoff.ts';
import type { CheckedWriteTransaction } from './checked-write-transaction.ts';

export type OwnedWriteHandoff = ReturnType<typeof createOwnedWriteHandoff>;
type Fence = ReturnType<OwnedWriteHandoff['beginAuthorityChange']>;
type Receipt = typeof schema.commandReceipt.$inferInsert;
type Attempt = { lock: bigint; receipt: Receipt; fence?: Fence; key: string };

export function createWorkbenchWriteAuthority(
  handoff: () => OwnedWriteHandoff | undefined,
  loginClosed: (id: string) => boolean,
  transaction?: CheckedWriteTransaction,
) {
  let queue = Promise.resolve();
  let closing = false;
  let recovery: Attempt | undefined;
  let retryTimer: NodeJS.Timeout | undefined;
  let retries = 0;
  const logouts = new Map<string, Fence>();
  const logoutWork = new Map<string, Promise<void>>();

  async function confirm(attempt: Attempt) {
    if (!transaction)
      throw new Error('Write authority transaction is unavailable');
    const marker = attempt.receipt;
    const saved = await transaction(async (tx) => {
      await tx.execute(sql`set local lock_timeout='650ms'`);
      await tx.execute(sql`select pg_advisory_xact_lock(${attempt.lock})`);
      const [row] = await tx
        .select({ digest: schema.commandReceipt.digest })
        .from(schema.commandReceipt)
        .where(
          and(
            eq(schema.commandReceipt.actorId, marker.actorId),
            eq(schema.commandReceipt.scope, marker.scope),
            eq(schema.commandReceipt.operation, marker.operation),
            eq(schema.commandReceipt.commandId, marker.commandId),
          ),
        );
      return row;
    });
    if (saved?.digest === marker.digest) {
      await attempt.fence?.committed(true);
      return true;
    }
    if (saved)
      throw new Error(
        'Stored write authority marker does not match the original operation',
      );
    attempt.fence?.rolledBack();
    return false;
  }

  async function settle(attempt: Attempt) {
    try {
      const committed = await confirm(attempt);
      if (recovery === attempt) recovery = undefined;
      return committed;
    } catch {
      attempt.fence?.uncertain();
      scheduleRecovery();
      businessError(503, '写入资格变更尚未确认，请重试原操作');
    }
  }

  function scheduleRecovery() {
    if (closing || retryTimer || retries >= 3) return;
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined;
        void recover();
      },
      250 * 2 ** retries++,
    ).unref();
  }

  function recover() {
    const pending = queue.then(async () => {
      if (closing) return;
      if (recovery) await settle(recovery).catch(() => {});
      for (const id of logouts.keys()) closeLogin(id);
      await Promise.all(logoutWork.values());
    });
    queue = pending.catch(() => {});
    return queue;
  }

  function change<T>(
    who: Actor,
    kind: string,
    scope: string,
    commandId: string,
    input: unknown,
    matches: (scope: WriteHandoffScope) => boolean,
    operation: () => Promise<T>,
  ) {
    const broker = handoff();
    if (!broker) return operation();
    if (!transaction)
      throw new Error('Write authority transaction is unavailable');
    const key = digestOf({
      actorId: who.userId,
      authSessionId: who.authSessionId,
      kind,
      scope,
      commandId,
      input,
    });
    const result = queue.then(async () => {
      if (closing) businessError(503, '写入协调正在关闭');
      if (loginClosed(who.authSessionId))
        businessError(401, '登录已失效，请重新登录');
      if (recovery) {
        const prior = recovery;
        if (prior.key !== key)
          businessError(503, '写入资格变更尚未确认，请重试原操作');
        await settle(prior);
        businessError(503, '写入资格已核对，请读取原命令结果');
      }
      retries = 0;
      const attemptId = randomUUID();
      const receipt = {
        actorId: who.userId,
        scope: 'write.authority:' + scope,
        operation: kind,
        commandId: attemptId,
        digest: key,
        result: {
          authSessionId: who.authSessionId,
          commandId,
        },
      };
      const lock = BigInt.asIntN(
        64,
        BigInt('0x' + digestOf(attemptId).slice(0, 16)),
      );
      const attempt: Attempt = { lock, receipt, key };
      recovery = attempt;
      let mutating = true;
      let value: T;
      try {
        value = await withWriteMutation(
          {
            lock,
            transaction,
            begin(affectedUserId) {
              if (!mutating || recovery !== attempt)
                businessError(503, '原写入资格变更不再活跃');
              if (closing || loginClosed(who.authSessionId))
                businessError(401, '登录已失效，请重新登录');
              attempt.fence ??= broker.beginAuthorityChange(
                (scope) =>
                  matches(scope) &&
                  (!affectedUserId || scope.who.userId === affectedUserId),
              );
            },
            receipt: () => ({
              ...receipt,
              result: {
                ...receipt.result,
                generations: attempt.fence?.generations ?? [],
              },
            }),
          },
          operation,
        );
      } catch (error) {
        mutating = false;
        await settle(attempt);
        throw error;
      } finally {
        mutating = false;
      }
      if (!(await settle(attempt)))
        businessError(503, '写入资格变更未提交，请重试原操作');
      return value;
    });
    queue = result.then(
      () => {},
      () => {},
    );
    return result;
  }

  function closeLogin(authSessionId: string) {
    const broker = handoff();
    if (!broker || closing || logoutWork.has(authSessionId)) return;
    let fence = logouts.get(authSessionId);
    if (!fence) {
      retries = 0;
      fence = broker.beginAuthorityChange(
        ({ who }) => who.authSessionId === authSessionId,
      );
      logouts.set(authSessionId, fence);
    }
    fence.uncertain();
    const work = fence
      .committed()
      .then(() => {
        logouts.delete(authSessionId);
      })
      .catch(() => scheduleRecovery())
      .finally(() => logoutWork.delete(authSessionId));
    logoutWork.set(authSessionId, work);
  }

  async function close() {
    closing = true;
    clearTimeout(retryTimer);
    const broker = handoff();
    broker?.stopAdmission();
    await queue;
    await Promise.all(logoutWork.values());
    const confirmations = await Promise.allSettled([
      ...(recovery ? [settle(recovery)] : []),
      ...[...logouts.entries()].map(async ([id, fence]) => {
        await fence.committed();
        logouts.delete(id);
      }),
    ]);
    await broker?.close();
    if (
      recovery ||
      logouts.size ||
      confirmations.some(({ status }) => status === 'rejected')
    )
      throw new Error('Write authority shutdown could not be confirmed');
  }

  return {
    change,
    closeLogin,
    close,
    recover,
    enabled: () => handoff() !== undefined,
  };
}
