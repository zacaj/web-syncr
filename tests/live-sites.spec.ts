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
import {
  DB_TEST_PATH,
  TEST_PORT,
  assertHeaderPresent,
  assertPageContent,
  createSession,
} from './global-setup';

const MAGICURL = process.env.LIVE_MAGICURL;
const LIVE = process.env.LIVE_TESTS || MAGICURL;

// ── Types ───────────────────────────────────────────────────────────────────

type NavigationAction = (page: Page) => Promise<void>;

interface NavigationTest {
  name: string;
  /** Action to trigger navigation */
  action: NavigationAction;
  /** Optional: wait for URL pattern; defaults to any URL change */
  urlPattern?: RegExp | string;
  /** Optional: expect a specific response header (e.g., 'x-load-mode': 'magicurl') */
  expectedHeaders?: Record<string, string>;
  /** Optional: assert content appears after navigation */
  expectedContent?: string;
  /** Optional: for navigation that triggers session saves, verify the file was saved */
  verifySavedFile?: (sessionDir: string) => string | null;
}

interface LiveSiteTest {
  name: string;
  url: string;
  /** Wrapped URL pattern matcher (e.g., `__brightnovels_com__.localhost`) */
  wrappedUrlPattern: RegExp | string;
  /** Required: content that should appear on the initial load */
  expectedContent: string;
  /** Optional: only run in magicurl mode */
  magicurlOnly?: boolean;
  /** Optional: only run in proxy mode */
  proxyOnly?: boolean;
  /** Optional: always skip this test (not yet working) */
  skip?: boolean;
  /** Optional: additional tests for in-page navigation */
  navigations?: NavigationTest[];
}

// ── Session helpers ─────────────────────────────────────────────────────────

/**
 * Create a session for a live site and wait for content to render.
 * Handles JS-heavy SPA sites that don't render content until JavaScript executes.
 */
async function createLiveSession(
  page: Page,
  url: string,
  wrappedPattern: RegExp | string,
): Promise<void> {
  const wrappedRe = typeof wrappedPattern === `string`
    ? new RegExp(wrappedPattern)
    : wrappedPattern;
  await createSession(page, url, wrappedRe);
  // For JS-heavy SPA sites, wait for content before asserting header
  await page.waitForLoadState(`networkidle`);
  await assertHeaderPresent(page);
}

/**
 * Switch the current session to magicurl mode and verify the header.
 */
async function switchToMagicurl(page: Page): Promise<void> {
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  if (!sessionId) throw new Error(`Could not extract sessionId from URL: ${page.url()}`);
  await page.request.post(`https://localhost:${TEST_PORT}/__session-mode`, {
    data: { sessionId, mode: `magicurl` },
  });
  const resp = await page.reload({ waitUntil: `domcontentloaded` });
  expect(await resp?.headerValue(`x-load-mode`)).toBe(`magicurl`);
}

/**
 * Extract the sessionId from the current page URL.
 */
function getSessionId(pageUrl: string): string {
  const match = pageUrl.match(/^https:\/\/([a-z0-9]+)__/);
  if (!match?.[1]) throw new Error(`Could not extract sessionId from URL: ${pageUrl}`);
  return match[1];
}

/**
 * Assert that all internal links have been rewritten to the wrapped subdomain form
 * and no raw domain links remain.
 */
async function assertLinksRewritten(page: Page, domain: string): Promise<void> {
  const rawLinks = await page.locator(`a[href*="${domain}"]`).count();
  expect(rawLinks).toBe(0);
}

// ── Test data ───────────────────────────────────────────────────────────────

const sites: LiveSiteTest[] = [
  {
    name: `brightnovels.com/series/sigrid/1 loads with header and rewritten links`,
    url: `https://brightnovels.com/series/sigrid/1`,
    wrappedUrlPattern: `__brightnovels_com__`,
    expectedContent: `You're always going on about luxury and whatnot`,
    navigations: [
      {
        name: `Next button navigates without showing an Inertia modal`,
        action: async page =>
          page.locator(`a[href*="/series/sigrid/2"], button:has-text("Next")`).first().click(),
        urlPattern: `/series/sigrid/2`,
        expectedContent: `1500 kerb per month`,
        verifySavedFile: sessionDir => {
          const candidates = [
            join(sessionDir, `series`, `sigrid`, `2.html`),
            join(sessionDir, `series`, `sigrid`, `2`, `index.html`),
          ];
          const saved = candidates
            .map(p => (existsSync(p) ? readFileSync(p, `utf8`) : null))
            .find(Boolean);
          if (!saved) throw new Error(`chapter 2 HTML file should exist and be non-empty`);
          if (saved.length <= 500) throw new Error(`chapter 2 HTML file too small`);
          return saved;
        },
      },
    ],
  },
  {
    name: `foxaholic.com chapter loads via magicurl with header and rewritten links`,
    url: `https://www.foxaholic.com/novel/transmigrating-to-become-the-bosss-little-fairy/chapter-1/`,
    wrappedUrlPattern: `__www_foxaholic_com__`,
    expectedContent: `nonymous group also said that Ji Rang and a gro`,
    magicurlOnly: true,
  },
  {
    name: `git.zacaj.com loads with header and allows navigation to explore`,
    url: `https://git.zacaj.com/`,
    wrappedUrlPattern: `__git_zacaj_com__`,
    expectedContent: `A painless, self-hosted Git service`,
    navigations: [
      {
        name: `navigate to Explore page`,
        action: async page => {
          await page.evaluate(() => {
            for (const el of document.querySelectorAll(`a`)) {
              // eslint-disable-next-line @typescript-eslint/prefer-optional-chain
              if (el.textContent && el.textContent.includes(`Explore`)) {
                el.click();
                break;
              }
            }
          });
        },
      },
      {
        name: `navigate to Sign in`,
        action: async page => page.locator(`a:has-text("Sign in")`).first().click(),
        expectedContent: `Username or email address`,
      },
    ],
  },
];

