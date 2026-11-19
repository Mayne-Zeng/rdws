import { test, expect, type Page } from '@playwright/test';
import { randomUUID } from 'node:crypto';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';

test.beforeEach(async ({ page, baseURL }) => {
  const accounts = await readTestAccounts();
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((a) => a.username === 'manager')!,
  );
});

async function createRequirement(page: Page, origin: string) {
  const { members } = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  const title = 'Workbench keyboard ' + randomUUID();
  const response = await page.request.post('/api/projects/poc/requirements', {
    headers: { origin },
    data: {
      commandId: randomUUID(),
      title,
      description: 'Synthetic workbench interaction fixture',
      acceptance: 'Keyboard and query recovery',
      leadId: members.find((m: { name: string }) => m.name === 'lead').id,
      participants: [],
    },
  });
  expect(response.status()).toBe(200);
  return { id: (await response.json()).id as string, title };
}

for (const failure of ['abort', 'invalid-json'] as const)
  test(`requirement ${failure} protects the original intent through a denied retry`, async ({
    page,
  }) => {
    await page.route('**/api/projects', async (route) => {
      const response = await route.fetch();
      const data = await response.json();
      data.projects.push({
        ...data.projects[0],
        id: 'synthetic-second-project',
      });
      await route.fulfill({ response, json: data });
    });
    await page.goto('/?project=poc&view=create');
    const title = 'Protected create ' + randomUUID();
    await page.getByLabel('需求标题', { exact: true }).fill(title);
    await page.getByLabel('需求描述', { exact: true }).fill('Original content');
    await page.getByLabel('验收标准', { exact: true }).fill('One requirement');
    await page
      .getByLabel('开发负责人', { exact: true })
      .selectOption({ label: 'lead' });
    await page.getByLabel('dev · 开发人员', { exact: true }).check();
    await page.getByRole('button', { name: '添加初始子任务' }).click();
    await page
      .getByLabel('子任务标题 1', { exact: true })
      .fill('Original task');
    const bodies: string[] = [];
    await page.route('**/api/projects/poc/requirements', async (route) => {
      if (route.request().method() !== 'POST') return route.continue();
      bodies.push(route.request().postData()!);
      if (bodies.length === 1) {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        if (failure === 'abort') await route.abort('failed');
        else
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: '{',
          });
      } else if (bodies.length === 2)
        await route.fulfill({
          status: 403,
          json: { error: 'Synthetic permission rejection' },
        });
      else await route.continue();
    });
    await page.getByRole('button', { name: '创建需求', exact: true }).click();
    const retry = page.getByRole('button', { name: '重试原操作', exact: true });
    await expect(retry).toBeVisible();
    await expect(page.getByLabel('需求标题', { exact: true })).toBeDisabled();
    await page
      .getByLabel('需求标题', { exact: true })
      .evaluate((el) => el.focus());
    await page.keyboard.type('Accidental change');
    await expect(page.getByLabel('需求标题', { exact: true })).toHaveValue(
      title,
    );
    await expect(
      page.getByLabel('dev · 开发人员', { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByLabel('子任务标题 1', { exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '取消', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '返回需求列表', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '新建需求', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '需求管理', exact: true }),
    ).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '设计系统', exact: true }),
    ).toBeDisabled();
    await expect(page.getByLabel('切换项目')).toBeDisabled();
    await page.setViewportSize({ width: 820, height: 900 });
    const createEntry = page.getByRole('button', {
      name: '新建需求',
      exact: true,
    });
    await expect(createEntry).toBeDisabled();
    await expect(page.getByLabel('切换项目')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '退出登录', exact: true }),
    ).toBeVisible();

    await page.setViewportSize({ width: 390, height: 900 });
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await expect(createEntry).toBeDisabled();
    await expect(page.getByLabel('切换项目')).toBeVisible();
    await expect(page.locator('.project-metrics')).toBeHidden();
    await createEntry.evaluate((element) =>
      (element as HTMLButtonElement).focus(),
    );
    await expect(createEntry).not.toBeFocused();
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(
      page.getByRole('button', { name: '退出登录', exact: true }),
    ).toBeEnabled();
    await page.locator('.rail .brand').click({ force: true });
    await expect(
      page.getByRole('heading', { name: '新建需求', exact: true }),
    ).toBeVisible();
    await retry.click();
    await expect(
      page.getByText('Synthetic permission rejection', { exact: true }),
    ).toBeVisible();
    await expect(page.getByLabel('需求标题', { exact: true })).toBeDisabled();
    await expect(
      page.getByRole('button', { name: '创建需求', exact: true }),
    ).toBeDisabled();
    await retry.click();
    await expect(
      page.getByRole('heading', { name: title, exact: true }),
    ).toBeVisible();
    expect(bodies).toHaveLength(3);
    expect(new Set(bodies).size).toBe(1);
    const { requirements } = await (
      await page.request.get('/api/projects/poc/requirements')
    ).json();
    expect(
      requirements.filter((r: { title: string }) => r.title === title),
    ).toHaveLength(1);
    await page.getByRole('button', { name: '新建需求', exact: true }).click();
    await expect(page.getByLabel('需求标题', { exact: true })).toBeEnabled();
  });

