import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/index.js';

test('GitHub OAuth returns to the frontend that initiated login', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = async input => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.hostname === 'github.com' && url.pathname === '/login/oauth/access_token') {
      return Response.json({ access_token: 'github-token', expires_in: 3600 });
    }
    throw new Error('Unexpected OAuth fetch: ' + url);
  };

  const env = {
    FRONTEND_URL: 'https://smartport-ntume.github.io/SmartPort-Progress-Hub/',
    ALLOWED_ORIGINS: 'https://device.example.ts.net',
    GITHUB_CLIENT_ID: 'client-id',
    GITHUB_CLIENT_SECRET: 'client-secret',
    SESSION_SECRET: 'oauth-test-session-secret-at-least-32-characters'
  };
  const returnTo = 'https://device.example.ts.net/?view=reports';
  const login = await app.fetch(new Request(
    'https://backend.example/auth/login?return_to=' + encodeURIComponent(returnTo)
  ), env, {});
  assert.equal(login.status, 302);
  assert.match(login.headers.get('set-cookie'), /SameSite=Lax/);
  assert.doesNotMatch(login.headers.get('set-cookie'), /SameSite=None/);
  const authorization = new URL(login.headers.get('location'));
  const state = authorization.searchParams.get('state');
  const stateCookie = login.headers.get('set-cookie').match(/^sp_state=([^;]+)/)[1];

  const callback = await app.fetch(new Request(
    'https://backend.example/auth/callback?code=oauth-code&state=' + encodeURIComponent(state),
    { headers: { Cookie: 'sp_state=' + stateCookie } }
  ), env, {});
  assert.equal(callback.status, 302);
  const redirect = new URL(callback.headers.get('location'));
  assert.equal(redirect.origin + redirect.pathname + redirect.search, returnTo);
  assert.match(redirect.hash, /^#sp_session=/);
});
