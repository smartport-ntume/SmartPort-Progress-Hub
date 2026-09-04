import test from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import { spawn, execFileSync } from 'node:child_process';
import path from 'node:path';

async function unusedPort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const port = server.address().port;
      server.close(error => error ? reject(error) : resolve(port));
    });
  });
}

function waitForOutput(child, text, timeoutMs = 8_000) {
  return new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Server start timed out:\n' + output)), timeoutMs);
    const append = chunk => {
      output += chunk.toString();
      if (output.includes(text)) {
        clearTimeout(timer);
        resolve(output);
      }
    };
    child.stdout.on('data', append);
    child.stderr.on('data', append);
    child.once('exit', code => {
      clearTimeout(timer);
      reject(new Error('Server exited before startup (' + code + '):\n' + output));
    });
  });
}

test('Node server starts in local mode without exposing backend files', async t => {
  const root = process.cwd();
  const port = await unusedPort();
  const projectRepo = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-server-project-'));
  t.after(() => fs.rm(projectRepo, { recursive: true, force: true }));
  execFileSync('git', ['init', '--initial-branch=main'], { cwd: projectRepo });
  await fs.writeFile(path.join(projectRepo, 'README.md'), 'smoke fixture\n');
  execFileSync('git', ['add', '.'], { cwd: projectRepo });
  execFileSync('git', [
    '-c', 'user.name=Test', '-c', 'user.email=test@example.com',
    'commit', '-m', 'smoke fixture'
  ], { cwd: projectRepo });
  const origin = 'http://127.0.0.1:' + port;
  const child = spawn(process.execPath, ['local-server/server.mjs'], {
    cwd: root,
    env: {
      ...process.env,
      HOST: '127.0.0.1',
      PORT: String(port),
      SERVE_FRONTEND: 'true',
      FRONTEND_URL: origin,
      PUBLIC_BASE_URL: origin,
      ALLOWED_ORIGINS: origin,
      GITHUB_CLIENT_ID: 'smoke-client',
      GITHUB_CLIENT_SECRET: 'smoke-secret',
      SESSION_SECRET: 'smoke-test-session-secret-at-least-32-characters',
      PROJECT_REPO: 'smartport-ntume/SmartPort-Progress-Hub',
      PROJECT_REPO_PATH: projectRepo,
      PROJECT_REPO_URL: 'https://github.com/smartport-ntume/SmartPort-Progress-Hub.git',
      PROJECT_BRANCH: 'main',
      GIT_AUTO_PULL: 'false',
      GIT_AUTO_PUSH: 'false',
      LOCAL_CODEX_ENABLED: 'false',
      PUBLIC_SNAPSHOT_ENABLED: 'false'
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true
  });
  t.after(() => {
    if (child.exitCode == null) child.kill('SIGTERM');
  });

  await waitForOutput(child, 'SmartPort Local Backend listening');
  const health = await fetch(origin + '/api/health');
  assert.equal(health.status, 200);
  const healthBody = await health.json();
  assert.equal(healthBody.mode, 'local');
  assert.equal(healthBody.local.ready, true);
  assert.equal(healthBody.local.repository, undefined);

  const index = await fetch(origin + '/');
  assert.equal(index.status, 200);
  assert.match(await index.text(), /SmartPort Progress Hub/);

  for (const forbidden of ['/.env.example', '/local-server/server.mjs', '/package.json']) {
    assert.equal((await fetch(origin + forbidden)).status, 404);
  }
});
