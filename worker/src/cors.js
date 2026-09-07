function originOf(value) {
  try { return new URL(String(value || '')).origin; }
  catch (_) { return ''; }
}

export function allowedOrigins(env = {}) {
  const configured = String(env.ALLOWED_ORIGINS || '')
    .split(',')
    .map(item => originOf(item.trim()))
    .filter(Boolean);
  const frontend = originOf(env.FRONTEND_URL);
  if (frontend) configured.push(frontend);
  return [...new Set(configured)];
}

export function safeReturnUrl(value, env = {}) {
  try {
    if (!value || String(value).length > 2_048) return '';
    const url = new URL(String(value));
    if (!['http:', 'https:'].includes(url.protocol)) return '';
    const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
    if (url.protocol !== 'https:' && !loopback) return '';
    if (url.username || url.password || !allowedOrigins(env).includes(url.origin)) return '';
    url.hash = '';
    return url.toString();
  } catch (_) {
    return '';
  }
}

export function corsHeaders(requestOrigin, env = {}) {
  const allowed = allowedOrigins(env);
  const origin = allowed.includes(requestOrigin) ? requestOrigin : (allowed[0] || 'null');
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Vary': 'Origin'
  };
}
