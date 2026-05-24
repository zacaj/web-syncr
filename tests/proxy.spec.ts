import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { DB_TEST_PATH, MOCK_PAGES, TEST_PORT } from './global-setup';

// localhost has no dots, so the encoded subdomain is just: sessionid__localhost__
const WRAPPED_URL_RE = new RegExp(
  `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
);

async function createSession(page: Page, path = ``) {
  await page.goto(`/`);
  await page.fill(`input[type="url"][name="url"]`, `http://localhost${path}`);
  await Promise.all([
    page.waitForURL(WRAPPED_URL_RE),
    page.locator(`form[action="/"] button[type="submit"]`).first().click(),
  ]);
}

test(`POST / creates a session and redirects to wrapped URL`, async ({ page }) => {
  await createSession(page);
  expect(page.url()).toMatch(WRAPPED_URL_RE);
});

test(`proxied page has session header bar injected`, async ({ page }) => {
  await createSession(page);

  await expect(page.locator(`text=Session:`)).toBeVisible();
  await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();

  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();
  await expect(page.locator(`text=Session:`).first()).toContainText(sessionId!);
});

test(`proxied page renders fixture content`, async ({ page }) => {
  await createSession(page);

  await expect(page.locator(`h1`)).toContainText(`Hello from mock`);
  await expect(page.locator(`a[href="/page2"]`)).toBeVisible();

  // Root path '/' — path.join('./db/session_X', '/') = 'db/session_X/' → index.html
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();
  const saved = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}/index.html`, `utf8`);
  expect(saved).toContain(`Hello from mock`);
  expect(saved).not.toContain(`Error loading URL`);
});

test(`navigating to a sub-page loads the correct fixture`, async ({ page }) => {
  await createSession(page);

  await page.locator(`a[href="/page2"]`).click();

  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);
  await expect(page.locator(`text=Session:`)).toBeVisible();

  // /page2 pathname → db/session_<id>/page2.html
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();
  const saved = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}/page2.html`, `utf8`);
  expect(saved).toContain(MOCK_PAGES[`/page2`]!.title);
  expect(saved).not.toContain(`Error loading URL`);
});

test(`direct link navigation records a session entry in the JSONL`, async ({ page }) => {
  await createSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];
  expect(sessionId).toBeTruthy();

  await page.locator(`a[href="/page2"]`).click();
  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);

  const lines = readFileSync(`${DB_TEST_PATH}/session_${sessionId!}.jsonl`, `utf8`).trim().split(`\n`);
  const entries = lines.map((l: string) => JSON.parse(l) as { url: string; timestamp: string });
  expect(entries).toHaveLength(2);
  expect(entries[1]!.url).toContain(`/page2`);
});

test(`/__client-nav records a navigation entry`, async ({ page }) => {
  await createSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1];

  const resp = await page.request.post(`https://localhost:${TEST_PORT}/__client-nav`, {
    data: { sessionId, url: `http://localhost/`, html: `<html></html>` },
  });
  expect(resp.status()).toBe(200);
  expect((await resp.json() as { ok: boolean }).ok).toBe(true);
});

test(`ignoreProxy routes static assets without 500`, async ({ page }) => {
  await createSession(page);
  const assetUrl = page.url().replace(/\/[^/]*$/, `/favicon.ico`);
  // Use page.goto (browser DNS) not page.request (Node.js DNS) — *.localhost subdomains
  // resolve in browsers but not in Node's getaddrinfo.
  const resp = await page.goto(assetUrl);
  expect(resp?.status()).not.toBe(500);
});

test(`absolute hrefs in proxied HTML are rewritten to wrapped form`, async ({ page }) => {
  await createSession(page, `/with-link`);
  const href = await page.locator(`#abs`).getAttribute(`href`);
  expect(href).toContain(`__localhost__.localhost:${TEST_PORT}`);
  expect(href).not.toBe(`http://localhost/page2`);
});

test(`3xx redirects are rewritten to the wrapped subdomain`, async ({ page }) => {
  await createSession(page, `/redirect-to-page2`);
  expect(page.url()).toMatch(WRAPPED_URL_RE);
  expect(page.url()).toContain(`/page2`);
  await expect(page.locator(`h1`)).toContainText(MOCK_PAGES[`/page2`]!.title);
});

test(`/__client-nav stores the real (unwrapped) URL in the JSONL`, async ({ page }) => {
  await createSession(page);
  const sessionId = page.url().match(/^https:\/\/([a-z0-9]+)__/)?.[1]!;
  const wrappedPage2 = page.url().replace(/\/[^/]*$/, `/page2`);

  await page.request.post(`https://localhost:${TEST_PORT}/__client-nav`, {
    data: { sessionId, url: wrappedPage2 },
  });

  const lines = readFileSync(`${DB_TEST_PATH}/session_${sessionId}.jsonl`, `utf8`).trim().split(`\n`);
  const last = JSON.parse(lines.at(-1)!) as { url: string };
  expect(last.url).toContain(`/page2`);
  expect(last.url).not.toContain(`__`);
});
