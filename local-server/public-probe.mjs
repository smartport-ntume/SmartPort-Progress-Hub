import { loadConfig } from './config.mjs';

const config = loadConfig();
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

let origin = '';
try {
  const parsed = new URL(config.publicBaseUrl);
  origin = parsed.origin;
  add('Public URL', parsed.protocol === 'https:', parsed.origin);
} catch (error) {
  add('Public URL', false, error.message);
}

if (origin) {
  try {
    const response = await fetch(origin + '/api/health', {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
    const body = await response.json();
    add('HTTPS health', response.ok && body.mode === 'local', `HTTP ${response.status}; mode=${body.mode || 'unknown'}`);
    add('Health privacy', body.local?.repository === undefined, body.local?.repository === undefined ? 'details hidden' : 'repository details exposed');
    add('HSTS', !!response.headers.get('strict-transport-security'), response.headers.get('strict-transport-security') || 'missing');
    add('Content security policy', !!response.headers.get('content-security-policy'), response.headers.get('content-security-policy') ? 'present' : 'missing');
  } catch (error) {
    add('HTTPS health', false, error.message);
  }

  try {
    const response = await fetch(origin + '/.env.local', {
      redirect: 'error',
      signal: AbortSignal.timeout(15_000)
    });
    add('Secret-file denial', response.status === 404, `HTTP ${response.status}`);
  } catch (error) {
    add('Secret-file denial', false, error.message);
  }
}

for (const check of checks) {
  process.stdout.write((check.ok ? '[OK] ' : '[!!] ') + check.name + ': ' + check.detail + '\n');
}
if (checks.some(check => !check.ok)) process.exitCode = 1;