test('a first definite create rejection allows corrected content and a new command', async ({
  page,
}) => {
  await page.goto('/?project=poc&view=create');
  await page.getByLabel('需求标题', { exact: true }).fill('Before correction');
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  const bodies: { commandId: string; title: string }[] = [];
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postDataJSON());
    if (bodies.length === 1)
      await route.fulfill({
        status: 400,
        json: { error: 'Synthetic validation rejection' },
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  await expect(
    page.getByText('Synthetic validation rejection', { exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('需求标题', { exact: true })).toBeEnabled();
  const title = 'Corrected create ' + randomUUID();
  await page.getByLabel('需求标题', { exact: true }).fill(title);
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]!.commandId).not.toBe(bodies[1]!.commandId);
});

test('a definite validation failure resolves a pending create', async ({
  page,
}) => {
  await page.goto('/?project=poc&view=create');
  const title = page.getByLabel('需求标题', { exact: true });
  await title.fill('Pending local fixture');
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  let attempts = 0;
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts++;
    await route.fulfill({
      status: attempts === 1 ? 503 : 400,
      json: { error: attempts === 1 ? '暂不能核对' : '分派成员已停用' },
    });
  });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试原操作', exact: true });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText('分派成员已停用')).toBeVisible();
  await expect(title).toBeEnabled();
});

test('a lost create acknowledgement survives reload and worktree preparation is retriable', async ({
  page,
}) => {
  await page.goto('/?project=poc&view=create');
  const title = 'Worktree recovery ' + randomUUID();
  await page.getByLabel('需求标题', { exact: true }).fill(title);
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  const bodies: string[] = [];
  let id = '';
  let prepared = false;
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    bodies.push(route.request().postData()!);
    if (bodies.length > 1) return route.continue();
    const response = await route.fetch();
    expect(response.status()).toBe(200);
    id = (await response.json()).id;
    await route.fulfill({ status: 401, json: { error: '创建回执暂不可读' } });
  });
  await page.route('**/api/requirements/*/worktrees', async (route) => {
    if (
      id &&
      new URL(route.request().url()).pathname ===
        '/api/requirements/' + id + '/worktrees'
    ) {
      if (route.request().method() === 'POST') {
        prepared = true;
        return route.fulfill({ json: { state: 'ready' } });
      }
      return route.fulfill({
        json: {
          state: prepared ? 'ready' : 'pending',
          canPrepare: true,
          repositories: [
            {
              repositoryId: 'fixture',
              baseCommit: 'a'.repeat(40),
              branch: 'rdws/' + id + '/fixture',
              worktreePath: 'worktrees/fixture',
              gitStorePath: '.gitstore/fixture.git',
            },
          ],
        },
      });
    }
    return route.continue();
  });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  const retry = page.getByRole('button', { name: '重试原操作', exact: true });
  await expect(retry).toBeVisible();
  await page.reload();
  await expect(page.getByText('有一条需求创建命令待核对。')).toBeVisible();
  await retry.click();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
  expect(bodies).toHaveLength(2);
  expect(bodies[0]).toBe(bodies[1]);
  expect(new URL(page.url()).searchParams.get('requirement')).toBe(id);
  const workspace = page.getByRole('region', { name: '需求工作树' });
  await expect(workspace.getByText('待准备', { exact: true })).toBeVisible();
  await workspace.getByRole('button', { name: '重试准备工作树' }).click();
  await expect(workspace.getByText('已就绪', { exact: true })).toBeVisible();
  await expect(workspace.getByText('worktrees/fixture')).toBeVisible();
  await page.setViewportSize({ width: 390, height: 900 });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    await expect(page.locator('html')).toHaveAttribute(
      'theme-mode',
      colorScheme,
    );
    await expect(workspace.getByText('worktrees/fixture')).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
  }
});

