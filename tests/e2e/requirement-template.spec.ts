import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { TemplateBindingInput } from '@rdws/contracts';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('requirement template recovery stays with the same command and the current authorized view', async ({
  page,
  baseURL,
}, testInfo) => {
  const db = createTestPool('migration');
  const id = randomUUID(),
    other = randomUUID(),
    templateId = randomUUID();
  const title = `模板绑定 ${id.slice(0, 8)}`,
    otherTitle = `其他需求 ${other.slice(0, 8)}`;
  const template = `审核模板 ${templateId.slice(0, 8)}`;
  const reference = 'platform/binding-browser-' + randomUUID();
  const project = 'binding-browser-' + randomUUID();
  const path = `/api/requirements/${id}/capability-template`;
  const url = `/?project=${project}&view=context&requirement=${id}`;
  const accounts = await readTestAccounts();
  const login = (username: string) =>
    prepareSession(
      page.context(),
      baseURL!,
      accounts.find((row) => row.username === username)!,
    );
  const received: TemplateBindingInput[] = [];
  let firstSession = '';
  let firstRequestMatches = false;
  let outcome:
    | 'rejected-after-commit'
    | 'not-sent'
    | 'hold-completion'
    | 'partial-receipt'
    | undefined;
  let readDenied = false;
  let pausedReads: Promise<void> | undefined;
  let resumeReads: () => void = () => {};
  let isolated = false;
  let release!: () => void, notifyArrival!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const arrived = new Promise<void>((resolve) => {
    notifyArrival = resolve;
  });
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    const safety = (
      await db.query('select current_database() db, session_user as role')
    ).rows[0];
    expect(safety).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const [lead, manager] = (
      await db.query(
        "select id from auth_user where username in ('lead','pm') order by username",
      )
    ).rows;
    await db.query('insert into project(id,name) values($1,$2)', [
      project,
      '模板浏览器夹具',
    ]);
    await db.query(
      "insert into project_member values($1,$2,'developer'),($1,$3,'project_admin'),($1,$3,'requirement_manager')",
      [project, lead.id, manager.id],
    );
    for (const [demand, name] of [
      [id, title],
      [other, otherTitle],
    ]) {
      await db.query(
        'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
        [demand, project, name, '同页上下文证据', '仅验证模板绑定', lead.id],
      );
    }
    await db.query(
      "insert into requirement_participant values($1,$2,'developer'),($1,$3,'requirement_manager')",
      [id, lead.id, manager.id],
    );
    for (const revision of [1, 2]) {
      await db.query(
        "insert into capability_approval values('skill',$1,$2,true)",
        [reference, String(revision)],
      );
      await db.query(
        'insert into capability_template_revision values($1,$2,$3,$4,$5,$6)',
        [
          templateId,
          revision,
          project,
          template,
          '',
          JSON.stringify([
            { kind: 'skill', reference, revision: String(revision) },
          ]),
        ],
      );
    }
    await page.route(`**/api/requirements/${id}`, async (route) => {
      await pausedReads;
      return route.continue();
    });
    await page.route('**' + path, async (route) => {
      if (route.request().method() === 'GET') {
        await pausedReads;
        if (readDenied)
          return route.fulfill({
            status: 403,
            json: { error: '当前项目权限不可用' },
          });
        return route.continue();
      }
      const operation = route.request().postDataJSON() as TemplateBindingInput;
      received.push(operation);
      if (received.length === 1) {
        firstRequestMatches =
          route.request().headers()['x-rdws-edit-session'] === firstSession;
        if (!firstRequestMatches) return route.abort('failed');
      }
      const mode = outcome;
      outcome = undefined;
      if (mode === 'not-sent') return route.abort('failed');
      if (mode === 'partial-receipt')
        return route.fulfill({
          status: 200,
          json: { commandId: operation.commandId, status: 'unchanged' },
        });
      if (mode === 'rejected-after-commit') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        return route.fulfill({ status: 403, json: { error: '授权已变化' } });
      }
      if (mode === 'hold-completion') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        notifyArrival();
        await held;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    firstSession = (await login('pm')).session.id;
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(url);
    const panel = page.getByRole('region', { name: '需求能力模板' });
    const picker = panel.getByLabel('已发布模板版本');
    const submit = panel.getByRole('button', { name: '保存模板绑定' });
    const reconcile = panel.getByRole('button', { name: '核对原绑定操作' });
    await expect(panel.getByText('尚未绑定能力模板。')).toBeVisible();
    await picker.selectOption(`${templateId}:1`);
    outcome = 'rejected-after-commit';
    await submit.click();
    await expect.poll(() => firstRequestMatches).toBe(true);
    await expect(reconcile).toBeEnabled();
    await expect(panel.getByText(template, { exact: true })).toBeVisible();
    await expect(
      panel.getByRole('status').filter({ hasText: '模板绑定已保存' }),
    ).toHaveCount(0);
    await login('pm');
    await page.reload();
    await reconcile.click();
    await expect(panel.getByText('模板绑定已保存。')).toBeVisible();
    expect(received[1]).toEqual(received[0]);
    await expect(
      panel.getByText(
        '新建会话会核对绑定版本。已有会话和派生会话沿用原能力版本。',
      ),
    ).toBeVisible();

    await picker.selectOption(`${templateId}:2`);
    outcome = 'not-sent';
    await submit.click();
    await expect(reconcile).toBeEnabled();
    await expect.poll(() => received.length).toBe(3);
    const unsubmitted = received[2]!;
    expect(
      (
        await db.query('select 1 from command_receipt where command_id=$1', [
          unsubmitted.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      panel.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    await db.query("insert into project_member values($1,$2,'project_admin')", [
      project,
      lead.id,
    ]);
    pausedReads = new Promise<void>((resolve) => {
      resumeReads = resolve;
    });
    await login('lead');
    const staleResponse = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST',
    );
    await reconcile.click();
    const rejected = await staleResponse;
    expect(rejected.status()).toBe(401);
    expect(rejected.headers()['cache-control']).toBe('no-store');
    expect(received.at(-1)).toEqual(unsubmitted);
    expect(
      (
        await db.query('select 1 from command_receipt where command_id=$1', [
          unsubmitted.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await db.query(
          'select revision from requirement_capability_binding where requirement_id=$1',
          [id],
        )
      ).rows,
    ).toEqual([{ revision: 1 }]);
    await db.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='project_admin'",
      [project, lead.id],
    );
    await login('pm');
    resumeReads();
    pausedReads = undefined;
    await db.query(
      "update capability_approval set approved=false where reference=$1 and revision='2'",
      [reference],
    );
    await page.reload();
    await reconcile.click();
    await expect(
      panel.getByText('所选版本已不可用，当前绑定未变更。'),
    ).toBeVisible();
    expect(received.at(-1)).toEqual(unsubmitted);
    await expect(picker.locator(`option[value="${templateId}:2"]`)).toHaveCount(
      0,
    );
    await expect(picker).toBeVisible();
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath('requirement-template-light-390.png'),
    });

    await page.setViewportSize({ width: 1440, height: 900 });
    await picker.selectOption(`${templateId}:1`);
    outcome = 'hold-completion';
    await submit.click();
    await arrived;
    const lateCommand = received.at(-1)!;
    await page.getByRole('button', { name: otherTitle, exact: true }).click();
    await page.getByRole('tab', { name: '上下文' }).click();
    await expect(panel.getByText('尚未绑定能力模板。')).toBeVisible();
    await expect(reconcile).toHaveCount(0);
    readDenied = true;
    await page.getByRole('button', { name: title, exact: true }).click();
    await page.getByRole('tab', { name: '上下文' }).click();
    await expect(panel.getByText('当前项目权限不可用')).toBeVisible();
    const delivered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST',
    );
    release();
    await delivered;
    await expect(picker).toHaveCount(0);
    await expect(panel.getByText('当前已绑定该版本。')).toHaveCount(0);
    await expect(page.getByText('同页上下文证据')).toBeVisible();
    readDenied = false;
    await panel.getByRole('button', { name: '重试读取绑定' }).click();
    await reconcile.click();
    await expect(panel.getByText('当前已绑定该版本。')).toBeVisible();
    expect(received.at(-1)).toEqual(lateCommand);

    await picker.selectOption(`${templateId}:1`);
    outcome = 'partial-receipt';
    await submit.click();
    await expect(
      panel.getByText('响应与原操作不匹配，请核对原操作。'),
    ).toBeVisible();
    const incomplete = received.at(-1)!;
    await reconcile.click();
    await expect(panel.getByText('当前已绑定该版本。')).toBeVisible();
    expect(received.at(-1)).toEqual(incomplete);

    await db.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='project_admin'",
      [project, manager.id],
    );
    await expect(picker).toHaveCount(0);
    await expect(panel.getByText('当前已绑定该版本。')).toHaveCount(0);
    await expect(panel.getByText(template, { exact: true })).toBeVisible();

    await login('lead');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    await expect(panel.getByText(template, { exact: true })).toBeVisible();
    await expect(picker).toHaveCount(0);
    await expect(reconcile).toHaveCount(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await panel.screenshot({
      path: testInfo.outputPath('requirement-template-dark-390.png'),
    });
    expect(errors).toEqual([]);
  } finally {
    resumeReads();
    release();
    if (isolated) {
      await db.query(
        'delete from requirement_capability_binding where requirement_id=any($1::text[])',
        [[id, other]],
      );
      await db.query(
        'delete from requirement_participant where requirement_id=$1',
        [id],
      );
      await db.query('delete from requirement where id=any($1::text[])', [
        [id, other],
      ]);
      await db.query(
        'delete from capability_template_revision where template_id=$1',
        [templateId],
      );
      await db.query('delete from capability_approval where reference=$1', [
        reference,
      ]);
      await db.query(
        'delete from command_receipt where scope=any($1::text[])',
        [['requirement:' + id, 'requirement:' + other]],
      );
      await db.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await db.query('delete from project where id=$1', [project]);
    }
    await db.end();
  }
});
