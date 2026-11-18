import { test, expect } from '@playwright/test';
import { readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { runtimeHome } from '../../scripts/env.mjs';
import { prepareSession } from '../helpers/auth-session.ts';

test('five real workbench entries preserve the Demo geometry and readable themes', async ({
  page,
  baseURL,
}) => {
  test.setTimeout(120000);
  const accounts = JSON.parse(
    await readFile(join(runtimeHome, 'secrets/test-accounts.json'), 'utf8'),
  ) as { username: string; password: string }[];
  await prepareSession(
    page.context(),
    baseURL!,
    accounts.find((a) => a.username === 'manager')!,
  );
  const { members } = await (
    await page.request.get('/api/projects/poc/members')
  ).json();
  const title = (
    '长需求标题 ' +
    randomUUID() +
    'ContinuousIdentifier'.repeat(5)
  ).slice(0, 160);
  const created = await page.request.post('/api/projects/poc/requirements', {
    headers: { origin: baseURL! },
    data: {
      commandId: randomUUID(),
      title,
      description:
        '正文阅读与长标识符换行验证。'.repeat(12) + 'LongIdentifier'.repeat(12),
      acceptance: '四宽两主题保持可阅读，正文及占位提示对比度至少 4.5。',
      leadId: members.find((m: { name: string }) => m.name === 'lead').id,
      participants: [],
      tasks: [{ title: 'LongTaskIdentifier'.repeat(8) }],
    },
  });
  expect(created.status()).toBe(200);
  const id = (await created.json()).id;
  const session = await page.request.post(`/api/requirements/${id}/sessions`, {
    headers: { origin: baseURL! },
    data: { commandId: randomUUID() },
  });
  expect(session.status()).toBe(200);
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await mkdir('.impeccable/review/t01-final', { recursive: true });
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme });
    for (const view of [
      'context',
      'requirements',
      'create',
      'overview',
      'chat',
    ]) {
      await page.goto(
        `/?project=poc&view=${view}${['requirements', 'create'].includes(view) ? '' : '&requirement=' + id}`,
      );
      await expect(page.locator('h1')).toBeVisible();
      if (view === 'create') {
        await page.getByLabel('需求标题', { exact: true }).fill(title);
        await page
          .getByLabel('开发负责人', { exact: true })
          .selectOption({ label: 'lead' });
        await page.getByRole('button', { name: '添加初始子任务' }).click();
        await page
          .getByLabel('子任务标题 1', { exact: true })
          .fill('LongInitialTask'.repeat(10));
      }
      if (view === 'requirements') {
        await page.getByLabel('筛选需求列表', { exact: true }).fill(title);
        await expect(page.locator('.requirement-row')).toHaveCount(1);
      }
      if (view === 'chat') {
        await page
          .getByRole('button', { name: '会话 1 · 本人', exact: true })
          .click();
        await expect(page.getByTestId('transcript')).toContainText(
          '会话已就绪',
        );
        const send = page.getByRole('button', {
          name: '发送消息',
          exact: true,
        });
        await expect(send).toBeDisabled();
        expect(
          await send.evaluate((el) => Number(getComputedStyle(el).opacity)),
        ).toBe(0.45);
        const background = await send.evaluate(
          (el) => getComputedStyle(el).backgroundColor,
        );
        await send.hover({ force: true });
        expect(
          await send.evaluate((el) => getComputedStyle(el).backgroundColor),
        ).toBe(background);
        await page
          .getByLabel('消息', { exact: true })
          .fill('Synthetic unsent draft');
        await expect(send).toBeEnabled();
        expect(
          await send.evaluate((el) => Number(getComputedStyle(el).opacity)),
        ).toBe(1);
        await page.getByLabel('消息', { exact: true }).fill('');
      }
      for (const width of [1440, 1024, 820, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        const measurements = await page.evaluate(() => {
          const root = getComputedStyle(document.documentElement);
          return {
            overflow: document.documentElement.scrollWidth > innerWidth,
            workspaceOverflow:
              document.querySelector('.workspace-scroll')!.scrollWidth >
              document.querySelector('.workspace-scroll')!.clientWidth,
            rail: document.querySelector('.rail')!.getBoundingClientRect()
              .width,
            content: document
              .querySelector('.content-width')!
              .getBoundingClientRect().width,
            topbar: document.querySelector('.topbar')!.getBoundingClientRect()
              .height,
            gutter: root.getPropertyValue('--gutter').trim(),
            brandSoft: root.getPropertyValue('--brand-soft').trim(),
            control: root.getPropertyValue('--control-h').trim(),
          };
        });
        expect(measurements.overflow, `${view}/${colorScheme}/${width}`).toBe(
          false,
        );
        expect(
          measurements.workspaceOverflow,
          `${view}/${colorScheme}/${width} workspace`,
        ).toBe(false);
        if (width === 820)
          await expect(
            page.getByRole('button', { name: '退出登录', exact: true }),
          ).toBeVisible();
        expect(measurements.rail).toBe(width === 820 ? 64 : 248);
        expect(measurements.content).toBeLessThanOrEqual(960);
        expect(measurements.topbar).toBe(width === 390 ? 72 : 54);
        expect(measurements.gutter).toBe('24px');
        expect(measurements.control).toBe(width === 390 ? '40px' : '30px');
        expect(measurements.brandSoft).toBe(
          colorScheme === 'light' ? '#f1f8fa' : '#102a33',
        );
        const contrast = await page.evaluate(() => {
          const channels = (color: string) =>
            color.match(/[\d.]+/g)!.map(Number);
          const luminance = (rgb: number[]) =>
            rgb
              .slice(0, 3)
              .map((value) => {
                const c = value / 255;
                return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
              })
              .reduce(
                (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!,
                0,
              );
          return [
            ...document.querySelectorAll<HTMLElement>(
              '.content-width .muted, .prose-text, .detail-grid dd, .requirement-row small, .composer label, input[placeholder], textarea[placeholder]',
            ),
          ]
            .filter(
              (el) =>
                el.getClientRects().length &&
                !el.closest('[inert]') &&
                !el.matches(':disabled'),
            )
            .map((el) => {
              let ancestor: Element | null = el;
              let bg = channels(
                getComputedStyle(document.documentElement).backgroundColor,
              );
              while (ancestor) {
                const value = channels(
                  getComputedStyle(ancestor).backgroundColor,
                );
                if ((value[3] ?? 1) === 1) {
                  bg = value;
                  break;
                }
                ancestor = ancestor.parentElement;
              }
              const fg = channels(
                getComputedStyle(
                  el,
                  el.hasAttribute('placeholder') ? '::placeholder' : null,
                ).color,
              );
              const alpha = fg[3] ?? 1;
              const text = fg
                .slice(0, 3)
                .map((value, i) => value * alpha + bg[i]! * (1 - alpha));
              return (
                (Math.max(luminance(text), luminance(bg)) + 0.05) /
                (Math.min(luminance(text), luminance(bg)) + 0.05)
              );
            });
        });
        expect(contrast.length).toBeGreaterThan(0);
        expect(
          Math.min(...contrast),
          `${view}/${colorScheme}/${width} contrast`,
        ).toBeGreaterThanOrEqual(4.5);
        if (width === 390) {
          const heights = await page
            .locator(
              '.content-width button, .content-width select, .content-width input:not([type="checkbox"])',
            )
            .evaluateAll((elements) =>
              elements
                .filter((el) => el.getClientRects().length)
                .map((el) => ({
                  name: el.getAttribute('aria-label') ?? el.textContent?.trim(),
                  height: (el.closest('.t-input') ?? el).getBoundingClientRect()
                    .height,
                })),
            );
          expect(
            heights.filter((item) => item.height < 40),
            `${view}/${colorScheme}/${width} targets`,
          ).toEqual([]);
        }
        await page.locator('.workspace-scroll').evaluate((el) => {
          el.scrollTop = 0;
        });
        await page.screenshot({
          path: `.impeccable/review/t01-final/${view}-${colorScheme}-${width}.png`,
          animations: 'disabled',
        });
      }
    }
  }
  expect(errors).toEqual([]);
});
