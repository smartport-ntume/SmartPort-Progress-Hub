import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { loadConfig, configProblems, agentConfigProblems } from '../local-server/config.mjs';

const root = path.join(os.tmpdir(), 'smartport-config-root');

function validEnv(overrides = {}) {
  return {
    PUBLIC_BASE_URL: 'https://vincent-pc.example.ts.net',
    FRONTEND_URL: 'https://smartport-ntume.github.io/SmartPort-Progress-Hub/',
    GITHUB_CLIENT_ID: 'client',
    GITHUB_CLIENT_SECRET: 'secret',
    SESSION_SECRET: 'a-secure-random-session-secret-over-32-characters',
    PROJECT_REPO_PATH: '../smartport-project-control',
    ...overrides
  };
}

test('local configuration requires loopback plus an HTTPS public origin', () => {
  assert.deepEqual(configProblems(loadConfig(validEnv(), root)), []);

  const insecure = configProblems(loadConfig(validEnv({
    HOST: '0.0.0.0',
    PUBLIC_BASE_URL: 'http://192.168.1.10:8787/path'
  }), root));
  assert.ok(insecure.some(problem => problem.includes('HTTPS')));
  assert.ok(insecure.some(problem => problem.includes('without a path')));
  assert.ok(insecure.some(problem => problem.includes('HOST must stay on loopback')));

  const unsafeOrigin = configProblems(loadConfig(validEnv({
    ALLOWED_ORIGINS: 'http://192.168.1.10:8787'
  }), root));
  assert.ok(unsafeOrigin.some(problem => problem.includes('ALLOWED_ORIGINS entries must be HTTPS')));

  const sharedSource = configProblems(loadConfig(validEnv({ PROJECT_REPO_PATH: '.' }), root));
  assert.ok(sharedSource.some(problem => problem.includes('dedicated Project-Control clone')));
});

test('Supabase Agent configuration does not require a public listener or OAuth app', () => {
  const config = loadConfig({
    SUPABASE_URL: 'https://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'service-role-secret-key-with-enough-length',
    SUPABASE_AGENT_ID: 'vincent-windows-agent',
    PROJECT_REPO_PATH: '../smartport-project-control'
  }, root);
  assert.deepEqual(agentConfigProblems(config), []);

  const invalid = agentConfigProblems(loadConfig({
    SUPABASE_URL: 'http://example.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'short',
    SUPABASE_AGENT_ID: 'bad agent id',
    PROJECT_REPO_PATH: '.'
  }, root));
  assert.ok(invalid.some(problem => problem.includes('HTTPS')));
  assert.ok(invalid.some(problem => problem.includes('SERVICE_ROLE_KEY')));
  assert.ok(invalid.some(problem => problem.includes('SUPABASE_AGENT_ID')));
  assert.ok(invalid.some(problem => problem.includes('dedicated Project-Control clone')));
});
