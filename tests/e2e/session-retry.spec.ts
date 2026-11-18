import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';
for (const failure of ['abort', 'invalid-json', 'reconnect'] as const)
  test(`session ${failure} preserves one operation across reload`, async ({
    page,
    baseURL,
  }) => {
    const accounts = JSON.parse(
      await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
    ) as { username: string; password: string }[];
    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find((a) => a.username === 'manager')!,
    );
    const members = await (
      await page.request.get('/api/projects/poc/members')
    ).json();
    const leadId = members.members.find(
      (m: { name: string }) => m.name === 'lead',
    ).id;
    const created = await page.request.post('/api/projects/poc/requirements', {
      headers: { origin: baseURL! },
      data: {
        commandId: randomUUID(),
        title: 'Session retry ' + Date.now(),
        description: 'Synthetic retry',
        acceptance: 'One Native session',
        leadId,
        participants: [],
      },
    });
    expect(created.status()).toBe(200);
    const id = (await created.json()).id;
    await prepareSession(
      page.context(),
      baseURL!,
      accounts.find((a) => a.username === 'lead')!,
    );
    const commands: string[] = [];
    let lost = false,
      blockReconnect = false;
    if (failure === 'reconnect')
      await page.routeWebSocket(
        `**/api/dsh/${id}/native/api/remote.mux?*`,
        async (socket) => {
          if (blockReconnect)
            await socket.close({
              code: 1012,
              reason: 'Synthetic unavailable connection',
            });
          else socket.connectToServer();
        },
      );
    await page.goto(`/?project=poc&requirement=${id}&view=chat`);
    await page.route(`**/api/requirements/${id}/sessions`, async (route) => {
      if (route.request().method() !== 'POST') {
        await route.continue();
        return;
      }
      commands.push(route.request().postDataJSON().commandId);
      if (!lost) {
        lost = true;
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (failure === 'abort') await route.abort('failed');
        else if (failure === 'invalid-json')
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{',
          });
        else {
          expect((await response.json()).status).toBe('mapped');
          blockReconnect = true;
          await route.fulfill({ response });
        }
      } else await route.continue();
    });
    await expect(
      page.getByRole('button', { name: '新建会话', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    if (failure === 'reconnect') {
      await expect(
        page.getByText('会话结果未确认，请核对原操作。', { exact: true }),
      ).toBeVisible({ timeout: 17_000 });
      blockReconnect = false;
    }
    await expect(
      page.getByRole('button', { name: '核对原操作', exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '新建会话', exact: true }),
    ).toBeDisabled();
    await page.reload();
    await expect(
      page.getByRole('button', { name: '核对原操作', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '核对原操作', exact: true }).click();
    await expect(
      page.getByRole('button', { name: '核对原操作', exact: true }),
    ).toHaveCount(0);
    expect(commands).toHaveLength(2);
    expect(new Set(commands).size).toBe(1);
    const sessions = await (
      await page.request.get(`/api/requirements/${id}/sessions`)
    ).json();
    expect(sessions.sessions).toHaveLength(1);
    await page.getByRole('button', { name: '回放历史', exact: true }).focus();
    await page.keyboard.press('Enter');
    await expect(
      page.getByRole('region', { name: '会话历史回放' }),
    ).toBeVisible();
    await expect(
      page.getByRole('region', { name: '会话历史回放' }),
    ).toContainText('暂无可展示事件');
    await expect(
      page.getByRole('button', { name: '新建会话', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '返回会话', exact: true }).click();
    await page
      .getByRole('button', { name: '派生当前会话', exact: true })
      .click();
    await expect(
      page.getByText('当前会话没有已结束的轮次，暂不能派生', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '核对原操作', exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole('button', { name: '新建会话', exact: true }),
    ).toBeEnabled();
    await page.getByRole('button', { name: '新建会话', exact: true }).click();
    await expect(
      page
        .getByRole('navigation', { name: '需求会话列表' })
        .getByRole('button', { name: /^会话 \d/ }),
    ).toHaveCount(2);
  });
test('a late catalog from the previous requirement cannot replace the current sessions', async ({
  page,
  baseURL,
}) => {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((a) => a.username === 'manager')!,
  );
  const members = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  const leadId = members.members.find(
    (m: { name: string }) => m.name === 'lead',
  ).id;
  const requirements: { id: string; title: string }[] = [];
  for (const name of ['Catalog A ', 'Catalog B ']) {
    const title = name + Date.now();
    const response = await page.request.post('/api/projects/poc/requirements', {
      headers: { origin: baseURL! },
      data: {
        commandId: randomUUID(),
        title,
        description: 'Synthetic catalog race',
        acceptance: 'Late A does not replace B',
        leadId,
        participants: [],
      },
    });
    expect(response.status()).toBe(200);
    requirements.push({ id: (await response.json()).id, title });
  }
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((a) => a.username === 'lead')!,
  );
  for (const [index, requirement] of requirements.entries())
    for (let i = 0; i < 2 - index; i++) {
      const response = await page.request.post(
        `/api/requirements/${requirement.id}/sessions`,
        { headers: { origin: baseURL! }, data: { commandId: randomUUID() } },
      );
      expect(response.status()).toBe(200);
    }
  const [a, b] = requirements as [
    { id: string; title: string },
    { id: string; title: string },
  ];
  let release = () => {},
    arrived = () => {};
  const gate = new Promise<void>((r) => (release = r)),
    ready = new Promise<void>((r) => (arrived = r));
  await page.route(`**/api/requirements/${a.id}/sessions`, async (route) => {
    const response = await route.fetch();
    arrived();
    await gate;
    await route.fulfill({ response });
  });
  try {
    await page.goto(`/?project=poc&requirement=${a.id}&view=chat`);
    await ready;
    await page.getByRole('button', { name: b.title, exact: true }).click();
    await expect(
      page.getByRole('heading', { name: b.title, exact: true }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('navigation', { name: '需求会话列表' })
        .getByRole('button', { name: /^会话 \d/ }),
    ).toHaveCount(1);
    const delivered = page.waitForResponse((response) =>
      response.url().endsWith(`/api/requirements/${a.id}/sessions`),
    );
    release();
    await delivered;
    await expect(
      page
        .getByRole('navigation', { name: '需求会话列表' })
        .getByRole('button', { name: /^会话 \d/ }),
    ).toHaveCount(1);
    await expect(
      page.getByRole('heading', { name: b.title, exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: '回放会话 1', exact: true }).click();
    await expect(
      page.getByRole('region', { name: '会话历史回放' }),
    ).toBeVisible();
    await expect(page.getByLabel('消息', { exact: true })).toHaveCount(0);
  } finally {
    release();
  }
});
