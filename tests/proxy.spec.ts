import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import {
  DB_TEST_PATH,
  MOCK_PAGES,
  TEST_PORT,
  createSession,
  extractSessionId,
  assertHeaderPresent,
} from './global-setup';

test(`POST / creates a session and redirects to wrapped URL`, async ({ page }) => {
  await createSession(page);
  expect(page.url()).toMatch(
    new RegExp(`^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`),
  );
});

test(`proxied page has session header bar injected`, async ({ page }) => {
  await createSession(page);
  await assertHeaderPresent(page);

  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();
  // Header select has data-sid={sessionId}
  await expect(page.locator(`select[data-sid="${sessionId}"]`)).toBeVisible();
});

test(`proxied page renders fixture content`, async ({ page }) => {
  await createSession(page);

  await expect(page.locator(`h1`)).toContainText(`Hello from mock`);
  await expect(page.locator(`a[href="/page2"]`)).toBeVisible();

  // Root path '/' — path.join('./db/session_X', '/') = 'db/session_X/' → index.html
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();
  const saved = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}/index.html`, `utf8`);
  expect(saved).toContain(`Hello from mock`);
  expect(saved).not.toContain(`Error loading URL`);
});

test(`navigating to a sub-page loads the correct fixture`, async ({ page }) => {
  await createSession(page);

  await page.locator(`a[href="/page2"]`).click();

  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);
  await assertHeaderPresent(page);

  // /page2 pathname → db/session_<id>/page2.html
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();
  const saved = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}/page2.html`, `utf8`);
  expect(saved).toContain(MOCK_PAGES[`/page2`]!.title);
  expect(saved).not.toContain(`Error loading URL`);
});

test(`direct link navigation records a session entry in the JSONL`, async ({ page }) => {
  await createSession(page);
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  await page.locator(`a[href="/page2"]`).click();
  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);

  const lines = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}.jsonl`, `utf8`).trim().split(`\n`);
  const entries = lines.map((l: string) => JSON.parse(l) as { url: string; timestamp: string });
  expect(entries).toHaveLength(2);
  expect(entries[1]!.url).toContain(`/page2`);
});

test(`SPA pushState navigation triggers a full page load and saves HTML`, async ({ page }) => {
  await createSession(page);
  const sessionId = extractSessionId(page.url())!;

  // injected.js overrides history.pushState to call location.assign(url),
  // which triggers a full page load through the main proxy handler.
  await Promise.all([
    page.waitForURL(/\/page2/),
    page.evaluate(() => history.pushState({}, ``, `/page2`)),
  ]);

  const saved = readFileSync(`${DB_TEST_PATH}/session_${sessionId}/page2.html`, `utf8`);
  expect(saved).toContain(MOCK_PAGES[`/page2`]!.title);

  const lines = readFileSync(`${DB_TEST_PATH}/session_${sessionId}.jsonl`, `utf8`).trim().split(`\n`);
  const last = JSON.parse(lines.at(-1)!) as { url: string };
  expect(last.url).toContain(`/page2`);
  expect(last.url).not.toContain(`__`);
});

test(`ignoreProxy routes static assets without 500`, async ({ page }) => {
  await createSession(page);
  const assetUrl = page.url().replace(/\/[^/]*$/, `/favicon.ico`);
  // Use page.goto (browser DNS) not page.request (Node.js DNS) — *.localhost subdomains
  // resolves in browsers but not in Node's getaddrinfo.
  const resp = await page.goto(assetUrl);
  expect(resp?.status()).not.toBe(500);
});

test(`absolute hrefs in proxied HTML are rewritten to wrapped form`, async ({ page }) => {
  await createSession(page, `http://localhost/with-link`);
  const href = await page.locator(`#abs`).getAttribute(`href`);
  expect(href).toContain(`__localhost__.localhost:${TEST_PORT}`);
  expect(href).not.toBe(`http://localhost/page2`);
});

test(`3xx redirects are rewritten to the wrapped subdomain`, async ({ page }) => {
  await createSession(page, `http://localhost/redirect-to-page2`);
  expect(page.url()).toMatch(
    new RegExp(`^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`),
  );
  expect(page.url()).toContain(`/page2`);
  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);
});

test(`CSP meta tags are stripped so injected handlers work`, async ({ page }) => {
  await createSession(page, `http://localhost/with-csp`);
  await expect(page.locator(`h1`)).toContainText(`CSP Page`);

  // The CSP meta tag should have been stripped from the served HTML
  const html = await page.content();
  expect(html).not.toContain(`Content-Security-Policy`);

  // Inline handlers should work — the mode dropdown fires setSessionMode
  const select = page.locator(`select`);
  await expect(select).toBeVisible();
});

test(`clicking the pathname button toggles the sessions history dropdown`, async ({ page }) => {
  // Regression test: Header's pathname button uses an inline onClick string
  // (rendered by Preact SSR as a literal onclick="..." HTML attribute) to call
  // toggleSessions(), defined in injected.js. Catches breakage from either the
  // handler being stripped/malformed, or a duplicate listener causing a double
  // toggle that cancels itself out (looks like nothing happened).
  await createSession(page);

  const pathButton = page.locator(`button:has-text("/")`).first();
  const sessionsDropdown = page.locator(`#sessions`);

  // Starts hidden
  await expect(sessionsDropdown).toBeHidden();

  // Clicking opens it
  await pathButton.click();
  await expect(sessionsDropdown).toBeVisible();

  // Clicking again closes it
  await pathButton.click();
  await expect(sessionsDropdown).toBeHidden();
});

