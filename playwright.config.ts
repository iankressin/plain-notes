import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests',
  fullyParallel: false,
  workers: 1,
  timeout: 20_000,
  use: { baseURL: 'http://localhost:1422', channel: 'chrome', viewport: { width: 340, height: 520 } },
  projects: [
    { name: 'light', use: { colorScheme: 'light' } },
    { name: 'dark', use: { colorScheme: 'dark' } },
  ],
  webServer: { command: 'pnpm dev --port 1422', url: 'http://localhost:1422', reuseExistingServer: true },
});
