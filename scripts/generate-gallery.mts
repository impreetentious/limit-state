import { mkdirSync, writeFileSync } from 'node:fs';
import { gallerySources, gallerySources3d } from '../src/gallery/catalog';
import { encodeModelUncompressed, encodeModelUncompressed3d } from '../src/share/serialize';

const twoD = gallerySources().map((source) => ({
  id: source.id,
  title: source.title,
  blurb: source.blurb,
  hash: encodeModelUncompressed(source.model),
}));

const threeD = gallerySources3d().map((source) => {
  const hash = encodeModelUncompressed3d(source.model);
  const kb = hash.length / 1024;
  if (kb > 32) console.warn(`gallery 3D hash for ${source.id} is ${kb.toFixed(1)} kB — trim if it exceeds the URL comfort budget.`);
  return { id: source.id, title: source.title, blurb: source.blurb, hash };
});

const entries = [...twoD, ...threeD];

mkdirSync('public', { recursive: true });
writeFileSync('public/gallery.json', `${JSON.stringify(entries, null, 2)}\n`);
console.log(`wrote public/gallery.json (${entries.length} entries — ${twoD.length} 2D + ${threeD.length} 3D)`);
