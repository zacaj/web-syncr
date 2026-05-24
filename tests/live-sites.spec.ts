/**
 * Live site regression tests — opt-in.
 *
 * Prerequisites:
 *   - HTTPS certs configured in .env (same requirement as the normal test suite)
 *   - Internet access (these tests fetch real external sites through the proxy)
 *   - LIVE_TESTS=1 environment variable
 *
 * Run: LIVE_TESTS=1 pnpm test tests/live-sites.spec.ts
 */
import { expect, test } from '@playwright/test';
import { TEST_PORT } from './global-setup';

const BRIGHTNOVELS_WRAPPED_RE = new RegExp(
  `^https://[a-z0-9]+__brightnovels_com__\\.localhost:${TEST_PORT}/`,
);

test.describe(`Live site regression tests`, () => {
  test(`brightnovels.com/series/sigrid/1 loads with header and rewritten links`, async ({ page }) => {
    test.skip(!process.env[`LIVE_TESTS`], `opt-in: run with LIVE_TESTS=1`);
    test.setTimeout(30_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://brightnovels.com/series/sigrid/1`);
    await Promise.all([
      page.waitForURL(BRIGHTNOVELS_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    expect(page.url()).toMatch(BRIGHTNOVELS_WRAPPED_RE);

    // Header bar injected
    await expect(page.locator(`text=Session:`)).toBeVisible();
    await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

    // No raw brightnovels.com hrefs should remain
    const rawLinks = await page.locator(`a[href*="brightnovels.com"]`).count();
    expect(rawLinks).toBe(0);

    // At least some links were rewritten into the wrapped subdomain form
    const wrappedLinks = await page.locator(`a[href*="__.localhost:${TEST_PORT}"]`).count();
    expect(wrappedLinks).toBeGreaterThan(0);
  });

  test(`brightnovels.com Next button navigates without showing an Inertia modal`, async ({ page }) => {
    test.skip(!process.env[`LIVE_TESTS`], `opt-in: run with LIVE_TESTS=1`);
    test.setTimeout(45_000);

    await page.goto(`/`);
    await page.fill(`input[type="url"][name="url"]`, `https://brightnovels.com/series/sigrid/1`);
    await Promise.all([
      page.waitForURL(BRIGHTNOVELS_WRAPPED_RE),
      page.locator(`form[action="/"] button[type="submit"]`).first().click(),
    ]);

    // Wait for Inertia to hydrate and render the chapter content
    await page.waitForLoadState(`networkidle`);

    // Click the Next button (Inertia Link navigating to chapter 2)
    await page.locator(`a[href*="/series/sigrid/2"], button:has-text("Next")`)
      .first()
      .click();

    // URL should change to chapter 2 wrapped form — not stay on chapter 1
    await page.waitForURL(/\/series\/sigrid\/2/);
    expect(page.url()).toMatch(BRIGHTNOVELS_WRAPPED_RE);
    expect(page.url()).toContain(`/series/sigrid/2`);

    // Inertia shows failed non-Inertia responses in a <dialog> — must NOT be open
    const modalVisible = await page.locator(`dialog[open]`).count();
    expect(modalVisible).toBe(0);
  });
});
