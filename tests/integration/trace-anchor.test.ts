import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import {
  appendFile,
  chmod,
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { zstdDecompressSync } from 'node:zlib';
import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool } from 'pg';
import { NativeWebHost } from '@rdws/dsh/web';
import { expect, test, vi } from 'vitest';

const exec = promisify(execFile);

async function command(
  expectedCode: number,
  invocation: string[],
  env: NodeJS.ProcessEnv = process.env,
) {
  let result: { stdout: string; stderr: string; code?: number };
  try {
    result = await exec(invocation[0]!, invocation.slice(1), { env });
  } catch (error) {
    const failure = error as typeof result;
    if (typeof failure.code !== 'number') throw error;
    result = failure;
  }
  expect(result.stderr).toBe('');
  const body: unknown = JSON.parse(result.stdout);
  expect(result.stdout).toBe(JSON.stringify(body) + '\n');
  expect(result.code ?? 0).toBe(expectedCode);
  return body;
}

test('anchor CLI rejects malformed coordinates without exposing input or using ambient credentials', async () => {
  const args = [
    'pnpm',
    '--silent',
    'trace:anchor',
    'record',
    '/fictional-project/log',
    '1e3',
  ];
  expect(
    await command(2, args, {
      ...process.env,
      RDWS_ANCHOR_DATABASE_URL: '',
      RDWS_ANCHOR_SOURCE_DIR: '',
    }),
  ).toEqual({ status: 'invalid-input' });
});

test('automatic recording accepts the source coordinates without a numeric cutoff', async () => {
  const source = '/fictional-project/project-proof/sessions';
  const file = source + '/--work--/session-example/session.v4.jsonl.zstd';
  expect(
    await command(
      2,
      ['pnpm', '--silent', 'trace:anchor', 'record-auto', file],
      {
        ...process.env,
        RDWS_ANCHOR_DATABASE_URL: '',
        RDWS_ANCHOR_SOURCE_DIR: source,
      },
    ),
  ).toEqual({ status: 'database-unconfigured' });
});

const postgresImage =
  'postgres:18.7@sha256:2ea8630df176ad090ec92136dee850397c5af8781e4bcf2e4162593691c61bbc';
const nodeImage = 'node:24.20.0-bookworm-slim';
const dbName = 'rdws_test';
const ownerRole = 'rdws_test_migrator';
const appRole = 'rdws_test_app';
const writerRole = 'rdws_test_anchor_writer';
const sourceProject = 'anchor-proof';
const otherProject = 'anchor-neighbor';
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');

async function createJournal(root: string, demandId: string) {
  const config = join(root, 'config', 'projects', sourceProject, 'dsh');
  const profile = join(config, 'profiles', 'rdws');
  const cwd = join(root, 'projects', sourceProject, 'demands', demandId);
  const checkpoint = join(root, 'native-checkpoint.json');
  await mkdir(profile, { recursive: true, mode: 0o700 });
  await mkdir(cwd, { recursive: true, mode: 0o700 });
  await writeFile(join(config, '.credentials.yaml'), 'version: 1\nrefs: {}\n', {
    mode: 0o600,
  });
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      {
        id: 'llm-pi-ai',
        config: {
          providers: {
            'rdws-glm': {
              api: 'openai-completions',
              baseURL: 'http://127.0.0.1:1/v1',
              models: [{ id: 'unused-local-fixture' }],
            },
          },
        },
      },
      {
        insert: [
          {
            id: 'anchor-native-fixture',
            name: fileURLToPath(
              new URL(
                '../fixtures/native-preset-composition.mjs',
                import.meta.url,
              ),
            ),
            config: {
              cwd,
              checkpoint,
              create: ['standard'],
              resume: [],
              unknownPreset: 'unused-fixture-preset',
              selection: {
                provider: 'rdws-glm',
                model: 'unused-local-fixture',
              },
            },
          },
        ],
      },
    ]),
  );
  const host = new NativeWebHost(root, config, sourceProject);
  let sessionId: string, pid: number;
  try {
    await host.start();
    const report = await vi.waitFor(
      async () => {
        const value = JSON.parse(await readFile(checkpoint, 'utf8'));
        expect(value.error).toBeUndefined();
        expect(value.sessionIds).toHaveLength(1);
        return value;
      },
      { timeout: 6500 },
    );
    sessionId = report.sessionIds[0] as string;
    pid = report.pid as number;
  } finally {
    await host.close();
  }
  expect(() => process.kill(pid, 0)).toThrow(
    expect.objectContaining({ code: 'ESRCH' }),
  );
  const nativeRoot = join(
    root,
    'runtime',
    'dsh',
    'project-' + sourceProject,
    'sessions',
  );
  const logs = (await readdir(nativeRoot, { recursive: true })).filter(
    (file) => {
      const parts = file.split(sep);
      return (
        parts.at(-2) === sessionId &&
        /^session(?:\.v[1-9]\d*)?\.jsonl\.zstd$/.test(parts.at(-1)!)
      );
    },
  );
  expect(logs).toHaveLength(1);
  const bytes = await readFile(join(nativeRoot, logs[0]!));
  expect(bytes.readUInt32LE(0)).toBe(0xfd2fb528);
  const first = zstdDecompressSync(bytes, { info: true }) as unknown as {
    engine: { bytesWritten: number };
  };
  expect(first.engine.bytesWritten).toBeGreaterThan(0);
  expect(first.engine.bytesWritten).toBeLessThan(bytes.length);
  const eventText = zstdDecompressSync(
    bytes.subarray(first.engine.bytesWritten),
  ).toString();
  expect(
    eventText
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line)),
  ).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ type: 'model/selection' }),
    ]),
  );
  return { sessionId, entry: logs[0]!, bytes, nativeRoot };
}

