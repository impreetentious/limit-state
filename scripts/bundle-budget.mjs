import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

// Measured 381.2 KiB gzip on index.html before this gate landed; 400 KiB keeps
// roughly 5% headroom while still catching accidental dependency growth.
const DEFAULT_BUDGET_KIB = 400;
const budgetKib = Number.parseFloat(process.env.BUNDLE_BUDGET_KIB ?? String(DEFAULT_BUDGET_KIB));
const budgetBytes = budgetKib * 1024;
const exportDirectory = 'out';

function filesUnder(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? filesUnder(path) : [path];
  });
}

const htmlFiles = filesUnder(exportDirectory).filter((file) => file.endsWith('.html'));
const compressedSizes = new Map();

function compressedSize(file) {
  if (!compressedSizes.has(file)) {
    compressedSizes.set(file, gzipSync(readFileSync(file)).byteLength);
  }

  return compressedSizes.get(file);
}

function exportedPathFor(reference) {
  if (!reference.startsWith('/')) return null;

  const direct = join(exportDirectory, reference.slice(1));
  if (existsSync(direct)) return direct;

  const withoutBasePath = reference.split('/').filter(Boolean).slice(1).join('/');
  const rebased = join(exportDirectory, withoutBasePath);
  return existsSync(rebased) ? rebased : direct;
}

function referencedJavascript(htmlFile) {
  const html = readFileSync(htmlFile, 'utf8');
  const references = html.matchAll(/(?:src|href)="([^"?#]+\.js)(?:[?#][^"]*)?"/g);

  return new Set(
    [...references]
      .map((match) => match[1])
      .map((reference) => exportedPathFor(reference) ?? resolve(dirname(htmlFile), reference))
      .filter(existsSync),
  );
}

const routeSizes = htmlFiles
  .map((htmlFile) => {
    const javascriptFiles = referencedJavascript(htmlFile);
    const bytes = [...javascriptFiles].reduce((total, file) => total + compressedSize(file), 0);

    return {
      route: relative(exportDirectory, htmlFile),
      bytes,
      files: javascriptFiles.size,
    };
  })
  .sort((left, right) => right.bytes - left.bytes);

if (routeSizes.length === 0) {
  throw new Error('Bundle-budget check found no exported HTML routes.');
}

const largestRoute = routeSizes[0];
const oversizedRoutes = routeSizes.filter(({ bytes }) => bytes > budgetBytes);
const budgetLabel =
  budgetKib === DEFAULT_BUDGET_KIB ? '400 KiB per route' : `${budgetKib.toFixed(1)} KiB per route`;

console.log(
  `Largest initial route JavaScript: ${(largestRoute.bytes / 1024).toFixed(1)} KiB gzip across ${largestRoute.files} files for ${largestRoute.route} (budget: ${budgetLabel}; ${routeSizes.length} routes checked).`,
);

if (oversizedRoutes.length > 0) {
  for (const route of oversizedRoutes) {
    console.error(`Over budget: ${route.route}: ${(route.bytes / 1024).toFixed(1)} KiB gzip`);
  }

  process.exitCode = 1;
}
