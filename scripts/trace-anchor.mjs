import { createHash } from 'node:crypto';
import { lstat, opendir, realpath } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  relative,
  resolve,
  sep,
} from 'node:path';
import { Client } from 'pg';
import {
  explicitDatabaseConnection,
  clearPgDefaults,
  validateAnchorAccess,
} from './trace-anchor-db.mjs';
import { inspectJournalPrefix } from './trace-prefix.mjs';

const bucketName = /^(?:_no-cwd|--[a-zA-Z0-9._~-]{1,251}--)$/;
const journalNamePattern =
  /^session(?:\.v([1-9][0-9]{0,15}))?\.jsonl(?:\.zstd)?$/;
const exactAnchor = `select sha256, recorded_at from audit.session_log_anchor
  where project_id = $1 and session_id = $2 and bucket_sha256 = $3 and journal_name = $4 and through_byte = $5`;

function coordinates(root, path, throughByte) {
  if (
    !root ||
    !isAbsolute(root) ||
    !isAbsolute(path) ||
    resolve(root) !== root ||
    resolve(path) !== path ||
    root.includes('\0') ||
    path.includes('\0') ||
    basename(root) !== 'sessions'
  )
    return;
  const project = /^project-([a-z0-9][a-z0-9_-]{0,63})$/.exec(
    basename(dirname(root)),
  )?.[1];
  const [bucket, sessionId, journalName, ...rest] = relative(root, path).split(
    sep,
  );
  const generation = journalNamePattern.exec(journalName);
  if (
    !project ||
    !bucketName.test(bucket) ||
    !/^session-[a-zA-Z0-9-]{1,120}$/.test(sessionId) ||
    !generation ||
    !Number.isSafeInteger(Number(generation[1] ?? '0')) ||
    rest.length
  )
    return;
  return {
    root,
    bucket,
    sessionId,
    key: [
      project,
      sessionId,
      createHash('sha256').update(bucket).digest('hex'),
      journalName,
      throughByte,
    ],
  };
}

async function sourceStatus({ root, bucket, sessionId }) {
  try {
    if ((await realpath(root)) !== root) return 'invalid-source';
    const dir = await opendir(root);
    for await (const entry of dir) {
      if (!bucketName.test(entry.name) || entry.name === bucket) continue;
      if (entry.isSymbolicLink()) return 'invalid-source';
      if (!entry.isDirectory()) continue;
      const found = await lstat(
        root + sep + entry.name + sep + sessionId,
      ).catch((error) => {
        if (error.code !== 'ENOENT') throw error;
      });
      if (found) return 'ambiguous-source';
    }
  } catch {
    return 'source-unavailable';
  }
}

async function lookup(client, key) {
  return (await client.query(exactAnchor, key)).rows[0];
}

function receipt(status, throughByte, row) {
  return {
    status,
    throughByte,
    sha256: row.sha256,
    recordedAt: row.recorded_at.toISOString(),
  };
}

async function record(client, key, throughByte, sha256) {
  const compare = (row) =>
    row.sha256 === sha256
      ? receipt('replayed', throughByte, row)
      : { status: 'conflict', throughByte };
  const previous = await lookup(client, key);
  if (previous) return compare(previous);

  let row,
    denied = false;
  try {
    await client.query('begin isolation level read committed');
    await client.query('set local synchronous_commit = on');
    const saved = await client.query(
      `insert into audit.session_log_anchor
        (project_id, session_id, bucket_sha256, journal_name, through_byte, sha256)
      values ($1,$2,$3,$4,$5,$6)
      on conflict on constraint session_log_anchor_key do nothing
      returning sha256, recorded_at`,
      [...key, sha256],
    );
    row = saved.rows[0];
    await client.query('commit');
  } catch (error) {
    const rolledBack =
      error.code === '23503' &&
      (await client.query('rollback').then(
        () => true,
        () => false,
      ));
    if (!rolledBack) return { status: 'unconfirmed', throughByte };
    denied = true;
  }
  if (row) return receipt('recorded', throughByte, row);
  let existing;
  try {
    existing = await lookup(client, key);
  } catch {
    return { status: 'unconfirmed', throughByte };
  }
  if (existing) return compare(existing);
  return {
    status: denied ? 'source-unregistered' : 'unconfirmed',
    throughByte,
  };
}

async function run() {
  const [action, path, cutoff, ...extra] = process.argv.slice(2);
  const throughByte = Number(cutoff);
  if (
    !['record', 'verify'].includes(action) ||
    !path ||
    !/^[1-9][0-9]*$/.test(cutoff ?? '') ||
    !Number.isSafeInteger(throughByte) ||
    extra.length
  )
    return { status: 'invalid-input' };
  const source = coordinates(
    process.env.RDWS_ANCHOR_SOURCE_DIR,
    path,
    throughByte,
  );
  if (!source) return { status: 'invalid-source', throughByte };
  const config = explicitDatabaseConnection(
    process.env.RDWS_ANCHOR_DATABASE_URL,
    'writer',
  );
  if (!config) return { status: 'database-unconfigured' };
  clearPgDefaults();
  const client = new Client({
    ...config,
    application_name: 'rdws-trace-anchor',
    options: '-c search_path=pg_catalog,pg_temp',
    connectionTimeoutMillis: 4500,
    lock_timeout: 2500,
    statement_timeout: 5500,
    idle_in_transaction_session_timeout: 8000,
    query_timeout: 6500,
  });
  client.on('error', () => {});
  try {
    await client.connect();
    if (!(await validateAnchorAccess(client, action === 'record')))
      return { status: 'database-unauthorized' };
    const initial = await sourceStatus(source);
    if (initial) return { status: initial, throughByte };
    const row =
      action === 'verify' ? await lookup(client, source.key) : undefined;
    if (action === 'verify' && !row)
      return { status: 'missing-anchor', throughByte };
    const observation = await inspectJournalPrefix(
      path,
      throughByte,
      row?.sha256,
      { singleLink: true },
    );
    if (
      !['hashed', 'matched', 'mismatch', 'truncated'].includes(
        observation.status,
      )
    )
      return observation;
    const current = await sourceStatus(source);
    if (current) return { status: current, throughByte };
    return observation.status === 'hashed'
      ? await record(client, source.key, throughByte, observation.sha256)
      : observation;
  } catch (error) {
    return {
      status: ['42501', '42P01', '3F000', '42883'].includes(error.code)
        ? 'database-unauthorized'
        : 'database-unavailable',
    };
  } finally {
    await client.end().catch(() => {});
  }
}

const result = await run().catch(() => ({ status: 'database-unavailable' }));
console.log(JSON.stringify(result));
process.exitCode = ['recorded', 'replayed', 'matched'].includes(result.status)
  ? 0
  : ['conflict', 'mismatch', 'truncated'].includes(result.status)
    ? 1
    : 2;
