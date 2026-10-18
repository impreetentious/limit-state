import { expect, test } from 'playwright/test';

/**
 * docs/FEM-SPEC.md §9 — browser-level cover for the load → solve → render path. The unit
 * gates prove the numbers; this proves a preset actually reaches the canvas in the shipped
 * export, including the A/S/M diagram surface specified in §6.8.
 *
 * This browser check is deliberately shape-only: it verifies that the diagram controls are
 * reachable and render. G37 covers the numerical sign and end-value contract directly in the
 * kernel, where failures are easier to diagnose precisely.
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

test('analysis artifact restores options, raw cantilever results and invalid section drafts', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  const model = {
    v: 1,
    name: 'cantilever',
    seed: 1,
    nodes: [
      { id: 1, x: 0, y: 0 },
      { id: 2, x: 1, y: 0 },
    ],
    members: [
      {
        id: 1,
        a: 1,
        b: 2,
        material: 'steel-s355',
        section: { kind: 'rect', b: 0.2, h: 0.3 },
        releaseA: false,
        releaseB: false,
        cableOnly: false,
      },
    ],
    supports: [{ node: 1, kind: 'fixed' }],
    loads: { gravity: false, points: [{ node: 2, fx: 0, fy: -1000 }] },
    deck: [],
    story: { kind: 'pushover' },
  };
  const artifact = {
    kind: 'analysis',
    model,
    dimension: '2d',
    appVersion: '0.12.3',
    analysisOptions: { shearFlexible: true, secondOrder: false },
    view: {
      simulationTime: 0.5,
      loadStation: null,
      exaggeration: 10,
      units: { length: 'm', force: 'N', moment: 'Nm', displayLength: 'adaptive' },
    },
    results: { capacity: { status: 'unavailable', value: null, reason: 'archival' } },
  };
  await page.goto('/');
  await page.getByLabel('Import analysis', { exact: true }).setInputFiles({
    name: 'cantilever.json',
    mimeType: 'application/json',
    buffer: Buffer.from(JSON.stringify(artifact)),
  });
  await expect(page.getByLabel('Model name')).toHaveValue('cantilever');
  await expect(page.getByLabel('Timoshenko', { exact: true })).toBeChecked();
  const button = page.getByRole('button', { name: 'Export analysis', exact: true });
  await expect(button).toBeEnabled({ timeout: 60000 });
  const event = page.waitForEvent('download');
  await button.click();
  const download = await event;
  const stream = await download.createReadStream();
  const chunks = [];
  for await (const chunk of stream!) chunks.push(chunk);
  const exported = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  expect(exported.analysisOptions).toEqual(artifact.analysisOptions);
  expect(exported.view.simulationTime).toBe(0.5);
  expect(exported.view.exaggeration).toBe(10);
  // PL³/(3EI) + PL/(G As), E=200GPa, I=0.00045m4, As=0.05m2.
  const tip = -1000 / (3 * 200e9 * 0.00045) - 1000 / ((200e9 / 2.6) * 0.05);
  expect(exported.results.statics.value.rawDisplacements[4]).toBeCloseTo(tip, 10);
  expect(exported.results.statics.value.rawDisplacements[5]).toBeCloseTo(
    -1000 / (2 * 200e9 * 0.00045),
    10,
  );
  await page.getByLabel('Mode').getByRole('button', { name: 'Build', exact: true }).click();
  const canvas = page.getByLabel('Structural editor canvas');
  const bounds = await canvas.boundingBox();
  await canvas.click({ position: { x: bounds!.width / 2 + 22, y: bounds!.height - 68 } });
  const inspector = page.getByRole('complementary', { name: 'Member inspector' });
  await expect(inspector).toBeVisible();
  await inspector.getByRole('combobox', { name: 'Section', exact: true }).selectOption('tube');
  await inspector.getByRole('spinbutton', { name: 'diameter mm', exact: true }).fill('200');
  await inspector.getByRole('spinbutton', { name: 'wall mm', exact: true }).fill('150');
  await expect(inspector.getByRole('alert')).toBeVisible();
  await inspector.getByRole('spinbutton', { name: 'wall mm', exact: true }).fill('');
  await expect(inspector.getByRole('spinbutton', { name: 'wall mm', exact: true })).toHaveValue('');
  await page.getByLabel('Mode').getByRole('button', { name: 'Test', exact: true }).click();
  await expect(button).toBeDisabled();
  expect(errors).toEqual([]);
});

test('3D story artifacts restore the captured paused view and refuse unsupported options atomically', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto('/');
  await page
    .getByLabel('Dimension', { exact: true })
    .getByRole('button', { name: '3D', exact: true })
    .click();
  await page.getByLabel('3D presets', { exact: true }).selectOption('portal');
  await page
    .getByLabel('Mode', { exact: true })
    .getByRole('button', { name: 'Test', exact: true })
    .click();
  const button = page.getByRole('button', { name: 'Export analysis', exact: true });
  async function capture() {
    await expect(button).toBeEnabled({ timeout: 60_000 });
    const event = page.waitForEvent('download');
    await button.click();
    const stream = await (await event).createReadStream();
    const chunks = [];
    for await (const chunk of stream!) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  const artifact = await capture();
  expect(artifact.dimension).toBe('3d');
  expect(artifact.model.v).toBe(2);
  artifact.view.simulationTime = 0.25;
  artifact.view.exaggeration = 7;
  artifact.analysisOptions = { shearFlexible: true, secondOrder: true };
  async function install(value: unknown) {
    await page.getByLabel('Import analysis', { exact: true }).setInputFiles({
      name: 'portal.json',
      mimeType: 'application/json',
      buffer: Buffer.from(JSON.stringify(value)),
    });
  }
  await install(artifact);
  await expect(
    page.getByText('Imported result values are archival evidence.', { exact: false }),
  ).toBeVisible();
  await expect(page.getByLabel('Timoshenko', { exact: true })).toBeChecked();
  await expect(page.getByLabel('P-Δ', { exact: true })).toBeChecked();
  const restored = await capture();
  expect(restored.model).toEqual(artifact.model);
  expect(restored.analysisOptions).toEqual(artifact.analysisOptions);
  expect(restored.view).toEqual(artifact.view);
  const invalid = structuredClone(artifact);
  invalid.analysisOptions.futureSolver = true;
  invalid.model.name = 'must not install';
  await install(invalid);
  await expect(page.getByRole('status').filter({ hasText: /option/i })).toBeVisible();
  const unchanged = await capture();
  expect(unchanged.model).toEqual(restored.model);
  expect(unchanged.view).toEqual(restored.view);
  expect(errors).toEqual([]);
});

test('analysis export withholds dynamic history after solver options change', async ({ page }) => {
  await page.goto('/');
  await page.getByLabel('Presets', { exact: true }).selectOption('slender-deck');
  await page
    .getByLabel('Mode', { exact: true })
    .getByRole('button', { name: 'Test', exact: true })
    .click();
  const exportButton = page.getByRole('button', { name: 'Export analysis', exact: true });
  await expect(exportButton).toBeEnabled({ timeout: 60_000 });
  await page.getByRole('button', { name: /^Play/ }).click();
  await page.waitForTimeout(250);
  await page.getByRole('button', { name: /^Pause/ }).click();
  async function capture() {
    await expect(exportButton).toBeEnabled({ timeout: 60_000 });
    const event = page.waitForEvent('download');
    await exportButton.click();
    const stream = await (await event).createReadStream();
    const chunks: Buffer[] = [];
    for await (const chunk of stream!) chunks.push(Buffer.from(chunk));
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  }
  expect((await capture()).results.story.status).toBe('available');
  await page.getByLabel('Timoshenko', { exact: true }).check();
  const changed = await capture();
  expect(changed.analysisOptions.shearFlexible).toBe(true);
  expect(changed.results.story.status).toBe('unavailable');
  expect(changed.results.story.value).toBeNull();
});
