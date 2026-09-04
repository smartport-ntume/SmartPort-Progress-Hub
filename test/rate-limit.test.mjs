import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestRateLimiter, requestClientIp } from '../local-server/rate-limit.mjs';

function request(ip = '198.51.100.8', method = 'POST') {
  return {
    method,
    headers: { 'x-forwarded-for': `203.0.113.9, ${ip}` },
    socket: { remoteAddress: '127.0.0.1' }
  };
}

test('public limiter caps Guest password attempts by the proxy-provided client IP', () => {
  let now = 1_000;
  const limiter = new RequestRateLimiter({
    now: () => now,
    guestLoginMax: 2,
    guestLoginWindowMs: 10_000
  });

  assert.equal(requestClientIp(request()), '198.51.100.8');
  assert.equal(limiter.consume(request(), '/api/guest/login').allowed, true);
  assert.equal(limiter.consume(request(), '/api/guest/login').allowed, true);
  const denied = limiter.consume(request(), '/api/guest/login');
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfter, 10);

  assert.equal(limiter.consume(request('198.51.100.9'), '/api/guest/login').allowed, true);
  assert.equal(limiter.consume(request(), '/index.html').allowed, true);

  now += 10_000;
  assert.equal(limiter.consume(request(), '/api/guest/login').allowed, true);
});
