import { test, expect } from 'vitest';
import { grantApplication } from '../../scripts/db-migrate.ts';
import { loadEnvironment } from '@rdws/runtime-config';
import { createTestPool } from '../helpers/test-pool.ts';
loadEnvironment('test');
test('failed privilege setup cannot leave audit update and delete rights committed', async () => {
  const pool = createTestPool('migration'),
    client = await pool.connect();
  const query = client.query.bind(client);
  let observed = true;
  const controlled = {
    query: ((...args: unknown[]) => {
      if (String(args[0]).startsWith('revoke'))
        return pool
          .query(
            "select has_table_privilege('rdws_test_app','requirement_event','UPDATE') allowed",
          )
          .then((r) => {
            observed = r.rows[0].allowed;
            throw new Error('Controlled revoke failure');
          });
      return Reflect.apply(query, client, args);
    }) as typeof client.query,
  };
  try {
    await expect(grantApplication(controlled, 'rdws_test_app')).rejects.toThrow(
      'Controlled revoke failure',
    );
    expect(observed).toBe(false);
    expect(
      (
        await pool.query(
          "select has_table_privilege('rdws_test_app','requirement_event','UPDATE') allowed",
        )
      ).rows[0].allowed,
    ).toBe(false);
  } finally {
    await client.query('rollback');
    await client.query(
      'revoke update,delete on requirement_event from rdws_test_app',
    );
    client.release();
    await pool.end();
  }
});