test('mobile navigation contains keyboard focus and tabs support arrows', async ({
  page,
  baseURL,
}) => {
  const requirement = await createRequirement(page, baseURL!);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`/?project=poc&requirement=${requirement.id}&view=overview`);
  const trigger = page.getByRole('button', {
    name: '打开导航',
    exact: true,
    includeHidden: true,
  });
  await trigger.focus();
  await page.keyboard.press('Shift+Tab');
  expect(
    await page
      .locator('.rail')
      .evaluate((el) => el.contains(document.activeElement)),
  ).toBe(false);
  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');
  const first = page.locator('.rail .brand');
  await expect(first).toBeFocused();
  await page
    .locator('.workspace-tabs [role="tab"]')
    .first()
    .evaluate((el) => (el as HTMLElement).focus());
  await expect(first).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(
    page.getByRole('button', { name: '退出登录', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(first).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('Enter');
  await page
    .getByRole('button', { name: requirement.title, exact: true })
    .click();
  await expect(trigger).toBeFocused();
  await page.keyboard.press('Enter');
  await page.setViewportSize({ width: 820, height: 900 });
  await expect(page.locator('.workspace-main')).not.toHaveAttribute(
    'inert',
    '',
  );
  await expect(
    page.getByRole('button', { name: '需求管理', exact: true }),
  ).toBeFocused();
  await page.setViewportSize({ width: 390, height: 900 });
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  const overview = page.getByRole('tab', { name: '需求档案', exact: true });
  await overview.focus();
  await page.keyboard.press('ArrowRight');
  const context = page.getByRole('tab', { name: '上下文', exact: true });
  await expect(context).toBeFocused();
  await expect(context).toHaveAttribute('aria-selected', 'true');
  await expect(
    page.getByRole('tabpanel', { name: '上下文', exact: true }),
  ).toBeVisible();
  await page.keyboard.press('Home');
  await expect(
    page.getByRole('tab', { name: '对话', exact: true }),
  ).toBeFocused();
  await page.keyboard.press('End');
  await expect(context).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(overview).toBeFocused();
  await expect(overview).toHaveAttribute('aria-selected', 'true');
  expect(
    await overview.evaluate((el) => getComputedStyle(el).outlineStyle),
  ).toBe('solid');
  await page.keyboard.press('Tab');
  await expect(page.getByRole('tabpanel')).toBeFocused();
});

test('member loading and failure recover before a busy create protects navigation', async ({
  page,
}) => {
  let mode: 'pending' | 'error' | 'ready' = 'pending';
  let releaseMembers!: () => void;
  const memberGate = new Promise<void>((resolve) => {
    releaseMembers = resolve;
  });
  await page.route('**/api/projects/poc/members', async (route) => {
    if (mode === 'pending') await memberGate;
    if (mode === 'error')
      await route.fulfill({
        status: 503,
        json: { error: 'Synthetic member outage' },
      });
    else await route.continue();
  });
  await page.goto('/?project=poc&view=create');
  await expect(
    page.getByText('正在读取项目成员', { exact: true }),
  ).toBeVisible();
  mode = 'error';
  releaseMembers();
  await expect(
    page.getByRole('button', { name: '重试读取项目成员', exact: true }),
  ).toBeVisible();
  mode = 'ready';
  await page
    .getByRole('button', { name: '重试读取项目成员', exact: true })
    .click();
  const title = 'Busy create ' + randomUUID();
  await page.getByLabel('需求标题', { exact: true }).fill(title);
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  let releaseCreate!: () => void;
  const createGate = new Promise<void>((resolve) => {
    releaseCreate = resolve;
  });
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const response = await route.fetch();
    await createGate;
    await route.fulfill({ response });
  });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  await expect(page.getByLabel('需求标题', { exact: true })).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '取消', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '需求管理', exact: true }),
  ).toBeDisabled();
  await expect(
    page.getByRole('button', { name: '设计系统', exact: true }),
  ).toBeDisabled();
  expect(
    await page
      .getByRole('button', { name: '创建需求', exact: true })
      .evaluate((el) => Number(getComputedStyle(el).opacity)),
  ).toBe(0.45);
  releaseCreate();
  await expect(
    page.getByRole('heading', { name: title, exact: true }),
  ).toBeVisible();
});

