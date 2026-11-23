import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { Pool } from 'pg';

const exec = promisify(execFile);
const random = () => randomBytes(32).toString('hex');

export async function authorityDatabase(
  dockerHost?: string,
  beforeMigrate?: (owner: Pool, root: string) => Promise<void>,
) {
  const dockerEnv = { ...process.env };
  if (dockerHost !== undefined) {
    if (!dockerHost.startsWith('unix:///'))
      throw new Error('The fixture Docker endpoint must be a local socket');
    delete dockerEnv.DOCKER_CONTEXT;
    dockerEnv.DOCKER_HOST = dockerHost;
  }
  const image = /^\s*image: (postgres:\S+@sha256:[a-f0-9]{64})$/m.exec(
    await readFile('deploy/compose.postgres.yml', 'utf8'),
  )?.[1];
  if (!image) throw new Error('Missing pinned PostgreSQL image');
  const root = await mkdtemp(join(tmpdir(), 'rdws-authority-db-'));
  const name = 'rdws-authority-' + randomUUID();
  const password = random();
  let created = false;
  let stage = 'container startup';
  let admin: Pool | undefined;
  let owner: Pool | undefined;
  async function close() {
    try {
      await Promise.all([owner?.end(), admin?.end()]);
    } finally {
      try {
        if (created)
          await exec('docker', ['stop', '-t', '2', name], { env: dockerEnv });
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  }
  try {
    await exec(
      'docker',
      [
        'run',
        '--detach',
        '--rm',
        '--pull=never',
        '--name',
        name,
        '--publish',
        '127.0.0.1::5432',
        '--env',
        'POSTGRES_PASSWORD',
        '--env',
        'POSTGRES_DB=rdws_test',
        image,
        '-c',
        'log_statement=all',
        '-c',
        'log_parameter_max_length=0',
        '-c',
        'log_parameter_max_length_on_error=0',
        '-c',
        'shared_preload_libraries=auto_explain',
        '-c',
        'rdws.fixture_instance=' + name,
      ],
      { env: { ...dockerEnv, POSTGRES_PASSWORD: password } },
    );
    created = true;
    const mapping = (
      await exec('docker', ['port', name, '5432/tcp'], { env: dockerEnv })
    ).stdout.trim();
    const port = /^127\.0\.0\.1:(\d+)$/.exec(mapping)?.[1];
    if (!port)
      throw new Error(
        'Authority database did not bind a private loopback port',
      );
    stage = 'server readiness';
    const url = (user: string, secret: string) =>
      `postgresql://${user}:${secret}@127.0.0.1:${port}/rdws_test`;
    admin = new Pool({
      connectionString: url('postgres', password),
      connectionTimeoutMillis: 1_000,
    });
    admin.on('error', () => {});
    const startupDeadline = Date.now() + 15_000;
    while (
      !(await admin.query('select 1').then(
        () => true,
        () => false,
      ))
    ) {
      if (Date.now() >= startupDeadline)
        throw new Error('PostgreSQL did not become ready');
      await delay(100);
    }
    const migrationPassword = random();
    const appPassword = random();
    stage = 'fixture roles';
    const bootstrap = await admin.connect();
    try {
      const { rows } = await bootstrap.query<{ matches: boolean }>(
        `select current_setting('rdws.fixture_instance', true) = $1
          and current_database() = 'rdws_test' and session_user = 'postgres' as matches`,
        [name],
      );
      if (rows[0]?.matches !== true)
        throw new Error('Disposable PostgreSQL identity was not confirmed');
      await bootstrap.query(
        "set log_statement='none'; set log_min_error_statement='panic'",
      );
      await bootstrap.query(
        `create role rdws_test_migrator login password '${migrationPassword}'`,
      );
      await bootstrap.query(
        `create role rdws_test_app login password '${appPassword}'`,
      );
      await bootstrap.query(
        'alter database rdws_test owner to rdws_test_migrator',
      );
      await bootstrap.query('revoke connect on database rdws_test from public');
      await bootstrap.query(
        'grant connect on database rdws_test to rdws_test_app',
      );
    } finally {
      bootstrap.release();
    }
    const databaseUrl = url('rdws_test_app', appPassword);
    const migrationUrl = url('rdws_test_migrator', migrationPassword);
    const childEnv = {
      PATH: process.env.PATH,
      RDWS_MODE: 'test',
      RDWS_HOME: root,
      DATABASE_URL: databaseUrl,
      BETTER_AUTH_SECRET: random(),
      RDWS_ORIGIN: 'http://127.0.0.1:5317',
    };
    await mkdir(join(root, 'secrets'), { mode: 0o700 });
    await writeFile(join(root, 'secrets/test.env'), '', { mode: 0o600 });
    const migrate = () =>
      exec(process.execPath, ['--import', 'tsx', 'scripts/db-migrate.ts'], {
        env: { ...childEnv, DATABASE_MIGRATION_URL: migrationUrl },
        timeout: 20_000,
      });
    owner = new Pool({ connectionString: migrationUrl });
    if (beforeMigrate) {
      stage = 'fixture migration baseline';
      await beforeMigrate(owner, root);
    }
    stage = 'project migration';
    await migrate();
    return {
      admin,
      owner,
      databaseUrl,
      childEnv,
      migrate,
      root,
      close,
      async logs() {
        const result = await exec('docker', ['logs', name], {
          env: dockerEnv,
          maxBuffer: 4 * 1024 * 1024,
        });
        return result.stdout + result.stderr;
      },
      // Silent-loss injection (§11.20.25 phase 4): freeze and thaw the whole
      // instance without any TCP-level RST or FIN.
      pause: () => exec('docker', ['pause', name], { env: dockerEnv }),
      resume: () => exec('docker', ['unpause', name], { env: dockerEnv }),
    };
  } catch {
    await close();
    throw new Error(
      `Disposable authority database setup failed during ${stage}`,
    );
  }
}
