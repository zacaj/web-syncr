import { expect, test, type Page } from '@playwright/test';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  DB_TEST_PATH,
  MOCK_MAGICURL_PORT,
  TEST_PORT,
  createSession,
  extractSessionId,
} from './global-setup';

// The mock magicurl's solved/unsolved state is shared, so these run in order.
test.describe.configure({ mode: `serial` });

const MOCK = `http://localhost:${MOCK_MAGICURL_PORT}`;
async function mock(action: `solve` | `reset` | `state`): Promise<{ solved: boolean; renders: number; lastUpgrade: string }> {
  return await (await fetch(`${MOCK}/__mock/${action}`)).json() as { solved: boolean; renders: number; lastUpgrade: string };
}
test.beforeEach(async () => { await mock(`reset`) });

// Override WRAPPED_URL_RE for the test subdomain format
const WRAPPED_URL_RE = new RegExp(
  `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
);

async function createChallengeSession(page: Page) {
  await createSession(page, `http://localhost/page2`, WRAPPED_URL_RE);
}

/** A session in magicurl mode whose last render was the pending challenge, showing the challenge page. */
async function openChallengePage(page: Page): Promise<string> {
  await createChallengeSession(page);
  const sessionId = extractSessionId(page.url())!;
  writeFileSync(join(DB_TEST_PATH, `session_${sessionId}.config.json`), JSON.stringify({
    mode: `magicurl`,
    magicSessionId: `magic-challenge`,
  }));
  const response = await page.goto(page.url());
  expect(response?.headers()[`x-magicurl-challenge`]).toBe(`cloudflare`);
  return sessionId;
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

// ── Getting past the challenge ───────────────────────────────────────────────

test(`reloading a challenge page re-renders instead of re-serving the cached challenge`, async ({ page }) => {
  // Regression: a non-forced navigation reused the session's cached fetch, and
  // magicurl writes a challenged fetch's manifest once and never updates it —
  // so after solving in VNC, every refresh served the same challenge forever.
  await openChallengePage(page);
  const before = (await mock(`state`)).renders;
  await mock(`solve`);
  const response = await page.reload();
  expect(response?.headers()[`x-magicurl-challenge`]).toBeUndefined();
  await expect(page.locator(`#solved`)).toBeVisible();
  expect((await mock(`state`)).renders).toBe(before + 1);
});

test(`the auto-check never re-renders (it would close the page being solved in VNC)`, async ({ page }) => {
  const sessionId = await openChallengePage(page);
  const before = (await mock(`state`)).renders;
  const poll = () => page.evaluate(async (sid) => {
    // The challenge page's own REAL_URL, so this hits the cached fetch rather than a miss.
    const r = await fetch(`/__poll-challenge?sessionId=${sid}&url=${encodeURIComponent((window as unknown as { REAL_URL: string }).REAL_URL)}`);
    return await r.json() as { pending: boolean };
  }, sessionId);
  expect((await poll()).pending).toBe(true);
  // Solved in VNC, but nothing has re-rendered yet: still pending, still no render.
  await mock(`solve`);
  expect((await poll()).pending).toBe(true);
  expect((await mock(`state`)).renders).toBe(before);
});

test(`Check Now while still blocked says so instead of doing nothing`, async ({ page }) => {
  await openChallengePage(page);
  const dialog = page.waitForEvent(`dialog`);
  await page.locator(`#done-btn`).click();
  const d = await dialog;
  expect(d.message()).toContain(`Still blocked by cloudflare`);
  await d.dismiss();
  await expect(page.locator(`#poll-status`)).toHaveClass(`error`);
  await expect(page.locator(`#done-btn`)).toBeEnabled();
});

test(`Check Now after solving loads the page — and another device's challenge page follows`, async ({ page, browser }) => {
  await openChallengePage(page);
  // Second device sitting on the same challenge page.
  const other = await browser.newContext({ ignoreHTTPSErrors: true });
  const phone = await other.newPage();
  const phoneResponse = await phone.goto(page.url());
  expect(phoneResponse?.headers()[`x-magicurl-challenge`]).toBe(`cloudflare`);

  await mock(`solve`);
  await page.locator(`#done-btn`).click();
  await expect(page.locator(`#solved`)).toBeVisible();

  // The phone never re-renders; its cheap 5s poll sees the desktop's render.
  await expect(phone.locator(`#solved`)).toBeVisible({ timeout: 10_000 });
  await other.close();
});

// ── Public VNC behind a per-attempt token ────────────────────────────────────

/** The challenge page's own VNC path (same-origin, token-bearing). */
async function vncPath(page: Page): Promise<string> {
  const src = await page.locator(`iframe#vnc`).getAttribute(`data-src`);
  expect(src).toMatch(/^\/__vnc\/[\w-]{20,}\/vnc\.html\?/);
  return src!;
}

/** Open a websocket from the page; resolves to the first message, or `closed` if refused. */
function wsFirstMessage(page: Page, path: string): Promise<string> {
  return page.evaluate(p => new Promise<string>(resolve => {
    const ws = new WebSocket(`wss://${location.host}${p}`);
    ws.onmessage = e => { resolve(String(e.data)); ws.close() };
    ws.onerror = () => resolve(`closed`);
    ws.onclose = () => resolve(`closed`);
  }), path);
}

test(`the challenge page embeds noVNC same-origin over https, with no referrer leak`, async ({ page }) => {
  await openChallengePage(page);
  const src = await vncPath(page);
  // The websocket is routed back through the same token, not to the root.
  const token = /^\/__vnc\/([^/]+)\//.exec(src)![1]!;
  expect(new URLSearchParams(src.split(`?`)[1]).get(`path`)).toBe(`__vnc/${token}/websockify`);

  await expect(page.frameLocator(`iframe#vnc`).locator(`#novnc`)).toHaveText(`mock novnc`);
  const res = await page.request.get(src);
  expect(res.status()).toBe(200);
  expect(res.headers()[`referrer-policy`]).toBe(`no-referrer`);

  expect(await wsFirstMessage(page, `/__vnc/${token}/websockify`)).toBe(`hello`);
  // Re-pathed and re-hosted for websockify.
  expect((await mock(`state`)).lastUpgrade).toBe(`localhost:${MOCK_MAGICURL_PORT} /websockify`);
});

test(`an unknown VNC token gets nothing — page or websocket`, async ({ page }) => {
  await openChallengePage(page);
  expect((await page.request.get(`/__vnc/not-a-real-token-at-all/vnc.html`)).status()).toBe(404);
  expect(await wsFirstMessage(page, `/__vnc/not-a-real-token-at-all/websockify`)).toBe(`closed`);
  expect((await mock(`state`)).lastUpgrade).toBe(``);
});

test(`getting past the challenge revokes the VNC link`, async ({ page }) => {
  await openChallengePage(page);
  const src = await vncPath(page);
  expect((await page.request.get(src)).status()).toBe(200);
  await mock(`solve`);
  await page.locator(`#done-btn`).click();
  await expect(page.locator(`#solved`)).toBeVisible();
  expect((await page.request.get(src)).status()).toBe(404);
});

// ── Re-render reuse ──────────────────────────────────────────────────────────

test(`a forced check right after a successful render reuses it`, async ({ page }) => {
  // Regression: the reload after a successful check can look like a refresh
  // (Referer === URL), which forced a second full render of a page that had
  // just been rendered — doubling the wait to get past the challenge.
  await openChallengePage(page);
  await mock(`solve`);
  const force = () => page.evaluate(async () => (await fetch(`/__poll-challenge?sessionId=${(window as unknown as { SESSION_ID: string }).SESSION_ID}&url=${encodeURIComponent((window as unknown as { REAL_URL: string }).REAL_URL)}&force=1`)).json() as Promise<{ pending: boolean }>);
  expect((await force()).pending).toBe(false);
  const after = (await mock(`state`)).renders;
  expect((await force()).pending).toBe(false);
  expect((await mock(`state`)).renders).toBe(after);
});
