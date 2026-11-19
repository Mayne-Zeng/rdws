import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';
for (const colorScheme of ['light', 'dark'] as const) {
  test(`preset account login and logout (${colorScheme})`, async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const accounts: { username: string; password: string }[] = JSON.parse(
      await readFile(
        join(runtimeHome, 'secrets', 'test-accounts.json'),
        'utf8',
      ),
    );
    const lead = accounts.find((a) => a.username === 'lead')!;
    const photo = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname.endsWith('/login-studio.png') &&
        response.ok(),
    );
    await page.goto('/');
    await photo;
    await expect(
      page.getByRole('heading', { name: '登录工作台' }),
    ).toBeVisible();
    const placeholderContrast = await page
      .getByLabel('账号', { exact: true })
      .evaluate((el) => {
        const values = (s: string) => s.match(/[\d.]+/g)!.map(Number);
        const fg = values(getComputedStyle(el, '::placeholder').color),
          bg = values(getComputedStyle(el).backgroundColor);
        const alpha = fg[3] ?? 1;
        const composed = fg
          .slice(0, 3)
          .map((v, i) => v * alpha + bg[i]! * (1 - alpha));
        const lum = (rgb: number[]) =>
          rgb
            .slice(0, 3)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        return (
          (Math.max(lum(composed), lum(bg)) + 0.05) /
          (Math.min(lum(composed), lum(bg)) + 0.05)
        );
      });
    const login = page.locator('.login-screen');
    expect(await login.evaluate((el) => getComputedStyle(el).colorScheme)).toBe(
      'dark',
    );
    const form = page.getByRole('region', { name: '登录工作台', exact: true });
    expect((await form.boundingBox())!.x).toBeGreaterThan(720);
    expect(
      await form.evaluate((el) => getComputedStyle(el).backgroundColor),
    ).toBe('rgba(0, 0, 0, 0)');
    await expect(page.getByRole('button', { name: /切换.*主题/ })).toHaveCount(
      0,
    );
    await expect(page.getByLabel('账号', { exact: true })).toBeEnabled();
    expect(placeholderContrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/login-${colorScheme}.png` });
    await page.getByLabel('账号', { exact: true }).fill(lead.username);
    await page.getByLabel('密码', { exact: true }).fill(lead.password);
    await page.getByLabel('密码', { exact: true }).press('Enter');
    await expect(
      page.getByRole('heading', { name: '需求管理', exact: true }),
    ).toBeVisible();
    await expect(page.locator('html')).toHaveAttribute(
      'theme-mode',
      colorScheme,
    );
    await expect(login).toHaveCount(0);
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '需求管理', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.nav-item .count').first()).toHaveText(/^\d+$/);
    const newRequirement = page.getByRole('button', {
      name: '新建需求',
      exact: true,
    });
    await page.setViewportSize({ width: 1440, height: 844 });
    await expect(newRequirement).toHaveCount(0);
    await page.setViewportSize({ width: 820, height: 844 });
    await expect(newRequirement).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/workbench-${colorScheme}.png`,
    });
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await expect(newRequirement).toHaveCount(0);
    const contrast = await page
      .getByRole('button', { name: '退出登录' })
      .evaluate((button) => {
        const style = getComputedStyle(button);
        let ancestor: Element | null = button;
        let backgroundColor = 'rgb(255,255,255)';
        while (ancestor) {
          const color = getComputedStyle(ancestor).backgroundColor;
          const channels = color.match(/[\d.]+/g)!.map(Number);
          if ((channels[3] ?? 1) > 0) {
            backgroundColor = color;
            break;
          }
          ancestor = ancestor.parentElement;
        }
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return (
            0.2126 * channels[0]! +
            0.7152 * channels[1]! +
            0.0722 * channels[2]!
          );
        };
        const text = luminance(style.color),
          background = luminance(backgroundColor);
        return (
          (Math.max(text, background) + 0.05) /
          (Math.min(text, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(
      page.getByRole('heading', { name: '登录工作台' }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}

async function logoutTestAccount(username: string) {
  const accounts: { username: string; password: string }[] = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  );
  return accounts.find((entry) => entry.username === username)!;
}

for (const [username, heading] of [
  ['lead', '需求管理'],
  ['admin', '项目与账号'],
] as const) {
  test(`logout failure remains visible and retryable for ${username}`, async ({
    page,
    baseURL,
  }) => {
    const account = await logoutTestAccount(username);
    await prepareSession(page.context(), baseURL!, account);
    if (username === 'lead')
      await page.setViewportSize({ width: 390, height: 844 });
    const jar = () => page.context().cookies(baseURL);
    const sessionCookie = (await jar()).find(({ name }) =>
      name.endsWith('.session_token'),
    )!;
    expect(sessionCookie).toBeTruthy();
    let attempts = 0;
    await page.route('**/api/auth/sign-out', async (route) => {
      if (++attempts === 1)
        await route.fulfill({
          status: 503,
          json: { message: '退出登录暂未确认，请重试' },
          headers: { 'cache-control': 'no-store' },
        });
      else await route.continue();
    });
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: heading, exact: true }),
    ).toBeVisible();
    if (username === 'lead')
      await page.getByRole('button', { name: '打开导航' }).click();
    const logout = page.getByRole('button', { name: '退出登录', exact: true });
    await logout.click();
    const failed = page.getByText('退出失败，请重试', { exact: true });
    await expect(failed).toBeVisible();
    expect(
      await failed.evaluate((node) => Boolean(node.closest('[inert]'))),
    ).toBe(false);
    await expect(logout).toBeEnabled();
    expect(
      (await jar()).some(
        ({ name, value }) =>
          name === sessionCookie.name && value === sessionCookie.value,
      ),
    ).toBe(true);
    await logout.click();
    await expect(
      page.getByRole('heading', { name: '登录工作台' }),
    ).toBeVisible();
    expect(attempts).toBe(2);
    expect((await jar()).some(({ name }) => name === sessionCookie.name)).toBe(
      false,
    );
  });
}

test('retry from an old tab cannot sign out a replacement login', async ({
  page,
  baseURL,
}) => {
  const account = await logoutTestAccount('lead');
  const original = await prepareSession(page.context(), baseURL!, account);
  let attempts = 0;
  await page.route('**/api/auth/sign-out', async (route) => {
    expect(route.request().headers()['x-rdws-edit-session']).toBe(
      original.session.id,
    );
    if (++attempts === 1)
      await route.fulfill({
        status: 503,
        json: { message: 'Fixture unconfirmed result' },
      });
    else await route.continue();
  });
  await page.goto('/');
  const logout = page.getByRole('button', { name: '退出登录', exact: true });
  await logout.click();
  await expect(
    page.getByText('退出失败，请重试', { exact: true }),
  ).toBeVisible();
  const nextTab = await page.context().newPage();
  const replacement = await prepareSession(
    nextTab.context(),
    baseURL!,
    account,
  );
  expect(replacement.session.id).not.toBe(original.session.id);
  await nextTab.goto('/');
  await expect(
    nextTab.getByRole('heading', { name: '需求管理', exact: true }),
  ).toBeVisible();
  await page.bringToFront();
  const rejected = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/sign-out' &&
      response.status() === 401,
  );
  await logout.click();
  await rejected;
  await expect(
    page.getByText('登录已变化，请刷新后重试', { exact: true }),
  ).toBeVisible();
  const live = await nextTab.request.get('/api/auth/get-session');
  expect((await live.json()).session.id).toBe(replacement.session.id);
  expect(attempts).toBe(2);
});

