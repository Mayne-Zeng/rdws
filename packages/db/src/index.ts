import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, Pool, type ClientBase, type PoolClient } from 'pg';
import * as schema from './schema.ts';
import { bindAuthorityProof } from './authority.ts';
export { acquireAuthority, releaseAuthority } from './authority.ts';
const DATABASE_POOL_MAX = 5;

type Checkouts = WeakMap<ClientBase, () => void>;

function trackCheckouts(
  pool: Pool,
  checkouts: Checkouts,
  failures: WeakMap<ClientBase, Error>,
) {
  function track(client: PoolClient) {
    const release = client.release;
    let released = false;
    let discarded = false;
    client.release = (error) => {
      if (discarded) return;
      released = true;
      checkouts.delete(client);
      release(error);
    };
    checkouts.set(client, () => {
      if (released) return;
      released = discarded = true;
      checkouts.delete(client);
      release(true);
    });
    return client;
  }
  pool.connect = ((callback?: Parameters<Pool['connect']>[0]) => {
    const connect = Pool.prototype.connect.bind(pool);
    if (!callback)
      return connect().then((client) => {
        const failure = failures.get(client);
        if (failure) {
          client.release(true);
          throw failure;
        }
        return track(client);
      });
    return connect((error, client, release) => {
      if (error || !client) return callback(error, client, release);
      const failure = failures.get(client);
      if (failure) {
        release(true);
        return callback(failure, client, release);
      }
      track(client);
      return callback(error, client, client.release);
    });
  }) as typeof pool.connect;
}

function discardOnQueryFailure(client: Client, checkouts: Checkouts) {
  const query = client.query;
  client.query = ((...parameters: unknown[]) => {
    const checkout = checkouts.get(client);
    const request = parameters[0] as string | { text?: string } | undefined;
    const text = typeof request === 'string' ? request : (request?.text ?? '');
    const begin = /^\s*begin(?:\s|;|$)/i.test(text);
    const discard = (error: unknown) => {
      if (
        error instanceof Error &&
        (begin || error.message === 'Query read timeout')
      ) {
        if (checkout) checkout();
        else void client.end().catch(() => {});
      }
    };
    const callback = parameters.at(-1);
    if (typeof callback === 'function') {
      parameters[parameters.length - 1] = (
        error: unknown,
        ...values: unknown[]
      ) => {
        discard(error);
        return Reflect.apply(callback, undefined, [error, ...values]);
      };
      return Reflect.apply(query, client, parameters);
    }
    const response = Reflect.apply(query, client, parameters);
    if (!(response instanceof Promise)) return response;
    return response.catch((error: unknown) => {
      discard(error);
      throw error;
    });
  }) as typeof query;
}

export function connectDatabase(
  connectionString: string,
  authorityProof?: string,
  queryTimeoutMs?: number,
  synchronousWrites = false,
) {
  const checkouts: Checkouts = new WeakMap();
  const failed = new WeakMap<ClientBase, Error>();
  const live = new Map<Client, Promise<void>>();
  class TrackedClient extends Client {
    constructor(...args: ConstructorParameters<typeof Client>) {
      super(...args);
      live.set(
        this,
        new Promise<void>((resolve) => {
          this.once('end', () => {
            live.delete(this);
            resolve();
          });
        }),
      );
      this.on('error', (error: Error) => {
        failed.set(this, error);
        checkouts.get(this)?.();
      });
      discardOnQueryFailure(this, checkouts);
    }
  }
  const config = {
    connectionString,
    max: DATABASE_POOL_MAX,
    connectionTimeoutMillis: authorityProof ? 1_500 : 5_000,
    query_timeout: queryTimeoutMs,
    ...(queryTimeoutMs !== undefined && { Client: TrackedClient }),
    onConnect:
      authorityProof || synchronousWrites
        ? async (client: ClientBase) => {
            if (authorityProof)
              await bindAuthorityProof(client, authorityProof);
            if (synchronousWrites) {
              await client.query("set synchronous_commit='on'");
              await client.query("set statement_timeout='3000ms'");
              const { rows } = await client.query<{ ready: boolean }>(
                "select current_setting('synchronous_commit') = 'on' as ready",
              );
              if (rows[0]?.ready !== true)
                throw new Error(
                  'Database synchronous writes could not be confirmed',
                );
            }
          }
        : undefined,
  };
  const pool = new Pool(config);
  if (queryTimeoutMs !== undefined) trackCheckouts(pool, checkouts, failed);
  if (authorityProof || queryTimeoutMs !== undefined)
    pool.on('error', () => {});
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      await pool.end();
      await Promise.all(live.values());
    })());
  return { pool, db: drizzle(pool, { schema }), close };
}
export * as schema from './schema.ts';
