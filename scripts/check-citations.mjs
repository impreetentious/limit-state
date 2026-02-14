import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Ensure every numbered solver-spec citation in source resolves to a real
 * heading. This keeps implementation comments coupled to the normative
 * technical contract rather than to an accidental or renamed section.
 */
const SPEC = 'docs/FEM-SPEC.md';
const ROOTS = ['src', 'scripts', 'tests'];
const EXTRA_FILES = ['next.config.ts'];
const EXTENSIONS = new Set(['.ts', '.tsx', '.mjs', '.js', '.css']);

async function filesUnder(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error?.code === 'ENOENT') return [];
    throw error;
  }
  const nested = await Promise.all(
    entries.map((entry) => {
      const filePath = path.join(directory, entry.name);
      return entry.isDirectory() ? filesUnder(filePath) : Promise.resolve([filePath]);
    }),
  );
  return nested.flat();
}

const specHeadings = new Set();
for (const line of (await readFile(SPEC, 'utf8')).split('\n')) {
  const heading = /^#{1,6}\s+(\d+(?:\.\d+)*)/.exec(line);
  if (heading) specHeadings.add(heading[1]);
}
if (specHeadings.size === 0) {
  console.error(`citation check failed: no numbered headings found in ${SPEC}.`);
  process.exit(1);
}

const files = [...(await Promise.all(ROOTS.map(filesUnder))).flat(), ...EXTRA_FILES].filter(
  (file) => EXTENSIONS.has(path.extname(file)),
);

const unresolved = [];

for (const file of files) {
  const content = await readFile(file, 'utf8');
  content.split('\n').forEach((line, index) => {
    for (const match of line.matchAll(/docs\/FEM-SPEC\.md §(\d+(?:\.\d+)*)/g)) {
      if (!specHeadings.has(match[1])) {
        unresolved.push(`${file}:${index + 1}: §${match[1]} is not a heading in ${SPEC}`);
      }
    }
  });
}

if (unresolved.length > 0) {
  console.error('citation check failed.');
  console.error(`\n${unresolved.length} citation(s) name a section that does not exist:`);
  for (const hit of unresolved) console.error(` - ${hit}`);
  console.error('\nEither add the section to the spec or cite the one that governs.');
  process.exit(1);
}

console.log(
  `citations OK — ${files.length} files scanned, every § citation resolves in ${SPEC} (${specHeadings.size} numbered headings).`,
);
