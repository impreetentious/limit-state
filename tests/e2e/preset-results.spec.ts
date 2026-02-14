import { expect, test } from 'playwright/test';

/**
 * docs/FEM-SPEC.md §9 — browser-level cover for the load → solve → render path. The unit
 * gates prove the numbers; this proves a preset actually reaches the canvas in the shipped
 * export, including the A/S/M diagram surface specified in §6.8.
 *
 * Deliberately shape-only. §6.8 records GAP-10 open: the internal-action sign convention is
 * unsettled, so the moment diagram's sign and end values are NOT yet verified and this
 * suite must not imply they are. It asserts the diagram controls are reachable and render,
 * which is true today, and leaves the numeric contract to G37 once the kernel decision lands.
 */

test('a preset loads, solves, and exposes its result diagrams', async ({ page }) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await page.getByLabel('Presets').selectOption({ label: '2 · Pratt truss' });
  await page.getByLabel('Mode').getByRole('button', { name: 'Test' }).click();

  // The result controls render only for a stable analysis, so their presence is the
  // "this model solved" signal rather than a separate assertion.
  const results = page.getByLabel('Static result display');
  await expect(results).toBeVisible();

  for (const diagram of ['Axial', 'Shear', 'Moment']) {
    await results.getByRole('button', { name: diagram, exact: true }).click();
    await expect(results.getByRole('button', { name: diagram, exact: true })).toHaveClass(/active/);
    await expect(page.getByLabel('Structural editor canvas')).toBeVisible();
  }

  expect(pageErrors).toEqual([]);
});

test('switching presets re-solves rather than leaving the previous result on screen', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Mode').getByRole('button', { name: 'Test' }).click();

  await page.getByLabel('Presets').selectOption({ label: '1 · Simple beam' });
  const modes = page.getByLabel('Animated mode shapes');
  await expect(modes.getByRole('button').first()).toHaveText(/Hz$/, { timeout: 60_000 });
  const beamFrequencies = await modes.getByRole('button').allTextContents();

  await page.getByLabel('Presets').selectOption({ label: '3 · Two-span cantilever' });
  await expect(modes.getByRole('button').first()).toHaveText(/Hz$/, { timeout: 60_000 });

  // A different structure must produce different natural frequencies. Equality here would
  // mean the panel is showing a stale worker response for a model that is no longer loaded.
  await expect
    .poll(async () => (await modes.getByRole('button').allTextContents()).join('|'), {
      timeout: 60_000,
    })
    .not.toBe(beamFrequencies.join('|'));
});
