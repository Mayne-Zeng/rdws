import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeHome } from '../../scripts/env.mjs';
for (const failure of ['abort', 'invalid-json'] as const)
  test(
    'task result ' + failure + ' preserves its intent and recovers editing',
    async ({ page, baseURL }) => {
      const accounts = JSON.parse(
        await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
      ) as { username: string; password: string }[];
      await page.request.post('/api/auth/sign-in/username', {
        headers: { origin: baseURL! },
        data: accounts.find((a) => a.username === 'manager'),
      });
      const members = await (
        await page.request.get('/api/projects/poc/members')
      ).json();
      const leadId = members.members.find(
        (m: { name: string }) => m.name === 'lead',
      ).id;
      const response = await page.request.post(
        '/api/projects/poc/requirements',
        {
          headers: { origin: baseURL! },
          data: {
            commandId: randomUUID(),
            title: 'Retry ' + Date.now(),
            description: 'Synthetic retry',
            acceptance: 'One task only',
            leadId,
            participants: [],
          },
        },
      );
      expect(response.status()).toBe(200);
      const id = (await response.json()).id;
      await page.request.post('/api/auth/sign-in/username', {
        headers: { origin: baseURL! },
        data: accounts.find((a) => a.username === 'lead'),
      });
      await page.goto(`/?project=poc&requirement=${id}&view=overview`);
      await page
        .getByRole('button', { name: '新增子任务', exact: true })
        .click();
      await page.getByLabel('任务标题', { exact: true }).fill('一次任务');
      const commands: string[] = [];
      let lost = false;
      await page.route(`**/api/requirements/${id}/commands`, async (route) => {
        const body = route.request().postDataJSON();
        commands.push(body.commandId);
        if (!lost) {
          lost = true;
          await route.fetch();
          if (failure === 'abort') await route.abort('failed');
          else
            await route.fulfill({
              status: 200,
              contentType: 'application/json',
              body: '{',
            });
        } else await route.continue();
      });
      await page
        .getByRole('button', { name: '保存子任务', exact: true })
        .click();
      await expect(
        page.getByRole('button', { name: '重试原操作', exact: true }),
      ).toBeVisible();
      await expect(page.getByLabel('任务标题', { exact: true })).toBeDisabled();
      await page
        .getByRole('button', { name: '重试原操作', exact: true })
        .click();
      await expect(
        page.getByTestId('task-row').filter({ hasText: '一次任务' }),
      ).toHaveCount(1);
      expect(commands.length).toBe(2);
      expect(new Set(commands).size).toBe(1);
      await page
        .getByRole('button', { name: '新增子任务', exact: true })
        .click();
      await expect(page.getByLabel('任务标题', { exact: true })).toBeEnabled();
    },
  );
