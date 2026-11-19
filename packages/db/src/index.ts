import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';
import { bindAuthorityProof } from './authority.ts';
export { acquireAuthority, releaseAuthority } from './authority.ts';
const DATABASE_POOL_MAX = 5;

export function connectDatabase(
  connectionString: string,
  authorityProof?: string,
) {
  const pool = new Pool({
    connectionString,
    max: DATABASE_POOL_MAX,
    connectionTimeoutMillis: authorityProof ? 1_500 : 5_000,
    onConnect: authorityProof
      ? (client) => bindAuthorityProof(client, authorityProof)
      : undefined,
  });
  if (authorityProof) pool.on('error', () => {});
  return { pool, db: drizzle(pool, { schema }) };
}
export * as schema from './schema.ts';
