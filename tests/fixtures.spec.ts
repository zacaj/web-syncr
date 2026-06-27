import { expect, test } from '@playwright/test';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  TEST_PORT,
  createSession,
  assertHeaderPresent,
  assertPageContent,
} from './global-setup';

function fixtureExists(relPath: string) {
  return existsSync(join(process.cwd(), `tests/fixtures`, `${relPath}.local.html`));
}

// localhost has no dots, so the encoded subdomain matches proxy.spec.ts pattern:
// sessionid__localhost__.localhost:PORT
const WRAPPED_URL_RE = new RegExp(
  `^https://[a-z0-9]+__localhost__\\.localhost:${TEST_PORT}/`,
);

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
    await createSession(page, `http://localhost${FIXTURE_PATH}`, WRAPPED_URL_RE);
    expect(page.url()).toMatch(WRAPPED_URL_RE);
  });

  test(`header bar is injected into fixture page`, async ({ page }) => {
    await createSession(page, `http://localhost${FIXTURE_PATH}`, WRAPPED_URL_RE);
    await assertHeaderPresent(page);
  });

  test(`Inertia data-page bootstrap URL is rewritten to wrapped subdomain`, async ({ page }) => {
    await createSession(page, `http://localhost${FIXTURE_PATH}`, WRAPPED_URL_RE);
    const datePage = await page.locator(`#app`).getAttribute(`data-page`);
    expect(datePage).toBeTruthy();
    // The .local.html has brightnovels.com replaced with 'localhost';
    // the proxy must then replace 'localhost' with the wrapped subdomain.
    expect(datePage).not.toContain(`"url":"https:\\/\\/localhost"`);
    expect(datePage).toContain(`__.localhost:${TEST_PORT}`);
  });
});
