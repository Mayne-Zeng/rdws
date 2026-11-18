import base from './playwright.config.ts';
import { defineConfig } from '@playwright/test';
export default defineConfig({
  ...base,
  testDir: './tests/web-live',
  timeout: 180000,
  use: { ...base.use, actionTimeout: 12000 },
});
