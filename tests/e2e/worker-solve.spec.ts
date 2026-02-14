import { expect, test } from 'playwright/test';

/**
 * docs/FEM-SPEC.md §9 — the G-gates are Vitest checks against the solver kernel and stay
 * there. What they cannot cover is whether the solver is reachable *in the shipped
 * artifact*: the eigen solver runs in a Web Worker whose script URL is emitted by the
 * build, and the deployed export is served under a `BASE_PATH` prefix. A worker URL that
 * does not resolve under that prefix leaves every unit gate green while modal and buckling
 * analysis silently stop working in production.
 *
 * This suite runs against the built `out/` under the same `BASE_PATH` CI deploys with, so
 * that failure mode is caught here rather than by a user.
 */

const HZ_MODE = /^f1 \d+\.\d+ Hz$/;

test('the eigen worker loads and returns modes for a preset under the deployed base path', async ({
  page,
}) => {
  const pageErrors: string[] = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));

  await page.goto('/');
  await expect(page.getByLabel('Structure workspace')).toBeVisible();

  await page.getByLabel('Presets').selectOption({ label: '1 · Simple beam' });
  await page.getByLabel('Mode').getByRole('button', { name: 'Test' }).click();

  const eigen = page.locator('.eigen-panel');
  await expect(eigen).toBeVisible();

  // The worker either answers or it does not. Asserting on a rendered eigenvalue — not on
  // the panel merely existing — is what makes this a round-trip proof: the frequency is a
  // number the worker computed and posted back.
  const modes = page.getByLabel('Animated mode shapes');
  await expect(modes.getByRole('button').first()).toHaveText(HZ_MODE, { timeout: 60_000 });

  // The explicit failure copy the app shows when the worker cannot start. If the worker
  // URL breaks under BASE_PATH this is what appears, so assert it never does.
  await expect(eigen.locator('.eigen-error')).toHaveCount(0);
  await expect(eigen.getByText('Solving in worker…')).toHaveCount(0);
  expect(pageErrors).toEqual([]);
});

test('the eigen panel refuses to invent modes for a model with no free degree of freedom', async ({
  page,
}) => {
  await page.goto('/');
  await page.getByLabel('Presets').selectOption({ label: '6 · Blank grid' });
  await page.getByLabel('Mode').getByRole('button', { name: 'Test' }).click();

  // Honesty gate, not a smoke check. A degenerate model is the case where a solver is most
  // tempted to display a zero and let it read as an answer. The shipped behaviour is to say
  // what is wrong instead, and that has to survive into the export as much as any number does.
  const eigen = page.locator('.eigen-panel');
  await expect(eigen).toBeVisible();
  await expect(eigen).toContainText(
    'Eigenanalysis needs at least one unconstrained degree of freedom.',
  );
  await expect(page.getByLabel('Animated mode shapes')).toHaveCount(0);
});
