import type { ClientBase, Pool, PoolClient, QueryResultRow } from 'pg';

function query<R extends QueryResultRow>(
  client: ClientBase,
  text: string,
  values: unknown[] = [],
) {
  const config = { text, values, query_timeout: 1_000 };
  return client.query<R>(config);
}

async function verifyPrivateParameters(client: ClientBase) {
  const { rows } = await query<{ private: boolean }>(
    client,
    `select current_setting('log_parameter_max_length') = '0'
      and current_setting('log_parameter_max_length_on_error') = '0'
      and current_setting('debug_print_plan') = 'off'
      and coalesce(current_setting('auto_explain.log_min_duration', true), '-1') = '-1' as private`,
  );
  if (rows[0]?.private !== true) throw new Error();
}

export async function bindAuthorityProof(client: ClientBase, proof: string) {
  try {
    await verifyPrivateParameters(client);
    await query(
      client,
      "select set_config('rdws.runtime_authority_proof', $1, false) is not null",
      [proof],
    );
  } catch {
    throw new Error('Database authority connection could not be configured');
  }
}

async function transaction<T>(
  pool: Pool,
  operation: (client: PoolClient) => Promise<T>,
): Promise<T> {
  let client: PoolClient | undefined;
  let committed = false;
  try {
    client = await pool.connect();
    await query(client, 'begin');
    await query(
      client,
      "set local synchronous_commit = 'on'; set local lock_timeout = '850ms'",
    );
    const result = await operation(client);
    const confirmation = await query(client, 'commit');
    if (confirmation.command !== 'COMMIT') throw new Error();
    committed = true;
    return result;
  } catch {
    throw new Error('Database authority ownership could not be confirmed');
  } finally {
    client?.release(!committed);
  }
}

export function acquireAuthority(
  pool: Pool,
  paused: boolean,
  ticket?: string,
): Promise<string | null> {
  return transaction(pool, async (client) => {
    const { rows } = await query<{ installed: boolean }>(
      client,
      "select exists(select 1 from pg_catalog.pg_namespace where nspname = 'rdws_authority') as installed",
    );
    if (rows[0]?.installed === false && ticket === undefined) return null;
    if (ticket !== undefined) await verifyPrivateParameters(client);
    const claimed = await query<{ generation: string | null }>(
      client,
      'select rdws_authority.admit_owner($1, $2) as generation',
      [paused, ticket ?? null],
    );
    return claimed.rows[0]!.generation;
  });
}

export function releaseAuthority(pool: Pool, generation: string) {
  return transaction(pool, async (client) => {
    await query(client, 'select rdws_authority.release_owner($1)', [
      generation,
    ]);
  });
}