test('a session refresh can confirm the browser is signed out and an explicit sign-in rebinds logout', async ({
  page,
  baseURL,
}) => {
  const account = await logoutTestAccount('lead');
  const original = await prepareSession(page.context(), baseURL!, account);
  const observations: (string | undefined)[] = [];
  await page.route('**/api/auth/sign-out', async (route) => {
    const request = route.request();
    observations.push(request.headers()['x-rdws-edit-session']);
    if (observations.length !== 1) return route.continue();
    const cookie = await request.headerValue('cookie');
    const confirmed = await fetch(request.url(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        origin: baseURL!,
        cookie: cookie!,
        'x-rdws-edit-session': original.session.id,
      },
      body: '{}',
    });
    expect(confirmed.status).toBe(200);
    await confirmed.text();
    await route.fulfill({
      status: 503,
      json: { message: 'Fixture confirmation unavailable' },
    });
  });
  await page.goto('/');
  const logout = page.getByRole('button', { name: '退出登录', exact: true });
  await logout.click();
  await expect(
    page.getByText('退出失败，请重试', { exact: true }),
  ).toBeVisible();
  await page.route(
    '**/api/auth/get-session',
    (route) =>
      route.fulfill({
        status: 503,
        json: { message: 'Fixture session read unavailable' },
      }),
    { times: 1 },
  );
  const unavailable = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/get-session' &&
      response.status() === 503,
  );
  const refreshFromFocus = async (secondsAhead: number) => {
    await page.clock.setFixedTime(new Date(Date.now() + secondsAhead * 1000));
    await page.evaluate(() =>
      document.dispatchEvent(new Event('visibilitychange')),
    );
  };
  await refreshFromFocus(10);
  await (await unavailable).finished();
  const noLogin = page.getByText(
    '此浏览器当前没有有效登录，原退出结果尚未确认。',
    {
      exact: true,
    },
  );
  await expect(noLogin).toHaveCount(0);
  const refresh = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/auth/get-session' &&
      response.status() === 200,
  );
  await refreshFromFocus(20);
  expect(await (await refresh).json()).toBeNull();
  await expect(noLogin).toBeVisible();

  await page.getByLabel('账号', { exact: true }).fill(account.username);
  const password = page.getByLabel('密码', { exact: true });
  await password.fill(account.password);
  const rebound = page.waitForEvent('framenavigated', {
    predicate: (frame) => frame === page.mainFrame(),
  });
  await password.press('Enter');
  await rebound;
  await expect(
    page.getByRole('heading', { name: '需求管理', exact: true }),
  ).toBeVisible();
  const fresh = (await (await page.request.get('/api/auth/get-session')).json())
    .session.id;
  expect(fresh).not.toBe(original.session.id);
  await logout.click();
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible();
  expect(observations).toEqual([original.session.id, fresh]);
});

