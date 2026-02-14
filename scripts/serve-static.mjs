import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { extname, join, normalize, resolve, sep } from 'node:path';

const root = resolve(process.argv[2] ?? 'out');
const port = Number.parseInt(process.env.PORT ?? '3012', 10);
const host = process.env.HOST ?? '127.0.0.1';
const basePath = (process.env.BASE_PATH ?? '').replace(/\/$/, '');

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

function resolveRequest(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const candidate = normalize(join(root, decoded));
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) return null;

  if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  if (existsSync(candidate) && statSync(candidate).isDirectory()) {
    const index = join(candidate, 'index.html');
    if (existsSync(index)) return index;
  }

  const html = `${candidate}.html`;
  if (existsSync(html)) return html;

  if (extname(decoded)) return null;
  return join(root, 'index.html');
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
      response.writeHead(404);
      response.end('Not found');
      return;
    }
    pathname = pathname.slice(basePath.length) || '/';
  }
  const file = resolveRequest(pathname);

  if (!file || !existsSync(file)) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  response.writeHead(200, {
    'Content-Type': types.get(extname(file)) ?? 'application/octet-stream',
  });
  createReadStream(file).pipe(response);
});

server.listen(port, host, () => {
  console.log(`Serving ${root} at http://${host}:${port}`);
});
