import { defineConfig, devices } from '@playwright/test';
import { loadEnvironment } from '@rdws/runtime-config';
loadEnvironment('test');
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  workers: 1,
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:5317',
    trace: 'off',
    screenshot: 'off',
    video: 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'pnpm dev',
    url: 'http://127.0.0.1:5317/api/health',
    reuseExistingServer: false,
    env: {
      RDWS_MODE: 'test',
      RDWS_WEB_PORT: '5317',
      RDWS_API_PORT: '3303',
      RDWS_ORIGIN: 'http://127.0.0.1:5317',
    },
    timeout: 60000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 10000 },
  },
});
