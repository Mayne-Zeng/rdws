import { expect, test } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { runtimeHome } from '@rdws/runtime-config';
import { prepareSession } from '../helpers/auth-session.ts';

test('platform registers a project and the assigned administrator manages its members', async ({
  page,
  baseURL,
}) => {
  const project = 'team-' + randomUUID();
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const migration = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  async function login(name: string) {
    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find((row) => row.username === name)!,
    );
    await page.goto('/');
  }
  try {
    await login('admin');
    await expect(
      page.getByRole('heading', { name: '项目与账号', exact: true }),
    ).toBeVisible();
    await page.getByLabel('项目标识', { exact: true }).fill(project);
    await page.getByLabel('项目显示名', { exact: true }).fill('T03 浏览器验收');
    await page.getByLabel('初始项目管理员登录名', { exact: true }).fill('pm');
    await page.getByRole('button', { name: '登记项目', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: '已保存。' }),
    ).toBeVisible();
    await page.getByLabel('项目', { exact: true }).selectOption(project);
    await expect(
      page.getByText('原生运行未登记，请由维护者配置项目 Profile。', {
        exact: true,
      }),
    ).toBeVisible();
    await login('pm');
    await page.goto('/?project=unavailable-' + randomUUID() + '&view=members');
    await expect(
      page.getByRole('heading', { name: '无法访问指定项目', exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('成员登录名', { exact: true })).toHaveCount(0);
    await page
      .getByRole('button', { name: '返回可访问项目', exact: true })
      .click();

    await page.getByLabel('切换项目', { exact: true }).selectOption(project);
    await page.getByRole('button', { name: '成员与权限', exact: true }).click();
    await page.getByLabel('成员登录名', { exact: true }).fill('tester');
    await page.getByLabel('测试人员', { exact: true }).check();
    await page.getByLabel('开发人员', { exact: true }).check();
    await page
      .getByRole('button', { name: '保存成员角色', exact: true })
      .click();
    await expect(
      page.getByText('开发人员 · 测试人员', { exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '编辑 tester', exact: true })
      .click();
    await expect(page.getByLabel('测试人员', { exact: true })).toBeChecked();
    await page.getByLabel('开发人员', { exact: true }).uncheck();
    await page
      .getByRole('button', { name: '保存成员角色', exact: true })
      .click();
    await expect(
      page.getByText('开发人员 · 测试人员', { exact: true }),
    ).toHaveCount(0);
    let managementCalls = 0;
    await page.route('**/api/management/commands', async (route) => {
      managementCalls++;
      await route.continue();
    });
    await page.evaluate(() => {
      const original = Storage.prototype.setItem;
      Storage.prototype.setItem = function (name: string, value: string) {
        if (name.startsWith('rdws:management:'))
          throw new Error('Synthetic storage restriction');
        original.call(this, name, value);
      };
      window.addEventListener(
        'rdws-restore-storage',
        () => {
          Storage.prototype.setItem = original;
        },
        { once: true },
      );
    });
    await page
      .getByRole('button', { name: '保存成员角色', exact: true })
      .click();
    await expect(
      page.getByText('无法保存原管理命令。', { exact: false }),
    ).toBeVisible();
    expect(managementCalls).toBe(0);
    await page.evaluate(() =>
      window.dispatchEvent(new Event('rdws-restore-storage')),
    );
    await page.unroute('**/api/management/commands');
    let replyLost = false;
    const sent: string[] = [];
    await page.route('**/api/projects', async (route) => {
      if (replyLost && sent.length === 1)
        await route.fulfill({
          status: 401,
          json: { error: '模拟权限等待核对' },
        });
      else await route.continue();
    });
    await page.route('**/api/management/commands', async (route) => {
      sent.push(route.request().postData()!);
      if (!replyLost) {
        replyLost = true;
        await route.fulfill({
          status: 503,
          json: { error: '模拟管理命令未知' },
        });
      } else await route.continue();
    });
    await page
      .getByRole('button', { name: '保存成员角色', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: '核对原管理操作', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '核对管理操作', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: '核对原管理操作', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: '成员与权限', exact: true }),
    ).toBeVisible();
    expect(sent).toHaveLength(2);
    expect(sent[1]).toBe(sent[0]);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect(
      page.getByRole('heading', { name: '成员与权限', exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(390);
    expect(errors).toEqual([]);
  } finally {
    await migration.query('delete from project_member where project_id=$1', [
      project,
    ]);
    await migration.query('delete from project where id=$1', [project]);
    await migration.end();
  }
});
