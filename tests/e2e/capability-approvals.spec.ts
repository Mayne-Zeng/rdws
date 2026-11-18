import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { Pool } from 'pg';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';

test('platform approval recovery reads the current retired version without resubmitting changed content', async ({
  page,
  baseURL,
}) => {
  const reference = `platform/browser-${randomUUID()}`;
  const accounts: { username: string; password: string }[] = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  );
  const migration = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const writes: { commandId: string; kind: string }[] = [];
  const retireId = randomUUID();
  const lateId = randomUUID();
  let failRead = false;
  try {
    await page.setViewportSize({ width: 390, height: 844 });
    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find(({ username }) => username === 'admin')!,
    );
    await page.route('**/api/management/capability-approvals', (route) =>
      failRead
        ? route.fulfill({
            status: 503,
            json: { error: 'Synthetic read failure' },
          })
        : route.continue(),
    );
    await page.route('**/api/management/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body.kind !== 'capability.approval') return route.continue();
      writes.push(body);
      if (writes.length !== 1) return route.continue();
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto('/?view=platform');
    const section = page.getByRole('region', { name: '平台能力白名单' });
    const row = section.getByRole('listitem').filter({ hasText: reference });
    async function fill(revision: string) {
      await section.getByLabel('能力类别').selectOption('skill');
      await section.getByLabel('来源／能力标识').fill(reference);
      await section.getByLabel('审核版本', { exact: true }).fill(revision);
      await section.getByRole('button', { name: '登记审核版本' }).click();
    }
    await fill('1.0.0');
    await expect(
      page.getByRole('button', { name: '核对原管理操作' }),
    ).toBeEnabled();
    await expect(
      section.getByRole('button', { name: '登记审核版本' }),
    ).toBeDisabled();
    const approval = {
      kind: 'capability.approval',
      capabilityKind: 'skill',
      reference,
      revision: '1.0.0',
    };
    const retired = await page.request.post('/api/management/commands', {
      headers: { origin: baseURL! },
      data: { ...approval, commandId: retireId, approved: false },
    });
    expect(retired.status()).toBe(200);
    expect((await retired.json()).changed).toBe(true);

    failRead = true;
    await page.reload();
    await page.getByRole('button', { name: '核对原管理操作' }).click();
    await expect(page.getByRole('status')).toContainText('原审核命令已核对');
    await expect(section.getByText(/白名单读取失败/)).toBeVisible();
    expect(writes).toHaveLength(2);
    expect(writes[1]).toEqual(writes[0]);
    failRead = false;
    await section.getByRole('button', { name: '重试读取白名单' }).click();
    await expect(row).toContainText('1.0.0 · 已停用');
    expect(writes).toHaveLength(2);

    const { user } = await (
      await page.request.get('/api/auth/get-session')
    ).json();
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
      {
        key: 'rdws:management:' + user.id,
        value: { ...approval, commandId: lateId, approved: true },
      },
    );
    await page.reload();
    await page.getByRole('button', { name: '核对原管理操作' }).click();
    await expect(page.getByRole('status')).toContainText('审核状态未变');
    await expect(row).toContainText('1.0.0 · 已停用');
    await expect(
      page.getByRole('button', { name: '核对原管理操作' }),
    ).toHaveCount(0);
    await fill('2.0.0');
    const active = row.filter({ hasText: '2.0.0' });
    await expect(active).toContainText('已登记');
    await section.screenshot({
      path: '.impeccable/review/t14-approvals-mobile.png',
    });
    await active.getByRole('button', { name: '停用审核版本' }).click();
    await expect(active).toContainText('已停用');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  } finally {
    await migration.query(
      'delete from capability_approval where reference=$1',
      [reference],
    );
    await migration.query(
      'delete from command_receipt where command_id=any($1::text[])',
      [[retireId, lateId, ...writes.map(({ commandId }) => commandId)]],
    );
    await migration.end();
  }
});
