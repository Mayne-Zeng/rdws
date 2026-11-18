import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeHome } from '../../scripts/env.mjs';
test('tasks, assignments and button stages follow the Demo workspace', async ({
  page,
}) => {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  async function login(name: string) {
    const account = accounts.find((a) => a.username === name)!;
    await page.goto('/');
    await page.getByLabel('账号', { exact: true }).fill(account.username);
    await page.getByLabel('密码', { exact: true }).fill(account.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      page.getByRole('navigation', { name: '项目导航' }),
    ).toBeVisible();
  }
  const title = '需求协作 ' + Date.now();
  await login('manager');
  await page.getByRole('button', { name: '新建需求', exact: true }).click();
  await page.getByLabel('需求标题', { exact: true }).fill(title);
  await page
    .getByLabel('需求描述', { exact: true })
    .fill('围绕当前需求协作并准确留痕');
  await page.getByLabel('验收标准', { exact: true }).fill('子任务与状态同步');
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  await page.getByLabel('dev · 开发人员', { exact: true }).check();
  await page.getByLabel('tester · 测试人员', { exact: true }).check();
  await page.getByRole('button', { name: '添加初始子任务' }).click();
  await page.getByLabel('子任务标题 1', { exact: true }).fill('实现查询接口');
  await page.getByRole('button', { name: '添加初始子任务' }).click();
  await page.getByLabel('子任务标题 2', { exact: true }).fill('补充查询验证');
  await page
    .getByLabel('子任务负责人 2', { exact: true })
    .selectOption({ label: 'dev' });
  await mkdir('.impeccable/review', { recursive: true });
  await page.screenshot({
    path: '.impeccable/review/form-initial-assignment.png',
    animations: 'disabled',
    fullPage: true,
  });
  await mkdir('.impeccable/review', { recursive: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator('.workspace-scroll').evaluate((el) => {
    el.scrollTop = 0;
  });
  await page
    .getByRole('heading', { name: '新建需求', exact: true })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: '.impeccable/review/form-requirement-1440.png',
    animations: 'disabled',
    fullPage: false,
  });
  await page.locator('.workspace-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await page
    .getByRole('button', { name: '创建需求', exact: true })
    .scrollIntoViewIfNeeded();
  await expect(
    page.getByRole('button', { name: '创建需求', exact: true }),
  ).toBeInViewport();
  await expect(
    page.getByLabel('子任务负责人 2', { exact: true }),
  ).toBeInViewport();
  await page.screenshot({
    path: '.impeccable/review/form-assignment-1440.png',
    animations: 'disabled',
    fullPage: false,
  });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  await expect(
    page.getByTestId('task-row').filter({ hasText: '实现查询接口' }),
  ).toContainText('lead');
  await expect(page.getByLabel('调整阶段', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '登录工作台', exact: true }),
  ).toBeVisible();
  await login('lead');
  await page.getByRole('button', { name: title, exact: true }).click();
  await page.getByLabel('调整阶段', { exact: true }).selectOption('testing');
  await expect(page.getByTestId('current-stage')).toHaveText('测试');
  await page
    .getByLabel('调整阶段', { exact: true })
    .selectOption('development');
  await expect(page.getByTestId('current-stage')).toHaveText('开发');
  await page
    .getByRole('button', { name: '编辑子任务 实现查询接口', exact: true })
    .click();
  await page
    .getByLabel('任务负责人', { exact: true })
    .selectOption({ label: 'dev' });
  await page.getByRole('button', { name: '保存子任务', exact: true }).click();
  await expect(
    page.getByTestId('task-row').filter({ hasText: '实现查询接口' }),
  ).toContainText('dev');
  await page.getByRole('tab', { name: '上下文', exact: true }).click();
  await expect(page.getByTestId('context-summary')).toContainText('开发');
  await expect(page.getByTestId('context-summary')).toContainText('dev');
  await mkdir('.impeccable/review', { recursive: true });
  const reference = await page.context().newPage();
  await reference.setViewportSize({ width: 1440, height: 900 });
  await reference.goto(
    'file://' + process.cwd() + '/demo/rdws-workbench.html#/overview/D-1042',
  );
  await reference.screenshot({
    animations: 'disabled',
    path: '.impeccable/review/demo-overview-1440.png',
    fullPage: true,
  });
  await reference.close();

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({
    path: '.impeccable/review/context-light-1440.png',
    fullPage: true,
  });
  await page.getByRole('tab', { name: '需求档案', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '主线流程', exact: true }),
  ).toBeVisible();
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [1440, 1024, 820, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 820)
        expect((await page.locator('.rail').boundingBox())!.width).toBe(64);
      if (width === 390) {
        expect(
          (await page.getByLabel('调整阶段', { exact: true }).boundingBox())!
            .height,
        ).toBeGreaterThanOrEqual(40);
        expect(
          (await page
            .getByRole('button', { name: '打开导航', exact: true })
            .boundingBox())!.height,
        ).toBeGreaterThanOrEqual(40);
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await page.screenshot({
        animations: 'disabled',
        path:
          '.impeccable/review/overview-' + colorScheme + '-' + width + '.png',
        fullPage: true,
      });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.emulateMedia({ colorScheme: 'light' });

  await page.getByRole('button', { name: '退出登录', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '登录工作台', exact: true }),
  ).toBeVisible();
  await login('dev');
  await page.getByRole('button', { name: title, exact: true }).click();
  await page
    .getByLabel('实现查询接口 状态', { exact: true })
    .selectOption('in_progress');
  await expect(
    page.getByLabel('实现查询接口 状态', { exact: true }),
  ).toHaveValue('in_progress');
  await expect(page.getByLabel('调整阶段', { exact: true })).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: '编辑子任务 实现查询接口', exact: true }),
  ).toHaveCount(0);
  for (const width of [1440, 1024, 820, 390]) {
    await page.setViewportSize({ width, height: 900 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
  expect(errors).toEqual([]);
});
