import { expect, test } from '@playwright/test';
import { TEST_PORT, createSession, extractSessionId } from './global-setup';

// Regression tests for the "Context is not finalized" bug.
//
// When the proxy fetched a *rewritable* but *non-HTML* asset (CSS / JS / JSON)
// whose body contained no occurrence of the proxied base URL, the link-rewrite
// pass made no change — and the handler fell out of its `if (isRewritable)` block
// WITHOUT returning a Response. @hono/node-server then threw
// "Context is not finalized. Did you forget to return a Response object …",
// turning an ordinary asset request into a 500. This is the same path a
// magicurl-snapshot miss falls through to, which is why the errors correlated
// 1:1 with "MAGICURL MISS" in production.
//
// The fix guarantees a passthrough Response for that case. These tests build the
// wrapped asset URL directly and assert a clean 200 with the body intact.

function wrappedAssetUrl(sessionId: string, path: string): string {
  // Navigate via the browser, not page.request: Chrome resolves any *.localhost
  // host to loopback (RFC 6761), but Playwright's APIRequestContext does not, so a
  // wrapped subdomain would fail DNS there.
  return `https://${sessionId}__localhost__.localhost:${TEST_PORT}${path}`;
}

test(`CSS asset with no base-URL occurrences proxies cleanly (was: Context is not finalized 500)`, async ({ page }) => {
  await createSession(page); // proxy mode (default), base URL = localhost
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  const res = await page.goto(wrappedAssetUrl(sessionId!, `/no-host.css`));

  expect(res).toBeTruthy();
  expect(res!.status()).toBe(200);
  expect(res!.headers()[`content-type`]).toContain(`text/css`);
  const bodyText = await res!.text();
  expect(bodyText).toContain(`.hero{color:red`);
  // The failure mode returned the error page instead of the asset.
  expect(bodyText).not.toContain(`Context is not finalized`);
  expect(bodyText).not.toContain(`Error loading URL`);
});

test(`JS asset with no base-URL occurrences proxies cleanly`, async ({ page }) => {
  await createSession(page);
  const sessionId = extractSessionId(page.url());
  expect(sessionId).toBeTruthy();

  const res = await page.goto(wrappedAssetUrl(sessionId!, `/no-host.js`));

  expect(res).toBeTruthy();
  expect(res!.status()).toBe(200);
  const bodyText = await res!.text();
  expect(bodyText).toContain(`no base url here at all`);
  expect(bodyText).not.toContain(`Context is not finalized`);
});

test(`/__healthz liveness probe answers 200`, async ({ page }) => {
  const res = await page.request.get(`/__healthz`);
  expect(res.status()).toBe(200);
  expect(await res.text()).toBe(`ok`);
});
