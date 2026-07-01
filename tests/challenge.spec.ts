import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DB_TEST_PATH,
  TEST_PORT,
  createSession,
  extractSessionId,
} from './global-setup';

// Override WRAPPED_URL_RE for the test subdomain format
const WRAPPED_URL_RE = new RegExp(
  `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
);

async function createChallengeSession(page: Page) {
  await createSession(page, `http://localhost/page2`, WRAPPED_URL_RE);
}

// ── Challenge page HTML tests ────────────────────────────────────────────────

test(`challenge page renders when magicurl returns challengePending`, async ({ page }) => {
  // Create a session in magicurl mode
  await createChallengeSession(page);
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  // Write magicurl config pointing to the mock magicurl API
  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  writeFileSync(configPath, JSON.stringify({
    mode: `magicurl`,
    magicSessionId: `magic-challenge`,
    lastFetchId: `challenge_fetch`,
    _lastUrl: `http://localhost/page2`,
  }));

  // Navigate — this triggers renderPage() which hits the mock magicurl API
  // and returns the challenge response
  const response = await page.goto(page.url());
  expect(response?.status()).toBe(200);

  // Verify challenge header
  expect(response?.headers()['x-magicurl-challenge']).toBe(`cloudflare`);

  // Verify challenge HTML structure
  const html = await page.content();
  expect(html).toContain(`Challenge pending — cloudflare`);
  expect(html).toContain(`<h2>cloudflare challenge</h2>`);
  expect(html).toContain(`http://localhost/page2`);
  expect(html).toContain(`<iframe`);
  expect(html).toContain(`__poll-challenge`);

  // Verify injected header (session ID input, new URL form)
  await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

  // Verify injected navigation script (pushState interceptor)
  expect(html).toContain(`__client-nav`);
});
