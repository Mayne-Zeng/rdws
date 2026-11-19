import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { runtimeHome } from '@rdws/runtime-config';
await mkdir(join(runtimeHome, 'secrets'), { recursive: true, mode: 0o700 });
for (const dir of [
  'config',
  'runtime/instances',
  'runtime/cache',
  'state/exports',
])
  await mkdir(join(runtimeHome, dir), { recursive: true, mode: 0o700 });
const marker = join(runtimeHome, 'secrets', 'development.env');
try {
  await access(marker);
  console.log('Local configuration already exists; credentials preserved.');
  process.exit(0);
} catch {
  /* Initial setup only. */
}
const secret = () => randomBytes(32).toString('hex');
const admin = secret(),
  migration = secret(),
  app = secret(),
  testMigration = secret(),
  testApp = secret();
const port = process.env.RDWS_PG_PORT || '55432';
const url = (role, password, db) =>
  `postgresql://${role}:${password}@127.0.0.1:${port}/${db}`;
await writeFile(join(runtimeHome, 'secrets', 'postgres-password'), admin, {
  mode: 0o600,
  flag: 'wx',
});
await writeFile(
  join(runtimeHome, 'secrets', 'bootstrap.env'),
  `DATABASE_ADMIN_URL=${url('rdws_bootstrap', admin, 'postgres')}
DEV_MIGRATION_PASSWORD=${migration}
DEV_APP_PASSWORD=${app}
TEST_MIGRATION_PASSWORD=${testMigration}
TEST_APP_PASSWORD=${testApp}
`,
  { mode: 0o600, flag: 'wx' },
);
for (const [
  mode,
  database,
  migrator,
  migratorPassword,
  application,
  applicationPassword,
] of [
  ['development', 'rdws_dev', 'rdws_migrator', migration, 'rdws_app', app],
  [
    'test',
    'rdws_test',
    'rdws_test_migrator',
    testMigration,
    'rdws_test_app',
    testApp,
  ],
]) {
  const accounts = ['admin', 'pm', 'manager', 'lead', 'dev', 'tester'].map(
    (username) => ({ username, password: secret() }),
  );
  await writeFile(
    join(runtimeHome, 'secrets', `${mode}-accounts.json`),
    JSON.stringify(accounts, null, 2),
    { mode: 0o600, flag: 'wx' },
  );
  await writeFile(
    join(runtimeHome, 'secrets', `${mode}.env`),
    `DATABASE_URL=${url(application, applicationPassword, database)}
DATABASE_MIGRATION_URL=${url(migrator, migratorPassword, database)}
BETTER_AUTH_SECRET=${secret()}
RDWS_ORIGIN=http://127.0.0.1:5173
RDWS_PG_PORT=${port}
`,
    { mode: 0o600, flag: 'wx' },
  );
}
console.log(
  'Private local configuration created. Account credentials remain in RDWS_HOME/secrets.',
);
