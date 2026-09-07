import test from 'node:test';
import assert from 'node:assert/strict';
import { corsHeaders, safeReturnUrl } from '../worker/src/cors.js';

test('CORS reflects only explicitly configured frontend origins', () => {
  const env = {
    FRONTEND_URL: 'https://smartport-ntume.github.io/SmartPort-Progress-Hub/',
    ALLOWED_ORIGINS: 'http://localhost:8787,https://device.example.ts.net'
  };
  assert.equal(
    corsHeaders('https://device.example.ts.net', env)['Access-Control-Allow-Origin'],
    'https://device.example.ts.net'
  );
  assert.equal(
    corsHeaders('https://evil.example', env)['Access-Control-Allow-Origin'],
    'http://localhost:8787'
  );
  assert.equal(
    safeReturnUrl('https://device.example.ts.net/project?view=cp#old', env),
    'https://device.example.ts.net/project?view=cp'
  );
  assert.equal(safeReturnUrl('https://evil.example/redirect', env), '');
});
