import { promises as fs } from 'node:fs';
import path from 'node:path';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

function isPublicFrontendPath(pathname, allowPublicSnapshot) {
  if (pathname === '/index.html') return true;
  if (allowPublicSnapshot && pathname === '/data/public-snapshot.json') return true;
  return /^\/(?:js|css)\/[^/]+\.(?:js|css)$/.test(pathname);
}

export async function serveStaticFile(request, response, rootDir, { allowPublicSnapshot = false } = {}) {
  if (!['GET', 'HEAD'].includes(request.method || 'GET')) return false;
  const url = new URL(request.url || '/', 'http://local');
  let pathname;
  try { pathname = decodeURIComponent(url.pathname); }
  catch (_) { pathname = '/'; }
  if (pathname === '/') pathname = '/index.html';
  if (pathname.includes('\\') || !isPublicFrontendPath(pathname, allowPublicSnapshot)) return false;

  const root = await fs.realpath(path.resolve(rootDir)).catch(() => path.resolve(rootDir));
  const target = path.resolve(root, '.' + pathname);
  if (target !== root && !target.startsWith(root + path.sep)) return false;

  let stat;
  let realTarget;
  try {
    realTarget = await fs.realpath(target);
    if (!realTarget.startsWith(root + path.sep)) return false;
    stat = await fs.stat(realTarget);
  }
  catch (_) { return false; }
  if (!stat.isFile()) return false;

  const body = request.method === 'HEAD' ? null : await fs.readFile(realTarget);
  response.writeHead(200, {
    'Content-Type': TYPES[path.extname(realTarget).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': pathname.endsWith('.html') || pathname.endsWith('.js')
      ? 'no-cache'
      : 'public, max-age=300'
  });
  response.end(body);
  return true;
}
