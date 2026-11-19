import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import type {
  RequirementImportInput,
  RequirementImportRow,
} from '@rdws/contracts';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('CSV and XLSX can be corrected, validated and committed with recoverable per-row results', async ({
  page,
  baseURL,
}, testInfo) => {
  const pool = createTestPool('migration');
  const project = 'import-browser-' + randomUUID();
  const source = fileURLToPath(
    new URL('../fixtures/requirement-import.xlsx', import.meta.url),
  );
  const path = `/api/projects/${project}/requirements/import`;
  let isolated = false,
    fault: 'drop-after' | 'drop-before' | 'list-readback' | undefined;
  let failList = false;
  let delaySecond = false;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const sent: RequirementImportInput[] = [];
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const accounts = await readTestAccounts();
  const login = (username: string) =>
    prepareSession(
      page.context(),
      baseURL!,
      accounts.find((account) => account.username === username)!,
    );
  const count = async () =>
    (
      await pool.query(
        'select count(*)::int n from requirement where project_id=$1',
        [project],
      )
    ).rows[0].n as number;
  try {
    expect(
      (await pool.query('select current_database() db, session_user role'))
        .rows[0],
    ).toEqual({ db: 'rdws_test', role: 'rdws_test_migrator' });
    isolated = true;
    await pool.query('insert into project(id,name) values($1,$2)', [
      project,
      '导入浏览器夹具',
    ]);
    await pool.query(
      `insert into project_member(project_id,user_id,role) select $1,id,case username when 'pm' then 'project_admin' when 'lead' then 'developer' else 'tester' end from auth_user where username in ('pm','lead','tester')`,
      [project],
    );
    await page.route('**' + path + '/preview', async (route) => {
      const { rows } = route.request().postDataJSON() as {
        rows: RequirementImportRow[];
      };
      if (delaySecond && rows.length === 1) {
        delaySecond = false;
        const response = await route.fetch();
        await held;
        await route.fulfill({ response }).catch(() => undefined);
      } else await route.continue();
    });
    await page.route(`**/api/projects/${project}/requirements`, (route) =>
      failList && route.request().method() === 'GET'
        ? route.fulfill({ status: 503, json: { error: '合成列表暂不可用' } })
        : route.continue(),
    );
    await page.route('**' + path + '/commit', async (route) => {
      sent.push(route.request().postDataJSON());
      const current = fault;
      fault = undefined;
      if (current === 'drop-before') return route.abort('failed');
      if (current === 'drop-after') {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        expect((await response.json()).status).toBe('created');
        return route.abort('failed');
      }
      if (current === 'list-readback') {
        const response = await route.fetch();
        failList = true;
        return route.fulfill({ response });
      }
      return route.continue();
    });
    await login('pm');
    await page.setViewportSize({ width: 390, height: 844 });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.goto(`/?project=${project}&view=requirements`);
    await page.getByRole('button', { name: '批量导入', exact: true }).click();
    const file = page.getByLabel('需求文件', { exact: true });
    const commit = page.getByRole('button', {
      name: '整批提交入库',
      exact: true,
    });
    const retry = page.getByRole('button', { name: '重试原批次', exact: true });
    const validate = page.getByRole('button', {
      name: '重新校验',
      exact: true,
    });
    await file.setInputFiles(source);
    await page
      .getByLabel('工作表', { exact: true })
      .selectOption({ label: '含公式' });
    await expect(
      page.getByText('第 2 行第 1 列含公式，请转换为文本值'),
    ).toBeVisible();
    expect(await count()).toBe(0);
    await page
      .getByLabel('工作表', { exact: true })
      .selectOption({ label: '需求数据' });
    await expect(
      page.getByText('第 2 行 · 账单 & 复核', { exact: true }),
    ).toBeVisible();
    const third = page.getByRole('group', { name: '修正第 3 行' });
    await expect(
      third.getByText('开发负责人须填写本项目有效开发成员的登录名'),
    ).toBeVisible();
    await expect(commit).toBeDisabled();
    await third.getByLabel('开发负责人', { exact: true }).fill('lead');
    await expect(third.getByLabel('开发负责人', { exact: true })).toBeVisible();
    await validate.click();
    await expect(commit).toBeEnabled();
    await page.getByText('第 3 行 · 修正负责人后入库', { exact: true }).click();
    expect(await count()).toBe(0);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await page.getByRole('region', { name: '逐条导入预览' }).screenshot({
      path: testInfo.outputPath('requirement-import-dark-390.png'),
    });
    fault = 'drop-after';
    await commit.click();
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    expect(await count()).toBe(2);
    await page
      .getByRole('button', { name: '返回需求列表', exact: true })
      .click();
    await page.getByRole('button', { name: '批量导入', exact: true }).click();
    await expect(retry).toBeVisible();
    expect(sent).toHaveLength(1);
    await login('pm');
    await page.reload();
    await expect(retry).toBeVisible();
    expect(sent).toHaveLength(1);
    fault = 'list-readback';
    await retry.click();
    await expect(page.getByText('已整批入库，共 2 条需求。')).toBeVisible();
    await expect(page.getByText('合成列表暂不可用')).toBeVisible();
    await expect(page.getByText('已整批入库，共 2 条需求。')).toBeVisible();
    failList = false;
    await page.getByRole('button', { name: '重试读取需求列表' }).click();
    await expect(page.getByText('合成列表暂不可用')).toHaveCount(0);
    await expect(page.getByText('已整批入库，共 2 条需求。')).toBeVisible();
    expect(sent[1]).toEqual(sent[0]);
    await expect(page.getByText('工作树未配置', { exact: true })).toHaveCount(
      2,
    );
    expect(await count()).toBe(2);

    const csv =
      '\ufeff需求标题,开发负责人,需求说明\r\n' +
      Array.from(
        { length: 9 },
        (_, i) => `批量样例 ${i + 1},lead,"问题,说明\n第二行"`,
      ).join('\r\n');
    delaySecond = true;
    await page.evaluate(() => {
      const observer = new MutationObserver(() => {
        if (
          [...document.querySelectorAll('[role="status"]')].some((node) =>
            node.textContent?.includes('正在解析，已读 1 条需求'),
          )
        ) {
          document.body.dataset.sawImportProgress = 'true';
          observer.disconnect();
        }
      });
      observer.observe(document.body, {
        subtree: true,
        childList: true,
        characterData: true,
      });
    });
    await file.setInputFiles({
      name: 'synthetic.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from(csv),
    });
    await expect(page.getByText('正在校验 · 8 / 9')).toBeVisible();
    await expect(page.locator('body')).toHaveAttribute(
      'data-saw-import-progress',
      'true',
    );
    await page.getByText('第 2 行 · 批量样例 1', { exact: true }).click();
    const second = page.getByRole('group', { name: '修正第 2 行' });
    await expect(second.getByLabel('需求说明', { exact: true })).toHaveValue(
      '问题,说明\n第二行',
    );
    await second.getByLabel('需求标题', { exact: true }).fill('');
    release();
    await expect(commit).toBeDisabled();
    await validate.click();
    await expect(second.getByText('请填写 1–160 字符的需求标题')).toBeVisible();
    await second
      .getByLabel('需求标题', { exact: true })
      .fill('修订后的 CSV 标题');
    failList = true;
    await expect(page.getByText('合成列表暂不可用')).toBeVisible();
    await expect(second.getByLabel('需求标题', { exact: true })).toHaveValue(
      '修订后的 CSV 标题',
    );
    failList = false;
    await page.getByRole('button', { name: '重试读取需求列表' }).click();
    await validate.click();
    await expect(commit).toBeEnabled();
    await page.emulateMedia({ colorScheme: 'light' });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    fault = 'drop-before';
    await commit.click();
    await expect(
      page.getByText('连接中断，操作结果尚未确认', { exact: false }),
    ).toBeVisible();
    expect(await count()).toBe(2);
    await page.reload();
    await expect(retry).toBeVisible();
    expect(await count()).toBe(2);
    await retry.click();
    await expect(page.getByText('已整批入库，共 9 条需求。')).toBeVisible();
    expect(sent[3]).toEqual(sent[2]);
    expect(await count()).toBe(11);
    await file.setInputFiles(
      fileURLToPath(
        new URL('../fixtures/requirement-import-inline.xlsx', import.meta.url),
      ),
    );
    await expect(
      page.getByText('第 2 行 · 内联文本 & 验证', { exact: true }),
    ).toBeVisible();
    await expect(commit).toBeEnabled();
    await file.setInputFiles({
      name: 'invalid-encoding.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from([0xff, 0xff]),
    });
    await expect(page.getByText('CSV 须使用 UTF-8 编码')).toBeVisible();
    expect(await count()).toBe(11);
    expect(errors).toEqual([]);
    await login('lead');
    await page.reload();
    await expect(
      page.getByText('当前项目权限不可用，请核对后再批量导入。'),
    ).toBeVisible();
    await expect(file).toHaveCount(0);
  } finally {
    release();
    if (isolated) {
      for (const table of [
        'task',
        'requirement_event',
        'requirement_worktree_plan',
        'requirement_participant',
      ])
        await pool.query(
          `delete from ${table} where requirement_id in (select id from requirement where project_id=$1)`,
          [project],
        );
      await pool.query('delete from requirement where project_id=$1', [
        project,
      ]);
      await pool.query('delete from command_receipt where scope=$1', [
        'project:' + project,
      ]);
      await pool.query('delete from project_member where project_id=$1', [
        project,
      ]);
      await pool.query('delete from project where id=$1', [project]);
    }
    await pool.end();
  }
});
