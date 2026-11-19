import { expect, test } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('platform account audit reads genuine changes and keeps its original login', async ({
  page,
  baseURL,
}, testInfo) => {
  const db = createTestPool('migration');
  const id = randomUUID();
  const username = 'u' + id.slice(0, 12).replaceAll('-', '');
  const name = '=账号状态审计 ' + username;
  const stop = randomUUID();
  const restore = randomUUID();
  const path = '/api/management/platform/account-audit';
  let isolated = false;
  let releaseAuth: (() => void) | undefined;
  try {
    expect(
      (await db.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    await db.query(
      'insert into auth_user(id,name,email,username) values($1,$2,$3,$4)',
      [id, name, username + '@example.invalid', username],
    );
    const accounts = await readTestAccounts();
    const admin = accounts.find(({ username }) => username === 'admin')!;
    const original = await prepareSession(page.context(), baseURL!, admin);
    for (const [active, commandId] of [
      [false, stop],
      [true, restore],
    ] as const) {
      const changed = await page.request.post('/api/management/commands', {
        headers: { origin: baseURL! },
        data: { kind: 'account.active', username, active, commandId },
      });
      expect(changed.status()).toBe(200);
    }
    const logins: string[] = [];
    let unavailable = false;
    await page.route(`**${path}*`, async (route) => {
      logins.push(route.request().headers()['x-rdws-edit-session'] ?? '');
      if (unavailable)
        return route.fulfill({
          status: 503,
          json: { error: 'Synthetic read failure' },
        });
      return route.continue();
    });
    await page.goto('/?view=platform');
    const panel = page.getByText('账号状态记录', { exact: true });
    const list = page.getByRole('list', { name: '账号状态审计事件' });
    const entry = list.getByText('停用账号 · ' + name, { exact: true });
    const disabled = list.getByRole('listitem').filter({
      has: page.getByText('停用账号 · ' + name, { exact: true }),
    });
    const download = page.getByRole('button', { name: '导出当前页 CSV' });
    await expect(panel).toBeVisible();
    expect(logins).toEqual([]);
    await panel.click();
    await entry.click();
    await expect(disabled.getByText('变更前状态 有效')).toBeVisible();
    await expect(disabled.getByText('变更后状态 已停用')).toBeVisible();
    await expect(
      list.getByText('恢复账号 · ' + name, { exact: true }),
    ).toBeVisible();
    await expect(disabled.getByText('操作标识 ' + stop)).toBeVisible();
    const requested = page.waitForEvent('download');
    await download.click();
    const csv = await requested;
    expect(csv.suggestedFilename()).toBe('platform-account-audit.csv');
    const contents = await readFile(await csv.path(), 'utf8');
    expect(contents).toContain(`"'${name}"`);
    expect(contents).toContain(`"有效","已停用","${stop}"`);
    expect(contents).toContain(`"已停用","有效","${restore}"`);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await disabled.screenshot({
      path: testInfo.outputPath('platform-account-audit-light-390.png'),
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    await disabled.screenshot({
      path: testInfo.outputPath('platform-account-audit-dark-390.png'),
    });
    await page.setViewportSize({ width: 1280, height: 820 });

    unavailable = true;
    await panel.click();
    await expect(list).toHaveCount(0);
    await panel.click();
    const failure = page.getByText('读取账号状态记录失败，请重试。', {
      exact: true,
    });
    await expect(failure).toBeVisible();
    await expect(download).toHaveCount(0);
    await expect(entry).toHaveCount(0);
    unavailable = false;
    await page.getByRole('button', { name: '重试读取账号状态记录' }).click();
    await expect(entry).toBeVisible();

    const hold = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    await page.route('**/api/auth/get-session', async (route) => {
      await hold;
      await route.continue();
    });
    const replacement = await prepareSession(page.context(), baseURL!, admin);
    expect(replacement.user.id).toBe(original.user.id);
    expect(replacement.session.id).not.toBe(original.session.id);
    const oldResult = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.status() === 401,
    );
    await panel.click();
    await expect(list).toHaveCount(0);
    await panel.click();
    expect((await oldResult).request().headers()['x-rdws-edit-session']).toBe(
      original.session.id,
    );
    await expect(failure).toBeVisible();
    await expect(download).toHaveCount(0);
    await expect(entry).toHaveCount(0);
    const observed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/get-session' &&
        response.status() === 200,
    );
    releaseAuth?.();
    await page.clock.setFixedTime(new Date(Date.now() + 10_000));
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
    expect((await (await observed).json()).session.id).toBe(
      replacement.session.id,
    );
    await expect(panel).toHaveCount(0);
    await expect(download).toHaveCount(0);
    expect(logins.every((login) => login === original.session.id)).toBe(true);
    await page.reload();
    await panel.click();
    await expect(entry).toBeVisible();
    expect(logins.at(-1)).toBe(replacement.session.id);

    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find(({ username }) => username === 'pm')!,
    );
    await page.goto('/?view=platform');
    await expect(page.getByRole('heading', { name: '需求管理' })).toBeVisible();
    await expect(panel).toHaveCount(0);
  } finally {
    releaseAuth?.();
    try {
      if (isolated) {
        await db.query(
          "delete from command_receipt where scope='platform' and operation='account.active' and command_id=any($1::text[])",
          [[stop, restore]],
        );
        await db.query('delete from auth_user where id=$1', [id]);
      }
    } finally {
      await db.end();
    }
  }
});

test('platform registers a project and the assigned administrator manages its members', async ({
  page,
  baseURL,
}) => {
  const project = 'team-' + randomUUID();
  const accounts = await readTestAccounts();
  const migration = createTestPool('migration');
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
