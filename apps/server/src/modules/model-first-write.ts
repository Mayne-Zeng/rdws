import { schema } from '@rdws/db';
import { and, eq, sql } from 'drizzle-orm';
import { businessError } from './business.ts';
import type {
  CheckedWriteTransaction,
  WriteTransaction,
} from './checked-write-transaction.ts';

const table = schema.sessionModelFirstWrite;

export type ModelFirstWrite = Omit<
  typeof table.$inferSelect,
  'state' | 'createdAt' | 'submittedAt'
>;

export function createModelFirstWriteReceipts(
  checked: CheckedWriteTransaction,
) {
  const settlements = new Set<Promise<void>>();
  async function limits(tx: WriteTransaction) {
    await tx.execute(
      sql`set local transaction_timeout='2400ms'; set local lock_timeout='650ms'; set local statement_timeout='950ms'; set local synchronous_commit='on'`,
    );
  }
  async function prepare(write: ModelFirstWrite) {
    await checked(async (tx, assertCurrent) => {
      await limits(tx);
      const inserted = await tx.execute(sql`
        insert into ${table}
          (project_id, requirement_id, native_session_id, selection_request_id, selection_revision,
           provider, model, host_generation, agent_generation, binding_id, call_id, attempt_id,
           turn, step, step_seq, note_seq)
        values (${write.projectId}, ${write.requirementId}, ${write.nativeSessionId},
          ${write.selectionRequestId}, ${write.selectionRevision}, ${write.provider}, ${write.model},
          ${write.hostGeneration}, ${write.agentGeneration}, ${write.bindingId},
          ${write.callId}, ${write.attemptId}, ${write.turn}, ${write.step}, ${write.stepSeq}, ${write.noteSeq})
        on conflict do nothing returning attempt_id
      `);
      if (inserted.rowCount !== 1) businessError(403, '模型首写尝试已登记');
      assertCurrent();
    });
  }

  async function settle(write: ModelFirstWrite) {
    const key = and(
      eq(table.hostGeneration, write.hostGeneration),
      eq(table.attemptId, write.attemptId),
      eq(table.nativeSessionId, write.nativeSessionId),
      eq(table.selectionRevision, write.selectionRevision),
      eq(table.bindingId, write.bindingId),
      eq(table.callId, write.callId),
      eq(table.stepSeq, write.stepSeq),
      eq(table.noteSeq, write.noteSeq),
    );
    try {
      await checked(async (tx, assertCurrent) => {
        await limits(tx);
        const [updated] = await tx
          .update(table)
          .set({ state: 'submitted', submittedAt: sql`clock_timestamp()` })
          .where(and(key, eq(table.state, 'prepared')))
          .returning({ attemptId: table.attemptId });
        if (!updated) throw new Error('Model first write is unconfirmed');
        assertCurrent();
      });
      return;
    } catch {
      await checked(async (tx) => {
        await limits(tx);
        const [confirmed] = await tx
          .select({ attemptId: table.attemptId })
          .from(table)
          .where(and(key, eq(table.state, 'submitted')));
        if (!confirmed) throw new Error('Model first write is unconfirmed');
      });
    }
  }

  return {
    prepare,
    submitted(write: ModelFirstWrite) {
      const task = Promise.resolve()
        .then(() => settle(write))
        .catch(() => {});
      settlements.add(task);
      void task.then(() => settlements.delete(task));
    },
    async drain() {
      while (settlements.size) await Promise.allSettled(settlements);
    },
  };
}

export type ModelFirstWriteReceipts = ReturnType<
  typeof createModelFirstWriteReceipts
>;
