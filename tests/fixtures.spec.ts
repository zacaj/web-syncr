import { expect, test, type Page } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TEST_PORT } from './global-setup';

function fixtureExists(relPath: string) {
  return existsSync(join(process.cwd(), `tests/fixtures`, `${relPath}.local.html`));
}

// localhost has no dots, so the encoded subdomain matches proxy.spec.ts pattern:
// sessionid__localhost__.localhost:PORT
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

test.describe(`brightnovels.com fixture`, () => {
  // mirror-page.ts saves /series/sigrid/1 (no extension) as .../1/index.html
  const FIXTURE_PATH = `/fixtures/brightnovels_com/series/sigrid/1/index`;

  test.beforeAll(() => {
    test.skip(
      !fixtureExists(`brightnovels_com/series/sigrid/1/index`),
      `fixture not captured — run: npx tsx scripts/mirror-page.ts https://brightnovels.com/series/sigrid/1`,
    );
  });

  test(`fixture page loads through proxy`, async ({ page }) => {
    await createSession(page, FIXTURE_PATH);
    expect(page.url()).toMatch(WRAPPED_URL_RE);
  });

  test(`header bar is injected into fixture page`, async ({ page }) => {
    await createSession(page, FIXTURE_PATH);
    await expect(page.locator(`text=Session:`)).toBeVisible();
    await expect(page.locator(`input[placeholder="New URL"]`)).toBeVisible();
  });

  test(`Inertia data-page bootstrap URL is rewritten to wrapped subdomain`, async ({ page }) => {
    // Inertia bootstraps with a JSON blob in data-page on #app.
    // The proxy must rewrite domain refs there so Inertia routes its XHR
    // requests through the proxy subdomain instead of the raw origin.
    await createSession(page, FIXTURE_PATH);
    const datePage = await page.locator(`#app`).getAttribute(`data-page`);
    expect(datePage).toBeTruthy();
    // The .local.html has brightnovels.com replaced with 'localhost';
    // the proxy must then replace 'localhost' with the wrapped subdomain.
    expect(datePage).not.toContain(`"url":"https:\\/\\/localhost"`);
    expect(datePage).toContain(`__.localhost:${TEST_PORT}`);
  });
});
