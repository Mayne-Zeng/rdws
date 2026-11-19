import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('project audit searches authorized demands, exports a page and resets on project change', async ({
  page,
  baseURL,
}, testInfo) => {
  const db = createTestPool('migration');
  const project = 'audit-browser-' + randomUUID();
  const secondProject = 'audit-browser-' + randomUUID();
  const foreignProject = 'audit-browser-' + randomUUID();
  const projects = [project, secondProject, foreignProject];
  const demands = [
    { id: randomUUID(), projectId: project, title: '业务审计验收甲' },
    { id: randomUUID(), projectId: project, title: '业务审计验收乙' },
    { id: randomUUID(), projectId: project, title: '项目内未授权需求' },
    { id: randomUUID(), projectId: secondProject, title: '另一项目已授权需求' },
    { id: randomUUID(), projectId: foreignProject, title: '外部项目需求' },
  ];
  const ids = demands.map(({ id }) => id);
  const marker = 'SYNTHETIC_PROJECT_AUDIT_PRIVATE_' + randomUUID();
  let isolated = false;
  let releaseOld: (() => void) | undefined;
  try {
    expect(
      (await db.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const [actor] = (
      await db.query("select id from auth_user where username='tester'")
    ).rows;
    for (const [index, projectId] of projects.entries()) {
      await db.query('insert into project(id,name) values($1,$2)', [
        projectId,
        '审计浏览器夹具 ' + (index + 1),
      ]);
      if (index < 2)
        await db.query("insert into project_member values($1,$2,'tester')", [
          projectId,
          actor.id,
        ]);
    }
    for (const [index, { id, projectId, title }] of demands.entries()) {
      await db.query(
        'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$4,$5,$5)',
        [id, projectId, title, '', actor.id],
      );
      if (index !== 2 && index !== 4)
        await db.query(
          "insert into requirement_participant values($1,$2,'tester')",
          [id, actor.id],
        );
      await db.query(
        'insert into requirement_event(id,requirement_id,kind,actor_id,source,command_id,version,"after") values($1,$2,$3,$4,\'web\',$5,1,$6)',
        [
          randomUUID(),
          id,
          index === 1 ? 'task.created' : 'requirement.details',
          actor.id,
          randomUUID(),
          JSON.stringify({ description: marker, status: 'todo' }),
        ],
      );
    }
    const accounts = await readTestAccounts();
    const login = await prepareSession(
      page.context(),
      baseURL!,
      accounts.find(({ username }) => username === 'tester')!,
    );
    let denied = false;
    let holdOld = false;
    let oldReady = false;
    let oldReleased = false;
    const held = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route(
      `**/api/projects/${project}/business-audit*`,
      async (route) => {
        expect(route.request().headers()['x-rdws-edit-session']).toBe(
          login.session.id,
        );
        if (holdOld) {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          oldReady = true;
          await held;
          await route.fulfill({ response }).catch(() => {});
          oldReleased = true;
          return;
        }
        return denied
          ? route.fulfill({ status: 403, json: { error: '合成撤权响应' } })
          : route.continue();
      },
    );
    await page.goto(`/?project=${project}`);
    await page.getByRole('button', { name: '审计中心', exact: true }).click();
    const audit = page.getByRole('region', { name: '审计中心' });
    const events = audit.getByRole('list', { name: '业务审计事件' });
    const search = audit.getByLabel('搜索需求或操作者');
    const submit = audit.getByRole('button', { name: '搜索', exact: true });
    const download = audit.getByRole('button', { name: '导出当前页 CSV' });
    await expect(
      audit.getByText(demands[0]!.title, { exact: false }),
    ).toBeVisible();
    await expect(
      audit.getByText(demands[1]!.title, { exact: false }),
    ).toBeVisible();
    await expect(
      audit.getByText(demands[2]!.title, { exact: false }),
    ).toHaveCount(0);
    await expect(
      audit.getByText(demands[4]!.title, { exact: false }),
    ).toHaveCount(0);
    await audit.getByLabel('事件类型').selectOption('requirement.details');
    await submit.click();
    await expect(
      audit.getByText(demands[0]!.title, { exact: false }),
    ).toBeVisible();
    await expect(
      audit.getByText(demands[1]!.title, { exact: false }),
    ).toHaveCount(0);
    await search.fill('无匹配记录');
    await submit.click();
    await expect(audit.getByText('没有匹配的业务事件。')).toBeVisible();
    await search.fill('验收甲');
    await submit.click();
    await events.getByText('编辑需求资料', { exact: true }).click();
    await expect(audit.getByText('变更字段 需求说明')).toBeVisible();
    const requested = page.waitForEvent('download');
    await download.click();
    const csv = await requested;
    expect(csv.suggestedFilename()).toBe(`business-audit-${project}.csv`);
    const data = await readFile(await csv.path(), 'utf8');
    expect(data).toContain(demands[0]!.id);
    expect(data).not.toContain(demands[1]!.id);
    expect(data).not.toContain(marker);

    denied = true;
    await submit.click();
    await expect(audit.getByText('读取项目审计失败，请重试。')).toBeVisible();
    await expect(download).toHaveCount(0);
    await expect(events.getByText('编辑需求资料', { exact: true })).toHaveCount(
      0,
    );
    denied = false;
    await audit.getByRole('button', { name: '重试读取项目审计' }).click();
    await expect(
      events.getByText('编辑需求资料', { exact: true }),
    ).toBeVisible();
    holdOld = true;
    await submit.click();
    await expect.poll(() => oldReady).toBe(true);
    await page.getByLabel('切换项目').selectOption(secondProject);
    await expect(
      audit.getByText(demands[3]!.title, { exact: false }),
    ).toBeVisible();
    await expect(
      audit.getByText(demands[0]!.title, { exact: false }),
    ).toHaveCount(0);
    await expect(search).toHaveValue('');
    await expect(audit.getByLabel('事件类型')).toHaveValue('');
    releaseOld?.();
    await expect.poll(() => oldReleased).toBe(true);
    await expect(
      audit.getByText(demands[3]!.title, { exact: false }),
    ).toBeVisible();
    await expect(
      audit.getByText(demands[0]!.title, { exact: false }),
    ).toHaveCount(0);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await audit.screenshot({
      path: testInfo.outputPath('project-audit-light-390.png'),
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    await audit.screenshot({
      path: testInfo.outputPath('project-audit-dark-390.png'),
    });
    await page.goto(`/?project=${foreignProject}&view=audit`);
    await expect(
      page.getByRole('heading', { name: '无法访问指定项目' }),
    ).toBeVisible();
  } finally {
    releaseOld?.();
    try {
      if (isolated) {
        await db.query(
          'delete from requirement_event where requirement_id=any($1::text[])',
          [ids],
        );
        await db.query(
          'delete from requirement_participant where requirement_id=any($1::text[])',
          [ids],
        );
        await db.query('delete from requirement where id=any($1::text[])', [
          ids,
        ]);
        await db.query(
          'delete from project_member where project_id=any($1::text[])',
          [projects],
        );
        await db.query('delete from project where id=any($1::text[])', [
          projects,
        ]);
      }
    } finally {
      await db.end();
    }
  }
});

test('project permission audit follows the current project administrator scope', async ({
  page,
  baseURL,
}, testInfo) => {
  const db = createTestPool('migration');
  const project = 'access-audit-browser-' + randomUUID();
  const secondProject = 'access-audit-browser-' + randomUUID();
  const projects = [project, secondProject];
  const commandId = randomUUID();
  let isolated = false;
  let releaseOld: (() => void) | undefined;
  try {
    expect(
      (await db.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const [actor] = (
      await db.query("select id from auth_user where username='pm'")
    ).rows;
    for (const [index, projectId] of projects.entries()) {
      await db.query('insert into project(id,name) values($1,$2)', [
        projectId,
        '权限审计浏览器夹具 ' + (index + 1),
      ]);
      await db.query('insert into project_member values($1,$2,$3)', [
        projectId,
        actor.id,
        index === 0 ? 'project_admin' : 'tester',
      ]);
    }
    const accounts = await readTestAccounts();
    const login = await prepareSession(
      page.context(),
      baseURL!,
      accounts.find(({ username }) => username === 'pm')!,
    );
    const saved = await page.request.post('/api/management/commands', {
      headers: { origin: baseURL! },
      data: {
        kind: 'project.roles',
        projectId: project,
        commandId,
        username: 'tester',
        roles: ['developer'],
      },
    });
    expect(saved.status()).toBe(200);
    let mode: 'allow' | 'deny' | 'hold' = 'allow';
    let oldReady = false;
    let oldReleased = false;
    const held = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    await page.route(
      `**/api/projects/${project}/access-audit*`,
      async (route) => {
        expect(route.request().headers()['x-rdws-edit-session']).toBe(
          login.session.id,
        );
        if (mode === 'deny')
          return route.fulfill({
            status: 403,
            json: { error: '合成撤权响应' },
          });
        if (mode === 'hold') {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          oldReady = true;
          await held;
          await route.fulfill({ response }).catch(() => {});
          oldReleased = true;
          return;
        }
        return route.continue();
      },
    );
    await page.goto(`/?project=${project}&view=audit`);
    const audit = page.getByRole('region', { name: '审计中心' });
    const permissionTab = audit.getByRole('button', { name: '权限事件' });
    const businessTab = audit.getByRole('button', { name: '业务事件' });
    const events = audit.getByRole('list', { name: '项目权限事件' });
    const entry = events.getByText(/^项目角色变更/);
    const download = audit.getByRole('button', { name: '导出当前页 CSV' });
    await expect(businessTab).toHaveAttribute('aria-pressed', 'true');
    await permissionTab.click();
    await expect(permissionTab).toHaveAttribute('aria-pressed', 'true');
    await entry.click();
    await expect(events.getByText('变更前角色 无')).toBeVisible();
    await expect(events.getByText('变更后角色 开发人员')).toBeVisible();
    await expect(events.getByText('操作标识 ' + commandId)).toBeVisible();
    const requested = page.waitForEvent('download');
    await download.click();
    const csv = await requested;
    expect(csv.suggestedFilename()).toBe(`project-access-audit-${project}.csv`);
    const data = await readFile(await csv.path(), 'utf8');
    expect(data).toContain('"变更前角色","变更后角色","操作标识"');
    expect(data).toContain(`"无","开发人员","${commandId}"`);

    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await audit.screenshot({
      path: testInfo.outputPath('project-access-audit-light-390.png'),
    });
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    await audit.screenshot({
      path: testInfo.outputPath('project-access-audit-dark-390.png'),
    });
    await page.setViewportSize({ width: 1280, height: 820 });

    mode = 'deny';
    await businessTab.click();
    await permissionTab.click();
    await expect(audit.getByText('读取权限事件失败，请重试。')).toBeVisible();
    await expect(entry).toHaveCount(0);
    await expect(download).toHaveCount(0);
    mode = 'allow';
    await audit.getByRole('button', { name: '重试读取权限事件' }).click();
    await expect(entry).toBeVisible();
    mode = 'hold';
    await businessTab.click();
    await permissionTab.click();
    await expect.poll(() => oldReady).toBe(true);
    await expect(entry).toHaveCount(0);
    await page.getByLabel('切换项目').selectOption(secondProject);
    await expect(audit.getByLabel('搜索需求或操作者')).toBeVisible();
    await expect(permissionTab).toHaveCount(0);
    releaseOld?.();
    await expect.poll(() => oldReleased).toBe(true);
    await expect(entry).toHaveCount(0);
    await expect(permissionTab).toHaveCount(0);
    await expect(download).toHaveCount(0);
  } finally {
    releaseOld?.();
    try {
      if (isolated) {
        await db.query(
          'delete from command_receipt where scope=any($1::text[])',
          [projects.map((projectId) => 'project:' + projectId)],
        );
        await db.query(
          'delete from project_member where project_id=any($1::text[])',
          [projects],
        );
        await db.query('delete from project where id=any($1::text[])', [
          projects,
        ]);
      }
    } finally {
      await db.end();
    }
  }
});
