import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/index.js';

function b64url(bytes) {
  return Buffer.from(bytes).toString('base64url');
}

async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(value))
  );
  return b64url(iv) + '.' + b64url(new Uint8Array(encrypted));
}

test('local mode keeps Codex PM-only and never queues work during health checks', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  let canApprove = false;
  let enqueueCount = 0;
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/user') {
      return Response.json({ login: 'engineer' });
    }
    if (url.pathname === '/repos/example/private-project') {
      return Response.json({ permissions: { pull: true, push: canApprove, maintain: canApprove } });
    }
    throw new Error('Unexpected GitHub request: ' + url.pathname);
  };

  const secret = 'test-session-secret-with-at-least-32-characters';
  const session = await seal({ token: 'github-user-token', exp: Date.now() + 60_000 }, secret);
  const env = {
    FRONTEND_URL: 'https://frontend.example',
    PROJECT_REPO: 'example/private-project',
    SESSION_SECRET: secret,
    LOCAL_CODEX_REQUIRE_PM: true,
    LOCAL_JOB_QUEUE: {
      async enqueue() {
        enqueueCount += 1;
        return { id: 'job-1', status: 'queued' };
      }
    },
    LOCAL_STATUS_PROVIDER: async () => ({ ready: true })
  };

  const health = await app.fetch(new Request('https://backend.example/api/health'), env, {});
  assert.equal(health.status, 200);
  assert.equal(enqueueCount, 0);

  const request = () => new Request('https://backend.example/api/reports/analyze', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer ' + session,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      report_date: '2026-09-03',
      owner_team: 'CTL',
      report_path: 'weekly_reports/2026/report.docx'
    })
  });

  const denied = await app.fetch(request(), env, {});
  assert.equal(denied.status, 403);
  assert.equal((await denied.json()).error, 'pm_permission_required_for_local_codex');
  assert.equal(enqueueCount, 0);

  canApprove = true;
  const accepted = await app.fetch(request(), env, {});
  assert.equal(accepted.status, 202);
  assert.equal((await accepted.json()).job.id, 'job-1');
  assert.equal(enqueueCount, 1);
});