test(`clicking a history entry in the sessions dropdown triggers real navigation`, async ({ page }) => {
  // Regression test: history buttons use an inline onClick string handler
  // (wrapAndNavigate) rendered by Preact SSR — verifies the click actually
  // triggers navigation rather than being a dead/no-op button. Also exercises
  // realUrlToWrapped() with a session URL that has a non-default port baked
  // in (e.g. the test proxyPort), which previously broke the server-side
  // redirect by mutating URL.host on a string containing an embedded colon.
  //
  // Note: navigating to the clicked entry's wrapped root URL triggers the
  // app's own "resume session at latest known page" redirect (separate,
  // pre-existing behavior), which can land back on the exact same URL —
  // so we assert a real top-level navigation *request* fired (proving the
  // click handler actually ran), not a specific final destination.
  await createSession(page);
  await page.locator(`a[href="/page2"]`).click();
  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);

  const pathButton = page.locator(`button:has-text("/")`).first();
  await pathButton.click();
  await expect(page.locator(`#sessions`)).toBeVisible();

  const homeEntry = page.locator(`#sessions button`).first();
  const dataUrl = await homeEntry.getAttribute(`data-url`);
  const navigationRequests: string[] = [];
  page.on(`framenavigated`, frame => {
    if (frame === page.mainFrame()) navigationRequests.push(frame.url());
  });

  await homeEntry.click();
  await page.waitForLoadState(`load`);

  // The wrapped root URL (built from dataUrl's hostname) should appear among
  // the navigations this click triggered, proving wrapAndNavigate() actually ran.
  const wrappedRootHost = new URL(dataUrl!).hostname.replaceAll(`.`, `_`);
  expect(navigationRequests.some(u => u.includes(wrappedRootHost))).toBe(true);
  await expect(page.locator(`h1`)).toBeVisible();
});

test(`reloading a page buried past the dedup lookback window doesn't duplicate it as newest`, async ({ page, context }) => {
  // Regression test: the reload/nav "is this URL already in history" check
  // only ever searched the last 20 JSONL lines (the same window used to
  // populate the history dropdown UI). In a session with real usage history,
  // an already-visited page easily falls outside that window — so reloading
  // it was indistinguishable from a brand-new navigation and got re-appended
  // as the newest entry, burying whatever another browser had navigated to
  // and hiding the Latest button behind it.
  await createSession(page);
  await page.locator(`a[href="/page2"]`).click();
  await expect(page.locator(`h1`)).toContainText(`Mock Page 2`);
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  // Pad history with >20 distinct-URL navigations so /page2 falls out of the
  // small lookback window. Query strings keep each visit's realUrl unique —
  // revisiting the exact same URL would just resolve to its existing entry
  // instead of appending a fresh one.
  const base = page.url().replace(/\/page2$/, ``);
  for (let i = 0; i < 25; i++) {
    await page.goto(`${base}/with-csp?i=${i}`);
    await expect(page.locator(`h1`)).toContainText(`CSP Page`);
  }

  // A second browser opens the same session and navigates to a fresh page.
  const secondContext = await context.browser()!.newContext({ ignoreHTTPSErrors: true });
  const secondPage = await secondContext.newPage();
  await secondPage.goto(`${base}/with-link`);
  await expect(secondPage.locator(`h1`)).toContainText(`With Absolute Link`);
  await secondContext.close();

  // First browser reloads its now-stale, long-buried page2.
  await page.goto(`${base}/page2`);
  await expect(page.locator(`h1`)).toContainText(`Mock Page 2`);

  const lines = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}.jsonl`, `utf8`).trim().split(`\n`);
  const entries = lines.map((l: string) => JSON.parse(l) as { url: string; timestamp: string });
  // Revisiting page2 must not re-append it as the newest entry.
  expect(entries.at(-1)!.url).not.toContain(`/page2`);

  // The Latest button should point back at the second browser's page.
  await expect(page.locator(`button:has-text("Latest")`)).toBeVisible();
});

test(`body tag with attributes containing > chars is injected correctly`, async ({ page }) => {
  // Regression test for issue where regex matching <body ...> would break
  // if attributes contained special characters like > inside quoted values.
  // See: rewrite.ts uses regex /(<body(?:[^>"']|"[^"]*"|'[^']*')*>)/i
  await createSession(page, `http://localhost/with-special-attrs`);
  await expect(page.locator(`h1`)).toContainText(`Special Attrs`);

  // Header should be present and functional (this proves injection happened correctly)
  await assertHeaderPresent(page);

  // Verify the script was injected (the functions should be available)
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  // Verify the mode select is accessible
  const select = page.locator(`select[data-sid="${sessionId}"]`);
  await expect(select).toBeVisible();

  // The HTML should contain the injected web-syncr spacer div
  const html = await page.content();
  expect(html).toContain(`web-syncr-spacer`);
});
