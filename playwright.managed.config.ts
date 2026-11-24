import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/web-live',
  testMatch: [
    '**/managed-fleet.browser.ts',
    '**/model-pilot-passive.browser.ts',
    '**/write-tools-journey.browser.ts',
  ],
  workers: 1,
  timeout: 120000,
  reporter: 'list',
  projects: [
    { name: 'managed-chromium', use: { ...devices['Desktop Chrome'] } },
  ],
});
