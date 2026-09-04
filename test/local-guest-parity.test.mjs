import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/public.js';

function githubFile(value) {
  return Response.json({
    sha: 'fixture-sha',
    content: Buffer.from(JSON.stringify(value), 'utf8').toString('base64')
  });
}

async function guestPolicy(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits({
    name: 'PBKDF2',
    hash: 'SHA-256',
    salt,
    iterations: 100_000
  }, key, 256);
  return {
    guest_access: {
      enabled: true,
      password_algorithm: 'PBKDF2-SHA256',
      iterations: 100_000,
      salt: Buffer.from(salt).toString('base64url'),
      password_hash: Buffer.from(bits).toString('base64url'),
      revision: 'guest-policy-v1',
      session_hours: 8,
      allowed_views: ['dashboard', 'plan', 'fsr', 'cp', 'item-functions', 'reference', 'tr']
    }
  };
}

test('local Guest receives the complete main project snapshot as read-only data', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  const password = 'guest-password-fixture';
  const policy = await guestPolicy(password);
  const documents = {
    'project/access_control.json': policy,
    'project/project.json': { name: 'SmartPort', scope: 'Complete project scope' },
    'project/work_packages.json': {
      work_packages: [{ id: 'WP-01', description: 'Complete work-package description' }]
    },
    'project/subtasks.json': {
      subtasks: [{ id: 'ST-01', github_issue: 42, expected_evidence: ['test-report.pdf'] }]
    },
    'safety/fsr.json': {
      functional_safety_requirements: [{ id: 'FSR-01', requirement: 'Complete safety requirement' }]
    },
    'project/checkpoints.json': {
      checkpoints: [{ id: 'CP-01', review_checks: ['Evidence complete'] }]
    }
  };

  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const marker = '/repos/example/private-project/contents/';
    if (url.pathname.startsWith(marker)) {
      const path = decodeURIComponent(url.pathname.slice(marker.length));
      if (documents[path]) return githubFile(documents[path]);
    }
    throw new Error('Unexpected GitHub request: ' + url.pathname);
  };

  const env = {
    PROJECT_REPO: 'example/private-project',
    GUEST_REPO_TOKEN: 'local-read-token',
    SESSION_SECRET: 'test-session-secret-with-at-least-32-characters'
  };
  const login = await app.fetch(new Request('https://hub.example/api/guest/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password })
  }), env, {});
  assert.equal(login.status, 200);
  const session = (await login.json()).session;

  const snapshotResponse = await app.fetch(new Request('https://hub.example/api/project/snapshot', {
    headers: { Authorization: 'Bearer ' + session }
  }), env, {});
  assert.equal(snapshotResponse.status, 200);
  assert.deepEqual(await snapshotResponse.json(), {
    project: documents['project/project.json'],
    work_packages: documents['project/work_packages.json'].work_packages,
    subtasks: documents['project/subtasks.json'].subtasks,
    functional_safety_requirements: documents['safety/fsr.json'].functional_safety_requirements,
    checkpoints: documents['project/checkpoints.json'].checkpoints
  });

  const writeResponse = await app.fetch(new Request('https://hub.example/api/project/work-packages', {
    method: 'PUT',
    headers: {
      Authorization: 'Bearer ' + session,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ work_packages: [] })
  }), env, {});
  assert.equal(writeResponse.status, 403);
  assert.equal((await writeResponse.json()).error, 'guest_read_only');
});
