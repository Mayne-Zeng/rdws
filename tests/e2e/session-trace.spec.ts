import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { test, expect } from '@playwright/test';
import { runtimeHome } from '@rdws/runtime-config';
import { prepareSession } from '../helpers/auth-session.ts';

test('the passive trace shows one authorized session and exports only its loaded event summary', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const origin = baseURL!;
  await prepareSession(
    page.context(),
    origin,
    accounts.find((item) => item.username === 'manager')!,
  );
  const { members } = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  const leadId = members.find(
    (item: { name: string }) => item.name === 'lead',
  ).id;
  const otherTitle = `Trace other ${randomUUID()}`;
  async function requirement(title: string) {
    const response = await page.request.post('/api/projects/poc/requirements', {
      headers: { origin },
      data: {
        commandId: randomUUID(),
        title,
        description: 'Synthetic trace fixture',
        acceptance: 'Passive read',
        leadId,
        participants: [],
      },
    });
    expect(response.status()).toBe(200);
    return (await response.json()).id as string;
  }
  const id = await requirement(`Trace ${randomUUID()}`);
  const other = await requirement(otherTitle);
  const sessions = `/api/requirements/${id}/sessions`;
  for (let index = 0; index < 2; index++) {
    const response = await page.request.post(sessions, {
      headers: { origin },
      data: { commandId: randomUUID() },
    });
    expect(response.status()).toBe(200);
  }
  const directory = (await (await page.request.get(sessions)).json()) as {
    sessions: { id: string }[];
  };
  const [first, second] = directory.sessions.map((item) => item.id);
  expect(directory.sessions).toHaveLength(2);
  const history = `${sessions}/${first}/history`;
  const deniedPath = `/api/requirements/${other}/sessions/${first}/history`;
  expect((await page.request.get(deniedPath)).status()).toBe(403);

  const stranger = await browser.newContext({ baseURL: origin });
  try {
    expect((await stranger.request.get(history)).status()).toBe(401);
    await prepareSession(
      stranger,
      origin,
      accounts.find((item) => item.username === 'tester')!,
    );
    expect((await stranger.request.get(sessions)).status()).toBe(403);
    expect((await stranger.request.get(history)).status()).toBe(403);
  } finally {
    await stranger.close();
  }

  const requests: { url: string; method: string }[] = [];
  const sockets: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/api/'))
      requests.push({ url: pathname, method: request.method() });
  });
  page.on('websocket', (socket) => sockets.push(socket.url()));
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/?project=poc&view=trace&requirement=${id}`);
  const trace = page.getByRole('region', { name: '会话轨迹', exact: true });
  const select = trace.getByLabel('选择会话');
  const empty = trace.getByText('当前范围暂无可展示事件。', { exact: true });
  const retry = trace.getByRole('button', { name: '重试读取历史' });
  const older = trace.getByRole('button', { name: '加载更早事件' });
  const download = trace.getByRole('button', { name: '导出已读摘要' });
  await expect(page.getByRole('tab', { name: '轨迹' })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(select.locator('option')).toHaveCount(3);
  const nativeRead = page.waitForResponse(
    (response) => new URL(response.url()).pathname === history && response.ok(),
  );
  await select.selectOption(first!);
  expect(await (await nativeRead).json()).toMatchObject({ events: [] });
  await expect(empty).toBeVisible();
  await expect(download).toHaveCount(0);

  const text = '<img src=x onerror="throw 1"> private-message-sentinel';
  const earlier = {
    seq: 9,
    type: 'turn/end',
    label: '轮次结束',
    outcome: '已中断',
  };
  const message = { seq: 22, type: 'assistant/message', label: '助手回复' };
  let phase:
    | 'initial-error'
    | 'pages'
    | 'unavailable'
    | 'bad-position'
    | 'late'
    | 'forbidden' = 'initial-error';
  const positions: string[] = [];
  let resumeLate!: () => void;
  let lateStarted!: () => void;
  let lateCompleted!: () => void;
  const paused = new Promise<void>((resolve) => {
    resumeLate = resolve;
  });
  const lateRequest = new Promise<void>((resolve) => {
    lateStarted = resolve;
  });
  const lateDone = new Promise<void>((resolve) => {
    lateCompleted = resolve;
  });
  await page.route(
    (url) => url.pathname === history,
    async (route) => {
      const params = new URL(route.request().url()).searchParams;
      positions.push(params.toString());
      const before = params.get('beforeSeq');
      if (phase === 'late') {
        lateStarted();
        await paused;
        await route
          .fulfill({
            json: {
              cursor: 37,
              beforeSeq: 35,
              hasMore: false,
              events: [{ ...message, seq: 35, label: '迟到的旧会话事件' }],
            },
          })
          .catch(() => {});
        lateCompleted();
        return;
      }
      if (phase === 'forbidden') {
        await route.fulfill({ status: 403, json: { error: '访问已撤回' } });
        return;
      }
      if (phase === 'initial-error' || phase === 'unavailable') {
        await route.fulfill({ status: 503, json: { error: '暂时不可用' } });
        return;
      }
      if (phase === 'bad-position') {
        await route.fulfill({
          json: { cursor: 38, beforeSeq: 1, hasMore: false, events: [earlier] },
        });
        return;
      }
      const body = !before
        ? { cursor: 37, beforeSeq: 31, hasMore: true, events: [] }
        : before === '31'
          ? {
              cursor: 37,
              beforeSeq: 20,
              hasMore: true,
              events: [
                { ...message, text, rawPayload: 'fixture-secret /tmp/native' },
              ],
            }
          : { cursor: 37, beforeSeq: 1, hasMore: false, events: [earlier] };
      await route.fulfill({ json: body });
    },
  );
  await select.selectOption('');
  await select.selectOption(first!);
  await expect(retry).toBeVisible();
  phase = 'pages';
  await retry.click();
  await expect(
    trace.getByText('逻辑范围 #31 至 #37 · 可见 0 条 · 还有更早事件'),
  ).toBeVisible();
  await expect(older).toBeEnabled();
  await expect(download).toHaveCount(0);
  await older.click();
  await expect(
    trace.getByText('逻辑范围 #20 至 #37 · 可见 1 条 · 还有更早事件'),
  ).toBeVisible();
  expect(positions).toContain('throughSeq=37&beforeSeq=31');

  const detail = trace.locator('summary').filter({ hasText: '助手回复' });
  await detail.focus();
  await page.keyboard.press('Enter');
  await expect(trace.getByText(text, { exact: true })).toBeVisible();
  await expect(trace.locator('img')).toHaveCount(0);
  expect(
    await detail.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThanOrEqual(40);
  const file = page.waitForEvent('download');
  await download.click();
  const summary = await file;
  expect(summary.suggestedFilename()).toBe(`trace-${first}.json`);
  expect(JSON.parse(await readFile((await summary.path())!, 'utf8'))).toEqual({
    sessionId: first,
    source: 'native-logical-history',
    recoveryMayBeSynthesized: true,
    throughSeq: 37,
    oldestLoadedSeq: 20,
    hasEarlierPages: true,
    events: [message],
  });

  await mkdir('.impeccable/review', { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const width of [390, 1440]) {
      await page.setViewportSize({ width, height: 900 });
      await expect(page.locator('html')).toHaveAttribute(
        'theme-mode',
        colorScheme,
      );
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      await expect(trace.getByText(text, { exact: true })).toBeVisible();
      if (width === 1440) {
        const [chat, timeline, overview] = await page
          .getByRole('tablist', { name: '工作区视图' })
          .getByRole('tab')
          .evaluateAll((tabs) =>
            tabs.map((tab) => {
              const { left, right } = tab.getBoundingClientRect();
              return { left, right };
            }),
          );
        expect(overview!.left - timeline!.right).toBeGreaterThan(
          timeline!.left - chat!.right,
        );
      }
      await page.screenshot({
        path: `.impeccable/review/t16-trace-${colorScheme}-${width}.png`,
      });
    }
  }

  phase = 'unavailable';
  await older.click();
  await expect(retry).toBeVisible();
  await expect(trace.getByText(text, { exact: true })).toHaveCount(0);
  await expect(download).toHaveCount(0);
  phase = 'bad-position';
  await retry.click();
  await expect(
    trace.getByText('会话历史分页位置变化，请重试读取同一页。'),
  ).toBeVisible();
  await expect(download).toHaveCount(0);
  phase = 'pages';
  await retry.click();
  await expect(trace.getByRole('listitem')).toHaveText([
    /#9.*轮次结束/,
    /#22.*助手回复/,
  ]);
  expect(positions.slice(-3)).toEqual(
    Array(3).fill('throughSeq=37&beforeSeq=20'),
  );

  await select.selectOption('');
  phase = 'late';
  await select.selectOption(first!);
  await lateRequest;
  await select.selectOption(second!);
  await expect(empty).toBeVisible();
  resumeLate();
  await lateDone;
  await expect(trace.getByText('迟到的旧会话事件')).toHaveCount(0);
  await expect(download).toHaveCount(0);

  phase = 'pages';
  await select.selectOption(first!);
  await older.click();
  await expect(download).toBeEnabled();
  phase = 'forbidden';
  await older.click();
  await expect(
    trace.getByText('会话访问已变化，请重新读取会话列表。'),
  ).toBeVisible();
  await expect(download).toHaveCount(0);
  await expect(select).toHaveCount(0);
  await trace.getByRole('button', { name: '重试读取会话列表' }).click();
  await expect(select).toHaveValue('');

  phase = 'pages';
  await select.selectOption(first!);
  await older.click();
  await expect(download).toBeEnabled();
  const projectDirectory = '**/api/projects/poc/requirements';
  await page.route(projectDirectory, (route) =>
    route.fulfill({ status: 403, json: { error: '项目需求访问已变化' } }),
  );
  const retryProject = page.getByRole('button', { name: '重试读取需求列表' });
  await expect(retryProject).toBeVisible();
  await expect(trace).toHaveCount(0);
  await page.unroute(projectDirectory);
  await retryProject.click();
  await expect(select).toHaveValue('');

  await page.getByRole('button', { name: otherTitle, exact: true }).click();
  await expect(trace.getByText('当前需求暂无会话。')).toBeVisible();
  await page.goto(`/?project=unknown&view=trace&requirement=${id}`);
  await expect(
    page.getByRole('heading', { name: '无法访问指定项目' }),
  ).toBeVisible();
  await expect(trace).toHaveCount(0);
  expect(requests.some((request) => request.url === history)).toBe(true);
  expect(requests.every((request) => request.method === 'GET')).toBe(true);
  expect(requests.some((request) => request.url.startsWith('/api/dsh/'))).toBe(
    false,
  );
  expect(sockets.some((url) => url.includes('/api/dsh/'))).toBe(false);
});
