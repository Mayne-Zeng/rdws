import { checkServerIdentity } from 'node:tls';

export const anchorTargets = Object.freeze({
  rdws_dev: { owner: 'rdws_migrator', writer: 'rdws_anchor_writer' },
  rdws_test: { owner: 'rdws_test_migrator', writer: 'rdws_test_anchor_writer' },
});

export function explicitDatabaseConnection(value, role) {
  try {
    const uri = new URL(value);
    const host = uri.hostname.replace(/^\[|\]$/g, '');
    const user = decodeURIComponent(uri.username);
    const password = decodeURIComponent(uri.password);
    const database = uri.pathname.slice(1);
    const modes = uri.searchParams.getAll('sslmode');
    const mode = modes[0] ?? 'disable';
    const port = Number(uri.port || '5432');
    if (
      !['postgres:', 'postgresql:'].includes(uri.protocol) ||
      !host ||
      !password ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535 ||
      !Object.hasOwn(anchorTargets, database) ||
      anchorTargets[database][role] !== user ||
      uri.hash ||
      modes.length > 1 ||
      [...uri.searchParams.keys()].some((key) => key !== 'sslmode') ||
      !['disable', 'verify-full'].includes(mode)
    )
      return;
    return {
      host,
      user,
      password,
      database,
      port,
      ssl:
        mode === 'verify-full'
          ? {
              rejectUnauthorized: true,
              checkServerIdentity: (_host, certificate) =>
                checkServerIdentity(host, certificate),
            }
          : false,
    };
  } catch {
    return;
  }
}

export function clearPgDefaults() {
  for (const key of Object.keys(process.env))
    if (/^PG[A-Z_]+$/.test(key)) delete process.env[key];
}

const insertColumns = [
  'project_id',
  'session_id',
  'bucket_sha256',
  'journal_name',
  'through_byte',
  'sha256',
];

export async function databaseIdentity(client) {
  const result = await client.query(
    "select current_database() as database, session_user as login, current_user as role, current_setting('fsync') = 'on' as durable",
  );
  return result.rows[0];
}

async function writerBoundary(client, writer) {
  const result = await client.query(
    `select
      r.rolcanlogin and not (r.rolsuper or r.rolcreatedb or r.rolcreaterole or r.rolreplication or r.rolbypassrls)
      and r.oid <> d.datdba
      and not has_database_privilege(r.oid, d.oid, 'CREATE')
      and not has_parameter_privilege(r.oid, 'session_replication_role', 'SET')
      and not exists (
        select 1 from pg_auth_members m where m.member = r.oid or m.roleid = r.oid
      )
      and not exists (
        select 1 from pg_namespace n
        where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
          and (n.nspowner = r.oid or has_schema_privilege(r.oid, n.oid, 'CREATE'))
      )
      and not exists (
        select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
          and c.oid <> 'audit.session_log_anchor'::regclass
          and (c.relowner = r.oid or case
            when c.relkind in ('r','p','v','m','f') then
              has_table_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER,MAINTAIN')
              or has_any_column_privilege(r.oid, c.oid, 'SELECT,INSERT,UPDATE,REFERENCES')
            when c.relkind = 'S' then has_sequence_privilege(r.oid, c.oid, 'USAGE,SELECT,UPDATE')
            else false end)
      )
      and not exists (
        select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname <> 'information_schema' and n.nspname !~ '^pg_'
          and (p.proowner = r.oid or (p.prosecdef and has_function_privilege(r.oid, p.oid, 'EXECUTE')))
      ) as isolated
      from pg_roles r join pg_database d on d.datname = current_database()
      where r.rolname = $1`,
    [writer],
  );
  return result.rows[0]?.isolated;
}

