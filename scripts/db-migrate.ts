import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Client, type PoolClient } from 'pg';
import { loadEnvironment } from '@rdws/runtime-config';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import {
  anchorTargets,
  clearPgDefaults,
  databaseIdentity,
  explicitDatabaseConnection,
  grantAnchorWriter,
} from './trace-anchor-db.mjs';
const anchorProjection =
  'public.read_session_log_anchors(text,text,text,text,text,timestamptz,text)';
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
    const hasWriteLease = await client.query(
      "select to_regclass('public.requirement_write_lease') is not null as present",
    );
    if (hasWriteLease.rows[0]?.present)
      await client.query(
        `revoke delete, truncate on requirement_write_lease from ${application}`,
      );
    for (const table of [
      'session_model_selection',
      'session_prompt_dispatch',
      'project_model_allowlist',
    ] as const) {
      const relation = await client.query<{ present: boolean }>(
        'select to_regclass($1) is not null as present',
        ['public.' + table],
      );
      if (relation.rows[0]?.present)
        await client.query(
          `revoke delete, truncate on ${table} from ${application}`,
        );
    }
    const hasFirstWrite = await client.query<{ present: boolean }>(
      "select to_regclass('public.session_model_first_write') is not null as present",
    );
    if (hasFirstWrite.rows[0]?.present) {
      await client.query(
        `revoke insert, update, delete, truncate on session_model_first_write from ${application}`,
      );
      await client.query(
        `grant insert (project_id,requirement_id,native_session_id,selection_request_id,selection_revision,
          provider,model,host_generation,agent_generation,binding_id,call_id,attempt_id,turn,step,step_seq,note_seq),
          update (state,submitted_at) on session_model_first_write to ${application}`,
      );
    }
    const authority = await client.query(
      "select exists(select 1 from pg_catalog.pg_namespace where nspname='rdws_authority') as present",
    );
    if (authority.rows[0]?.present) {
      await client.query(
        `grant usage on schema rdws_authority to ${application}`,
      );
      await client.query(
        `grant execute on function rdws_authority.admit_owner(boolean, text), rdws_authority.release_owner(uuid) to ${application}`,
      );
      const { rows } = await client.query<{ safe: boolean }>(
        'select rdws_authority.acl_is_safe($1) as safe',
        [application],
      );
      if (rows[0]?.safe !== true)
        throw new Error('Unexpected runtime authority permissions');
    }
    const {
      rows: [projection],
    } = await client.query<{ present: boolean }>(
      'select pg_catalog.to_regprocedure($1) is not null as present',
      [anchorProjection],
    );
    if (projection?.present) {
      await client.query(
        `grant execute on function ${anchorProjection} to ${application}`,
      );
      const {
        rows: [acl],
      } = await client.query<{ safe: boolean }>(
        `select pg_catalog.pg_get_userbyid(proc.proowner) = current_user
          and proc.prosecdef and proc.provolatile = 's'
          and proc.proconfig = array['search_path=pg_catalog, pg_temp']
          and pg_catalog.has_function_privilege($1, proc.oid, 'EXECUTE')
          and not exists (
            select 1 from pg_catalog.aclexplode(coalesce(proc.proacl, pg_catalog.acldefault('f', proc.proowner))) as entry
            where entry.grantee <> proc.proowner
              and (entry.grantee <> (select oid from pg_catalog.pg_roles where rolname = $1)
                or entry.grantor <> proc.proowner or entry.privilege_type <> 'EXECUTE' or entry.is_grantable)
          ) as safe
          from pg_catalog.pg_proc as proc where proc.oid = pg_catalog.to_regprocedure($2)`,
        [application, anchorProjection],
      );
      if (acl?.safe !== true)
        throw new Error('Unexpected session log anchor projection permissions');
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
