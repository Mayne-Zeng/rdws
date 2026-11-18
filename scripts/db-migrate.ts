import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, type PoolClient } from 'pg';
import { loadEnvironment } from './env.mjs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  anchorTargets,
  clearPgDefaults,
  databaseIdentity,
  explicitDatabaseConnection,
  grantAnchorWriter,
} from './trace-anchor-db.mjs';
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
    const hasPlan = await client.query(
      "select to_regclass('public.requirement_worktree_plan') is not null as present",
    );
    if (hasPlan.rows[0]?.present)
      await client.query(
        `revoke update, delete on requirement_worktree_plan from ${application}`,
      );
    const hasBinding = await client.query(
      "select to_regclass('public.requirement_capability_binding') is not null as present",
    );
    if (hasBinding.rows[0]?.present) {
      await client.query(
        `revoke update, delete, truncate on requirement_capability_binding from ${application}`,
      );
      await client.query(
        `grant update (template_id, revision) on requirement_capability_binding to ${application}`,
      );
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
async function main() {
  loadEnvironment(process.env.RDWS_MODE || 'development');
  const test = process.env.RDWS_MODE === 'test';
  const database = test ? 'rdws_test' : 'rdws_dev';
  const owner = anchorTargets[database].owner;
  const config = explicitDatabaseConnection(
    process.env.DATABASE_MIGRATION_URL,
    'owner',
  );
  if (config?.database !== database)
    throw new Error('Explicit migration connection is required');
  clearPgDefaults();
  const client = new Client({
    ...config,
    options: '-c search_path=public,pg_temp',
    connectionTimeoutMillis: 5000,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    const identity = await databaseIdentity(client);
    if (
      identity.database !== database ||
      identity.login !== owner ||
      identity.role !== owner
    )
      throw new Error('Unexpected migration identity');
    await migrate(drizzle(client), {
      migrationsFolder: 'packages/db/migrations',
    });
    await grantApplication(client, test ? 'rdws_test_app' : 'rdws_app');
    await grantAnchorWriter(client, database);
    console.log(
      'Migrations applied; application role has data access without schema ownership.',
    );
  } finally {
    await client.end();
  }
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await main();
