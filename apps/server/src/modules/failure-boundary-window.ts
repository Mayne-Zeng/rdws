import { sql } from 'drizzle-orm';
import { schema } from '@rdws/db';
import type {
  CheckedWriteTransaction,
  WriteTransaction,
} from './checked-write-transaction.ts';

// §11.20.25 checked authorization window: the opt-in consumer wrapper around the
// checked short transaction. Existing checkedWriteTransaction.run callers keep
// their exact semantics; only window consumers call this helper.
//
// Four-piece set: final confirmation roundtrip with waiter counting, waiter
// gate, original-connection commit receipt as the coverage certificate, and a
// single-shot seal when the certificate is lost. Zero retries, zero
// continuation steps; only an independent connection resolves the persisted
// attempt row by its original key.

export type WindowAttemptKey = {
  actorId: string;
  scope: string;
  operation: string;
  commandId: string;
  digest: string;
};

// The raw wire outcome of the synchronous first write, carried so the window
// can distinguish a provable zero-byte delivery from an unknown one.
export type WindowWireOutcome = 'submitted' | 'not-sent' | 'indeterminate';

export type WindowWitness = {
  acceptedBytes: number;
  witnessedAt: number;
  wire?: WindowWireOutcome;
};

export type WindowOutcome =
  | { state: 'certified'; witness: WindowWitness }
  | {
      state: 'zero-write';
      reason: 'waiter-gate' | 'transport-not-sent';
      waiters: number;
    }
  | {
      state: 'sealed';
      reason: 'attempt-registered' | 'certificate-lost' | 'row-unconfirmed';
    };

type WindowAttemptRow = {
  state: 'prepared' | 'submitted' | 'zero-write' | undefined;
  result: unknown;
};

export class WindowZeroWrite extends Error {
  constructor(
    readonly waiters: number,
    readonly wire?: WindowWireOutcome,
  ) {
    super('Authority window closed with a proven zero-byte delivery');
  }
}

export class WindowSealed extends Error {
  constructor(
    readonly reason:
      'attempt-registered' | 'certificate-lost' | 'row-unconfirmed',
  ) {
    super('Authority window commit certificate was not confirmed');
  }
}

export function windowAttemptKey(input: {
  userId: string;
  requirementId: string;
  attemptId: string;
  digest: string;
}): WindowAttemptKey {
  return {
    actorId: input.userId,
    scope: 'requirement:' + input.requirementId,
    operation: 'worktree.read.window',
    commandId: input.attemptId,
    digest: input.digest,
  };
}

async function windowLimits(tx: WriteTransaction) {
  await tx.execute(
    sql`set local transaction_timeout='2400ms'; set local lock_timeout='650ms'; set local statement_timeout='950ms'; set local synchronous_commit='on'`,
  );
}

