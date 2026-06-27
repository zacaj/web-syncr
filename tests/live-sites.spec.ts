/**
 * Live site regression tests — opt-in.
 *
 * Prerequisites:
 *   - HTTPS certs configured in .env (same requirement as the normal test suite)
 *   - Internet access (these tests fetch real external sites through the proxy)
 *   - LIVE_TESTS=1 or LIVE_MAGICURL=<url> environment variable
 *
 * Run:
 *   LIVE_TESTS=1 pnpm test tests/live-sites.spec.ts
 *   LIVE_MAGICURL=http://100.111.42.92:3005 pnpm test tests/live-sites.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_TEST_PATH, TEST_PORT } from './global-setup';

const MAGICURL = process.env.LIVE_MAGICURL;
const LIVE = process.env.LIVE_TESTS || MAGICURL;

const BRIGHTNOVELS_WRAPPED_RE = new RegExp(
  `^https://[a-z0-9]+__brightnovels_com__\\.localhost:${TEST_PORT}/`,
);

const FOXAHOLIC_WRAPPED_RE = new RegExp(
  `^https://[a-z0-9]+__www_foxaholic_com__\\.localhost:${TEST_PORT}/`,
);

const GIT_ZACAJ_WRAPPED_RE = new RegExp(
  `^https://[a-z0-9]+__git_zacaj_com__\\.localhost:${TEST_PORT}/`,
);

async function switchToMagicurl(page: Page): Promise<void> {
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  if (!sessionId) throw new Error(`Could not extract sessionId from URL: ${page.url()}`);
  await page.request.post(`https://localhost:${TEST_PORT}/__session-mode`, {
    data: { sessionId, mode: `magicurl` },
  });
  const resp = await page.reload({ waitUntil: `domcontentloaded` });
  expect(await resp?.headerValue(`x-load-mode`)).toBe(`magicurl`);
}

test.describe(`Live site regression tests`, () => {
  test(`brightnovels.com/series/sigrid/1 loads with header and rewritten links`, async ({ page }) => {
    test.skip(!LIVE, `opt-in: run with LIVE_TESTS=1 or LIVE_MAGICURL=<url>`);
    test.setTimeout(MAGICURL ? 60_000 : 30_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://brightnovels.com/series/sigrid/1`);
    await Promise.all([
      page.waitForURL(BRIGHTNOVELS_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    if (MAGICURL) await switchToMagicurl(page);

    expect(page.url()).toMatch(BRIGHTNOVELS_WRAPPED_RE);

    // Wait for page content to load before checking
    await page.waitForLoadState(`networkidle`);

    // Header bar injected
    await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

    // Wait for page content to load (JavaScript-heavy SPA)
    await page.waitForFunction(() =>
      document.body.textContent?.includes('luxury'),
    );
  });

  test.skip(`foxaholic.com chapter loads via magicurl with header and rewritten links`, async ({ page }) => {
    test.skip(!MAGICURL, `opt-in: run with LIVE_MAGICURL=<url>`);
    test.setTimeout(60_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://www.foxaholic.com/novel/transmigrating-to-become-the-bosss-little-fairy/chapter-1/`);
    await Promise.all([
      page.waitForURL(FOXAHOLIC_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    await switchToMagicurl(page);

    expect(page.url()).toMatch(FOXAHOLIC_WRAPPED_RE);

    // Header bar injected
    await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

    // No raw foxaholic.com hrefs should remain
    const rawLinks = await page.locator(`a[href*="foxaholic.com"]`).count();
    expect(rawLinks).toBe(0);

    // At least some links were rewritten into the wrapped subdomain form
    const wrappedLinks = await page.locator(`a[href*="__.localhost:${TEST_PORT}"]`).count();
    expect(wrappedLinks).toBeGreaterThan(0);

    await expect(page.locator(`body`)).toContainText(`nonymous group also said that Ji Rang and a gro`);
  });

  test(`brightnovels.com Next button navigates without showing an Inertia modal`, async ({ page }) => {
    test.skip(!LIVE, `opt-in: run with LIVE_TESTS=1 or LIVE_MAGICURL=<url>`);
    test.setTimeout(MAGICURL ? 90_000 : 45_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://brightnovels.com/series/sigrid/1`);
    await Promise.all([
      page.waitForURL(BRIGHTNOVELS_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    if (MAGICURL) await switchToMagicurl(page);

    // Wait for Inertia to hydrate and render the chapter content
    await page.waitForLoadState(`networkidle`);

    // Click the Next button (Inertia Link navigating to chapter 2)
    // In magicurl mode, our injected click handler forces a full page navigate
    // instead of letting Inertia XHR it — so we capture the navigate response.
    const ch2ResponsePromise = MAGICURL
      ? page.waitForResponse(r =>
        r.url().includes(`/series/sigrid/2`) &&
        (r.headers()[`content-type`] ?? ``).includes(`text/html`))
      : undefined;

    await page.locator(`a[href*="/series/sigrid/2"], button:has-text("Next")`)
      .first()
      .click();

    // URL should change to chapter 2 wrapped form — not stay on chapter 1
    await page.waitForURL(/\/series\/sigrid\/2/);
    expect(page.url()).toMatch(BRIGHTNOVELS_WRAPPED_RE);
    expect(page.url()).toContain(`/series/sigrid/2`);

    // In magicurl mode, verify chapter 2 was served through magicurl (not proxy fallback)
    if (MAGICURL && ch2ResponsePromise) {
      const ch2Response = await ch2ResponsePromise;
      expect(ch2Response.headers()[`x-load-mode`]).toBe(`magicurl`);
    }

    // Inertia shows failed non-Inertia responses in a <dialog> — must NOT be open
    const modalVisible = await page.locator(`dialog[open]`).count();
    expect(modalVisible).toBe(0);

    // Wait for the async /__client-nav fetch+save to complete
    await page.waitForTimeout(3000);

    // Find the session dir and verify the chapter 2 HTML was saved non-empty
    const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1]!;
    const sessionDir = join(DB_TEST_PATH, `session_${sessionId}`);
    const candidates = [
      join(sessionDir, `series`, `sigrid`, `2.html`),
      join(sessionDir, `series`, `sigrid`, `2`, `index.html`),
    ];
    const saved = candidates.map(p => existsSync(p) ? readFileSync(p, `utf8`) : null).find(Boolean);
    expect(saved, `chapter 2 HTML file should exist and be non-empty`).toBeTruthy();
    expect(saved!.length).toBeGreaterThan(500);

    await expect(page.locator(`body`)).toContainText(`1500 kerb per month`);
  });

  test(`git.zacaj.com loads with header and allows navigation to explore`, async ({ page }) => {
    test.skip(!LIVE, `opt-in: run with LIVE_TESTS=1 or LIVE_MAGICURL=<url>`);
    test.setTimeout(MAGICURL ? 60_000 : 30_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://git.zacaj.com/`);
    await Promise.all([
      page.waitForURL(GIT_ZACAJ_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    if (MAGICURL) await switchToMagicurl(page);

    expect(page.url()).toMatch(GIT_ZACAJ_WRAPPED_RE);

    // Header bar injected
    await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

    // Verify initial page content
    await expect(page.locator(`body`)).toContainText(`A painless, self-hosted Git service`);

    // Click the Explore link in the header (evaluate to bypass <select> interception)
    await page.evaluate(() => {
      const els = document.querySelectorAll('a');
      for (const el of els) {
        if (el.textContent?.includes('Explore')) {
          el.click();
          break;
        }
      }
    });

    // Wait for navigation and verify the explore page loaded
    await page.waitForLoadState(`networkidle`);

    // Click Sign in to reach the login form
    await page.locator(`a:has-text("Sign in")`).first().click();
    await page.waitForLoadState(`networkidle`);
    await expect(page.locator(`body`)).toContainText(`Username or email address`);
  });
});