test('mobile fixed-dark login guards real requests and exposes validation states', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ colorScheme: 'light' });
  let releaseSession!: () => void;
  let releaseLogin!: () => void;
  const sessionGate = new Promise<void>((resolve) => {
    releaseSession = resolve;
  });
  const loginGate = new Promise<void>((resolve) => {
    releaseLogin = resolve;
  });
  let requests = 0;
  let firstSession = true;
  await page.route('**/api/auth/get-session', async (route) => {
    if (firstSession) {
      firstSession = false;
      await sessionGate;
    }
    await route.continue();
  });
  await page.route('**/api/auth/sign-in/username', async (route) => {
    requests++;
    if (requests === 1) {
      await loginGate;
      await route.continue();
    } else {
      await route.fulfill({
        status: 503,
        json: { message: 'Synthetic login outage' },
      });
    }
  });
  try {
    await page.goto('/');
    const account = page.getByLabel('账号', { exact: true });
    const password = page.getByLabel('密码', { exact: true });
    await expect(page.getByRole('status')).toHaveText('正在读取登录状态…');
    await expect(page.getByRole('heading', { name: '登录工作台' })).toHaveCount(
      0,
    );
    await expect(account).toHaveCount(0);
    releaseSession();
    const login = page.getByRole('button', { name: '登录', exact: true });
    await expect(login).toBeEnabled();
    expect(
      await page
        .locator('.login-screen')
        .evaluate((el) => getComputedStyle(el).colorScheme),
    ).toBe('dark');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    expect((await login.boundingBox())!.height).toBeGreaterThanOrEqual(44);
    await page.screenshot({ path: 'test-results/login-mobile-dark.png' });

    await login.click();
    await expect(account).toBeFocused();
    await expect(account).toHaveAttribute('aria-invalid', 'true');
    await expect(password).toHaveAttribute('aria-invalid', 'true');
    await expect(page.getByText('请输入账号。', { exact: true })).toBeVisible();
    expect(requests).toBe(0);

    await account.fill('unknown_' + randomUUID().slice(0, 8));
    await password.fill('fixture-not-an-account-password');
    await page
      .getByRole('button', { name: '显示密码', exact: true })
      .press('Enter');
    await expect(password).toHaveAttribute('type', 'text');
    await page
      .getByRole('button', { name: '隐藏密码', exact: true })
      .press('Enter');
    await expect(password).toHaveAttribute('type', 'password');

    const rejected = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/sign-in/username' &&
        response.status() === 401,
    );
    await login.click();
    await expect(page.getByRole('button', { name: '登录中…' })).toBeDisabled();
    await expect(account).toBeDisabled();
    await expect(password).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '显示密码', exact: true }),
    ).toBeDisabled();
    await page
      .locator('.login-form')
      .evaluate((form) => (form as HTMLFormElement).requestSubmit());
    expect(requests).toBe(1);
    releaseLogin();
    await rejected;
    await expect(page.getByRole('alert')).toHaveText(
      '登录失败，请检查账号与密码。',
    );
    await expect(password).toBeFocused();
    await expect(login).toBeEnabled();

    await login.click();
    await expect(page.getByRole('alert')).toHaveText(
      '暂时无法连接登录服务，请稍后重试。',
    );
    expect(requests).toBe(2);
  } finally {
    releaseSession();
    releaseLogin();
  }
});
