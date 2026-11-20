import { randomUUID } from 'node:crypto';
import { expect, test, type APIRequestContext } from '@playwright/test';
import { connectDatabase, schema } from '@rdws/db';
import { and, eq } from 'drizzle-orm';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

async function createRequirement(request: APIRequestContext, origin: string) {
  const title = 'Fleet ' + randomUUID();
  const { members } = await (
    await request.get('/api/projects/poc/members')
  ).json();
  const response = await request.post('/api/projects/poc/requirements', {
    headers: { origin },
    data: {
      commandId: randomUUID(),
      title,
      description: 'Synthetic fleet fixture',
      acceptance: 'Scoped read-only history',
      leadId: members.find((member: { name: string }) => member.name === 'lead')
        .id,
      participants: [],
    },
  });
  expect(response.status()).toBe(200);
  const { id } = await response.json();
  return { id: String(id), title, path: `/api/requirements/${id}/sessions` };
}

async function createSession(
  request: APIRequestContext,
  origin: string,
  path: string,
  login: string,
) {
  const response = await request.post(path, {
    headers: { origin, 'x-rdws-edit-session': login },
    data: { commandId: randomUUID() },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).sessionId as string;
}

test('the requirement fleet opens five real sessions and reads only the selected history', async ({
  baseURL,
  browser,
  page,
}) => {
  const origin = baseURL!;
  const accounts = await readTestAccounts();
  const manager = await prepareSession(
    page.context(),
    origin,
    accounts.find(({ username }) => username === 'manager')!,
  );
  const fleet = await createRequirement(page.request, origin);
  const originals: string[] = [];
  for (let index = 0; index < 4; index++)
    originals.push(
      await createSession(page.request, origin, fleet.path, manager.session.id),
    );
  const lead = await browser.newContext({ baseURL });
  let other: string;
  try {
    const login = await prepareSession(
      lead,
      origin,
      accounts.find(({ username }) => username === 'lead')!,
    );
    other = await createSession(
      lead.request,
      origin,
      fleet.path,
      login.session.id,
    );
  } finally {
    await lead.close();
  }
  const derived = originals[3]!;
  const database = connectDatabase(process.env.DATABASE_URL!);
  try {
    await database.db
      .update(schema.nativeSession)
      .set({ sourceSessionId: originals[0]!, sourceThroughSeq: 0 })
      .where(
        and(
          eq(schema.nativeSession.requirementId, fleet.id),
          eq(schema.nativeSession.id, derived),
        ),
      );
  } finally {
    await database.pool.end();
  }
  const listed = await page.request.get(fleet.path, {
    headers: { 'x-rdws-edit-session': manager.session.id },
  });
  expect(listed.status()).toBe(200);
  const { sessions } = (await listed.json()) as {
    sessions: { id: string; own: boolean }[];
  };
  expect(sessions.map(({ id }) => id)).toEqual([...originals, other]);
  expect(sessions.map(({ own }) => own)).toEqual([
    true,
    true,
    true,
    true,
    false,
  ]);

  const native: string[] = [];
  const history: string[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/dsh/')) native.push(url.pathname);
    if (
      url.pathname.startsWith(fleet.path) &&
      url.pathname.endsWith('/history')
    )
      history.push(url.pathname + url.search);
  });
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname.startsWith('/api/dsh/'))
      native.push(socket.url());
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/?project=poc&view=overview&requirement=${fleet.id}`);
  const tab = page.getByRole('tab', { name: '编队', exact: true });
  await page.getByRole('tab', { name: '上下文', exact: true }).focus();
  await page.keyboard.press('End');
  await expect(tab).toBeFocused();
  await expect(tab).toHaveAttribute('aria-selected', 'true');
  const list = page.getByRole('list', { name: '编队会话列表' });
  const rows = list.getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.nth(3)).toContainText(
    '本人 · 派生会话 · 源会话 1 · 源事件 0',
  );
  await expect(rows.nth(4)).toContainText('其他成员 · 原始会话');
  expect(history).toEqual([]);
  expect(native).toEqual([]);

  const replay = page.getByRole('button', { name: '回放会话 4', exact: true });
  const playback = page.getByRole('region', { name: '会话历史回放' });
  const path = `${fleet.path}/${derived}/history`;
  const reply = page.waitForResponse(
    (response) => new URL(response.url()).pathname === path,
  );
  await replay.focus();
  await replay.press('Enter');
  await expect(replay).toHaveAttribute('aria-expanded', 'true');
  const response = await reply;
  expect(response.status()).toBe(200);
  expect(response.request().headers()['x-rdws-edit-session']).toBe(
    manager.session.id,
  );
  const { cursor } = await response.json();
  await expect(playback).toContainText(
    cursor < 0 ? '空历史' : `固定至事件 ${cursor}`,
  );
  for (const [width, colorScheme] of [
    [390, 'light'],
    [390, 'dark'],
    [320, 'dark'],
    [1440, 'light'],
  ] as const) {
    await page.setViewportSize({ width, height: 900 });
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'theme-mode',
      colorScheme,
    );
    expect((await replay.boundingBox())!.height).toBeGreaterThanOrEqual(
      width <= 620 ? 40 : 30,
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBeLessThanOrEqual(width);
    const tabs = await page.getByRole('tablist').boundingBox();
    const selected = await tab.boundingBox();
    expect(selected!.x + selected!.width).toBeLessThanOrEqual(
      tabs!.x + tabs!.width,
    );
    await page.locator('.workspace-main').screenshot({
      path: `.impeccable/review/t07-fleet/${colorScheme}-${width}.png`,
      animations: 'disabled',
    });
  }
  await replay.press('Enter');
  await expect(playback).toHaveCount(0);
  expect([...new Set(history)]).toEqual([path]);
  expect(native).toEqual([]);
});

test('fleet discards a late requirement response and clears an active replay when access changes', async ({
  baseURL,
  page,
}) => {
  const origin = baseURL!;
  const accounts = await readTestAccounts();
  const account = accounts.find(({ username }) => username === 'manager')!;
  const original = await prepareSession(page.context(), origin, account);
  const first = await createRequirement(page.request, origin);
  const second = await createRequirement(page.request, origin);
  const empty = await createRequirement(page.request, origin);
  await createSession(page.request, origin, first.path, original.session.id);
  await createSession(page.request, origin, first.path, original.session.id);
  const target = await createSession(
    page.request,
    origin,
    second.path,
    original.session.id,
  );
  let firstEntered!: () => void;
  let releaseFirst!: () => void;
  const waiting = new Promise<void>((resolve) => {
    firstEntered = resolve;
  });
  const released = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  await page.route(
    (url) => url.pathname === first.path,
    async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      firstEntered();
      await released;
      await route.fulfill({ response }).catch(() => {});
    },
  );
  let failSecond = true;
  let failRequirements = false;
  let denyHistory = false;
  const historyPath = `${second.path}/${target}/history`;
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (failRequirements && route.request().method() === 'GET')
      await route.fulfill({
        status: 503,
        json: { error: 'Synthetic requirement read failure' },
      });
    else await route.continue();
  });
  await page.route(
    (url) => url.pathname === historyPath,
    async (route) => {
      if (denyHistory)
        await route.fulfill({
          status: 403,
          json: { error: 'Synthetic history authorization change' },
        });
      else await route.continue();
    },
  );
  await page.route(
    (url) => url.pathname === second.path,
    async (route) => {
      if (failSecond)
        await route.fulfill({
          status: 503,
          json: { error: 'Synthetic fleet read failure' },
        });
      else await route.continue();
    },
  );
  try {
    await page.goto(`/?project=poc&view=fleet&requirement=${first.id}`);
    await waiting;
    await expect(
      page.getByText('正在读取会话列表', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: second.title, exact: true }).click();
    await expect(page).toHaveURL(
      new RegExp(`view=fleet&requirement=${second.id}`),
    );
    const list = page.getByRole('list', { name: '编队会话列表' });
    await expect(page.getByText('读取会话列表失败，请重试。')).toBeVisible();
    await expect(list).toHaveCount(0);
    failSecond = false;
    await page.getByRole('button', { name: '重试读取会话列表' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    releaseFirst();
    const reply = page.waitForResponse(
      (response) => new URL(response.url()).pathname === historyPath,
    );
    const replay = page.getByRole('button', {
      name: '回放会话 1',
      exact: true,
    });
    await replay.click();
    expect((await reply).status()).toBe(200);
    const playback = page.getByRole('region', { name: '会话历史回放' });
    await expect(playback).toContainText('已加载至历史起点');
    await expect(list.getByRole('listitem')).toHaveCount(1);
    failSecond = true;
    await expect(page.getByText('读取会话列表失败，请重试。')).toBeVisible();
    await expect(playback).toHaveCount(0);
    await expect(list).toHaveCount(0);
    failSecond = false;
    await page.getByRole('button', { name: empty.title, exact: true }).click();
    await expect(page.getByText('当前需求暂无会话。')).toBeVisible();
    await expect(playback).toHaveCount(0);

    await page.getByRole('button', { name: second.title, exact: true }).click();
    await expect(replay).toHaveAttribute('aria-expanded', 'false');
    denyHistory = true;
    await replay.click();
    await expect(
      page.getByText('会话访问已变化，请重新读取会话列表。'),
    ).toBeVisible();
    await expect(playback).toHaveCount(0);
    await expect(list).toHaveCount(0);
    denyHistory = false;
    const directoryRecheck = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === second.path &&
        response.status() === 200,
    );
    await page.getByRole('button', { name: '重试读取会话列表' }).click();
    expect(
      (await directoryRecheck).request().headers()['x-rdws-edit-session'],
    ).toBe(original.session.id);
    await expect(replay).toHaveAttribute('aria-expanded', 'false');
    await replay.click();
    await expect(playback).toContainText('已加载至历史起点');
    failRequirements = true;
    const retryRequirements = page.getByRole('button', {
      name: '重试读取需求列表',
    });
    await expect(retryRequirements).toBeVisible();
    await expect(playback).toHaveCount(0);
    await expect(list).toHaveCount(0);
    failRequirements = false;
    await retryRequirements.click();
    await expect(replay).toHaveAttribute('aria-expanded', 'false');
    await replay.click();
    await expect(playback).toContainText('已加载至历史起点');
    const denied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === second.path &&
        response.status() === 401,
    );
    const replacement = await prepareSession(page.context(), origin, account);
    expect(replacement.session.id).not.toBe(original.session.id);
    const rejected = await denied;
    expect(rejected.status()).toBe(401);
    expect(rejected.request().headers()['x-rdws-edit-session']).toBe(
      original.session.id,
    );
    await expect(playback).toHaveCount(0);
    await expect(list).toHaveCount(0);
    await page.goto(
      `/?project=missing-fleet-project&view=fleet&requirement=${second.id}`,
    );
    await expect(
      page.getByRole('heading', { name: '无法访问指定项目' }),
    ).toBeVisible();
    await expect(list).toHaveCount(0);
  } finally {
    releaseFirst();
  }
});
