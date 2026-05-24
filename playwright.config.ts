import { defineConfig, devices } from '@playwright/test';

export const TEST_PORT = 29443;
export const BASE_URL = `https://localhost:${TEST_PORT}`;

export default defineConfig({
  testDir: `./tests`,
  fullyParallel: true,
  timeout: 10_000,
  reporter: [
    [`list`],
    [`html`, { open: `never` }],
  ],
  /* Shared settings for all the projects below. See https://playwright.dev/docs/api/class-testoptions. */
  use: {
    /* Collect trace when retrying the failed test. See https://playwright.dev/docs/trace-viewer */
    trace: `on`,
    // trace: 'on-first-retry',

    /* Capture screenshot on failure */
    // screenshot: 'on',
    screenshot: `only-on-failure`,

    /* Capture video on failure */
    video: `retain-on-failure`,

    baseURL: BASE_URL,
    ignoreHTTPSErrors: true,

  },
  projects: [
    {
      name: `chromium`,
      use: { ...devices[`Desktop Chrome`] },
    },
  ],
  globalSetup: `./tests/global-setup.ts`,
  globalTeardown: `./tests/global-teardown.ts`,
});
