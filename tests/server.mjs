// Tiny static file server used by the test harness. Picks an ephemeral port
// and serves files relative to the repository root.

import http from 'node:http';
import { createReadStream, statSync } from 'node:fs';
import { join, normalize, sep } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.epub': 'application/epub+zip',
  '.xml':  'application/xml',
  '.txt':  'text/plain; charset=utf-8',
  '.ico':  'image/x-icon',
};

export async function startServer(root) {
  const server = http.createServer((req, res) => {
    let url;
    try { url = new URL(req.url, 'http://localhost'); } catch { res.writeHead(400).end(); return; }
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';

    // Resolve and reject anything that escapes `root`.
    const resolved = normalize(join(root, path));
    if (!resolved.startsWith(root + sep) && resolved !== root) {
      res.writeHead(403).end('Forbidden'); return;
    }

    let stat;
    try { stat = statSync(resolved); }
    catch { res.writeHead(404).end('Not found'); return; }
    if (!stat.isFile()) { res.writeHead(404).end('Not found'); return; }

    const ext = resolved.slice(resolved.lastIndexOf('.')).toLowerCase();
    res.writeHead(200, {
      'content-type': MIME[ext] || 'application/octet-stream',
      'content-length': stat.size,
      'cache-control': 'no-store',
    });
    createReadStream(resolved).pipe(res);
  });

  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise(r => server.close(r)),
  };
}
