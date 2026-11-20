import { drizzle } from 'drizzle-orm/node-postgres';
import { schema, type connectDatabase } from '@rdws/db';

type Database = ReturnType<typeof connectDatabase>;
export type WriteTransaction = Parameters<
  Parameters<Database['db']['transaction']>[0]
>[0];

export function checkedWriteTransaction(pool: Database['pool']) {
  const active = new Set<Promise<unknown>>();
  async function run<T>(
    work: (tx: WriteTransaction, assertCurrent: () => void) => Promise<T>,
    retire = false,
  ) {
    const client = await pool.connect();
    let committed = false;
    let expired = false;
    let disconnected = false;
    let acknowledged = false;
    const lost = () => {
      disconnected = true;
    };
    client.on('error', lost);
    const query = client.query;
    const observe = ((...parameters: unknown[]) => {
      const request = parameters[0] as string | { text: string };
      const text = typeof request === 'string' ? request : request.text;
      const response = Reflect.apply(query, client, parameters);
      if (text !== 'commit') return response;
      return response.then((result: { command: string }) => {
        acknowledged = result.command === 'COMMIT';
        return result;
      });
    }) as typeof query;
    client.query = observe;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        expired = true;
        reject(new Error('Write authority transaction timed out'));
      }, 3_000).unref();
    });
    function assertCurrent() {
      if (expired || disconnected)
        throw new Error('Write authority connection is no longer current');
    }
    async function complete() {
      if (client.getTransactionStatus() !== 'I')
        throw new Error('Write authority connection is not idle');
      const value = await drizzle(client, { schema }).transaction(
        async (tx) => {
          assertCurrent();
          if (client.getTransactionStatus() !== 'T')
            throw new Error('Write authority BEGIN was not confirmed');
          const result = await work(tx, assertCurrent);
          assertCurrent();
          return result;
        },
        { isolationLevel: 'read committed' },
      );
      if (!acknowledged || client.getTransactionStatus() !== 'I')
        throw new Error('Write authority commit could not be confirmed');
      return value;
    }
    const workDone = complete();
    active.add(workDone);
    const remove = () => {
      active.delete(workDone);
    };
    void workDone.then(remove, remove);
    try {
      const value = await Promise.race([workDone, timeout]);
      assertCurrent();
      committed = true;
      return value;
    } finally {
      clearTimeout(timer);
      if (client.query === observe) client.query = query;
      if (committed) client.off('error', lost);
      client.release(!committed || retire);
    }
  }
  return Object.assign(run, {
    async drain() {
      while (active.size) await Promise.allSettled(active);
    },
  });
}

export type CheckedWriteTransaction = ReturnType<
  typeof checkedWriteTransaction
>;
