/**
 * Capture Build + Test stills (2D and 3D) for README / docs.
 * Run against a local static server serving `out/`.
 * docs/FEM-SPEC.md §14 3Z.
 *
 *   npx serve out -l 4173
 *   node scripts/capture-screenshots.mjs
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const docs = join(root, 'docs');
mkdirSync(docs, { recursive: true });

const base = process.env.SHOT_BASE ?? 'http://127.0.0.1:4173';

async function settle(page, ms = 800) {
  await page.waitForTimeout(ms);
}

async function shot(page, name) {
  const path = join(docs, name);
  await page.screenshot({ path, fullPage: false });
  console.log('wrote', path);
}

async function main() {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.setDefaultTimeout(20_000);

  await page.goto(base, { waitUntil: 'networkidle' });
  await settle(page, 1200);

  // —— 2D Build: Pratt truss ——
  await page.locator('select[aria-label="Presets"]').selectOption('pratt-truss');
  await settle(page, 1200);
  await shot(page, 'build-2d.png');

  // —— 2D Test: traffic ——
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await settle(page, 800);
  await page.locator('.test-console .play-button').first().click();
  await settle(page, 1500);
  await shot(page, 'test-2d.png');

  // —— 3D Build: slender deck (St. Venant torsion cousin) ——
  await page.getByRole('button', { name: '3D', exact: true }).click();
  await settle(page, 800);
  await page.locator('select[aria-label="3D presets"]').selectOption('slender-deck');
  await settle(page, 2500);
  await shot(page, 'build-3d.png');

  // —— 3D Test: wind story playing on the same deck ——
  await page.getByRole('button', { name: 'Test', exact: true }).click();
  await settle(page, 400);
  await page.locator('.test-console-3d .play-button').first().click();
  await settle(page, 2500);
  await shot(page, 'test-3d.png');

  await browser.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
