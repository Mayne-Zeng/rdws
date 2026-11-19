import { expect, test, type Page } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

async function login(page: Page, origin: string, username: string) {
  const accounts: { username: string; password: string }[] =
    await readTestAccounts();
  await prepareSession(
    page.context(),
    origin,
    accounts.find((account) => account.username === username)!,
  );
}

test('design deep links require login and use live theme and layout without business requests', async ({
  page,
  baseURL,
}) => {
  const businessRequests: string[] = [];
  const errors: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/') && !path.startsWith('/api/auth/'))
      businessRequests.push(path);
  });
  page.on('pageerror', (error) => errors.push(error.message));
  const heading = page.getByRole('heading', { name: '设计系统', exact: true });
  await page.goto('/?view=design');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  await expect(heading).toHaveCount(0);

  await login(page, baseURL!, 'dev');
  await page.reload();
  await expect(heading).toBeVisible();
  for (const state of ['加载', '空态', '忙碌', '无权', '失败与重试'])
    await expect(
      page.getByRole('heading', { name: state, exact: true }),
    ).toBeVisible();
  await expect(page.getByRole('button', { name: '处理中' })).toBeDisabled();
  await mkdir('.impeccable/review/t20', { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'theme-mode',
      colorScheme,
    );
    const brand = page.getByTestId('design-token-brand');
    await expect(brand).toHaveText(
      colorScheme === 'light' ? '#0e7490' : '#48b6d1',
    );
    expect(
      await brand.evaluate(
        (el) =>
          getComputedStyle(el.closest('li')!.firstElementChild!)
            .backgroundColor,
      ),
    ).toBe(colorScheme === 'light' ? 'rgb(14, 116, 144)' : 'rgb(72, 182, 209)');
    for (const width of [1440, 1024, 820, 390, 320]) {
      await page.setViewportSize({ width, height: 900 });
      const control = page.getByTestId('design-token-control-h');
      await expect(control).toHaveText(width <= 620 ? '40px' : '30px');
      await expect(
        page.locator('.design-breakpoints [aria-current=true]'),
      ).toContainText(
        width <= 620 ? '离屏导航' : width <= 820 ? '图标侧栏' : '展开侧栏',
      );
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBeLessThanOrEqual(width);
      expect(
        await page
          .locator('.design-page .workspace-scroll')
          .evaluate((el) => el.scrollWidth <= el.clientWidth),
      ).toBe(true);
      const retry = page.getByRole('button', { name: '重试示例' });
      expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(
        width <= 620 ? 40 : 30,
      );
      if (
        (colorScheme === 'light' && width === 1440) ||
        (colorScheme === 'dark' && width === 390)
      ) {
        await page.screenshot({
          path: `.impeccable/review/t20/design-${colorScheme}-${width}.png`,
          animations: 'disabled',
        });
        await page.getByRole('region', { name: '组件状态' }).screenshot({
          path: `.impeccable/review/t20/states-${colorScheme}-${width}.png`,
          animations: 'disabled',
        });
        await heading.scrollIntoViewIfNeeded();
      }
    }
  }
  const retry = page.getByRole('button', { name: '重试示例' });
  await page.getByRole('button', { name: '退出登录' }).focus();
  await page.keyboard.press('Tab');
  await expect(retry).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: '示例已恢复' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: '重置示例' })).toBeFocused();
  expect(businessRequests).toEqual([]);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page.getByRole('heading', { name: '需求管理' })).toBeVisible();
  await page.getByRole('button', { name: '打开导航' }).click();
  const openDesign = page.getByRole('button', {
    name: '设计系统',
    exact: true,
  });
  expect((await openDesign.boundingBox())!.height).toBeGreaterThanOrEqual(40);
  await openDesign.press('Enter');
  await expect(heading).toBeFocused();
  await expect(page).toHaveTitle('RDWS · 设计系统');
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(page).toHaveURL(/project=poc$/);
  await expect(page).toHaveTitle('RDWS · 研发工作台');
  await expect(page.getByRole('heading', { name: '需求管理' })).toBeVisible();
  await page.goBack();
  await expect(heading).toBeVisible();
  await page.getByRole('button', { name: '退出登录' }).click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
});

test('the collapsed sidebar distinguishes design from project administration', async ({
  page,
  baseURL,
}) => {
  await login(page, baseURL!, 'pm');
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto('/?project=poc');
  const design = page.getByRole('button', { name: '设计系统', exact: true });
  const members = page.getByRole('button', { name: '成员与权限', exact: true });
  await expect(members).toBeVisible();
  await expect(design).toHaveAttribute('title', '设计系统');
  expect(await design.locator('path').getAttribute('d')).not.toBe(
    await members.locator('path').getAttribute('d'),
  );
});

test('authenticated accounts with an empty project list can open design from their landing page', async ({
  page,
  baseURL,
}) => {
  await login(page, baseURL!, 'dev');
  await page.route('**/api/projects', (route) =>
    route.fulfill({ json: { projects: [] } }),
  );
  await page.goto('/');
  const empty = page.getByRole('heading', { name: '尚未分配项目' });
  await expect(empty).toBeVisible();
  await page.getByRole('button', { name: '设计系统', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '设计系统', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '返回工作台' }).click();
  await expect(empty).toBeVisible();
});

test('platform design entry observes the management command lock', async ({
  page,
  baseURL,
}) => {
  await login(page, baseURL!, 'admin');
  await page.goto('/?view=platform');
  const design = page.getByRole('button', { name: '设计系统', exact: true });
  await design.click();
  await expect(
    page.getByRole('heading', { name: '设计系统', exact: true }),
  ).toBeVisible();
  await page.goto('/?view=platform');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/management/commands', async (route) => {
    await pending;
    await route.fulfill({
      status: 503,
      json: { error: 'Synthetic unknown result' },
    });
  });
  try {
    await page
      .getByLabel('项目标识', { exact: true })
      .fill('t20-navigation-fixture');
    await page.getByLabel('项目显示名', { exact: true }).fill('T20 导航夹具');
    await page.getByLabel('初始项目管理员登录名', { exact: true }).fill('pm');
    await page.getByRole('button', { name: '登记项目', exact: true }).click();
    await expect(design).toBeDisabled();
    release();
    await expect(
      page.getByRole('button', { name: '核对原管理操作' }),
    ).toBeEnabled();
    await expect(design).toBeDisabled();
    await expect(page).toHaveURL(/view=platform$/);
  } finally {
    release();
  }
});
