import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';

async function replayFixture(page: Page, origin: string) {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await prepareSession(
    page.context(),
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
      title: `Replay ${randomUUID()}`,
      description: 'Synthetic replay fixture',
      acceptance: 'Fixed history behind current permissions',
      leadId: members.find((item: { name: string }) => item.name === 'lead').id,
      participants: [],
    },
  });
  expect(created.status()).toBe(200);
  const { id } = await created.json();
  const createdSession = await page.request.post(
    `/api/requirements/${id}/sessions`,
    { headers: { origin }, data: { commandId: randomUUID() } },
  );
  expect(createdSession.status()).toBe(200);
  const { sessionId } = await createdSession.json();
  return {
    path: `/api/requirements/${id}/sessions/${sessionId}/history`,
    url: `/?project=poc&view=chat&requirement=${id}`,
    tester: accounts.find((account) => account.username === 'tester')!,
  };
}

function replayPage(
  cursor: number,
  beforeSeq: number,
  text: string,
  hasMore = true,
) {
  return {
    cursor,
    beforeSeq,
    hasMore,
    events: [
      {
        seq: beforeSeq,
        type: 'assistant/message',
        label: '助手回复',
        text,
      },
    ],
  };
}

test('replay clears the previously loaded history when an older page is denied', async ({
  page,
  browser,
  baseURL,
}) => {
  const fixture = await replayFixture(page, baseURL!);
  const reader = await browser.newContext({ baseURL });
  try {
    await prepareSession(reader, baseURL!, fixture.tester);
    const pageRequests: [string | null, string | null][] = [];
    let denial: number | undefined;
    let cursor = 60;
    await page.route(
      (url) => url.pathname === fixture.path,
      async (route) => {
        const query = new URL(route.request().url()).searchParams;
        pageRequests.push([query.get('throughSeq'), query.get('beforeSeq')]);
        if (denial === 403) {
          const response = await reader.request.get(route.request().url());
          expect(response.status()).toBe(403);
          await route.fulfill({ response });
          return;
        }
        if (denial) {
          await route.fulfill({
            status: denial,
            json: { error: 'Fixture access loss' },
          });
          return;
        }
        await route.fulfill({
          json: replayPage(cursor, cursor - 10, `Authorized replay ${cursor}`),
        });
      },
    );
    await page.goto(fixture.url);
    await page.getByRole('button', { name: '回放会话 1', exact: true }).click();
    const replay = page.getByRole('region', {
      name: '会话历史回放',
      exact: true,
    });
    const more = replay.getByRole('button', { name: '加载更早事件' });
    const retry = replay.getByRole('button', { name: '重试读取历史' });
    for (const status of [403, 401, 404]) {
      const previous = replay.getByText(`Authorized replay ${cursor}`, {
        exact: true,
      });
      await expect(previous).toBeVisible();
      denial = status;
      await more.click();
      await expect(retry).toBeVisible();
      expect(pageRequests.at(-1)).toEqual([
        String(cursor),
        String(cursor - 10),
      ]);
      await expect(previous).toHaveCount(0);
      await expect(
        replay.getByText(`固定至事件 ${cursor}`, { exact: true }),
      ).toHaveCount(0);
      await expect(replay.getByRole('alert')).toContainText('会话访问已变化');
      denial = undefined;
      cursor += 10;
      await retry.click();
      await expect(
        replay.getByText(`Authorized replay ${cursor}`, { exact: true }),
      ).toBeVisible();
      await expect(previous).toHaveCount(0);
      expect(pageRequests.at(-1)).toEqual([null, null]);
    }
  } finally {
    await reader.close();
  }
});

test('replay rejects a changed cut or a non-advancing older page and retries the fixed position', async ({
  page,
  baseURL,
}) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  const fixture = await replayFixture(page, baseURL!);
  const attempts: [string | null, string][] = [];
  let result:
    | 'changed-cut'
    | 'stalled-page'
    | 'overlap'
    | 'unavailable'
    | 'empty'
    | 'ok' = 'changed-cut';
  await page.route(
    (url) => url.pathname === fixture.path,
    async (route) => {
      const query = new URL(route.request().url()).searchParams;
      const before = query.get('beforeSeq');
      if (before === null) {
        await route.fulfill({
          json: replayPage(60, 40, 'Original authorized page'),
        });
        return;
      }
      attempts.push([query.get('throughSeq'), before]);
      if (result === 'unavailable') {
        await route.fulfill({
          status: 503,
          json: { error: 'Fixture unavailable' },
        });
        return;
      }
      const frames = {
        'changed-cut': replayPage(61, 20, 'Page from a different cut'),
        'stalled-page': replayPage(60, 40, 'Page did not advance'),
        overlap: {
          ...replayPage(60, 20, 'In-range event in an overlapping page'),
          events: [
            ...replayPage(60, 20, 'In-range event in an overlapping page')
              .events,
            ...replayPage(60, 50, 'Event beyond the requested position').events,
          ],
        },
        empty: { cursor: 60, beforeSeq: 30, hasMore: true, events: [] },
        ok: replayPage(60, 20, 'Older authorized page', false),
      };
      await route.fulfill({ json: frames[result] });
    },
  );
  await page.goto(fixture.url);
  await page.getByRole('button', { name: '回放会话 1', exact: true }).click();
  const replay = page.getByRole('region', {
    name: '会话历史回放',
    exact: true,
  });
  const retry = replay.getByRole('button', { name: '重试读取历史' });
  const original = replay.getByText('Original authorized page', {
    exact: true,
  });
  const alert = replay.getByRole('alert');
  await expect(original).toBeVisible();
  await replay.getByRole('button', { name: '加载更早事件' }).click();
  await expect(alert).toContainText('分页位置变化');
  await expect(
    replay.getByText('Page from a different cut', { exact: true }),
  ).toHaveCount(0);
  await expect(original).toBeVisible();
  result = 'stalled-page';
  await retry.click();
  await expect.poll(() => attempts.length).toBe(2);
  await expect(alert).toContainText('分页位置变化');
  await expect(
    replay.getByText('Page did not advance', { exact: true }),
  ).toHaveCount(0);
  result = 'overlap';
  await retry.click();
  await expect.poll(() => attempts.length).toBe(3);
  await expect(alert).toContainText('分页位置变化');
  await expect(
    replay.getByText('In-range event in an overlapping page', { exact: true }),
  ).toHaveCount(0);
  await expect(
    replay.getByText('Event beyond the requested position', { exact: true }),
  ).toHaveCount(0);
  result = 'unavailable';
  await retry.click();
  await expect(alert).toContainText('会话历史读取失败');
  await expect(original).toBeVisible();
  result = 'empty';
  await retry.click();
  await expect(retry).toHaveCount(0);
  await expect(original).toBeVisible();
  const more = replay.getByRole('button', { name: '加载更早事件' });
  await expect(more).toBeEnabled();
  result = 'ok';
  await more.click();
  await expect(
    replay.getByText('Older authorized page', { exact: true }),
  ).toBeVisible();
  await expect(original).toBeVisible();
  await expect(
    replay.getByText('固定至事件 60', { exact: true }),
  ).toBeVisible();
  await expect(retry).toHaveCount(0);
  await expect(replay.getByRole('listitem')).toHaveText([
    /Older authorized page/,
    /Original authorized page/,
  ]);
  expect(attempts).toEqual([
    ...Array.from({ length: 5 }, () => ['60', '40']),
    ['60', '30'],
  ]);
});
