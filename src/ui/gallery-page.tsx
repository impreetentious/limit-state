'use client';

/**
 * Static curated gallery — opens share hashes in the editor.
 */
import Link from 'next/link';
import galleryEntries from '../../public/gallery.json';

interface GalleryEntry {
  id: string;
  title: string;
  blurb: string;
  hash: string;
}

const ENTRIES = galleryEntries as GalleryEntry[];

export function GalleryPage(): React.JSX.Element {
  return (
    <main className="gallery-shell">
      <header className="gallery-header">
        <div className="brand"><span className="brand-mark" aria-hidden>△</span><span>Limit State</span></div>
        <p className="gallery-kicker">Curated gallery</p>
        <h1>Structures worth opening</h1>
        <p className="gallery-lead">
          Each entry is a share URL frozen as JSON — no backend. Open one in the editor, or return to sketch your own.
        </p>
        <p className="gallery-actions">
          <Link className="gallery-primary" href="/">Open editor</Link>
          <Link className="gallery-secondary" href="/?challenge=span-40-steel-6t">Try a challenge</Link>
        </p>
      </header>
      <section className="gallery-grid" aria-label="Curated models">
        {ENTRIES.map((entry) => {
          const is3d = entry.id.startsWith('preset3d-');
          return (
            <article key={entry.id} className={is3d ? 'gallery-card gallery-card-3d' : 'gallery-card'}>
              <h2>
                {entry.title}
                {is3d && <span className="gallery-badge" title="Schema v2 · 3D space frame">v2 · 3D</span>}
              </h2>
              <p>{entry.blurb}</p>
              <Link href={{ pathname: '/', hash: entry.hash.replace(/^#/, '') }}>Open in editor</Link>
            </article>
          );
        })}
      </section>
      <footer className="gallery-footer">
        <p>
          Hashes live in <code>public/gallery.json</code>. Regenerate with{' '}
          <code>npx vite-node scripts/generate-gallery.mts</code> after editing gallery sources.
        </p>
      </footer>
    </main>
  );
}
