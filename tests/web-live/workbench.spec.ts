import { nativeReady } from '../helpers/native-ready.ts';
import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { Pool } from 'pg';
import { signGrant } from '@rdws/dsh/access';
import { runtimeHome } from '../../scripts/env.mjs';
test('real native Web session and streaming', async ({ page }) => {
  const accounts: { username: string; password: string }[] = JSON.parse(
    await readFile(join(runtimeHome, 'secrets', 'test-accounts.json'), 'utf8'),
  );
  const manager = accounts.find((row) => row.username === 'manager')!;
  const errors: string[] = [];
  let socketGenerations = 0;
  let liveFrames = 0;
  let sessionId = '';
  let requirementId = '';
  page.on('websocket', (socket) => {
    if (socket.url().includes('remote.mux')) {
      socketGenerations++;
      socket.on('framereceived', (frame) => {
        try {
          const data = JSON.parse(String(frame.payload));
          if (
            data.value?.type === 'assistant-stream' &&
            data.value.frame?.type === 'chunk' &&
            data.value.frame.chunk?.type === 'text-delta'
          )
            liveFrames++;
        } catch {
          errors.push('会话流包含无法解码的帧');
        }
      });
    }
  });
  page.on('response', (response) => {
    if (
      response.request().method() === 'POST' &&
      /\/api\/requirements\/[^/]+\/sessions$/.test(response.url())
    )
      void response.json().then((value) => {
        sessionId = value.sessionId;
        requirementId = response
          .url()
          .split('/requirements/')[1]!
          .split('/')[0]!;
      });
  });
  const requirementTitle = 'Web Native ' + Date.now();
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error')
      console.log(
        'Browser:',
        message.text().replace(/https?:\/\/[^\s]+/g, '[local]'),
      );
  });
  await page.goto('/');
  await expect(page.getByRole('heading', { name: '登录工作台' })).toBeVisible({
    timeout: 10000,
  });
  await page.getByLabel('账号', { exact: true }).fill(manager.username);
  await page.getByLabel('密码', { exact: true }).fill(manager.password);
  await page.getByRole('button', { name: '登录', exact: true }).click();
  await page.getByRole('button', { name: '新建需求', exact: true }).click();
  await page.getByLabel('需求标题', { exact: true }).fill(requirementTitle);
  await page
    .getByLabel('需求描述', { exact: true })
    .fill('验证原生客户端、真实模型和权限边界');
  await page
    .getByLabel('验收标准', { exact: true })
    .fill('会话流式显示并可刷新恢复');
  await page
    .getByLabel('开发负责人', { exact: true })
    .selectOption({ label: 'lead' });
  await page.getByRole('button', { name: '创建需求', exact: true }).click();
  await page.getByRole('tab', { name: '对话', exact: true }).click();
  await expect(
    page.getByRole('button', { name: '新建会话', exact: true }),
  ).toBeEnabled({ timeout: 60000 });
  await page.getByRole('button', { name: '新建会话', exact: true }).click();
  await expect(page.getByLabel('消息', { exact: true })).toBeVisible({
    timeout: 30000,
  });
  await page
    .getByLabel('消息', { exact: true })
    .fill(
      'Reply with RDWS_WEB_NATIVE_OK then count from 1 to 100, one number per line. Do not use tools.',
    );
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('[data-live="true"]')).toBeVisible({
    timeout: 30000,
  });
  await expect(page.getByTestId('transcript')).toContainText(
    'RDWS_WEB_NATIVE_OK',
    { timeout: 60000 },
  );
  await expect(page.locator('[data-live="true"]')).toHaveCount(0, {
    timeout: 60000,
  });
  await page.screenshot({
    path: 'test-results/native-web-light.png',
    fullPage: true,
  });
  await page.reload();
  await page
    .getByRole('button', { name: requirementTitle, exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: '会话 1 · 本人', exact: true }),
  ).toBeVisible({ timeout: 30000 });
  await page
    .getByRole('button', { name: '会话 1 · 本人', exact: true })
    .click();
  await expect(page.locator('.message:not(.from-user)>div')).toContainText(
    'RDWS_WEB_NATIVE_OK',
    { timeout: 30000 },
  );
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.screenshot({
    path: 'test-results/native-web-dark.png',
    fullPage: true,
  });
  const contrast = await page
    .getByRole('button', { name: '退出登录' })
    .evaluate((button) => {
      const style = getComputedStyle(button);
      let ancestor: Element | null = button;
      let backgroundColor = 'rgb(255,255,255)';
      while (ancestor) {
        const color = getComputedStyle(ancestor).backgroundColor;
        const channels = color.match(/[\d.]+/g)!.map(Number);
        if ((channels[3] ?? 1) > 0) {
          backgroundColor = color;
          break;
        }
        ancestor = ancestor.parentElement;
      }
      const luminance = (value: string) => {
        const c = value
          .match(/[\d.]+/g)!
          .slice(0, 3)
          .map(Number)
          .map((n) => {
            const v = n / 255;
            return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
          });
        return 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
      };
      const a = luminance(style.color),
        b = luminance(backgroundColor);
      return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    });
  expect(contrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.from-user')).not.toContainText(
    '<system-reminder>',
  );
  const generationsBefore = socketGenerations;
  const framesBefore = liveFrames;
  const started = Date.now();
  await page
    .getByLabel('消息', { exact: true })
    .fill(
      'For a streaming continuity test, reply RDWS_LONG_BEGIN, then print every integer from 1 through 3000 with each integer on its own line, and finally RDWS_LONG_END. Do not abbreviate, skip, summarize, use ellipses, or use tools.',
    );
  await expect(
    page.getByRole('button', { name: '发送消息', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: '发送消息', exact: true }).click();
  await expect(page.locator('[data-live="true"]')).toBeVisible({
    timeout: 30000,
  });
  await expect(
    page.locator('.message:not(.from-user)>div').last(),
  ).toContainText('RDWS_LONG_END', { timeout: 150000 });
  await expect(page.locator('[data-live="true"]')).toHaveCount(0, {
    timeout: 30000,
  });
  const duration = Date.now() - started;
  expect(duration).toBeGreaterThan(20000);
  expect(socketGenerations).toBeGreaterThan(generationsBefore);
  expect(liveFrames).toBeGreaterThan(framesBefore + 10);
  const displayed = await page
    .locator('.message:not(.from-user)>div')
    .last()
    .textContent();
  const root = join(runtimeHome, 'testing-web');
  const key = await readFile(join(root, 'secrets', 'dsh-bff-key'), 'utf8');
  const { port, generation: hostGeneration } = await nativeReady(root);
  const actor = await page.evaluate(async () => {
    const response = await fetch('/api/auth/get-session');
    return response.json();
  });
  const pool = new Pool({
    connectionString: process.env.DATABASE_MIGRATION_URL,
  });
  let workspaceId: string;
  try {
    workspaceId = (
      await pool.query(
        'select native_workspace_id from requirement where id=$1',
        [requirementId],
      )
    ).rows[0].native_workspace_id;
  } finally {
    await pool.end();
  }
  const token = signGrant(key, {
    aud: 'rdws:poc',
    hostGeneration,
    purpose: 'browser',
    userId: actor.user.id,
    authSessionId: actor.session.id,
    requirementId,
    workspaceId,
    readSessionIds: [sessionId],
    ownSessionIds: [sessionId],
  });
  const journal = await (
    await fetch(`http://127.0.0.1:${port}/_rdws/api/session/page`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-rdws-delegation': token,
      },
      body: JSON.stringify({
        type: 'client-request',
        rpcId: crypto.randomUUID(),
        method: 'session/page',
        payload: {
          args: {
            request: {
              address: { kind: 'session', sessionId },
              maxMessages: 500,
              turnWindow: { minMessages: 50, minTurns: 2 },
            },
          },
        },
      }),
    })
  ).json();
  const messages: string[] = [];
  const requestHeaders: number[] = [];
  let toolCalls = 0;
  const visit = (value: unknown) => {
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') {
      const row = value as Record<string, unknown>;
      if (row.type === 'request/header') {
        const data = row.data as { header: { tools?: unknown[] } };
        requestHeaders.push((data.header.tools ?? []).length);
      }
      if (row.type === 'tool/call') toolCalls++;
      if (row.type === 'assistant/message') {
        const data = row.data as {
          message?: { content?: { type: string; text?: string }[] };
        };
        const text = data?.message?.content
          ?.filter((part) => part.type === 'text')
          .map((part) => part.text ?? '')
          .join('');
        if (text?.includes('RDWS_LONG_END')) messages.push(text);
      }
      Object.values(row).forEach(visit);
    }
  };
  visit(journal);
  expect(requestHeaders.length).toBeGreaterThan(0);
  expect(requestHeaders.every((count) => count === 0)).toBe(true);
  expect(toolCalls).toBe(0);
  expect(messages.length).toBeGreaterThan(0);
  expect(displayed === messages.at(-1)).toBe(true);
  await page.reload();
  await page
    .getByRole('button', { name: requirementTitle, exact: true })
    .click();
  await page
    .getByRole('button', { name: '会话 1 · 本人', exact: true })
    .click();
  await expect(
    page.locator('.message:not(.from-user)>div').last(),
  ).toContainText('RDWS_LONG_END', { timeout: 30000 });
  expect(
    (await page
      .locator('.message:not(.from-user)>div')
      .last()
      .textContent()) === displayed,
  ).toBe(true);
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: 'test-results/native-web-mobile.png',
    fullPage: true,
  });
  await writeFile(
    'test-results/web-native-evidence.json',
    JSON.stringify(
      {
        requirementId,
        sessionId,
        longResponseMs: duration,
        socketGenerationsDuringLong: socketGenerations - generationsBefore,
        liveTextFramesDuringLong: liveFrames - framesBefore,
        displayMatchesNativeJournal: true,
        refreshPreservesText: true,
        unhandledPageErrors: errors.length,
        modelRequestHeaders: requestHeaders.length,
        publishedExecutionTools: 0,
        toolCalls,
      },
      null,
      2,
    ),
  );
  expect(errors).toEqual([]);
});
