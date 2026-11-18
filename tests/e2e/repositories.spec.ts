import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';

test('repository navigation displays the empty state for a real unconfigured project', async ({
  page,
  baseURL,
}) => {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((row) => row.username === 'lead')!,
  );
  await page.goto('/');
  await page.getByRole('button', { name: '仓库与环境', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: '尚未登记仓库', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: '同步基线', exact: true }),
  ).toHaveCount(0);
});

test('the repository view reconciles a lost response with the same command and explains failures', async ({
  page,
  baseURL,
}) => {
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((row) => row.username === 'pm')!,
  );
  const commit = '1'.repeat(40);
  const project = '**/api/projects/poc/repositories';
  const received: string[] = [];
  let status: 'succeeded' | 'failed' | 'unknown' | undefined;
  let unavailable = false;
  const summary = () => ({
    canSync: true,
    repositories: [
      {
        id: 'app',
        name: '验收仓库',
        baselineRef: 'refs/heads/main',
        targetName: '集成',
        targetRef: 'refs/heads/integration',
        publishedCommit: status ? commit : undefined,
        lastSync: status
          ? {
              status,
              commandId: received[received.length - 1],
              candidateCommit: status === 'succeeded' ? commit : '2'.repeat(40),
              issue: status === 'failed' ? 'signature' : undefined,
              startedAt: '2026-11-18T07:00:00Z',
            }
          : undefined,
      },
    ],
  });
  await page.route(project, (route) =>
    unavailable
      ? route.fulfill({ status: 503, json: { error: '模拟短时读取失败' } })
      : route.fulfill({ json: summary() }),
  );
  await page.route(project + '/app/sync', async (route) => {
    const { commandId } = route.request().postDataJSON() as {
      commandId: string;
    };
    received.push(commandId);
    if (received.length === 1) {
      status = 'succeeded';
      unavailable = true;
      await route.abort('failed');
      return;
    }
    if (received.length === 2) {
      await route.fulfill({ status: 409, json: { error: '同步暂未留下回执' } });
      return;
    }
    unavailable = received.length === 3;
    status =
      received.length === 3
        ? 'unknown'
        : received.length === 4
          ? 'succeeded'
          : 'failed';
    await route.fulfill({ json: summary().repositories[0]!.lastSync });
  });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.goto('/?project=poc&view=repos');
  await expect(
    page.getByRole('heading', { name: '仓库与环境', exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('refs/heads/integration', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: '同步基线', exact: true })
    .press('Enter');
  await expect(
    page.getByText('模拟短时读取失败', { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '核对原同步', exact: true }).click();
  await expect.poll(() => received.length).toBe(2);
  await expect(
    page.getByRole('button', { name: '核对原同步', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '核对原同步', exact: true }).click();
  await expect.poll(() => received.length).toBe(3);
  await expect(page.getByText('结果待核对', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: '发起新同步', exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: '核对原同步', exact: true }).click();
  await expect(page.getByText('同步成功', { exact: true })).toBeVisible();
  expect(new Set(received).size).toBe(1);
  await page.getByRole('button', { name: '同步基线', exact: true }).click();
  await expect(page.getByText('同步失败', { exact: true })).toBeVisible();
  expect(received[4]).not.toBe(received[3]);
  await expect(
    page.getByText('基线签名未通过可信校验，请联系仓库维护者。'),
  ).toBeVisible();
  await expect(page.getByText(commit, { exact: true })).toBeVisible();
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth),
  ).toBeLessThanOrEqual(390);
  expect(
    await page.locator('.workspace-scroll').evaluate((el) => el.scrollWidth),
  ).toBeLessThanOrEqual(390);
});
