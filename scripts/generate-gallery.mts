import { mkdirSync, writeFileSync } from 'node:fs';
import { gallerySources } from '../src/gallery/catalog';
import { encodeModelUncompressed } from '../src/share/serialize';

const entries = gallerySources().map((source) => ({
  id: source.id,
  title: source.title,
  blurb: source.blurb,
  hash: encodeModelUncompressed(source.model),
}));

mkdirSync('public', { recursive: true });
writeFileSync('public/gallery.json', `${JSON.stringify(entries, null, 2)}\n`);
console.log(`wrote public/gallery.json (${entries.length} entries)`);
