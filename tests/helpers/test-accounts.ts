import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeHome } from '@rdws/runtime-config';

type TestAccount = { username: string; password: string };

export async function readTestAccounts(): Promise<TestAccount[]> {
  return JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  ) as TestAccount[];
}
