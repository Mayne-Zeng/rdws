import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { sql } from 'drizzle-orm';
import { Pool } from 'pg';
import { checkedWriteTransaction } from '../../apps/server/src/modules/checked-write-transaction.ts';
import {
  createAuthorityWindows,
  windowAttemptKey,
} from '../../apps/server/src/modules/failure-boundary-window.ts';
import { createWindowedReadEgress } from '../../apps/server/src/modules/windowed-read-egress.ts';

// §11.20.25 phase 8 driver: performs one armed window delivery in a dedicated
// process so the parent can kill it and prove the PG and supplier sockets die
// together with zero continuation steps.

type Boot = {
  databaseUrl: string;
  destination: string;
  ca: string;
  header: string;
  userId: string;
  requirementId: string;
  body: string;
  proof: string;
};

if (!process.send || process.env.RDWS_MODE !== 'test')
  throw new Error('Failure boundary driver requires IPC');
const [boot] = (await once(process, 'message')) as [Boot];
const pool = new Pool({ connectionString: boot.databaseUrl });
// The managed runtime writer guard only admits connections carrying the
// owner proof; bind it exactly like connectDatabase does.
pool.on('connect', (client) => {
  void client
    .query(
      "select set_config('rdws.runtime_authority_proof', $1, false) is not null",
      [boot.proof],
    )
    .catch(() => {});
});
const checked = checkedWriteTransaction(pool as never);
// Deterministic kill point: hold the window client's commit until the parent
// releases or kills the process, so the armed-but-uncommitted state can be
// observed without racing the loopback round trips.
let releaseDriverCommit: (() => void) | undefined;
pool.on('connect', (client) => {
  const rawQuery = client.query.bind(client) as (
    ...args: unknown[]
  ) => Promise<unknown>;
  let sawTxid = false;
  client.query = ((...params: unknown[]) => {
    const input = params[0] as string | { text: string };
    const text = typeof input === 'string' ? input : input.text;
    if (typeof text === 'string') {
      if (text.startsWith('begin')) sawTxid = false;
      if (text.includes('txid_current()')) sawTxid = true;
      if (text === 'commit' && sawTxid) {
        const gate = new Promise<void>((resolve) => {
          releaseDriverCommit = resolve;
        });
        return gate.then(() => rawQuery(...params));
      }
    }
    return rawQuery(...params);
  }) as typeof client.query;
});
const windows = createAuthorityWindows(checked);
const egress = createWindowedReadEgress({
  destination: boot.destination,
  ca: boot.ca,
  header: boot.header,
});
const attemptId = randomUUID();
const key = windowAttemptKey({
  userId: boot.userId,
  requirementId: boot.requirementId,
  attemptId,
  digest: 'driver',
});
const frame = await egress.frame({ attemptId, body: Buffer.from(boot.body) });
await windows.prepare(key);
const outcome = await windows.open({
  key,
  authorize: async (tx) => {
    await tx.execute(sql`select 1`);
  },
  arm: () => {
    const witness = frame.arm();
    if (process.connected)
      process.send!({ kind: 'witnessed', attemptId, witness });
    return witness;
  },
});
if (process.connected) process.send!({ kind: 'outcome', state: outcome.state });
void once(process, 'message').then((messages) => {
  const [message] = messages as [{ kind: string }];
  if (message.kind === 'release') releaseDriverCommit?.();
});
await new Promise<void>((resolve) => {
  process.once('disconnect', () => resolve());
});
await pool.end();
await egress.close();