export function createAuthorityWindows(checked: CheckedWriteTransaction) {
  // First-write persistence: the attempt row is committed by its own checked
  // short transaction before the window opens; a colliding original key seals
  // the attempt without a second preparation row.
  async function prepare(key: WindowAttemptKey): Promise<void> {
    await checked(async (tx) => {
      await windowLimits(tx);
      const inserted = await tx
        .insert(schema.commandReceipt)
        .values({
          actorId: key.actorId,
          scope: key.scope,
          operation: key.operation,
          commandId: key.commandId,
          digest: key.digest,
          result: { state: 'prepared' },
        })
        .onConflictDoNothing()
        .returning({ commandId: schema.commandReceipt.commandId });
      if (inserted.length !== 1) throw new WindowSealed('attempt-registered');
    });
  }

  async function confirmZeroWrite(
    key: WindowAttemptKey,
    waiters: number,
    wire?: WindowWireOutcome,
  ): Promise<void> {
    // Known zero-write close-out: release the occupation only when the bounded
    // confirmation transaction itself commits; a lost answer keeps the pending
    // row and the occupation.
    try {
      await checked(async (tx) => {
        await windowLimits(tx);
        const [updated] = await tx
          .update(schema.commandReceipt)
          .set({
            result: {
              state: 'zero-write',
              waiters,
              ...(wire && { wire }),
            },
          })
          .where(
            sql`${schema.commandReceipt.actorId} = ${key.actorId}
              and ${schema.commandReceipt.scope} = ${key.scope}
              and ${schema.commandReceipt.operation} = ${key.operation}
              and ${schema.commandReceipt.commandId} = ${key.commandId}
              and ${schema.commandReceipt.result} ->> 'state' = 'prepared'`,
          )
          .returning({ commandId: schema.commandReceipt.commandId });
        if (!updated) throw new WindowSealed('row-unconfirmed');
      });
    } catch {
      // Occupation and the prepared row stay retained; no retry.
    }
  }

  async function open(input: {
    key: WindowAttemptKey;
    authorize: (tx: WriteTransaction) => Promise<void>;
    arm: () => WindowWitness;
  }): Promise<WindowOutcome> {
    try {
      const witness = await checked(async (tx) => {
        await windowLimits(tx);
        await input.authorize(tx);
        // Final confirmation roundtrip: the same statement re-reads the
        // guarded attempt row under FOR SHARE and counts unauthorized
        // waiters waiting on this transaction identity.
        const answer = (await tx.execute(sql`
          select
            (select count(*)::int from pg_locks
              where locktype = 'transactionid'
                and transactionid = txid_current()::text::xid
                and not granted) as waiters,
            (select true from ${schema.commandReceipt}
              where command_id = ${input.key.commandId}
                and scope = ${input.key.scope}
                and operation = ${input.key.operation}
                and actor_id = ${input.key.actorId}
              for share) as attempt
        `)) as { rows: { waiters: number | null; attempt: boolean | null }[] };
        // window-atomic-segment-begin
        const waiters = Number(answer.rows[0]?.waiters ?? 0);
        if (waiters > 0) throw new WindowZeroWrite(waiters);
        if (answer.rows[0]?.attempt !== true)
          throw new WindowSealed('row-unconfirmed');
        const witness = input.arm();
        // An unknown delivery outcome is coverage-doubtful: seal instead of
        // closing out. Only a provable zero-byte delivery releases the
        // occupation (§11.16.47 known zero-write rule).
        if (witness.wire === 'indeterminate')
          throw new WindowSealed('certificate-lost');
        if (witness.acceptedBytes === 0)
          throw new WindowZeroWrite(0, witness.wire);
        // window-atomic-segment-end
        const [updated] = await tx
          .update(schema.commandReceipt)
          .set({
            result: {
              state: 'submitted',
              acceptedBytes: witness.acceptedBytes,
              witnessedAt: witness.witnessedAt,
            },
          })
          .where(
            sql`${schema.commandReceipt.actorId} = ${input.key.actorId}
              and ${schema.commandReceipt.scope} = ${input.key.scope}
              and ${schema.commandReceipt.operation} = ${input.key.operation}
              and ${schema.commandReceipt.commandId} = ${input.key.commandId}
              and ${schema.commandReceipt.result} ->> 'state' = 'prepared'`,
          )
          .returning({ commandId: schema.commandReceipt.commandId });
        if (!updated) throw new WindowSealed('row-unconfirmed');
        return witness;
      });
      return { state: 'certified', witness };
    } catch (error) {
      if (error instanceof WindowZeroWrite) {
        await confirmZeroWrite(input.key, error.waiters, error.wire);
        return {
          state: 'zero-write',
          reason: error.wire ? 'transport-not-sent' : 'waiter-gate',
          waiters: error.waiters,
        };
      }
      if (error instanceof WindowSealed)
        return { state: 'sealed', reason: error.reason };
      if (typeof (error as { statusCode?: unknown }).statusCode === 'number')
        throw error;
      return { state: 'sealed', reason: 'certificate-lost' };
    }
  }

  // Independent-connection read-back by the original key; resolves facts only,
  // never re-sends.
  async function readBack(key: WindowAttemptKey): Promise<WindowAttemptRow> {
    try {
      return await checked(async (tx) => {
        await windowLimits(tx);
        const [row] = await tx
          .select({ result: schema.commandReceipt.result })
          .from(schema.commandReceipt)
          .where(
            sql`${schema.commandReceipt.actorId} = ${key.actorId}
              and ${schema.commandReceipt.scope} = ${key.scope}
              and ${schema.commandReceipt.operation} = ${key.operation}
              and ${schema.commandReceipt.commandId} = ${key.commandId}`,
          )
          .for('share');
        const state = (row?.result as { state?: string } | null | undefined)
          ?.state as WindowAttemptRow['state'];
        return { state, result: row?.result };
      });
    } catch {
      return { state: undefined, result: undefined };
    }
  }

  return { prepare, open, readBack };
}

export type AuthorityWindows = ReturnType<typeof createAuthorityWindows>;
