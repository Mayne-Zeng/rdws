import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { runtimeHome } from '../../scripts/env.mjs';
for (const colorScheme of ['light', 'dark'] as const) {
  test(`preset account login and logout (${colorScheme})`, async ({ page }) => {
    await page.emulateMedia({ colorScheme });
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const accounts: { username: string; password: string }[] = JSON.parse(
      await readFile(
        join(runtimeHome, 'secrets', 'test-accounts.json'),
        'utf8',
      ),
    );
    const lead = accounts.find((a) => a.username === 'lead')!;
    await page.goto('/');
    await expect(
      page.getByRole('heading', { name: '进入你的工作台' }),
    ).toBeVisible();
    const placeholderContrast = await page
      .getByLabel('账号', { exact: true })
      .evaluate((el) => {
        const values = (s: string) => s.match(/[\d.]+/g)!.map(Number);
        const fg = values(getComputedStyle(el, '::placeholder').color),
          bg = values(getComputedStyle(el.parentElement!).backgroundColor);
        const alpha = fg[3] ?? 1;
        const composed = fg
          .slice(0, 3)
          .map((v, i) => v * alpha + bg[i]! * (1 - alpha));
        const lum = (rgb: number[]) =>
          rgb
            .slice(0, 3)
            .map((v) => {
              const c = v / 255;
              return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
            })
            .reduce((s, v, i) => s + v * [0.2126, 0.7152, 0.0722][i]!, 0);
        return (
          (Math.max(lum(composed), lum(bg)) + 0.05) /
          (Math.min(lum(composed), lum(bg)) + 0.05)
        );
      });
    expect(placeholderContrast).toBeGreaterThanOrEqual(4.5);
    await page.screenshot({ path: `test-results/login-${colorScheme}.png` });
    await page.getByLabel('账号', { exact: true }).fill(lead.username);
    await page.getByLabel('密码', { exact: true }).fill(lead.password);
    await page.getByRole('button', { name: '登录', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: '需求管理', exact: true }),
    ).toBeVisible();
    await page.reload();
    await expect(
      page.getByRole('heading', { name: '需求管理', exact: true }),
    ).toBeVisible();
    await expect(page.locator('.nav-item .count').first()).toHaveText(/^\d+$/);
    const newRequirement = page.getByRole('button', {
      name: '新建需求',
      exact: true,
    });
    await page.setViewportSize({ width: 1440, height: 844 });
    await expect(newRequirement).toHaveCount(0);
    await page.setViewportSize({ width: 820, height: 844 });
    await expect(newRequirement).toHaveCount(0);
    await page.setViewportSize({ width: 390, height: 844 });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await page.screenshot({
      path: `test-results/workbench-${colorScheme}.png`,
    });
    await page.getByRole('button', { name: '打开导航', exact: true }).click();
    await expect(newRequirement).toHaveCount(0);
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
        const luminance = (color: string) => {
          const channels = color
            .match(/[\d.]+/g)!
            .slice(0, 3)
            .map(Number)
            .map((value) => {
              const v = value / 255;
              return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
            });
          return (
            0.2126 * channels[0]! +
            0.7152 * channels[1]! +
            0.0722 * channels[2]!
          );
        };
        const text = luminance(style.color),
          background = luminance(backgroundColor);
        return (
          (Math.max(text, background) + 0.05) /
          (Math.min(text, background) + 0.05)
        );
      });
    expect(contrast).toBeGreaterThanOrEqual(4.5);
    await page.getByRole('button', { name: '退出登录' }).click();
    await expect(
      page.getByRole('heading', { name: '进入你的工作台' }),
    ).toBeVisible();
    expect(errors).toEqual([]);
  });
}
