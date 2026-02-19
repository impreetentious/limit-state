import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(process.argv[2] ?? 'out');
const port = Number.parseInt(process.env.PORT ?? '3012', 10);
const host = process.env.HOST ?? '127.0.0.1';
const basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, '');

// Serve the same response headers `serve.json` documents for a static host, so
// the Playwright suite exercises the export under its real Content-Security-Policy
// rather than a permissive local one. `worker-src 'self'` in particular is
// load-bearing — the eigen worker fails without it. docs/STATIC-HOST-HEADERS.md.
const securityHeaders = (() => {
  const configPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'serve.json');
  if (!existsSync(configPath)) return {};
  const blocks = JSON.parse(readFileSync(configPath, 'utf8')).headers ?? [];
  return Object.fromEntries(
    blocks.flatMap((block) => block.headers.map(({ key, value }) => [key, value])),
  );
})();

const types = new Map([
  ['.css', 'text/css; charset=utf-8'],
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.png', 'image/png'],
  ['.svg', 'image/svg+xml'],
  ['.txt', 'text/plain; charset=utf-8'],
  ['.woff', 'font/woff'],
  ['.woff2', 'font/woff2'],
]);

function isFile(path) {
  return existsSync(path) && statSync(path).isFile();
}

/**
 * Resolve a request path to an exported file, mirroring how a static host reads
 * `out/`. Returns null when nothing matches so the caller can serve a real 404 —
 * this export has no client-side router, so falling back to index.html for
 * unknown paths would answer 200 with the wrong page.
 */
function resolveRequest(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  if (isFile(candidate)) return candidate;

  // `next build` emits sibling files (gallery.html) alongside a directory of
  // route payloads (gallery/), so a directory hit must still fall through to
  // the sibling — otherwise `/gallery/` misses the page it names.
  const index = join(candidate, 'index.html');
  if (isFile(index)) return index;

  // Trailing slashes survive normalize(); strip them before appending .html.
  const withoutTrailingSlash = candidate.endsWith(sep) ? candidate.slice(0, -1) : candidate;
  const html = `${withoutTrailingSlash}.html`;
  if (isFile(html)) return html;

  if (decoded === '/' || decoded === '') return join(root, 'index.html');
  return null;
}

const server = createServer((request, response) => {
  const url = new URL(request.url ?? '/', `http://${host}:${port}`);
  let pathname = url.pathname;
  if (basePath) {
    if (pathname === '/') {
      response.writeHead(302, { Location: `${basePath}/` });
      response.end();
      return;
    }
    if (pathname !== basePath && !pathname.startsWith(`${basePath}/`)) {
      response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
      response.end('Not found');
      return;
    }
    pathname = pathname.slice(basePath.length) || '/';
  }
  const file = resolveRequest(pathname);

  if (!file) {
    // Serve the exported 404 page so the preview matches what a static host shows.
    const notFound = join(root, '404.html');
    if (isFile(notFound)) {
      response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/html; charset=utf-8' });
      createReadStream(notFound).pipe(response);
      return;
    }
    response.writeHead(404, { ...securityHeaders, 'Content-Type': 'text/plain; charset=utf-8' });
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    ...securityHeaders,
    'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}`);
});