test('failed queries offer recovery without claiming an empty project and filters remain reachable', async ({
  page,
  baseURL,
}) => {
  const requirement = await createRequirement(page, baseURL!);
  let failing = true;
  await page.route('**/api/projects/poc/requirements', async (route) => {
    if (failing)
      await route.fulfill({
        status: 503,
        json: { error: 'Synthetic list outage' },
      });
    else await route.continue();
  });
  await page.setViewportSize({ width: 820, height: 900 });
  await page.goto('/?project=poc&view=requirements');
  await expect(
    page.getByRole('button', { name: '重试读取需求列表', exact: true }),
  ).toBeVisible();
  await expect(page.getByText('从一个需求开始', { exact: true })).toHaveCount(
    0,
  );
  await expect(page.getByText('暂无可访问需求', { exact: true })).toHaveCount(
    0,
  );
  failing = false;
  await page
    .getByRole('button', { name: '重试读取需求列表', exact: true })
    .click();
  const filter = page.getByLabel('筛选需求列表', { exact: true });
  await filter.fill(requirement.title);
  await expect(page.locator('.requirement-row')).toHaveCount(1);
  await filter.fill('no-match-' + randomUUID());
  await expect(
    page.getByText('没有匹配的需求', { exact: true }).last(),
  ).toBeVisible();
  await page.getByRole('button', { name: '清除筛选', exact: true }).click();
  await expect(filter).toHaveValue('');
  let detailFailed = true;
  await page.route(`**/api/requirements/${requirement.id}`, async (route) => {
    if (detailFailed)
      await route.fulfill({
        status: 503,
        json: { error: 'Synthetic detail outage' },
      });
    else await route.continue();
  });
  await filter.fill(requirement.title);
  const list = page.getByRole('table', { name: '需求列表', exact: true });
  await expect(list.getByRole('columnheader')).toHaveText([
    '编号',
    '需求',
    '阶段',
  ]);
  const open = list.getByRole('button', {
    name: '查看需求 ' + requirement.title,
    exact: true,
  });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('button', { name: '重试读取需求档案', exact: true }),
  ).toBeVisible();
  detailFailed = false;
  await page
    .getByRole('button', { name: '重试读取需求档案', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: requirement.title, exact: true }),
  ).toBeVisible();
});
