import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hashPassword } from 'better-auth/crypto';
import { eq } from 'drizzle-orm';
import { connectDatabase, schema } from '@rdws/db';
import { loadEnvironment, runtimeHome } from '@rdws/runtime-config';
const mode = process.env.RDWS_MODE || 'development';
loadEnvironment(mode);
const { pool, db } = connectDatabase(process.env.DATABASE_MIGRATION_URL!);
try {
  const accounts: { username: string; password: string }[] = JSON.parse(
    await readFile(
      join(runtimeHome, 'secrets', `${mode}-accounts.json`),
      'utf8',
    ),
  );
  await db
    .insert(schema.project)
    .values({ id: 'poc', name: 'RDWS PoC' })
    .onConflictDoNothing();
  const roles: Record<string, string> = {
    pm: 'project_admin',
    manager: 'requirement_manager',
    lead: 'developer',
    dev: 'developer',
    tester: 'tester',
  };
  for (const entry of accounts) {
    const found = await db
      .select()
      .from(schema.user)
      .where(eq(schema.user.username, entry.username));
    if (found.length) continue;
    const id = randomUUID();
    const password = await hashPassword(entry.password);
    await db.transaction(async (tx) => {
      await tx.insert(schema.user).values({
        id,
        name: entry.username,
        username: entry.username,
        displayUsername: entry.username,
        email: `${entry.username}@rdws.invalid`,
        emailVerified: true,
        platformAdmin: entry.username === 'admin',
      });
      await tx.insert(schema.account).values({
        id: randomUUID(),
        accountId: id,
        providerId: 'credential',
        userId: id,
        password,
      });
      const role = roles[entry.username];
      if (role)
        await tx
          .insert(schema.projectMember)
          .values({ projectId: 'poc', userId: id, role });
    });
  }
  console.log(
    'Preset accounts and PoC project seeded; existing passwords preserved.',
  );
} finally {
  await pool.end();
}