async function anchorAcl(client, target) {
  const result = await client.query(
    `with objects as (
      select 'schema' as kind, '' as column_name, nspowner as owner,
             coalesce(nspacl, acldefault('n', nspowner)) as acl
      from pg_namespace where nspname = 'audit'
      union all
      select 'table', '', relowner, coalesce(relacl, acldefault('r', relowner))
      from pg_class where oid = 'audit.session_log_anchor'::regclass and relkind = 'r'
      union all
      select 'guard', '', proowner, coalesce(proacl, acldefault('f', proowner))
      from pg_proc
      where oid = 'audit.check_session_log_source()'::regprocedure and prosecdef
        and exists (
          select 1 from pg_trigger t where t.tgrelid = 'audit.session_log_anchor'::regclass
          and t.tgfoid = pg_proc.oid and t.tgname = 'anchor_current_session_source' and t.tgenabled = 'A'
        )
      union all
      select 'column', attname, relowner, attacl
      from pg_class join pg_attribute on attrelid = pg_class.oid
      where pg_class.oid = 'audit.session_log_anchor'::regclass and attnum > 0 and not attisdropped
    )
    select kind, column_name, owner_role.rolname as owner, grantee_role.rolname as grantee,
           entry.grantee as grantee_id, entry.grantor = owner as owner_grant,
           entry.grantee = owner as owner_access, entry.privilege_type, entry.is_grantable
    from objects join pg_roles owner_role on owner_role.oid = owner
    left join lateral aclexplode(acl) entry on true
    left join pg_roles grantee_role on grantee_role.oid = entry.grantee`,
  );
  const present = new Set();
  const access = new Set();
  const allowed = new Set([
    'schema::USAGE',
    'table::SELECT',
    ...insertColumns.map((column) => 'column:' + column + ':INSERT'),
  ]);
  for (const row of result.rows) {
    present.add(row.kind);
    if (row.owner !== target.owner) throw new Error('Unexpected anchor owner');
    if (row.grantee_id === null || row.owner_access) continue;
    const grant = [row.kind, row.column_name, row.privilege_type].join(':');
    if (
      row.grantee !== target.writer ||
      !row.owner_grant ||
      row.is_grantable ||
      !allowed.has(grant)
    )
      throw new Error('Unexpected anchor permissions');
    access.add(grant);
  }
  if (
    !['schema', 'table', 'guard', 'column'].every((kind) => present.has(kind))
  )
    throw new Error('Incomplete anchor schema');
  const read = access.has('schema::USAGE') && access.has('table::SELECT');
  if (
    access.size &&
    !(read && (access.size === 2 || access.size === allowed.size))
  )
    throw new Error('Incomplete anchor permissions');
  return { read, append: access.size === allowed.size };
}

export async function validateAnchorAccess(client, write) {
  const identity = await databaseIdentity(client);
  const target = Object.hasOwn(anchorTargets, identity.database)
    ? anchorTargets[identity.database]
    : undefined;
  if (
    !target ||
    !identity.durable ||
    identity.login !== target.writer ||
    identity.role !== target.writer ||
    !(await writerBoundary(client, target.writer))
  )
    return false;
  const access = await anchorAcl(client, target);
  return write ? access.append : access.read;
}

export async function grantAnchorWriter(client, database) {
  const target = anchorTargets[database];
  await client.query('begin');
  try {
    await client.query('set local search_path = pg_catalog, pg_temp');
    const identity = await databaseIdentity(client);
    if (
      identity.database !== database ||
      identity.login !== target.owner ||
      identity.role !== target.owner
    )
      throw new Error('Unexpected migration identity');
    const access = await anchorAcl(client, target);
    const isolated = await writerBoundary(client, target.writer);
    if (isolated === false) throw new Error('Anchor writer is not isolated');
    if (isolated === true && !access.read) {
      const writer = target.writer;
      await client.query(`grant usage on schema audit to ${writer}`);
      await client.query(
        `grant select on audit.session_log_anchor to ${writer}`,
      );
      await client.query(
        `grant insert (${insertColumns.join(', ')}) on audit.session_log_anchor to ${writer}`,
      );
      if (!(await anchorAcl(client, target)).append)
        throw new Error('Anchor writer grant is incomplete');
    }
    await client.query('commit');
  } catch (error) {
    await client.query('rollback');
    throw error;
  }
}
