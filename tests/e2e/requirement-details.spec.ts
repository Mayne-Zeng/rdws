import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { RequirementDetailsInput } from '@rdws/contracts';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('requirement details preserve the original edit across reload and discard stale authorized views', async ({
  page,
  baseURL,
}, testInfo) => {
  const pool = createTestPool('migration');
  const id = randomUUID(),
    second = randomUUID(),
    project = 'details-browser-' + randomUUID();
  const initialTitle = '资料编辑 ' + id.slice(0, 8),
    secondTitle = '其他需求 ' + second.slice(0, 8);
  const finalTitle = '更新 ' + id.slice(0, 8);
  const path = `/api/requirements/${id}/details`;
  const routeUrl = `/?project=${project}&requirement=${id}&view=overview`;
  const received: RequirementDetailsInput[] = [];
  let isolated = false;
  let fault:
    | 'drop-after'
    | 'drop-before'
    | 'held'
    | 'readback'
    | 'status-only'
    | undefined;
  let readUnavailable = false;
  let release!: () => void, accepted!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const exit = new Promise<void>((resolve) => {
    accepted = resolve;
  });
  const accounts = await readTestAccounts();
  const login = (username: string) =>
    prepareSession(
      page.context(),
      baseURL!,
      accounts.find((a) => a.username === username)!,
    );
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  try {
    expect(
      (await pool.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const [lead, manager] = (
      await pool.query(
        "select id from auth_user where username in ('lead','pm') order by username",
      )
    ).rows;
    await pool.query('insert into project(id,name) values($1,$2)', [
      project,
      '资料编辑夹具',
    ]);
    await pool.query(
      "insert into project_member values($1,$2,'developer'),($1,$2,'project_admin'),($1,$3,'project_admin'),($1,$3,'developer')",
      [project, lead.id, manager.id],
    );
    for (const [demand, title] of [
      [id, initialTitle],
      [second, secondTitle],
    ]) {
      await pool.query(
        'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
        [demand, project, title, '资料原文', '保留的验收标准', lead.id],
      );
      await pool.query(
        "insert into requirement_participant values($1,$2,'developer'),($1,$3,'developer')",
        [demand, lead.id, manager.id],
      );
    }
    await page.route(`**/api/requirements/${id}`, (route) =>
      readUnavailable
        ? route.fulfill({ status: 503, json: { error: '合成读取故障' } })
        : route.continue(),
    );
    await page.route('**' + path, async (route) => {
      const input = route.request().postDataJSON() as RequirementDetailsInput;
      received.push(input);
      const active = fault;
      fault = undefined;
      if (active === 'drop-before') return route.abort('failed');
      if (active === 'status-only')
        return route.fulfill({
          status: 409,
          json: { error: '未确认的中间响应' },
        });
      if (active === 'readback') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        readUnavailable = true;
        return route.fulfill({ response });
      }
      if (active === 'drop-after') {
        expect((await route.fetch()).status()).toBe(200);
        return route.abort('failed');
      }
      if (active === 'held') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        accepted();
        await held;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    await login('pm');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'light' });
    await page.goto(routeUrl);
    const edit = page.getByRole('button', {
      name: '编辑需求资料',
      exact: true,
    });
    const save = page.getByRole('button', {
      name: '保存需求资料',
      exact: true,
    });
    const retry = page.getByRole('button', { name: '重试原保存', exact: true });
    const description = page.getByLabel('需求说明', { exact: true });
    await edit.click();
    await expect(save).toBeDisabled();
    await expect(description).toHaveValue('资料原文');
    await page
      .locator('.requirement-details-editor')
      .filter({ has: description })
      .screenshot({
        path: testInfo.outputPath('requirement-details-light-390.png'),
      });
    await page.getByLabel('需求标题', { exact: true }).fill(finalTitle);
    fault = 'drop-after';
    await save.click();
    await expect(
      page.getByText('原保存结果待确认。', { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    await login('pm');
    await page.reload();
    fault = 'readback';
    await retry.click();
    await expect(page.getByText('合成读取故障')).toBeVisible();
    await expect(
      page.getByText('原保存已确认。', { exact: true }),
    ).toBeVisible();
    expect(received[0]!.patch).toEqual({ title: finalTitle });
    expect(received[1]).toEqual(received[0]);
    readUnavailable = false;
    await page.getByRole('button', { name: '重试读取需求档案' }).click();
    await expect(
      page.getByText('原保存已确认。', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText('更新了需求资料 · 需求标题', { exact: false }),
    ).toHaveCount(1);
    await expect(
      page.getByText('保留的验收标准', { exact: true }),
    ).toBeVisible();

    await page.emulateMedia({ colorScheme: 'dark' });
    await edit.click();
    await expect(page.locator('html')).toHaveAttribute('theme-mode', 'dark');
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page
      .locator('.requirement-details-editor')
      .filter({ has: description })
      .screenshot({
        path: testInfo.outputPath('requirement-details-dark-390.png'),
      });
    await description.fill('原意图重试会保存');
    fault = 'drop-before';
    await save.click();
    await expect.poll(() => received.length).toBe(3);
    const original = received[2]!;
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          original.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    await login('lead');
    const wrongLogin = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === path &&
        response.request().method() === 'POST',
    );
    await retry.click();
    expect((await wrongLogin).status()).toBe(401);
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          original.commandId,
        ])
      ).rowCount,
    ).toBe(0);
    const { session } = await login('pm');
    await page.reload();
    await expect(page.getByText('资料原文', { exact: true })).toBeVisible();
    await expect(
      page.getByText('重试时，如果原操作尚未提交', { exact: false }),
    ).toBeVisible();
    await retry.click();
    await expect(
      page.getByText('原意图重试会保存', { exact: true }),
    ).toBeVisible();
    expect(received.at(-1)).toEqual(original);

    await edit.click();
    await description.fill('被冲突的原稿');
    fault = 'drop-before';
    await save.click();
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    const conflicted = received.at(-1)!;
    fault = 'status-only';
    await retry.click();
    await expect(page.getByText('未确认的中间响应')).toBeVisible();
    await expect(retry).toBeVisible();
    expect(
      (
        await page.request.post(path, {
          headers: { origin: baseURL!, 'x-rdws-edit-session': session.id },
          data: {
            commandId: conflicted.commandId,
            patch: { acceptance: '其他同键字段' },
          },
        })
      ).status(),
    ).toBe(200);
    await retry.click();
    await expect(
      page.getByText('操作标识已用于不同内容，请重新编辑'),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('其他同键字段', { exact: true })).toBeVisible();

    await page.setViewportSize({ width: 1440, height: 900 });
    await edit.click();
    await description.fill('迟到响应前的保存');
    fault = 'held';
    await save.click();
    await exit;
    await page.getByRole('button', { name: secondTitle, exact: true }).click();
    await expect(edit).toBeVisible();
    await expect(retry).toHaveCount(0);
    await pool.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='project_admin'",
      [project, manager.id],
    );
    await page.getByRole('button', { name: finalTitle, exact: true }).click();
    await expect(
      page.getByText('迟到响应前的保存', { exact: true }),
    ).toBeVisible();
    const delivered = page.waitForResponse(
      (result) =>
        new URL(result.url()).pathname === path &&
        result.request().method() === 'POST',
    );
    release();
    await delivered;
    await expect(edit).toHaveCount(0);
    await expect(retry).toHaveCount(0);
    await expect(page.getByText('原保存已确认。', { exact: true })).toHaveCount(
      0,
    );
    await expect(
      page.getByText('更新了需求资料 · 需求说明', { exact: false }),
    ).toHaveCount(2);
    expect(errors).toEqual([]);
  } finally {
    release();
    if (isolated) {
      await pool.query(
        'delete from requirement_event where requirement_id=any($1::text[])',
        [[id, second]],
      );
      await pool.query(
        'delete from requirement_participant where requirement_id=any($1::text[])',
        [[id, second]],
      );
      await pool.query('delete from requirement where id=any($1::text[])', [
        [id, second],
      ]);
      await pool.query(
        'delete from command_receipt where scope=any($1::text[])',
        [['requirement:' + id, 'requirement:' + second]],
      );
      await pool.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await pool.query('delete from project where id=$1', [project]);
    }
    await pool.end();
  }
});
