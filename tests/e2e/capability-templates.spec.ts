import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { prepareSession } from '../helpers/auth-session.ts';
import { readTestAccounts } from '../helpers/test-accounts.ts';
import { createTestPool } from '../helpers/test-pool.ts';

test('template recovery preserves confirmed revisions and project members see retired references', async ({
  page,
  baseURL,
}) => {
  const suffix = randomUUID();
  const reference = `platform/template-${suffix}`;
  const name = `审核模板 ${suffix}`;
  const changed = name + ' v2';
  const recovered = name + ' v3';
  const item = { kind: 'skill', reference, revision: '1.0.0' };
  const accounts: { username: string; password: string }[] =
    await readTestAccounts();
  const migration = createTestPool('migration');
  const commands: string[] = [];
  const saves: { commandId: string }[] = [];
  let dropBeforeCommit = false;
  let failOverview = false;
  let failTemplates = false;
  const login = (username: string) =>
    prepareSession(
      page.context(),
      baseURL!,
      accounts.find((row) => row.username === username)!,
    );
  async function setApproval(approved: boolean) {
    const commandId = randomUUID();
    commands.push(commandId);
    const response = await page.request.post('/api/management/commands', {
      headers: { origin: baseURL! },
      data: {
        kind: 'capability.approval',
        commandId,
        capabilityKind: item.kind,
        reference,
        revision: item.revision,
        approved,
      },
    });
    expect(response.status()).toBe(200);
  }
  try {
    const { user } = await login('admin');
    await setApproval(true);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.route('**/api/management/platform', (route) =>
      failOverview
        ? route.fulfill({
            status: 503,
            json: { error: 'Synthetic overview failure' },
          })
        : route.continue(),
    );
    await page.route(
      '**/api/management/projects/*/capability-templates',
      (route) =>
        failTemplates
          ? route.fulfill({
              status: 503,
              json: { error: 'Synthetic template list failure' },
            })
          : route.continue(),
    );
    await page.route('**/api/management/commands', async (route) => {
      const body = route.request().postDataJSON();
      if (body.kind === 'capability.approval') commands.push(body.commandId);
      if (body.kind !== 'capability.template.save') return route.continue();
      saves.push(body);
      if (dropBeforeCommit) {
        dropBeforeCommit = false;
        await route.abort('failed');
        return;
      }
      if (saves.length !== 1) return route.continue();
      expect((await route.fetch()).status()).toBe(200);
      await route.abort('failed');
    });
    await page.goto('/?view=platform');
    const selected = page.getByLabel('项目', { exact: true });
    await selected.selectOption('poc');
    const editor = page.getByRole('region', {
      name: '项目能力模板',
      exact: true,
    });
    await editor.getByRole('button', { name: '新建能力模板' }).click();
    const field = editor.getByLabel('模板名称');
    await field.fill(name);
    await editor
      .getByRole('checkbox', {
        name: `技能 · ${reference} · 1.0.0`,
        exact: true,
      })
      .check();
    await editor.getByRole('button', { name: '保存模板版本' }).click();
    const retry = page.getByRole('button', { name: '核对原管理操作' });
    await expect(retry).toBeEnabled();
    await page.reload();
    await expect(selected).toHaveValue('poc');
    await expect(field).toHaveValue(name);
    await retry.click();
    await expect(retry).toHaveCount(0);
    await expect(field).toHaveCount(0);
    expect(saves).toHaveLength(2);
    expect(saves[1]).toEqual(saves[0]);
    const row = editor.getByRole('listitem').filter({ hasText: name });
    await expect(row).toContainText('第 1 版');
    await row.getByRole('button', { name: '编辑模板' }).click();
    await field.fill(changed);
    await editor.getByRole('button', { name: '保存模板版本' }).click();
    await expect(row).toContainText('第 2 版');
    const latest = (
      await (
        await page.request.get(
          '/api/management/projects/poc/capability-templates',
        )
      ).json()
    ).templates.find((entry: { name: string }) => entry.name === changed);
    const stale = {
      commandId: randomUUID(),
      kind: 'capability.template.save',
      projectId: 'poc',
      templateId: latest.templateId,
      expectedRevision: 1,
      name: name + ' stale',
      description: '',
      capabilities: [item],
    };
    commands.push(stale.commandId);
    await page.evaluate(
      ({ key, value }) => sessionStorage.setItem(key, JSON.stringify(value)),
      { key: 'rdws:management:' + user.id, value: stale },
    );
    await page.reload();
    await expect(field).toHaveValue(stale.name);
    failTemplates = true;
    await retry.click();
    await expect(
      page.getByText('模板版本已变化，请核对当前清单后重新编辑。'),
    ).toBeVisible();
    await expect(retry).toHaveCount(0);
    await expect(field).toHaveValue(stale.name);
    await expect(editor.getByText('能力模板读取失败。')).toBeVisible();
    const saveCount = saves.length;
    failTemplates = false;
    await editor.getByRole('button', { name: '重试读取模板' }).click();
    await expect(row).toContainText('第 2 版');
    expect(saves).toHaveLength(saveCount);

    failOverview = true;
    const approvals = page.getByRole('region', { name: '平台能力白名单' });
    await approvals.getByLabel('能力类别').selectOption('skill');
    await approvals.getByLabel('来源／能力标识').fill(reference);
    await approvals.getByLabel('审核版本', { exact: true }).fill('1.0.0');
    await approvals.getByRole('button', { name: '登记审核版本' }).click();
    await expect(page.getByText('Synthetic overview failure')).toBeVisible();
    await expect(field).toHaveValue(stale.name);
    failOverview = false;
    await page.getByRole('button', { name: '重试读取平台设置' }).click();
    await expect(selected).toHaveValue('poc');
    await expect(field).toHaveValue(stale.name);
    await row.getByRole('button', { name: '编辑模板' }).click();
    await field.fill(recovered);
    dropBeforeCommit = true;
    await editor.getByRole('button', { name: '保存模板版本' }).click();
    await expect(retry).toBeEnabled();
    await expect(field).toHaveValue(recovered);
    await retry.click();
    await expect(row).toContainText('第 3 版');
    await expect(field).toHaveCount(0);

    await setApproval(false);
    await login('pm');
    await page.goto('/?project=poc&view=capabilities');
    const project = page.getByRole('region', { name: '能力模板', exact: true });
    await expect(
      project.getByRole('listitem').filter({ hasText: recovered }),
    ).toContainText('需修订');
    await expect(
      project.getByText(`${reference} · 1.0.0 · 已停用`, { exact: false }),
    ).toBeVisible();
    await expect(project.getByRole('button', { name: '编辑模板' })).toHaveCount(
      0,
    );
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await project.screenshot({
      path: '.impeccable/review/t14-project-templates-mobile.png',
    });
  } finally {
    await migration.query(
      'delete from capability_template_revision where project_id=$1 and name=any($2::text[])',
      ['poc', [name, changed, recovered, name + ' stale']],
    );
    await migration.query(
      'delete from capability_approval where reference=$1',
      [reference],
    );
    await migration.query(
      'delete from command_receipt where command_id=any($1::text[])',
      [[...commands, ...saves.map(({ commandId }) => commandId)]],
    );
    await migration.end();
  }
});
