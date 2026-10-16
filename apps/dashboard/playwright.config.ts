import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests', workers: 1, use: { baseURL: 'http://localhost:5174' },
  webServer: { command: 'node tests/server.mjs', url: 'http://localhost:5174', reuseExistingServer: false },
});
