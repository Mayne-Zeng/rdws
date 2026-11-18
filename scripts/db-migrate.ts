import { migrate } from 'drizzle-orm/node-postgres/migrator';
import type { PoolClient } from 'pg';
import { connectDatabase } from '@rdws/db';
import { loadEnvironment } from './env.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
export async function grantApplication(
  client: Pick<PoolClient, 'query'>,
  application: 'rdws_app' | 'rdws_test_app',
) {
  await client.query('begin');
  try {
    await client.query(`grant usage on schema public to ${application}`);
    await client.query(
      `grant select, insert, update, delete on all tables in schema public to ${application}`,
    );
    await client.query(
      `revoke update, delete on requirement_event from ${application}`,
    );
    await client.query(
      `revoke delete on capability_approval from ${application}`,
    );
    await client.query(
      `revoke update, delete on capability_template_revision from ${application}`,
    );
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
async function main() {
  loadEnvironment(process.env.RDWS_MODE || 'development');
  const { pool, db } = connectDatabase(process.env.DATABASE_MIGRATION_URL!);
  try {
    await migrate(db, { migrationsFolder: 'packages/db/migrations' });
    const application =
      process.env.RDWS_MODE === 'test' ? 'rdws_test_app' : 'rdws_app';
    const client = await pool.connect();
    try {
      await grantApplication(client, application);
    } finally {
      client.release();
    }
    console.log(
      'Migrations applied; application role has data access without schema ownership.',
    );
  } finally {
    await pool.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
