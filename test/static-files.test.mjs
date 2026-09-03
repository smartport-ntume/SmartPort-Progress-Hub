import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { serveStaticFile } from '../local-server/static-files.mjs';

function responseRecorder() {
  return {
    status: null,
    headers: null,
    body: null,
    writeHead(status, headers) { this.status = status; this.headers = headers; },
    end(body) { this.body = body; }
  };
}

test('static server exposes only the frontend allowlist', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-static-'));
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-secret-'));
  t.after(() => Promise.all([
    fs.rm(root, { recursive: true, force: true }),
    fs.rm(outside, { recursive: true, force: true })
  ]));
  await fs.mkdir(path.join(root, 'js'));
  await fs.mkdir(path.join(root, 'data'));
  await fs.mkdir(path.join(root, 'local-server'));
  await fs.writeFile(path.join(root, 'index.html'), '<h1>SmartPort</h1>');
  await fs.writeFile(path.join(root, 'js', 'app.js'), 'window.app=true;');
  await fs.writeFile(path.join(root, '.env.local'), 'SESSION_SECRET=private');
  await fs.writeFile(path.join(root, 'local-server', 'server.mjs'), 'private');
  await fs.writeFile(path.join(root, 'data', 'public-snapshot.json'), '{"public":true}\n');

  const indexResponse = responseRecorder();
  assert.equal(await serveStaticFile({ method: 'GET', url: '/' }, indexResponse, root), true);
  assert.equal(indexResponse.status, 200);
  assert.match(indexResponse.body.toString(), /SmartPort/);

  const jsResponse = responseRecorder();
  assert.equal(await serveStaticFile({ method: 'GET', url: '/js/app.js' }, jsResponse, root), true);
  assert.equal(jsResponse.status, 200);

  for (const url of ['/.env.local', '/local-server/server.mjs', '/package.json', '/../.env.local', '/data/public-snapshot.json']) {
    const denied = responseRecorder();
    assert.equal(await serveStaticFile({ method: 'GET', url }, denied, root), false);
    assert.equal(denied.status, null);
  }

  const snapshotResponse = responseRecorder();
  assert.equal(await serveStaticFile(
    { method: 'GET', url: '/data/public-snapshot.json' },
    snapshotResponse,
    root,
    { allowPublicSnapshot: true }
  ), true);

  const secret = path.join(outside, 'leak.js');
  await fs.writeFile(secret, 'secret');
  try {
    await fs.symlink(secret, path.join(root, 'js', 'leak.js'));
    const symlinkResponse = responseRecorder();
    assert.equal(await serveStaticFile({ method: 'GET', url: '/js/leak.js' }, symlinkResponse, root), false);
  } catch (error) {
    if (!['EPERM', 'EACCES'].includes(error.code)) throw error;
  }
});
