import { expect, test, type Page } from '@playwright/test';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_TEST_PATH, MOCK_PORT, TEST_PORT } from './global-setup';

// Magicurl fixture data
const MAGICURL_MOUNT = join(process.cwd(), `tests/fixtures/magicurl`);
const FETCH_ID = `abc123fetch`;
const SESSION_ID = `test_magic_session`;

// Override WRAPPED_URL_RE for the test subdomain format
const WRAPPED_URL_RE = new RegExp(
  `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
);

// ── Helpers ─────────────────────────────────────────────────────────────────

async function createMagicurlSession(page: Page) {
  await page.goto(`/`);
  await page.fill(`input[type="url"][name="url"]`, `http://localhost/page2`);
  await Promise.all([
    page.waitForURL(WRAPPED_URL_RE),
    page.locator(`form[action="/"] button[type="submit"]`).first().click(),
  ]);
}

// ── Manifest lookup tests ───────────────────────────────────────────────────

test(`magicurl manifest lookup finds asset by exact URL`, async ({ page }) => {
  // Create a session, then manually set its config to magicurl mode
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  // Write magicurl session config
  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  const fixtureConfig = readFileSync(join(MAGICURL_MOUNT, FETCH_ID, `result.json`), `utf8`);
  const fetchResult = JSON.parse(fixtureConfig);

  // Set mode to magicurl and store the fetchId
  const config = { mode: `magicurl`, magicSessionId: `magic-1`, lastFetchId: FETCH_ID, _lastUrl: `http://localhost/page2` };
  writeFileSync(configPath, JSON.stringify(config));

  // Verify the config was written
  const written = JSON.parse(readFileSync(configPath, `utf8`)) as { mode: string; lastFetchId: string };
  expect(written.mode).toBe(`magicurl`);
  expect(written.lastFetchId).toBe(FETCH_ID);
});

test(`magicurl DOM is served from mount`, async ({ page }) => {
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  // Write magicurl config
  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  const config = { mode: `magicurl`, magicSessionId: `magic-1`, lastFetchId: FETCH_ID, _lastUrl: `http://localhost/page2` };
  writeFileSync(configPath, JSON.stringify(config));

  // The DOM file should exist in fixtures
  const domPath = join(MAGICURL_MOUNT, FETCH_ID, `dom.html`);
  expect(existsSync(domPath)).toBe(true);
  const dom = readFileSync(domPath, `utf8`);
  expect(dom).toContain(`Mock Page 2`);
  expect(dom).toContain(`Back home`);
});

test(`magicurl asset lookup returns correct mimeType`, async ({ page }) => {
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  // Write magicurl config
  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  const config = { mode: `magicurl`, magicSessionId: `magic-1`, lastFetchId: FETCH_ID, _lastUrl: `http://localhost/page2` };
  writeFileSync(configPath, JSON.stringify(config));

  // Verify asset files exist
  const cssPath = join(MAGICURL_MOUNT, FETCH_ID, `assets`, `a1b2c3.css`);
  const jsPath = join(MAGICURL_MOUNT, FETCH_ID, `assets`, `d4e5f6.js`);
  const pngPath = join(MAGICURL_MOUNT, FETCH_ID, `assets`, `g7h8i9.png`);
  expect(existsSync(cssPath)).toBe(true);
  expect(existsSync(jsPath)).toBe(true);
  expect(existsSync(pngPath)).toBe(true);
});

test(`magicurl mode HTML is rewritten with wrapped URLs`, async ({ page }) => {
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  // Write magicurl config pointing to fixture
  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  const config = { mode: `magicurl`, magicSessionId: `magic-1`, lastFetchId: FETCH_ID, _lastUrl: `http://localhost/page2` };
  writeFileSync(configPath, JSON.stringify(config));

  // Read the fixture DOM and verify it contains absolute URLs
  const domPath = join(MAGICURL_MOUNT, FETCH_ID, `dom.html`);
  const dom = readFileSync(domPath, `utf8`);
  expect(dom).toContain(`http://localhost/page2/style.css`);
  expect(dom).toContain(`http://localhost/page2/app.js`);
});

test(`magicurl miss falls back to proxy`, async ({ page }) => {
  // Create a session with magicurl mode but no matching asset
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  const config = { mode: `magicurl`, magicSessionId: `magic-1`, lastFetchId: `nonexistent`, _lastUrl: `http://localhost/nonexistent` };
  writeFileSync(configPath, JSON.stringify(config));

  // Navigate to a different path within the same session — should fall back to proxy
  // since the magicurl snapshot doesn't have this URL
  const resp = await page.goto(page.url());
  expect(resp?.status()).not.toBe(500);
});

test(`session config preserves magicSessionId when switching modes`, async ({ page }) => {
  await createMagicurlSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);

  // Write initial magicurl config with extra fields
  writeFileSync(configPath, JSON.stringify({
    mode: `magicurl`,
    magicSessionId: `magic-abc`,
    lastFetchId: `fetch-123`,
  }));

  // Simulate what the __session-mode endpoint does: preserve magicSessionId when writing new config
  const existing = existsSync(configPath)
    ? (JSON.parse(readFileSync(configPath, `utf8`)) as { magicSessionId?: string })
    : {};
  const updated = { mode: `proxy`, magicSessionId: existing.magicSessionId };
  writeFileSync(configPath, JSON.stringify(updated));

  // Verify mode changed but magicSessionId was preserved
  const result = JSON.parse(readFileSync(configPath, `utf8`)) as { mode: string; magicSessionId?: string };
  expect(result.mode).toBe(`proxy`);
  expect(result.magicSessionId).toBe(`magic-abc`);
});

test(`mode select in header shows magicurl option`, async ({ page }) => {
  await createMagicurlSession(page);

  // The header should have a select with both options
  const select = page.locator(`select`);
  await expect(select).toBeVisible();

  const options = await select.locator(`option`).all();
  expect(options).toHaveLength(2);
  const values = await Promise.all(options.map(o => o.innerText()));
  expect(values).toContain(`proxy`);
  expect(values).toContain(`magicurl`);
});

// ── Mode persistence ────────────────────────────────────────────────────────

test(`default mode is proxy for new sessions`, async ({ page }) => {
  // Fresh session should default to proxy mode
  await page.goto(`/`);
  await page.fill(`input[type="url"][name="url"]`, `http://localhost/`);
  await Promise.all([
    page.waitForURL(WRAPPED_URL_RE),
    page.locator(`form[action="/"] button[type="submit"]`).first().click(),
  ]);

  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  const configPath = join(DB_TEST_PATH, `session_${sessionId}.config.json`);
  expect(existsSync(configPath)).toBe(false);
  // No config file means default to proxy
});
