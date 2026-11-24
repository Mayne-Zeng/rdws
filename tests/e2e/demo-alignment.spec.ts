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

test('the sidebar groups requirements, unfolds sessions and folds to icons', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(90000);
  const { leadId } = await signIn(page, baseURL!);
  const first = await requirementWithSession(page, baseURL!, leadId);
  await page.request.post(first.path, {
    headers: { origin: baseURL! },
    data: { commandId: randomUUID() },
  });
  const second = await requirementWithSession(page, baseURL!, leadId);
  const directory = (await (await page.request.get(first.path)).json()) as {
    sessions: { id: string }[];
  };
  expect(directory.sessions).toHaveLength(2);
  const titleOf = async (id: string) =>
    (
      (await (await page.request.get(`/api/requirements/${id}`)).json())
        .requirement as { title: string }
    ).title;
  const [firstTitle, secondTitle] = [
    await titleOf(first.id),
    await titleOf(second.id),
  ];
  const rail = page.getByRole('complementary', { name: '项目侧栏' });
  const row = (title: string) =>
    rail.getByRole('button', { name: title, exact: true });
  const session = (title: string, index: number) =>
    rail.getByRole('button', {
      name: `${title} · 会话 ${index} · 本人`,
      exact: true,
    });

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?project=poc&view=requirements');
  // Every current stage is in progress; the other groups stay absent.
  await expect(rail.locator('.tree-group')).toHaveCount(1);
  await expect(rail.locator('.tree-group')).toContainText('进行中');
  await expect(row(firstTitle)).toBeVisible();
  await expect(row(secondTitle)).toBeVisible();
  // A requirement that was not opened shows no sessions yet.
  await expect(session(firstTitle, 1)).toHaveCount(0);

  // Opening a requirement keeps its row name and role, and unfolds it.
  await row(secondTitle).click();
  await expect(page).toHaveURL(
    new RegExp(`view=overview&requirement=${second.id}`),
  );
  await expect(session(secondTitle, 1)).toBeVisible();
  await expect(session(secondTitle, 2)).toHaveCount(0);

  // The arrow unfolds another requirement without leaving the page.
  await rail
    .getByRole('button', { name: `展开会话：${firstTitle}`, exact: true })
    .click();
  await expect(session(firstTitle, 1)).toBeVisible();
  await expect(session(firstTitle, 2)).toBeVisible();
  await expect(page).toHaveURL(
    new RegExp(`view=overview&requirement=${second.id}`),
  );
  await rail
    .getByRole('button', { name: `收起会话：${firstTitle}`, exact: true })
    .click();
  await expect(session(firstTitle, 1)).toHaveCount(0);
  await rail
    .getByRole('button', { name: `展开会话：${firstTitle}`, exact: true })
    .click();

  // A session opens the conversation with that session selected.
  await session(firstTitle, 2).click();
  await expect(page).toHaveURL(
    new RegExp(`session=${directory.sessions[1]!.id}`),
  );
  await expect(
    page
      .getByRole('navigation', { name: '需求会话列表' })
      .getByRole('button', { name: '会话 2 · 本人', exact: true }),
  ).toHaveAttribute('aria-current', 'true');
  await expect(session(firstTitle, 2)).toHaveAttribute('aria-current', 'true');

  // The profile button opens the requirement dossier.
  await row(firstTitle)
    .locator('..')
    .getByRole('button', { name: '打开需求档案' })
    .click();
  await expect(page).toHaveURL(
    new RegExp(`view=overview&requirement=${first.id}$`),
  );

  // Folding is a reader choice above the breakpoint and is remembered.
  const shell = page.locator('.workspace-shell');
  const width = () =>
    rail.evaluate((element) =>
      Math.round(element.getBoundingClientRect().width),
    );
  expect(await width()).toBe(248);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect(shell).toHaveClass(/rail-icon/);
  await expect.poll(width).toBe(64);
  await expect(rail.locator('.tree-group')).toBeHidden();
  await expect(session(firstTitle, 1)).toBeHidden();
  await expect(row(firstTitle)).toBeVisible();
  await expect(
    page.getByRole('button', { name: '展开侧栏', exact: true }),
  ).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(shell).toHaveClass(/rail-icon/);
  await page.getByRole('button', { name: '展开侧栏', exact: true }).click();
  await expect(shell).not.toHaveClass(/rail-icon/);
  await expect.poll(width).toBe(248);

  // The breakpoint decides on its own, in the same frame as the resize, and
  // leaves the stored choice untouched.
  await page.setViewportSize({ width: 820, height: 900 });
  expect(await width()).toBe(64);
  await expect(shell).not.toHaveClass(/rail-icon/);
  await expect(
    page.getByRole('button', { name: '收起侧栏', exact: true }),
  ).toBeHidden();
  await page.setViewportSize({ width: 1024, height: 900 });
  expect(await width()).toBe(248);
  await page.getByRole('button', { name: '收起侧栏', exact: true }).click();
  await expect.poll(width).toBe(64);
  await page.reload();
  await expect.poll(width).toBe(64);

  await page.setViewportSize({ width: 390, height: 900 });
  await page.getByRole('button', { name: '打开导航', exact: true }).click();
  await expect.poll(width).toBe(248);
  await expect(row(firstTitle)).toBeVisible();
  await expect(session(firstTitle, 1)).toBeVisible();
});

