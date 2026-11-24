import { expect, test, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

const base = Date.UTC(2026, 10, 24, 8, 0, 0);

async function signIn(page: Page, baseURL: string, username = 'manager') {
  const accounts = await readTestAccounts();
  await prepareSession(
    page.context(),
    baseURL,
    accounts.find((account) => account.username === username)!,
  );
  const { members } = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  return {
    leadId: members.find((item: { name: string }) => item.name === 'lead').id,
  };
}
async function requirementWithSession(
  page: Page,
  origin: string,
  leadId: string,
) {
  const created = await page.request.post('/api/projects/poc/requirements', {
    headers: { origin },
    data: {
      commandId: randomUUID(),
      title: `Alignment ${randomUUID()}`,
      description: 'Synthetic alignment fixture',
      acceptance: 'Rendered output matches the record',
      leadId,
      participants: [],
    },
  });
  expect(created.status(), await created.text()).toBe(200);
  const id = (await created.json()).id as string;
  const session = await page.request.post(`/api/requirements/${id}/sessions`, {
    headers: { origin },
    data: { commandId: randomUUID() },
  });
  expect(session.status(), await session.text()).toBe(200);
  return {
    id,
    sessionId: (await session.json()).sessionId as string,
    path: `/api/requirements/${id}/sessions`,
  };
}
const clock = (page: Page, time: number, seconds = false) =>
  page.evaluate(
    ([value, withSeconds]) =>
      new Date(value).toLocaleTimeString('zh-CN', {
        hour: '2-digit',
        minute: '2-digit',
        ...(withSeconds ? { second: '2-digit' } : {}),
        hour12: false,
      }),
    [time, seconds] as const,
  );

test('the trace shows event times and filters by event kind', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(60000);
  const { leadId } = await signIn(page, baseURL!);
  const fixture = await requirementWithSession(page, baseURL!, leadId);
  const history = `${fixture.path}/${fixture.sessionId}/history`;
  await page.route(`**${history}*`, (route) =>
    route.fulfill({
      json: {
        cursor: 17,
        beforeSeq: 4,
        hasMore: false,
        events: [
          { seq: 4, type: 'turn/start', label: '轮次开始', time: base },
          {
            seq: 8,
            type: 'user/message',
            label: '用户消息',
            text: '你好',
            time: base + 1000,
          },
          {
            seq: 15,
            type: 'assistant/message',
            label: '助手回复',
            text: '你好！',
            time: base + 2000,
          },
          {
            seq: 17,
            type: 'turn/end',
            label: '轮次结束',
            outcome: '已完成',
            time: base + 3000,
          },
        ],
      },
    }),
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?project=poc&view=trace&requirement=${fixture.id}`);
  const trace = page.getByRole('region', { name: '会话轨迹', exact: true });
  await trace.getByLabel('选择会话').selectOption(fixture.sessionId);
  const rows = page.locator('.history-events > li');
  const filter = trace.getByRole('group', { name: '事件类型筛选' });
  await expect(rows).toHaveCount(4);
  // A record's own time is shown; one without it shows no time at all.
  await expect(trace.locator('time')).toHaveCount(4);
  await expect(rows.nth(1).locator('time')).toHaveText(
    await clock(page, base + 1000, true),
  );
  await filter.getByRole('button', { name: '消息', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(trace.locator('time')).toHaveCount(2);
  await filter.getByRole('button', { name: '轮次', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await filter.getByRole('button', { name: '全部', exact: true }).click();
  await expect(rows).toHaveCount(4);
  // No tool row is loaded, so no tool filter is offered.
  await expect(
    filter.getByRole('button', { name: '工具', exact: true }),
  ).toHaveCount(0);

  const download = page.waitForEvent('download');
  await trace.getByRole('button', { name: '导出已读摘要' }).click();
  const stream = await (await download).createReadStream();
  const chunks: Buffer[] = [];
  for await (const chunk of stream!) chunks.push(chunk as Buffer);
  const summary = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(summary.events).toEqual([
    {
      seq: 4,
      type: 'turn/start',
      label: '轮次开始',
      outcome: undefined,
      time: base,
    },
    {
      seq: 8,
      type: 'user/message',
      label: '用户消息',
      outcome: undefined,
      time: base + 1000,
    },
    {
      seq: 15,
      type: 'assistant/message',
      label: '助手回复',
      outcome: undefined,
      time: base + 2000,
    },
    {
      seq: 17,
      type: 'turn/end',
      label: '轮次结束',
      outcome: '已完成',
      time: base + 3000,
    },
  ]);
  expect(JSON.stringify(summary)).not.toContain('你好');
});

// Recorded replies reach the transcript over the Native follow stream, which
// cannot be substituted here. Rendering is covered by the unit tests and the
// live workbench journey; this checks the layout on a real session.
test('the conversation keeps the composer inside the first screen', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { leadId } = await signIn(page, baseURL!);
  const fixture = await requirementWithSession(page, baseURL!, leadId);
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(`/?project=poc&view=chat&requirement=${fixture.id}`);
  const transcript = page.getByTestId('transcript');
  await page
    .getByRole('button', { name: '会话 1 · 本人', exact: true })
    .click();
  await expect(transcript).toContainText('会话已就绪');
  // The record fills the height left by the page and the composer sits
  // under it, fully visible above the status bar.
  const send = page.getByRole('button', { name: '发送消息', exact: true });
  await expect(send).toBeInViewport();
  const box = await send.boundingBox(),
    status = await page.locator('.workspace-main > .statusbar').boundingBox();
  expect(box!.y + box!.height).toBeLessThanOrEqual(status!.y);
  expect(
    await page
      .locator('.workspace-scroll')
      .evaluate((el) => el.scrollHeight <= el.clientHeight),
  ).toBe(true);
  expect(
    await page.locator('.conversation-body').evaluate((el) => el.clientHeight),
  ).toBeGreaterThan(300);
  await expect(page.getByTestId('active-session-model')).toBeInViewport();
  // Narrow screens keep plain page scrolling without horizontal overflow.
  await page.setViewportSize({ width: 390, height: 900 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.locator('.workspace-scroll').evaluate((el) => {
    el.scrollTop = el.scrollHeight;
  });
  await expect(send).toBeInViewport();
});
