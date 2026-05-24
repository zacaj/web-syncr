import { expect, test } from '@playwright/test';

test(`home page shows URL form and login when not authenticated`, async ({ page }) => {
  await page.goto(`/`);
  await expect(page.locator(`input[type="url"][name="url"]`)).toBeVisible();
  await expect(page.locator(`input[name="username"]`)).toBeVisible();
  await expect(page.locator(`input[type="password"]`)).toBeVisible();
});

test(`login sets cookie and shows session list instead of login form`, async ({ page }) => {
  await page.goto(`/`);
  await page.fill(`input[name="username"]`, `testuser`);
  await page.fill(`input[type="password"]`, `testpass`);
  await page.locator(`form[action="/login"] button[type="submit"]`).click();

  await page.waitForURL(`/`);
  await expect(page.locator(`input[name="username"]`)).not.toBeVisible();
  await expect(page.locator(`h3`)).toContainText(`Previous Sessions`);

  const cookies = await page.context().cookies();
  expect(cookies.some(c => c.name === `z.web-syncr.userId`)).toBe(true);
});
