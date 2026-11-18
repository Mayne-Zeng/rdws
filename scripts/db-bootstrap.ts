import { Pool } from 'pg';
import { loadEnvironment } from './env.mjs';
loadEnvironment('bootstrap');
const pool = new Pool({ connectionString: process.env.DATABASE_ADMIN_URL });
try {
  for (const [
    database,
    migrator,
    migratorPassword,
    application,
    appPassword,
  ] of [
    [
      'rdws_dev',
      'rdws_migrator',
      process.env.DEV_MIGRATION_PASSWORD,
      'rdws_app',
      process.env.DEV_APP_PASSWORD,
    ],
    [
      'rdws_test',
      'rdws_test_migrator',
      process.env.TEST_MIGRATION_PASSWORD,
      'rdws_test_app',
      process.env.TEST_APP_PASSWORD,
    ],
  ]) {
    for (const [role, password] of [
      [migrator, migratorPassword],
      [application, appPassword],
    ]) {
      const found = await pool.query(
        'select 1 from pg_roles where rolname=$1',
        [role],
      );
      if (!found.rowCount) {
        const q = await pool.query(
          "select format('create role %I login nosuperuser nocreatedb nocreaterole password %L', $1::text, $2::text) as sql",
          [role, password],
        );
        await pool.query(q.rows[0].sql);
      }
    }
    const found = await pool.query(
      'select 1 from pg_database where datname=$1',
      [database],
    );
    if (!found.rowCount) {
      const q = await pool.query(
        "select format('create database %I owner %I', $1::text, $2::text) as sql",
        [database, migrator],
      );
      await pool.query(q.rows[0].sql);
    }
    const revoke = await pool.query(
      "select format('revoke connect on database %I from public', $1::text) as sql",
      [database],
    );
    await pool.query(revoke.rows[0].sql);
    const grant = await pool.query(
      "select format('grant connect on database %I to %I', $1::text, $2::text) as sql",
      [database, application],
    );
    await pool.query(grant.rows[0].sql);
  }
  console.log(
    'Isolated development/test databases and least-privilege roles are ready.',
  );
} finally {
  await pool.end();
}
