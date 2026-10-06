// Zero-dependency static file server for the test fixtures (and, in Phase 3, the mock store).
// Usage: node tools/serve.mjs [port]   → serves tests/fixtures on http://localhost:<port>/
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

/**
 * @param {{root: string, port?: number, host?: string}} opts
 * @returns {Promise<import('node:http').Server>}
 */
export function startServer({ root, port = 8080, host = '127.0.0.1' }) {
  const base = resolve(root);
  const server = createServer(async (req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405, { Allow: 'GET, HEAD' }).end();
      return;
    }
    let pathname;
    try {
      pathname = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    } catch {
      res.writeHead(400).end();
      return;
    }
    if (pathname.endsWith('/')) pathname += 'index.html';
    const file = normalize(join(base, pathname));
    if (file !== base && !file.startsWith(base + sep)) {
      res.writeHead(403).end(); // path traversal
      return;
    }
    try {
      if (!(await stat(file)).isFile()) throw new Error('not a file');
      const body = await readFile(file);
      res.writeHead(200, {
        'Content-Type': TYPES[extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      });
      res.end(req.method === 'HEAD' ? undefined : body);
    } catch {
      res.writeHead(404, { 'Content-Type': 'text/plain' }).end('Not found');
    }
  });
  return new Promise((ok, fail) => {
    server.once('error', fail);
    server.listen(port, host, () => ok(server));
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.argv[2]) || 8080;
  const root = fileURLToPath(new URL('../tests/fixtures/', import.meta.url));
  const server = await startServer({ root, port });
  console.log(`Serving ${root} at http://localhost:${server.address().port}/`);
}