async function runMigration(
  fixtureHome: string,
  connectionString: string,
  succeeds: boolean,
  ambient: NodeJS.ProcessEnv = {},
) {
  const invocation = exec('pnpm', ['--silent', 'db:migrate'], {
    env: {
      ...process.env,
      ...ambient,
      RDWS_MODE: 'test',
      RDWS_HOME: fixtureHome,
      DATABASE_MIGRATION_URL: connectionString,
    },
  });
  if (succeeds) await expect(invocation).resolves.toMatchObject({ stderr: '' });
  else await expect(invocation).rejects.toMatchObject({ code: 1 });
}

test('a separate PostgreSQL login anchors an actual stopped Native journal and verifies it after restart', async () => {
  const fixture = await mkdtemp(
    join(await realpath(tmpdir()), 'rdws-anchor-check-'),
  );
  const mark = 'rdws-anchor-' + randomUUID();
  const bootstrapRole = 'rdws_anchor_fixture_bootstrap';
  const bootstrapPassword = randomBytes(24).toString('hex');
  const migrationPassword = randomBytes(24).toString('hex');
  const applicationPassword = randomBytes(24).toString('hex');
  const writerPassword = randomBytes(24).toString('hex');
  const pools: Pool[] = [];
  let container = '',
    network = '';
  const docker = (...args: string[]) => exec('docker', args);
  const makePool = (connectionString: string) => {
    const pool = new Pool({ connectionString, connectionTimeoutMillis: 700 });
    pool.on('error', () => {});
    pools.push(pool);
    return pool;
  };
  try {
    network = (
      await docker('network', 'create', '--label', 'rdws.fixture=' + mark, mark)
    ).stdout.trim();
    container = (
      await exec(
        'docker',
        [
          'run',
          '--detach',
          '--pull=never',
          '--name',
          mark,
          '--label',
          'rdws.fixture=' + mark,
          '--network',
          network,
          '--network-alias',
          'anchor-db',
          '--publish',
          '127.0.0.1::5432',
          '--env',
          'POSTGRES_USER=' + bootstrapRole,
          '--env',
          'POSTGRES_PASSWORD',
          postgresImage,
        ],
        { env: { ...process.env, POSTGRES_PASSWORD: bootstrapPassword } },
      )
    ).stdout.trim();
    expect(
      await docker(
        'inspect',
        '--format',
        '{{index .Config.Labels "rdws.fixture"}}',
        container,
      ),
    ).toMatchObject({ stdout: mark + '\n' });
    const binding = (await docker('port', container, '5432/tcp')).stdout.trim();
    expect(binding).toMatch(/^127\.0\.0\.1:[1-9][0-9]*$/);
    const dsn = (
      role: string,
      password: string,
      database = dbName,
      peer = binding,
    ) => 'postgresql://' + role + ':' + password + '@' + peer + '/' + database;
    const boot = makePool(dsn(bootstrapRole, bootstrapPassword, 'postgres'));
    async function waitDatabase(pool: Pool) {
      await vi.waitFor(
        async () => {
          const state = await pool.query(
            'select current_user as login, current_database() as db',
          );
          expect(state.rows[0]).toEqual({
            login: bootstrapRole,
            db: 'postgres',
          });
        },
        { timeout: 15_000, interval: 150 },
      );
    }
    await waitDatabase(boot);
    async function addRole(role: string, password: string) {
      const statement = await boot.query(
        "select format('create role %I login nosuperuser nocreatedb nocreaterole noreplication nobypassrls noinherit password %L', $1::text,$2::text) as sql",
        [role, password],
      );
      await boot.query(statement.rows[0].sql);
    }
    await addRole(ownerRole, migrationPassword);
    await addRole(appRole, applicationPassword);
    await boot.query('create database rdws_test owner rdws_test_migrator');
    await boot.query(
      'create database rdws_anchor_wrong owner rdws_test_migrator',
    );
    await boot.query('revoke connect on database rdws_test from public');
    await boot.query('grant connect on database rdws_test to rdws_test_app');
    const ownerDsn = dsn(ownerRole, migrationPassword);
    const owner = makePool(ownerDsn);
    const operator = makePool(dsn(bootstrapRole, bootstrapPassword));
    const app = makePool(dsn(appRole, applicationPassword));
    const wrong = makePool(
      dsn(ownerRole, migrationPassword, 'rdws_anchor_wrong'),
    );
    const fixtureHome = join(fixture, 'local-config');
    await mkdir(join(fixtureHome, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(fixtureHome, 'secrets', 'test.env'), '', {
      mode: 0o600,
    });
    await runMigration(
      fixtureHome,
      dsn(ownerRole, migrationPassword, 'rdws_anchor_wrong'),
      false,
    );
    expect(
      (
        await wrong.query(
          "select to_regnamespace('drizzle') as journal, to_regnamespace('audit') as audit",
        )
      ).rows[0],
    ).toEqual({ journal: null, audit: null });
    await runMigration(fixtureHome, dsn(appRole, applicationPassword), false);
    await runMigration(fixtureHome, '', false, {
      PGHOST: '127.0.0.1',
      PGPORT: binding.split(':')[1],
      PGUSER: ownerRole,
      PGPASSWORD: migrationPassword,
      PGDATABASE: dbName,
    });
    await boot.query('create role anchor_migrator_assumed nologin');
    await boot.query('grant anchor_migrator_assumed to rdws_test_migrator');
    await boot.query(
      'alter role rdws_test_migrator in database rdws_test set role = anchor_migrator_assumed',
    );
    await runMigration(fixtureHome, ownerDsn, false);
    await boot.query(
      'alter role rdws_test_migrator in database rdws_test reset role',
    );
    await boot.query('revoke anchor_migrator_assumed from rdws_test_migrator');
    expect(
      (
        await owner.query(
          "select to_regnamespace('drizzle') as journal, to_regnamespace('audit') as audit",
        )
      ).rows[0],
    ).toEqual({ journal: null, audit: null });

    const from = resolve('packages/db/migrations');
    const previous = join(fixture, 'baseline-0009');
    await mkdir(join(previous, 'meta'), { recursive: true });
    const journal = JSON.parse(
      await readFile(join(from, 'meta', '_journal.json'), 'utf8'),
    );
    journal.entries = journal.entries.filter(
      (entry: { idx: number }) => entry.idx < 10,
    );
    expect(journal.entries).toHaveLength(10);
    for (const item of journal.entries)
      await copyFile(
        join(from, item.tag + '.sql'),
        join(previous, item.tag + '.sql'),
      );
    await writeFile(
      join(previous, 'meta', '_journal.json'),
      JSON.stringify(journal),
    );
    const existing = await owner.connect();
    try {
      expect(
        (
          await existing.query(
            'select current_user as login,current_database() as db',
          )
        ).rows[0],
      ).toEqual({ login: ownerRole, db: dbName });
      await migrate(drizzle(existing), { migrationsFolder: previous });
    } finally {
      existing.release();
    }
    const demandId = randomUUID(),
      neighborDemand = randomUUID();
    const userId = randomUUID();
    const real = await createJournal(fixture, demandId);
    await owner.query('insert into auth_user(id,name,email) values($1,$2,$3)', [
      userId,
      'T16 fixture',
      't16-fixture@example.invalid',
    ]);
    await owner.query('insert into project(id,name) values($1,$1),($2,$2)', [
      sourceProject,
      otherProject,
    ]);
    await owner.query(
      "insert into requirement (id,project_id,title,description,acceptance,lead_id,created_by) values ($1,$2,'First','','',$5,$5),($3,$4,'Neighbor','','',$5,$5)",
      [demandId, sourceProject, neighborDemand, otherProject, userId],
    );
    await owner.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [real.sessionId, demandId, userId],
    );
    await owner.query(
      'alter default privileges grant select on tables to rdws_test_app',
    );
    await runMigration(fixtureHome, ownerDsn, false);
    expect(
      (
        await owner.query(
          "select to_regnamespace('audit') as audit, (select count(*)::integer from drizzle.__drizzle_migrations) as migrations",
        )
      ).rows[0],
    ).toEqual({ audit: null, migrations: 10 });
    await owner.query(
      'alter default privileges revoke select on tables from rdws_test_app',
    );
    await runMigration(fixtureHome, ownerDsn, true);
    expect(
      (
        await owner.query(
          'select requirement_id from native_session where id=$1',
          [real.sessionId],
        )
      ).rows,
    ).toEqual([{ requirement_id: demandId }]);
    expect(
      (
        await owner.query(
          'select exists(select 1 from pg_roles where rolname=$1) as present',
          [writerRole],
        )
      ).rows[0],
    ).toEqual({ present: false });
    await addRole(writerRole, writerPassword);
    await boot.query(
      'grant connect on database rdws_test to rdws_test_anchor_writer',
    );
    const writerDsn = dsn(writerRole, writerPassword);
    const writer = makePool(writerDsn);
    await owner.query(
      'grant select (id) on requirement to rdws_test_anchor_writer',
    );
    await runMigration(fixtureHome, ownerDsn, false);
    expect(
      (
        await owner.query(
          "select has_schema_privilege($1,'audit','USAGE') as allowed",
          [writerRole],
        )
      ).rows[0],
    ).toEqual({ allowed: false });
    await owner.query(
      'revoke select (id) on requirement from rdws_test_anchor_writer',
    );
    await runMigration(fixtureHome, ownerDsn, true);
    await runMigration(fixtureHome, ownerDsn, true);
    await expect(
      app.query('select * from audit.session_log_anchor'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      writer.query('select * from public.requirement'),
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      writer.query('select audit.check_session_log_source()'),
    ).rejects.toMatchObject({ code: '42501' });
    expect(
      (await writer.query('select current_user as role, session_user as login'))
        .rows[0],
    ).toEqual({ role: writerRole, login: writerRole });

    const snapshotRoot = join(
      fixture,
      'snapshot',
      'project-' + sourceProject,
      'sessions',
    );
    const journalFile = join(snapshotRoot, real.entry);
    await mkdir(dirname(journalFile), { recursive: true, mode: 0o755 });
    await writeFile(journalFile, real.bytes, { mode: 0o444 });
    const cutoff = real.bytes.length;
    const visibleRoot = '/proof/project-' + sourceProject + '/sessions';
    const visibleFile = visibleRoot + '/' + real.entry;
    const wireStub = join(fixture, 'lose-commit-result.mjs');
    const pgPath = pathToFileURL(
      createRequire(import.meta.url).resolve('pg'),
    ).href;
    const loseReply = `
      const original = pg.Client.prototype.query;
      pg.Client.prototype.query = function (...args) {
        const result = original.apply(this, args);
        if (args[0] !== 'commit') return result;
        return result.then(() => {
          this.connection.stream.destroy();
          throw new Error('fixture dropped the confirmed response');
        });
      };`;
    await writeFile(
      wireStub,
      `import pg from ${JSON.stringify(pgPath)};` + loseReply,
      { mode: 0o600 },
    );
    async function runVerifier(action: string, drop = false) {
      if (process.env.RDWS_TEST_ANCHOR_READONLY !== '1') {
        const address = (
          await docker('port', container, '5432/tcp')
        ).stdout.trim();
        expect(address).toMatch(/^127\.0\.0\.1:[1-9][0-9]*$/);
        const args = [
          action,
          journalFile,
          ...(action === 'record-auto' ? [] : [String(cutoff)]),
        ];
        return command(
          drop ? 2 : 0,
          drop
            ? [
                process.execPath,
                '--import',
                wireStub,
                'scripts/trace-anchor.mjs',
                ...args,
              ]
            : ['pnpm', '--silent', 'trace:anchor', ...args],
          {
            ...process.env,
            RDWS_ANCHOR_DATABASE_URL: dsn(
              writerRole,
              writerPassword,
              dbName,
              address,
            ),
            RDWS_ANCHOR_SOURCE_DIR: snapshotRoot,
          },
        );
      }
      const code = `import { readFile, appendFile } from 'node:fs/promises';
        import assert from 'node:assert/strict';
        import pg from '/work/node_modules/pg/lib/index.js';
        const [, mode, path, cutoff, drop] = process.argv;
        assert.equal(process.getuid(), 65534);
        assert.equal((await readFile(path)).length >= Number(cutoff), true);
        await assert.rejects(appendFile(path, 'forbidden'), { code: 'EROFS' });
        if (drop === 'drop') { ${loseReply} }
        process.argv = ['node','/work/scripts/trace-anchor.mjs',mode,path,...(mode === 'record-auto' ? [] : [cutoff])];
        await import('/work/scripts/trace-anchor.mjs');`;
      return command(
        drop ? 2 : 0,
        [
          'docker',
          'run',
          '--rm',
          '--pull=never',
          '--read-only',
          '--user',
          '65534:65534',
          '--network',
          network,
          '--env',
          'RDWS_ANCHOR_DATABASE_URL',
          '--env',
          'RDWS_ANCHOR_SOURCE_DIR',
          '--mount',
          'type=bind,source=' +
            snapshotRoot +
            ',target=' +
            visibleRoot +
            ',readonly',
          '--mount',
          'type=bind,source=' +
            resolve('scripts') +
            ',target=/work/scripts,readonly',
          '--mount',
          'type=bind,source=' +
            resolve('node_modules') +
            ',target=/work/node_modules,readonly',
          nodeImage,
          'node',
          '--input-type=module',
          '-e',
          code,
          action,
          visibleFile,
          String(cutoff),
          drop ? 'drop' : 'normal',
        ],
        {
          ...process.env,
          RDWS_ANCHOR_DATABASE_URL: dsn(
            writerRole,
            writerPassword,
            dbName,
            'anchor-db:5432',
          ),
          RDWS_ANCHOR_SOURCE_DIR: visibleRoot,
        },
      );
    }
    expect(await runVerifier('record-auto', true)).toEqual({
      status: 'unconfirmed',
      throughByte: cutoff,
      ignoredTailBytes: 0,
    });
    const recorded = await runVerifier('record-auto');
    expect(recorded).toMatchObject({
      status: 'replayed',
      throughByte: cutoff,
      sha256: sha(real.bytes),
      recordedAt: expect.any(String),
      ignoredTailBytes: 0,
    });
    const [bucket] = real.entry.split(sep);
    const independent = (
      await owner.query('select * from audit.session_log_anchor')
    ).rows;
    expect(independent).toEqual([
      {
        project_id: sourceProject,
        session_id: real.sessionId,
        bucket_sha256: sha(bucket!),
        journal_name: basename(journalFile),
        through_byte: String(cutoff),
        sha256: sha(real.bytes),
        recorded_at: expect.any(Date),
      },
    ]);
    expect(JSON.stringify(independent)).not.toContain(bucket);
    expect(await readFile(join(real.nativeRoot, real.entry))).toEqual(
      real.bytes,
    );
    expect(await readFile(journalFile)).toEqual(real.bytes);
    const environment = {
      ...process.env,
      RDWS_ANCHOR_DATABASE_URL: writerDsn,
      RDWS_ANCHOR_SOURCE_DIR: snapshotRoot,
    };
    const host = (
      action: string,
      code = 0,
      bytes = cutoff,
      path = journalFile,
      overrides: NodeJS.ProcessEnv = {},
    ) =>
      command(
        code,
        [
          'pnpm',
          '--silent',
          'trace:anchor',
          action,
          path,
          ...(action === 'record-auto' ? [] : [String(bytes)]),
        ],
        {
          ...environment,
          ...overrides,
        },
      );
    expect(await host('record')).toEqual({
      status: 'replayed',
      throughByte: cutoff,
      sha256: sha(real.bytes),
      recordedAt: independent[0].recorded_at.toISOString(),
    });
    const wrongBucket = join(snapshotRoot, '--unrelated-workspace--');
    await rename(join(snapshotRoot, bucket!), wrongBucket);
    expect(
      await host(
        'record-auto',
        2,
        cutoff,
        join(wrongBucket, real.sessionId, basename(journalFile)),
      ),
    ).toEqual({ status: 'invalid-journal' });
    await rename(wrongBucket, join(snapshotRoot, bucket!));
    await chmod(journalFile, 0o644);
    await appendFile(journalFile, Buffer.from([0x28, 0xb5, 0x2f]));
    expect(await host('record-auto')).toMatchObject({
      status: 'replayed',
      throughByte: cutoff,
      ignoredTailBytes: 3,
    });
    await appendFile(journalFile, Buffer.from([0]));
    expect(await host('record-auto', 2)).toEqual({ status: 'invalid-journal' });
    await writeFile(journalFile, real.bytes);
    expect(
      (
        await owner.query(
          'select count(*)::integer as count from audit.session_log_anchor',
        )
      ).rows[0],
    ).toEqual({ count: 1 });
    expect(
      await host('verify', 0, cutoff, journalFile, {
        PGUSER: bootstrapRole,
        PGHOST: 'example.invalid',
        PGOPTIONS:
          '-c search_path=unexpected -c default_transaction_read_only=on',
        PGPASSWORD: 'unrelated-fixture',
      }),
    ).toEqual({ status: 'matched', throughByte: cutoff });
    expect(
      await host('verify', 2, cutoff, journalFile, {
        PGPASSWORD: writerPassword,
        RDWS_ANCHOR_DATABASE_URL:
          'postgresql://' + writerRole + '@' + binding + '/' + dbName,
      }),
    ).toEqual({ status: 'database-unconfigured' });
    expect(
      await host('verify', 2, cutoff, journalFile, {
        RDWS_ANCHOR_DATABASE_URL: writerDsn + '?options=forbidden',
      }),
    ).toEqual({ status: 'database-unconfigured' });
    expect(
      await host('verify', 2, cutoff, journalFile, {
        RDWS_ANCHOR_DATABASE_URL: dsn(
          writerRole,
          writerPassword,
          dbName,
          '127.0.0.1:0',
        ),
      }),
    ).toEqual({ status: 'database-unconfigured' });
    expect(
      await host('verify', 2, cutoff, journalFile, {
        RDWS_ANCHOR_DATABASE_URL: dsn(appRole, applicationPassword),
      }),
    ).toEqual({ status: 'database-unconfigured' });

    await operator.query('grant rdws_test_app to rdws_test_anchor_writer');
    expect(await host('verify', 2)).toEqual({
      status: 'database-unauthorized',
    });
    await operator.query('revoke rdws_test_app from rdws_test_anchor_writer');
    await owner.query(
      'grant select (id) on requirement to rdws_test_anchor_writer',
    );
    expect(await host('verify', 2)).toEqual({
      status: 'database-unauthorized',
    });
    await owner.query(
      'revoke select (id) on requirement from rdws_test_anchor_writer',
    );
    const key = (bytes: number, project = sourceProject) => [
      project,
      real.sessionId,
      sha(bucket!),
      basename(journalFile),
      bytes,
      sha(real.bytes.subarray(0, bytes)),
    ];
    const insert = `insert into audit.session_log_anchor
      (project_id,session_id,bucket_sha256,journal_name,through_byte,sha256)
      values ($1,$2,$3,$4,$5,$6)`;
    await expect(
      writer.query(insert, key(cutoff, otherProject)),
    ).rejects.toMatchObject({ code: '23503' });
    for (const sql of [
      'update audit.session_log_anchor set sha256=sha256',
      'delete from audit.session_log_anchor',
      'truncate audit.session_log_anchor',
      'alter table audit.session_log_anchor disable trigger anchor_current_session_source',
    ])
      await expect(writer.query(sql)).rejects.toMatchObject({ code: '42501' });
    const independentKey = cutoff - 1;
    const racing = await Promise.all([
      host('record', 0, independentKey),
      host('record', 0, independentKey),
    ]);
    expect(
      racing.map((row) => (row as { status: string }).status).sort(),
    ).toEqual(['recorded', 'replayed']);
    expect((racing[0] as { recordedAt: string }).recordedAt).toBe(
      (racing[1] as { recordedAt: string }).recordedAt,
    );

    const snapshotLink = join(dirname(journalFile), 'copy');
    await link(journalFile, snapshotLink);
    expect(await host('verify', 2)).toEqual({
      status: 'invalid-source',
      throughByte: cutoff,
    });
    await rm(snapshotLink);
    const duplicate = join(
      snapshotRoot,
      '--alternate-workspace--',
      real.sessionId,
    );
    await mkdir(duplicate, { recursive: true });
    expect(await host('verify', 2)).toEqual({
      status: 'ambiguous-source',
      throughByte: cutoff,
    });
    await rm(dirname(duplicate), { recursive: true });
    expect(
      await host(
        'verify',
        2,
        cutoff,
        join(dirname(journalFile), 'session.v9007199254740992.jsonl'),
      ),
    ).toEqual({ status: 'invalid-source', throughByte: cutoff });
    const outside = join(fixture, 'outside', real.entry);
    expect(await host('verify', 2, cutoff, outside)).toEqual({
      status: 'invalid-source',
      throughByte: cutoff,
    });
    const anotherGeneration = join(
      dirname(journalFile),
      'session.v42.jsonl.zstd',
    );
    await writeFile(anotherGeneration, real.bytes);
    expect(await host('verify', 2, cutoff, anotherGeneration)).toEqual({
      status: 'missing-anchor',
      throughByte: cutoff,
    });
    expect(await host('record', 0, cutoff, anotherGeneration)).toMatchObject({
      status: 'recorded',
      sha256: sha(real.bytes),
    });
    await chmod(journalFile, 0o644);
    await appendFile(journalFile, 'append after sealed prefix');
    expect(await host('verify')).toEqual({
      status: 'matched',
      throughByte: cutoff,
    });
    const changed = Buffer.from(real.bytes);
    changed[0] = changed[0]! ^ 1;
    await writeFile(journalFile, changed);
    expect(await host('record', 1)).toEqual({
      status: 'conflict',
      throughByte: cutoff,
    });
    expect(await host('verify', 1)).toEqual({
      status: 'mismatch',
      throughByte: cutoff,
    });
    await truncate(journalFile, cutoff - 1);
    expect(await host('verify', 1)).toEqual({
      status: 'truncated',
      throughByte: cutoff,
    });
    expect(await host('record', 2)).toEqual({
      status: 'cutoff-unavailable',
      throughByte: cutoff,
    });
    await writeFile(journalFile, real.bytes);

    const ignoredResponseKey = cutoff - 2;
    expect(
      await command(
        2,
        [
          process.execPath,
          '--import',
          wireStub,
          'scripts/trace-anchor.mjs',
          'record',
          journalFile,
          String(ignoredResponseKey),
        ],
        environment,
      ),
    ).toEqual({ status: 'unconfirmed', throughByte: ignoredResponseKey });
    expect(await host('record', 0, ignoredResponseKey)).toMatchObject({
      status: 'replayed',
      throughByte: ignoredResponseKey,
      sha256: sha(real.bytes.subarray(0, ignoredResponseKey)),
    });
    const unanswered = cutoff - 7;
    await writeFile(
      wireStub,
      `import pg from ${JSON.stringify(pgPath)};
      const original = pg.Client.prototype._handleReadyForQuery;
      pg.Client.prototype._handleReadyForQuery = function (message) {
        if (this._getActiveQuery()?.text === 'commit') return;
        return original.call(this, message);
      };`,
      { mode: 0o600 },
    );
    expect(
      await command(
        2,
        [
          process.execPath,
          '--import',
          wireStub,
          'scripts/trace-anchor.mjs',
          'record',
          journalFile,
          String(unanswered),
        ],
        environment,
      ),
    ).toEqual({ status: 'unconfirmed', throughByte: unanswered });
    expect(await host('record', 0, unanswered)).toMatchObject({
      status: 'replayed',
      throughByte: unanswered,
      sha256: sha(real.bytes.subarray(0, unanswered)),
    });

    const writing = await writer.connect();
    const moving = await owner.connect();
    const move =
      'update public.native_session set requirement_id=$1 where id=$2';
    const moveValues = (demand: string) => [demand, real.sessionId];
    async function waitBlocked(pid: number) {
      await vi.waitFor(
        async () => {
          const waiting = await operator.query(
            'select cardinality(pg_blocking_pids($1)) > 0 as waiting',
            [pid],
          );
          expect(waiting.rows[0].waiting).toBe(true);
        },
        { timeout: 3000, interval: 30 },
      );
    }
    try {
      await writing.query("set lock_timeout = '5s'");
      await moving.query("set lock_timeout = '5s'");
      await writing.query(
        'create temporary table requirement (id text, project_id text)',
      );
      await writing.query(
        'create temporary table native_session (id text, requirement_id text)',
      );
      await writing.query('insert into pg_temp.requirement values ($1,$2)', [
        neighborDemand,
        otherProject,
      ]);
      await writing.query('insert into pg_temp.native_session values ($1,$2)', [
        real.sessionId,
        neighborDemand,
      ]);
      await expect(
        writing.query(insert, key(cutoff - 3, otherProject)),
      ).rejects.toMatchObject({ code: '23503' });
      await writing.query('begin');
      await writing.query(insert, key(cutoff - 3));
      expect(await host('verify', 2, cutoff - 3)).toEqual({
        status: 'missing-anchor',
        throughByte: cutoff - 3,
      });
      const movingPid = (await moving.query('select pg_backend_pid() as pid'))
        .rows[0].pid;
      const writingPid = (await writing.query('select pg_backend_pid() as pid'))
        .rows[0].pid;
      const blockedMove = moving.query(move, moveValues(neighborDemand));
      await waitBlocked(movingPid);
      await writing.query('commit');
      await blockedMove;
      expect(await host('verify', 0, cutoff - 3)).toEqual({
        status: 'matched',
        throughByte: cutoff - 3,
      });
      expect(await host('record', 2, cutoff - 4)).toEqual({
        status: 'source-unregistered',
        throughByte: cutoff - 4,
      });
      await moving.query(move, moveValues(demandId));

      for (const commitMove of [true, false]) {
        await moving.query('begin');
        await moving.query(move, moveValues(neighborDemand));
        const candidate = writing.query(insert, key(cutoff - 4)).then(
          () => 'recorded',
          (error: { code: string }) => error.code,
        );
        await waitBlocked(writingPid);
        await moving.query(commitMove ? 'commit' : 'rollback');
        expect(await candidate).toBe(commitMove ? '23503' : 'recorded');
        if (commitMove) await moving.query(move, moveValues(demandId));
      }
    } finally {
      await Promise.allSettled([
        writing.query('rollback'),
        moving.query('rollback'),
      ]);
      writing.release();
      moving.release();
    }
    await owner.query(`revoke insert (project_id,session_id,bucket_sha256,journal_name,through_byte,sha256)
      on audit.session_log_anchor from rdws_test_anchor_writer`);
    expect(await host('record', 2)).toEqual({
      status: 'database-unauthorized',
    });
    expect(await host('verify')).toEqual({
      status: 'matched',
      throughByte: cutoff,
    });
    await runMigration(fixtureHome, ownerDsn, true);
    expect(await host('record', 2)).toEqual({
      status: 'database-unauthorized',
    });
    expect(await host('verify')).toEqual({
      status: 'matched',
      throughByte: cutoff,
    });
    await expect(
      owner.query('delete from native_session where id=$1', [real.sessionId]),
    ).rejects.toMatchObject({ code: '23503' });
    expect(await readFile(journalFile)).toEqual(real.bytes);
    await Promise.all(pools.splice(0).map((pool) => pool.end()));
    await docker('restart', '--time', '10', container);
    const restartedAddress = (
      await docker('port', container, '5432/tcp')
    ).stdout.trim();
    expect(restartedAddress).toMatch(/^127\.0\.0\.1:[1-9][0-9]*$/);
    await waitDatabase(
      makePool(
        dsn(bootstrapRole, bootstrapPassword, 'postgres', restartedAddress),
      ),
    );
    expect(await runVerifier('verify')).toEqual({
      status: 'matched',
      throughByte: cutoff,
    });
  } finally {
    await Promise.all(pools.map((pool) => pool.end()));
    if (container) await docker('rm', '-fv', container).catch(() => {});
    if (network) await docker('network', 'rm', network).catch(() => {});
    await rm(fixture, { recursive: true, force: true });
  }
}, 85_000);
