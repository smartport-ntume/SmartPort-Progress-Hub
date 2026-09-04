import net from 'node:net';

function normalizedIp(value) {
  let candidate = String(value || '').trim();
  if (candidate.startsWith('[')) candidate = candidate.slice(1, candidate.indexOf(']'));
  if (candidate.startsWith('::ffff:')) candidate = candidate.slice(7);
  return net.isIP(candidate) ? candidate : '';
}

export function requestClientIp(request) {
  const forwarded = String(request?.headers?.['x-forwarded-for'] || '')
    .split(',')
    .map(normalizedIp)
    .filter(Boolean);
  return forwarded.at(-1) || normalizedIp(request?.socket?.remoteAddress) || 'unknown';
}

export class RequestRateLimiter {
  constructor(options = {}) {
    this.enabled = options.enabled !== false;
    this.now = options.now || Date.now;
    this.policies = {
      guest: { max: options.guestLoginMax || 10, windowMs: options.guestLoginWindowMs || 600_000 },
      auth: { max: options.authMax || 60, windowMs: options.windowMs || 60_000 },
      write: { max: options.writeMax || 120, windowMs: options.windowMs || 60_000 },
      api: { max: options.apiMax || 600, windowMs: options.windowMs || 60_000 }
    };
    this.entries = new Map();
  }

  policy(pathname, method) {
    if (pathname === '/api/guest/login') return ['guest', this.policies.guest];
    if (pathname.startsWith('/auth/')) return ['auth', this.policies.auth];
    if (pathname.startsWith('/api/') && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
      return ['write', this.policies.write];
    }
    if (pathname.startsWith('/api/')) return ['api', this.policies.api];
    return null;
  }

  consume(request, pathname) {
    if (!this.enabled) return { allowed: true };
    const selected = this.policy(pathname, String(request?.method || 'GET').toUpperCase());
    if (!selected) return { allowed: true };
    const [bucket, policy] = selected;
    const now = this.now();
    const key = bucket + ':' + requestClientIp(request);
    let entry = this.entries.get(key);
    if (!entry || now >= entry.resetAt) {
      entry = { count: 0, resetAt: now + policy.windowMs };
      this.entries.set(key, entry);
    }
    entry.count += 1;

    if (this.entries.size > 10_000) {
      for (const [entryKey, value] of this.entries) {
        if (now >= value.resetAt) this.entries.delete(entryKey);
      }
    }

    return {
      allowed: entry.count <= policy.max,
      limit: policy.max,
      remaining: Math.max(0, policy.max - entry.count),
      retryAfter: Math.max(1, Math.ceil((entry.resetAt - now) / 1000))
    };
  }
}
