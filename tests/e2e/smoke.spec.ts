// The smoke spec is the canary: if the export stops booting, every other check here is noise.
import { expect, test } from 'playwright/test';

test('static export renders the editor shell', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  const response = await page.goto('/', { waitUntil: 'networkidle' });

  expect(response?.ok()).toBe(true);
  await expect(page.getByText('Limit State').first()).toBeVisible();
  await expect(page.getByLabel('Structure workspace')).toBeVisible();
  await expect(page.getByLabel('Structural editor canvas')).toBeVisible();
  expect(pageErrors).toEqual([]);
});
