import { Pool } from 'pg';

export function createTestPool(role: 'application' | 'migration') {
  const connectionString =
    role === 'application'
      ? process.env.DATABASE_URL
      : process.env.DATABASE_MIGRATION_URL;
  return new Pool({ connectionString });
}