test('the requirement list filters by status and stage while export waits', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(90000);
  const accounts = await readTestAccounts();
  const { leadId } = await signIn(page, baseURL!);
  const token = randomUUID().slice(0, 8);
  async function create(letter: string) {
    const response = await page.request.post('/api/projects/poc/requirements', {
      headers: { origin: baseURL! },
      data: {
        commandId: randomUUID(),
        title: `Filter ${token} ${letter}`,
        description: 'Synthetic list filter fixture',
        acceptance: 'Filters narrow the list',
        leadId,
        participants: [],
      },
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()).id as string;
  }
  const [stays, moves] = [await create('甲'), await create('乙')];
  // Only the development lead moves a stage.
  const lead = await browser.newContext({ baseURL });
  try {
    await prepareSession(
      lead,
      baseURL!,
      accounts.find((account) => account.username === 'lead')!,
    );
    const changed = await lead.request.post(
      `/api/requirements/${moves}/commands`,
      {
        headers: { origin: baseURL! },
        data: {
          commandId: randomUUID(),
          type: 'requirement.stage',
          stage: 'design',
        },
      },
    );
    expect(changed.status(), await changed.text()).toBe(200);
  } finally {
    await lead.close();
  }

  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?project=poc&view=requirements');
  const rows = page.locator('.requirement-row');
  const stage = page.getByRole('group', { name: '阶段筛选' });
  const status = page.getByRole('group', { name: '需求状态筛选' });
  await page.getByLabel('筛选需求列表', { exact: true }).fill(token);
  await expect(rows).toHaveCount(2);

  await stage.getByRole('button', { name: '指派', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(`Filter ${token} 甲`);
  await stage.getByRole('button', { name: '设计', exact: true }).click();
  await expect(rows).toHaveCount(1);
  await expect(rows).toContainText(`Filter ${token} 乙`);
  await expect(
    stage.getByRole('button', { name: '设计', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await stage.getByRole('button', { name: '非生产集成', exact: true }).click();
  await expect(rows).toHaveCount(0);
  await expect(
    page.getByText('没有符合筛选条件的需求', { exact: true }),
  ).toBeVisible();

  // Filters combine; the status segment follows the same mapping as the tree.
  await stage.getByRole('button', { name: '全部阶段', exact: true }).click();
  await status.getByRole('button', { name: '进行中', exact: true }).click();
  await expect(rows).toHaveCount(2);
  await expect(
    status.getByRole('button', { name: '进行中', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  for (const name of ['待评审', '已归档']) {
    const button = status.getByRole('button', { name, exact: true });
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', `暂无处于「${name}」的需求`);
  }

  // One action clears the title, status and stage choices together.
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(page.getByLabel('筛选需求列表', { exact: true })).toHaveValue(
    '',
  );
  await expect(
    status.getByRole('button', { name: '全部', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(
    stage.getByRole('button', { name: '全部阶段', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true');
  await expect(rows.last()).toBeVisible();

  // Export is announced but not offered as a working action yet.
  await expect(
    page.getByRole('button', { name: '导出 CSV', exact: true }),
  ).toBeDisabled();
  void stays;
});
