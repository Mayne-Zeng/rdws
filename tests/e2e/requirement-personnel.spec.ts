import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type { RequirementPersonnelInput } from '@rdws/contracts';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('personnel form requires explicit task handoffs and restores the original saved edit after reload', async ({
  page,
  baseURL,
}, testInfo) => {
  const pool = createTestPool('migration');
  const project = 'personnel-browser-' + randomUUID(),
    id = randomUUID();
  const url = `/?project=${project}&requirement=${id}&view=overview`;
  const path = `/api/requirements/${id}/personnel`;
  let isolated = false,
    lost = false,
    failRead = false;
  const received: RequirementPersonnelInput[] = [];
  const accounts = await readTestAccounts();
  const login = (username: string) =>
    prepareSession(
      page.context(),
      baseURL!,
      accounts.find((row) => row.username === username)!,
    );
  try {
    expect(
      (await pool.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    const users = new Map<string, string>(
      (
        await pool.query(
          "select username,id from auth_user where username in ('lead','pm','dev','tester')",
        )
      ).rows.map((row) => [row.username, row.id]),
    );
    await pool.query('insert into project(id,name) values($1,$2)', [
      project,
      '人员维护夹具',
    ]);
    await pool.query(
      "insert into project_member values($1,$2,'project_admin'),($1,$3,'developer'),($1,$4,'developer'),($1,$5,'developer')",
      [
        project,
        users.get('pm'),
        users.get('lead'),
        users.get('dev'),
        users.get('tester'),
      ],
    );
    await pool.query(
      'insert into requirement(id,project_id,title,description,acceptance,lead_id,created_by) values($1,$2,$3,$4,$5,$6,$6)',
      [
        id,
        project,
        '明确分派 ' + id.slice(0, 8),
        '受控人员更换',
        '原分派留痕',
        users.get('lead'),
      ],
    );
    for (const username of ['lead', 'dev', 'tester'])
      await pool.query(
        "insert into requirement_participant values($1,$2,'developer')",
        [id, users.get(username)],
      );
    await pool.query(
      "insert into requirement_participant values($1,$2,'project_admin')",
      [id, users.get('pm')],
    );
    for (const [title, state] of [
      ['普通承接任务', 'todo'],
      ['单独承接任务', 'in_progress'],
      ['已结束的任务', 'done'],
    ]) {
      await pool.query(
        'insert into task(id,requirement_id,title,assignee_id,created_by,status) values($1,$2,$3,$4,$4,$5)',
        [randomUUID(), id, title, users.get('lead'), state],
      );
    }
    await page.route(`**/api/requirements/${id}`, async (route) => {
      if (failRead)
        return route.fulfill({
          status: 503,
          json: { error: '合成档案回读失败' },
        });
      return route.continue();
    });
    await page.route('**' + path, async (route) => {
      if (route.request().method() === 'GET') return route.continue();
      received.push(route.request().postDataJSON());
      const upstream = await route.fetch();
      expect(upstream.status()).toBe(200);
      if (!lost) {
        lost = true;
        return route.abort('failed');
      }
      failRead = true;
      return route.fulfill({ response: upstream });
    });
    await login('pm');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(url);
    await page
      .getByRole('button', { name: '维护需求人员', exact: true })
      .click();
    const form = page.getByRole('form', { name: '维护需求人员' });
    await form
      .getByRole('checkbox', { name: 'lead · 开发人员', exact: true })
      .uncheck();
    await form.getByLabel('目标开发负责人').selectOption(users.get('dev')!);
    await expect(
      form.getByRole('button', { name: '保存人员与分派' }),
    ).toBeDisabled();
    await expect(form.getByText('已结束的任务')).toHaveCount(0);
    await form.getByLabel('本组接手人').selectOption(users.get('dev')!);
    await form
      .getByLabel('单独承接任务的接手人')
      .selectOption(users.get('tester')!);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await form.screenshot({
      path: testInfo.outputPath('personnel-dark-390.png'),
    });
    await form.getByRole('button', { name: '保存人员与分派' }).click();
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    await login('pm');
    await page.reload();
    await page.getByRole('button', { name: '重试原人员变更' }).click();
    await expect(page.getByText('合成档案回读失败')).toBeVisible();
    await expect(page.getByText('需求人员与任务分派已保存。')).toBeVisible();
    expect(received[1]).toEqual(received[0]);
    failRead = false;
    await page.getByRole('button', { name: '重试读取需求档案' }).click();
    await expect(
      page.getByText('变更了需求人员与分工', { exact: false }),
    ).toHaveCount(1);
    const tasks = page.getByTestId('task-row');
    await expect(tasks.filter({ hasText: '普通承接任务' })).toContainText(
      'dev',
    );
    await expect(tasks.filter({ hasText: '单独承接任务' })).toContainText(
      'tester',
    );
    await expect(tasks.filter({ hasText: '已结束的任务' })).toContainText(
      'lead',
    );
    expect(
      (
        await pool.query(
          "select 1 from requirement_participant where requirement_id=$1 and user_id=$2 and role='project_admin'",
          [id, users.get('pm')],
        )
      ).rowCount,
    ).toBe(1);
    expect(
      (
        await pool.query('select 1 from command_receipt where command_id=$1', [
          received[0]!.commandId,
        ])
      ).rowCount,
    ).toBe(1);
    await pool.query(
      "delete from project_member where project_id=$1 and user_id=$2 and role='developer'",
      [project, users.get('tester')],
    );
    await login('dev');
    await page.reload();
    await expect(page.getByLabel('调整阶段')).toBeVisible();
    await expect(
      page.getByRole('button', { name: '维护需求人员', exact: true }),
    ).toHaveCount(0);
    await page
      .getByLabel('已结束的任务 状态', { exact: true })
      .selectOption('todo');
    await expect(
      page.getByRole('heading', { name: '编辑子任务' }),
    ).toBeVisible();
    const owner = page.getByLabel('任务负责人', { exact: true });
    await expect(owner).toHaveValue(users.get('lead')!);
    await expect(
      page.getByRole('button', { name: '保存子任务', exact: true }),
    ).toBeDisabled();
    await owner.selectOption(users.get('dev')!);
    await page.getByRole('button', { name: '保存子任务', exact: true }).click();
    await expect(
      page.getByLabel('已结束的任务 状态', { exact: true }),
    ).toHaveValue('todo');
    await expect(tasks.filter({ hasText: '已结束的任务' })).toContainText(
      'dev',
    );
  } finally {
    if (isolated) {
      await pool.query('delete from task where requirement_id=$1', [id]);
      await pool.query(
        'delete from requirement_event where requirement_id=$1',
        [id],
      );
      await pool.query(
        'delete from requirement_participant where requirement_id=$1',
        [id],
      );
      await pool.query('delete from requirement where id=$1', [id]);
      await pool.query('delete from command_receipt where scope=$1', [
        'requirement:' + id,
      ]);
      await pool.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await pool.query('delete from project where id=$1', [project]);
    }
    await pool.end();
  }
});
