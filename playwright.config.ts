import { defineConfig, devices } from 'playwright/test';

const PORT = 3012;
const BASE_PATH = (process.env.BASE_PATH ?? '').replace(/\/$/, '');
const BASE_URL = `http://127.0.0.1:${PORT}${BASE_PATH}`;

// End-to-end runs against the built export served by `serve`, not the dev server,
// so the suite exercises the same bytes the host will publish.
export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  reporter: process.env.CI ? 'github' : 'list',
  timeout: 90_000,
  expect: { timeout: 15_000 },
  use: {
    baseURL: `${BASE_URL}/`,
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node scripts/serve-static.mjs out',
    env: { BASE_PATH },
    url: `${BASE_URL}/`,
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
