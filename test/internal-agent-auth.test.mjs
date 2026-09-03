import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/public.js';

test('internal Agent credential bypasses browser OAuth without trusting an arbitrary actor header', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.pathname === '/repos/example/private-project') {
      return Response.json({ permissions: { pull: true, push: true } });
    }
    throw new Error('unexpected external call: ' + url.pathname);
  };
  const env = {
    PROJECT_REPO: 'example/private-project',
    GITHUB_ORG: 'example',
    INTERNAL_AGENT_BEARER: 'internal-random-secret',
    LOCAL_GITHUB_TOKEN: 'local-github-token'
  };

  const accepted = await app.fetch(new Request('https://local-agent/api/me', {
    headers: {
      Authorization: 'Bearer internal-random-secret',
      'X-SmartPort-Actor': 'engineer-one'
    }
  }), env, {});
  assert.equal(accepted.status, 200);
  const me = await accepted.json();
  assert.equal(me.login, 'engineer-one');
  assert.equal(me.role, 'PM');

  const rejected = await app.fetch(new Request('https://local-agent/api/me', {
    headers: {
      Authorization: 'Bearer wrong-secret',
      'X-SmartPort-Actor': 'attacker'
    }
  }), env, {});
  assert.equal(rejected.status, 401);
});
