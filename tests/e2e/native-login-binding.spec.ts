import {
  expect,
  test,
  type APIResponse,
  type WebSocketRoute,
} from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';

function latch() {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => (open = resolve));
  return { open, wait };
}

test('an open conversation keeps its original login and isolates the draft after a Cookie replacement', async ({
  page,
  baseURL,
}) => {
  const context = page.context();
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  const manager = accounts.find((account) => account.username === 'manager')!;
  const lead = accounts.find((account) => account.username === 'lead')!;
  await prepareSession(context, baseURL!, manager);
  const members = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  const leadId = members.members.find(
    (member: { name: string }) => member.name === 'lead',
  ).id;
  const created = await page.request.post('/api/projects/poc/requirements', {
    headers: { origin: baseURL! },
    data: {
      commandId: randomUUID(),
      title: 'Native login binding ' + randomUUID(),
      description: 'Synthetic browser draft',
      acceptance: 'No prompt submitted after a login change',
      leadId,
      participants: [],
    },
  });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  await prepareSession(context, baseURL!, lead);
  const originalCookies = await context.cookies(baseURL!);
  const url = `/?project=poc&requirement=${id}&view=chat`;
  const auth = latch(),
    details = latch();
  let holdAuth = false,
    holdDetails = false;
  await page.route('**/api/auth/get-session', async (route) => {
    if (holdAuth) await auth.wait;
    await route.continue();
  });
  await page.route(`**/api/requirements/${id}`, async (route) => {
    if (holdDetails) await details.wait;
    await route.continue();
  });
  const sockets: WebSocketRoute[] = [];
  await page.routeWebSocket(
    `**/api/dsh/${id}/native/api/remote.mux?*`,
    (socket) => {
      sockets.push(socket);
      socket.connectToServer();
    },
  );
  const bootstrapLogins: string[] = [];
  let promptRequests = 0;
  page.on('request', (request) => {
    if (request.url().endsWith(`/api/dsh/${id}/bootstrap`))
      bootstrapLogins.push(request.headers()['x-rdws-edit-session']!);
    if (request.url().endsWith('/native/api/session/prompt')) promptRequests++;
  });
  const otherPage = await context.newPage();
  const refreshLogin = () =>
    otherPage.evaluate((clientId) => {
      localStorage.setItem(
        'better-auth.message',
        JSON.stringify({
          event: 'session',
          data: { trigger: 'signIn' },
          clientId,
        }),
      );
    }, randomUUID());
  const newSession = page.getByRole('button', {
    name: '新建会话',
    exact: true,
  });
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  const original = page.getByLabel('消息', { exact: true });
  const archived = page.getByLabel('未发送草稿', { exact: true });
  const reopen = page.getByRole('button', { name: '重新打开需求会话' });
  const draft = 'Draft to preserve in the old tab';
  try {
    await page.goto(url);
    await expect(newSession).toBeEnabled();
    await newSession.click();
    await expect(original).toBeEditable();
    await original.fill(draft);
    await expect(send).toBeEnabled();
    const originalLogin = bootstrapLogins[0];
    const oldSocket = sockets.at(-1)!;
    const previous = new URL(oldSocket.url()).searchParams;
    expect(previous.get('login')).toMatch(/^[a-f0-9]{64}$/);
    holdAuth = holdDetails = true;
    await otherPage.goto('/api/health');
    const replacement = await prepareSession(
      otherPage.context(),
      baseURL!,
      lead,
    );
    expect(replacement.session.id).not.toBe(originalLogin);
    const rejected = page.waitForResponse(
      (response) =>
        response.url().endsWith('/native/api/session/prompt') &&
        response.request().method() === 'POST',
    );
    await send.click();
    expect((await rejected).status()).toBe(401);
    await expect(original).toHaveValue(draft);
    const beforeReconnect = sockets.length;
    await oldSocket.close({ code: 1012, reason: 'Synthetic reconnect' });
    await expect.poll(() => sockets.length).toBeGreaterThan(beforeReconnect);
    const reconnect = new URL(sockets[beforeReconnect]!.url()).searchParams;
    expect(reconnect.get('login')).toBe(previous.get('login'));
    expect(reconnect.get('generation')).not.toBe(previous.get('generation'));
    const deniedDetail = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/requirements/${id}`) &&
        response.status() === 401,
    );
    await page.bringToFront();
    holdDetails = false;
    details.open();
    await deniedDetail;
    await expect(original).toHaveCount(0);
    await expect(archived).toHaveCount(0);
    await expect(page.getByTestId('transcript')).toHaveCount(0);
    holdAuth = false;
    auth.open();
    await page.bringToFront();
    await refreshLogin();
    await expect(reopen).toBeVisible();
    await expect(archived).toHaveValue(draft);
    await expect(archived).not.toBeEditable();
    await expect(send).toHaveCount(0);
    expect(bootstrapLogins).toEqual([originalLogin]);
    const different = await prepareSession(
      otherPage.context(),
      baseURL!,
      manager,
    );
    const authorizedDetail = page.waitForResponse(
      (response) =>
        response.url().endsWith(`/api/requirements/${id}`) &&
        response.request().headers()['x-rdws-edit-session'] ===
          different.session.id &&
        response.status() === 200,
    );
    await refreshLogin();
    await authorizedDetail;
    await expect(reopen).toBeVisible();
    await expect(archived).toHaveCount(0);
    await expect(page.getByTestId('transcript')).toHaveCount(0);
    await context.addCookies(originalCookies);
    await refreshLogin();
    await expect(original).toHaveValue(draft);
    expect(bootstrapLogins.at(-1)).toBe(originalLogin);
    await prepareSession(otherPage.context(), baseURL!, lead);
    await refreshLogin();
    await expect(archived).toHaveValue(draft);
    await reopen.click();
    await expect(newSession).toBeEnabled();
    expect(bootstrapLogins.at(-1)).not.toBe(originalLogin);
    await expect
      .poll(() => {
        const current = sockets.at(-1);
        return current && new URL(current.url()).searchParams.get('login');
      })
      .not.toBe(previous.get('login'));
    await expect(archived).toHaveCount(0);
    await page
      .getByRole('button', { name: '会话 1 · 本人', exact: true })
      .click();
    await expect(page.getByTestId('transcript')).toContainText('会话已就绪');
    await expect(original).toHaveValue('');
    await expect(page.getByText(draft, { exact: true })).toHaveCount(0);
    expect(promptRequests).toBe(1);
  } finally {
    auth.open();
    details.open();
    await otherPage.close();
  }
});

for (const { view, replacementAccount } of [
  { view: 'chat', replacementAccount: 'manager' },
  { view: 'trace', replacementAccount: 'lead' },
] as const) {
  test(`passive ${view} reads keep the page login when another tab replaces its Cookie`, async ({
    page,
    baseURL,
  }) => {
    const origin = baseURL!;
    const context = page.context();
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    ) as { username: string; password: string }[];
    const original = await prepareSession(
      context,
      origin,
      accounts.find((account) => account.username === 'manager')!,
    );
    const { members } = await (
      await page.request.get('/api/projects/poc/members')
    ).json();
    const created = await page.request.post('/api/projects/poc/requirements', {
      headers: { origin },
      data: {
        commandId: randomUUID(),
        title: `Passive reads ${randomUUID()}`,
        description: 'Synthetic cross-login read fixture',
        acceptance: 'Scope remains tied to the observed login',
        leadId: members.find((item: { name: string }) => item.name === 'lead')
          .id,
        participants: [],
      },
    });
    expect(created.status()).toBe(200);
    const { id } = await created.json();
    const requirement = `/api/requirements/${id}`;
    const directory = requirement + '/sessions';
    const added = await page.request.post(directory, {
      headers: { origin },
      data: { commandId: randomUUID() },
    });
    expect(added.status()).toBe(200);
    const { sessionId } = await added.json();
    const history = `${directory}/${sessionId}/history`;
    const originalCookies = await context.cookies(origin);
    const trace = view === 'trace';
    const originalBody = 'Authorized content from the original login';
    let showFixtureHistory = true;
    await page.route(
      (url) => url.pathname === history,
      async (route) => {
        const query = new URL(route.request().url()).searchParams;
        if (!showFixtureHistory || query.has('throughSeq')) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        const prior = await response.json();
        await route.fulfill({
          response,
          json: {
            ...prior,
            cursor: 1,
            beforeSeq: 1,
            hasMore: true,
            events: [
              {
                seq: 1,
                type: 'assistant/message',
                label: '助手回复',
                text: originalBody,
              },
            ],
          },
        });
      },
    );
    const auth = latch();
    const details = latch();
    const lists = latch();
    const oldCaptured = latch(),
      sendOld = latch();
    const denialCaptured = latch(),
      sendDenial = latch();
    const laterCaptured = latch(),
      allowLater = latch();
    let readStage: 'normal' | 'hold-success' | 'hold-denial' = 'normal';
    let seenSuccess = false;
    let seenDenial = false;
    let pauseAuth = false;
    let resumedAuth: Promise<APIResponse> | undefined;
    let pauseDetails = false;
    let pauseLists = false;
    await page.route(
      (url) => url.pathname === '/api/auth/get-session',
      async (route) => {
        if (!pauseAuth) {
          await route.continue();
          return;
        }
        await auth.wait;
        resumedAuth ??= page.request.get('/api/auth/get-session');
        await route.fulfill({ response: await resumedAuth });
      },
    );
    await page.route(
      (url) => url.pathname === requirement,
      async (route) => {
        if (pauseDetails) await details.wait;
        await route.continue();
      },
    );
    await page.route(
      (url) => url.pathname === directory,
      async (route) => {
        if (readStage === 'hold-success' && !seenSuccess) {
          seenSuccess = true;
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          expect(route.request().headers()['x-rdws-edit-session']).toBe(
            original.session.id,
          );
          oldCaptured.open();
          await sendOld.wait;
          await route.fulfill({ response });
          return;
        }
        if (readStage === 'hold-denial') {
          if (!seenDenial) {
            const response = await route.fetch();
            if (response.status() === 200) {
              await route.fulfill({ response });
              return;
            }
            expect(response.status()).toBe(401);
            if (!seenDenial) {
              seenDenial = true;
              denialCaptured.open();
              await sendDenial.wait;
            } else {
              laterCaptured.open();
              await allowLater.wait;
            }
            await route.fulfill({ response });
            return;
          }
          laterCaptured.open();
          await allowLater.wait;
        }
        if (pauseLists) await lists.wait;
        await route.continue();
      },
    );
    const otherPage = await context.newPage();
    const historyRegion = page.getByRole('region', {
      name: trace ? '会话轨迹事件' : '会话历史回放',
      exact: true,
    });
    const select = page.getByLabel('选择会话', { exact: true });
    const replay = page.getByRole('button', {
      name: '回放会话 1',
      exact: true,
    });
    const openHistory = () =>
      trace ? select.selectOption(sessionId) : replay.click();
    const onRead = (path: string, status?: number) =>
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === path &&
          (status === undefined || response.status() === status),
      );
    try {
      await page.goto(`/?project=poc&view=${view}&requirement=${id}`);
      const first = onRead(history);
      await openHistory();
      const firstResponse = await first;
      expect(firstResponse.status()).toBe(200);
      expect(firstResponse.headers()['cache-control']).toBe('no-store');
      expect(firstResponse.request().headers()['x-rdws-edit-session']).toBe(
        original.session.id,
      );
      if (trace)
        await historyRegion.getByText('助手回复', { exact: true }).click();
      await expect(
        historyRegion.getByText(originalBody, { exact: true }),
      ).toBeVisible();
      pauseAuth = pauseDetails = true;
      if (trace) pauseLists = true;
      else {
        readStage = 'hold-success';
        await oldCaptured.wait;
        readStage = 'hold-denial';
      }
      await otherPage.goto('/api/health');
      const replacement = await prepareSession(
        otherPage.context(),
        origin,
        accounts.find((account) => account.username === replacementAccount)!,
      );
      expect(replacement.session.id).not.toBe(original.session.id);
      expect(replacement.user.id === original.user.id).toBe(
        replacementAccount === 'manager',
      );
      expect((await otherPage.request.get(history)).status()).toBe(200);
      expect((await otherPage.request.get(directory)).status()).toBe(200);

      await page.bringToFront();
      const oldDirectory = onRead(directory, 401);
      if (trace) {
        const staleHistory = await otherPage.request.get(history, {
          headers: { 'x-rdws-edit-session': original.session.id },
        });
        expect(staleHistory.status()).toBe(401);
        await expect(
          historyRegion.getByText(originalBody, { exact: true }),
        ).toBeVisible();
        pauseLists = false;
        lists.open();
      } else {
        const oldHistory = onRead(history);
        await historyRegion
          .getByRole('button', { name: '加载更早事件' })
          .click();
        expect((await oldHistory).status()).toBe(401);
        await expect(
          historyRegion.getByText(originalBody, { exact: true }),
        ).toHaveCount(0);
        await denialCaptured.wait;
        await laterCaptured.wait;
        sendDenial.open();
      }
      expect((await oldDirectory).headers()['cache-control']).toBe('no-store');
      await expect(historyRegion).toHaveCount(0);
      await expect(page.getByText(originalBody, { exact: true })).toHaveCount(
        0,
      );
      if (trace) await expect(select).toHaveCount(0);
      else {
        await expect(replay).toHaveCount(0);
        await expect(
          page.getByRole('button', { name: '会话 1 · 本人', exact: true }),
        ).toHaveCount(0);
        const lateSuccess = onRead(directory, 200);
        sendOld.open();
        await (await lateSuccess).finished();
        await page.evaluate(
          () =>
            new Promise<void>((resolve) =>
              requestAnimationFrame(() =>
                requestAnimationFrame(() => resolve()),
              ),
            ),
        );
        await expect(replay).toHaveCount(0);
        await expect(historyRegion).toHaveCount(0);

        const replacementCookies = await context.cookies(origin);
        await context.addCookies(originalCookies);
        readStage = 'normal';
        allowLater.open();
        await expect(replay).toBeVisible();
        await context.addCookies(replacementCookies);
      }

      pauseDetails = false;
      auth.open();
      details.open();
      await otherPage.evaluate((clientId) => {
        localStorage.setItem(
          'better-auth.message',
          JSON.stringify({
            event: 'session',
            data: { trigger: 'signIn' },
            clientId,
          }),
        );
      }, randomUUID());
      showFixtureHistory = false;
      const reopen = page.getByRole('button', { name: '重新打开需求会话' });
      await expect(reopen).toBeVisible();
      pauseAuth = false;
      await reopen.click();
      const reopened = onRead(history);
      await openHistory();
      const reopenedResponse = await reopened;
      expect(reopenedResponse.status()).toBe(200);
      expect(reopenedResponse.request().headers()['x-rdws-edit-session']).toBe(
        replacement.session.id,
      );
      await expect(
        historyRegion.getByText('当前范围暂无可展示事件。'),
      ).toBeVisible();
    } finally {
      auth.open();
      details.open();
      lists.open();
      sendOld.open();
      sendDenial.open();
      allowLater.open();
      await otherPage.close();
    }
  });
}
