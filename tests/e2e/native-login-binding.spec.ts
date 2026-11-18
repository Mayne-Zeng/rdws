import { expect, test, type WebSocketRoute } from '@playwright/test';
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
    await prepareSession(otherPage.context(), baseURL!, lead);
    const replacement = await (
      await otherPage.request.get('/api/auth/get-session')
    ).json();
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
    await prepareSession(otherPage.context(), baseURL!, manager);
    const different = await (
      await otherPage.request.get('/api/auth/get-session')
    ).json();
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
