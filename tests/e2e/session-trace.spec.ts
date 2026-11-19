import { randomUUID } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { test, expect } from '@playwright/test';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('business audit opens recorded anchors without loading the Native trace', async ({
  page,
  baseURL,
}, testInfo) => {
  test.setTimeout(60000);
  const db = createTestPool('migration');
  const landing = 'anchor-landing-' + randomUUID();
  const project = 'anchor-audit-' + randomUUID();
  const demand = randomUUID(),
    related = randomUUID();
  const session = 'session-' + randomUUID(),
    empty = 'session-' + randomUUID(),
    relatedSession = 'session-' + randomUUID();
  const title = '物理锚点验收 ' + demand.slice(0, 10);
  const relatedTitle = '同项目另一需求 ' + related.slice(0, 10);
  const sha = 'ab'.repeat(32);
  const bucket = '5'.repeat(64);
  const at = '2026-01-12T10:22:33.987654Z';
  const path = `/api/requirements/${demand}/sessions/${session}/anchors`;
  let isolated = false;
  let releaseOld: (() => void) | undefined;
  let releaseAuth: (() => void) | undefined;
  try {
    expect(
      (await db.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const account = (await readTestAccounts()).find(
      ({ username }) => username === 'tester',
    )!;
    const original = await prepareSession(page.context(), baseURL!, account);
    for (const projectId of [landing, project]) {
      await db.query('insert into project(id,name) values($1,$1)', [projectId]);
      await db.query("insert into project_member values($1,$2,'tester')", [
        projectId,
        original.user.id,
      ]);
    }
    for (const [id, name, sessionId] of [
      [demand, title, session],
      [related, relatedTitle, relatedSession],
    ] as const) {
      await db.query(
        "insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,'','',$4,$4)",
        [id, project, name, original.user.id],
      );
      await db.query(
        "insert into requirement_participant values($1,$2,'tester')",
        [id, original.user.id],
      );
      await db.query(
        'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
        [sessionId, id, original.user.id],
      );
    }
    await db.query(
      'insert into native_session(id,requirement_id,owner_id) values($1,$2,$3)',
      [empty, demand, original.user.id],
    );
    await db.query(
      `insert into requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,"after")
        values($1,$2,'requirement.details',$3,'web',$4,1,$5)`,
      [
        randomUUID(),
        demand,
        original.user.id,
        randomUUID(),
        JSON.stringify({ description: 'Synthetic anchor fixture' }),
      ],
    );
    await db.query(
      "insert into audit.session_log_anchor(project_id,session_id,bucket_sha256,journal_name,through_byte,sha256,recorded_at) values($1,$2,$3,'session.jsonl',64,$4,$5)",
      [project, session, bucket, sha, at],
    );

    const native: string[] = [];
    page.on('request', (request) => {
      const { pathname } = new URL(request.url());
      if (pathname.endsWith('/history') || pathname.startsWith('/api/dsh/'))
        native.push(pathname);
    });
    page.on('websocket', (socket) => {
      const { pathname } = new URL(socket.url());
      if (
        pathname.startsWith('/api/dsh/') ||
        pathname.includes('/api/remote.mux')
      )
        native.push(pathname);
    });
    let phase: 'allow' | 'hold' | 'unavailable' = 'allow';
    let oldReady = false;
    let oldSent = false;
    const held = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route(`**${path}*`, async (route) => {
      expect(route.request().headers()['x-rdws-edit-session']).toBe(
        original.session.id,
      );
      if (phase === 'unavailable')
        return route.fulfill({
          status: 503,
          json: { error: 'Synthetic anchor unavailable' },
        });
      if (phase === 'hold') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        oldReady = true;
        await held;
        await route.fulfill({ response }).catch(() => {});
        oldSent = true;
        return;
      }
      return route.continue();
    });
    await page.goto(`/?project=${landing}&view=audit`);
    const audit = page.getByRole('region', { name: '审计中心' });
    await audit.getByLabel('业务事件范围').selectOption('accessible');
    await audit.getByLabel('搜索需求或操作者').fill(title);
    await audit.getByRole('button', { name: '搜索', exact: true }).click();
    await audit
      .getByRole('list', { name: '业务审计事件' })
      .getByText(title, { exact: false })
      .click();
    await audit.getByRole('link', { name: '查看物理锚点' }).click();
    const viaAudit = new URL(page.url()).searchParams;
    expect(viaAudit.get('project')).toBe(project);
    expect(viaAudit.get('requirement')).toBe(demand);
    expect(viaAudit.get('panel')).toBe('anchors');
    const trace = page.getByRole('region', { name: '会话轨迹', exact: true });
    const select = trace.getByLabel('选择会话');
    const panel = trace.getByRole('region', { name: '已记录物理锚点' });
    const download = panel.getByRole('button', { name: '导出当前页锚点 CSV' });
    const digest = panel.getByText(sha, { exact: true });
    const noAnchors = panel.getByText('当前会话暂无已记录物理锚点。');
    await select.selectOption(session);
    await expect(digest).toBeVisible();
    await expect(panel.getByText('物理截止 64 字节')).toBeVisible();
    await expect(panel.getByText(at, { exact: true })).toBeVisible();
    const downloaded = page.waitForEvent('download');
    await download.click();
    const csv = await downloaded;
    expect(csv.suggestedFilename()).toBe(`anchors-${session}.csv`);
    const exported = await readFile(await csv.path(), 'utf8');
    expect(exported).toContain(`"${project}","${demand}","${session}"`);
    expect(exported).toContain(`"${at}","64","${sha}"`);
    expect(exported).not.toContain(bucket);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath('session-anchors-light-390.png'),
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    await panel.screenshot({
      path: testInfo.outputPath('session-anchors-dark-390.png'),
    });
    await page.setViewportSize({ width: 1280, height: 820 });

    await select.selectOption(empty);
    await expect(noAnchors).toBeVisible();
    phase = 'hold';
    await select.selectOption(session);
    await expect.poll(() => oldReady).toBe(true);
    await expect(download).toHaveCount(0);
    await select.selectOption(empty);
    await expect(noAnchors).toBeVisible();
    releaseOld?.();
    await expect.poll(() => oldSent).toBe(true);
    await expect(digest).toHaveCount(0);
    phase = 'unavailable';
    await select.selectOption(session);
    await expect(panel.getByText('读取物理锚点失败，请重试。')).toBeVisible();
    await expect(download).toHaveCount(0);
    phase = 'allow';
    await panel.getByRole('button', { name: '重试读取物理锚点' }).click();
    await expect(digest).toBeVisible();

    await page.getByRole('button', { name: relatedTitle, exact: true }).click();
    expect(new URL(page.url()).searchParams.get('panel')).toBe('anchors');
    await expect(select).toHaveValue('');
    await select.selectOption(relatedSession);
    await expect(noAnchors).toBeVisible();
    await page.goto(`/?project=${project}&view=overview&requirement=${demand}`);
    const requirementAudit = page.getByRole('region', {
      name: '业务审计',
      exact: true,
    });
    await requirementAudit.getByText('业务审计', { exact: true }).click();
    await requirementAudit
      .getByRole('list', { name: '业务审计事件' })
      .getByText('编辑需求资料', { exact: true })
      .click();
    await requirementAudit.getByRole('link', { name: '查看物理锚点' }).click();
    await select.selectOption(session);
    await expect(digest).toBeVisible();

    await select.selectOption(empty);
    await expect(noAnchors).toBeVisible();
    const observed = new Promise<void>((resolve) => {
      releaseAuth = resolve;
    });
    await page.route('**/api/auth/get-session', async (route) => {
      await observed;
      await route.continue();
    });
    await page.route(
      `**/api/requirements/${demand}/sessions`,
      async (route) => {
        await observed;
        await route.continue();
      },
    );
    const replacement = await prepareSession(page.context(), baseURL!, account);
    expect(replacement.user.id).toBe(original.user.id);
    expect(replacement.session.id).not.toBe(original.session.id);
    const denied = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path && response.status() === 401,
    );
    await select.selectOption(session);
    expect((await denied).request().headers()['x-rdws-edit-session']).toBe(
      original.session.id,
    );
    await expect(
      trace.getByText('会话访问已变化，请重新读取会话列表。'),
    ).toBeVisible();
    await expect(digest).toHaveCount(0);
    await expect(download).toHaveCount(0);
    expect(native).toEqual([]);
  } finally {
    releaseOld?.();
    releaseAuth?.();
    try {
      if (isolated) {
        await db.query(
          'delete from audit.session_log_anchor where session_id=$1',
          [session],
        );
        await db.query('delete from native_session where id=any($1::text[])', [
          [session, empty, relatedSession],
        ]);
        await db.query(
          'delete from requirement_event where requirement_id=any($1::text[])',
          [[demand, related]],
        );
        await db.query(
          'delete from requirement_participant where requirement_id=any($1::text[])',
          [[demand, related]],
        );
        await db.query('delete from requirement where id=any($1::text[])', [
          [demand, related],
        ]);
        await db.query(
          'delete from project_member where project_id=any($1::text[])',
          [[landing, project]],
        );
        await db.query('delete from project where id=any($1::text[])', [
          [landing, project],
        ]);
      }
    } finally {
      await db.end();
    }
  }
});

test('the passive trace shows one authorized session and exports only its loaded event summary', async ({
  page,
  browser,
  baseURL,
}) => {
  test.setTimeout(60000);
  const accounts = await readTestAccounts();
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