// ── Test runners ────────────────────────────────────────────────────────────

/**
 * Run a complete test for a live site: load page, verify header/links/content,
 * and optionally run navigation sub-tests.
 */
async function runLiveSiteTest(page: Page, site: LiveSiteTest): Promise<void> {
  const wrappedPattern = typeof site.wrappedUrlPattern === `string`
    ? new RegExp(site.wrappedUrlPattern)
    : site.wrappedUrlPattern;

  await createLiveSession(page, site.url, wrappedPattern);
  if (MAGICURL) await switchToMagicurl(page);

  // Verify URL matches wrapped pattern
  expect(page.url()).toMatch(wrappedPattern);

  // Verify no raw domain links remain
  const domain = new URL(site.url).hostname;
  await assertLinksRewritten(page, domain);

  // Verify initial content (live SPAs behind Cloudflare can be slow to hydrate)
  await assertPageContent(page, site.expectedContent, 15_000);

  // Run navigation sub-tests if any
  if (site.navigations) {
    for (const nav of site.navigations) {
      await runNavigation(page, nav);
    }
  }
}

/**
 * Run a navigation sub-test: trigger action, wait for URL/content/files as needed.
 */
async function runNavigation(page: Page, nav: NavigationTest): Promise<void> {
  const sessionId = getSessionId(page.url());
  const sessionDir = join(DB_TEST_PATH, `session_${sessionId}`);

  // Optionally wait for response with specific headers (used to verify magicurl served the page)
  let responsePromise: ReturnType<typeof page.waitForResponse> | undefined;
  if (nav.expectedHeaders && MAGICURL) {
    responsePromise = page.waitForResponse(r => {
      if (typeof nav.urlPattern === `string` && !r.url().includes(nav.urlPattern)) return false;
      if (typeof nav.urlPattern === `object` && !nav.urlPattern.test(r.url())) return false;
      if (!r.headers()[`content-type`]?.includes(`text/html`)) return false;
      return true;
    });
  }

  // Trigger the navigation action
  await nav.action(page);

  // Wait for URL to change or idle
  if (typeof nav.urlPattern === `string`) {
    await page.waitForURL(new RegExp(nav.urlPattern));
  } else if (nav.urlPattern) {
    await page.waitForURL(nav.urlPattern);
  } else {
    await page.waitForLoadState(`networkidle`);
  }

  // Verify response headers if expected
  if (responsePromise && nav.expectedHeaders) {
    const response = await responsePromise;
    for (const [header, value] of Object.entries(nav.expectedHeaders)) {
      expect(response.headers()[header.toLowerCase()]).toBe(value);
    }
  }

  // Verify content if expected
  if (nav.expectedContent) {
    await assertPageContent(page, nav.expectedContent, 15_000);
  }

  // Verify saved file if expected
  if (nav.verifySavedFile) {
    // Wait for the async /__client-nav fetch+save to complete
    await page.waitForTimeout(3000);
    nav.verifySavedFile(sessionDir);
  }

  // Check for error modals (Inertia shows failed responses in <dialog>)
  const modalVisible = await page.locator(`dialog[open]`).count();
  expect(modalVisible).toBe(0);
}

// ── Tests ───────────────────────────────────────────────────────────────────

test.describe(`Live site regression tests`, () => {
  for (const site of sites) {
    const shouldRun =
      LIVE &&
      !site.skip &&
      !(site.magicurlOnly && !MAGICURL) &&
      !(site.proxyOnly && MAGICURL);
    const skip = !shouldRun;

    const testName = site.navigations
      ? site.name
      : `${site.name} [${MAGICURL ? `magicurl` : `proxy`}]`;
    const timeout = site.navigations
      ? MAGICURL ? 30_000 : 15_000
      : MAGICURL ? 20_000 : 10_000;

    test(testName, async ({ page }) => {
      test.skip(skip, `opt-in: run with LIVE_TESTS=1 or LIVE_MAGICURL=<url>`);
      test.setTimeout(timeout);
      await runLiveSiteTest(page, site);
    });
  }
});
