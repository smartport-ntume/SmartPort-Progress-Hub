import path from 'node:path';

function bool(value, fallback = false) {
  if (value == null || value === '') return fallback;
  return /^(1|true|yes|on)$/i.test(String(value));
}

function integer(value, fallback, minimum = 0) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
}

function list(value) {
  return String(value || '')
    .split(',')
    .map(item => item.trim().replace(/\/$/, ''))
    .filter(Boolean);
}

export function loadConfig(env = process.env, rootDir = process.cwd()) {
  const runtimeDir = path.resolve(rootDir, env.RUNTIME_DIR || '.runtime');
  const projectRepoPath = path.resolve(rootDir, env.PROJECT_REPO_PATH || path.join('.runtime', 'SmartPort-Project-Control'));
  const publicRepoPath = env.PUBLIC_REPO_PATH ? path.resolve(rootDir, env.PUBLIC_REPO_PATH) : '';
  const frontendUrl = String(env.FRONTEND_URL || 'https://smartport-ntume.github.io/SmartPort-Progress-Hub/').trim();
  const publicBaseUrl = String(env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const allowedOrigins = list(env.ALLOWED_ORIGINS);
  try {
    allowedOrigins.push(new URL(frontendUrl).origin);
  } catch (_) {}
  try {
    allowedOrigins.push(new URL(publicBaseUrl).origin);
  } catch (_) {}

  return {
    rootDir,
    runtimeDir,
    host: String(env.HOST || '127.0.0.1'),
    port: integer(env.PORT, 8787, 1),
    serveFrontend: bool(env.SERVE_FRONTEND, true),
    frontendUrl,
    publicBaseUrl,
    allowedOrigins: [...new Set(allowedOrigins)],
    github: {
      clientId: String(env.GITHUB_CLIENT_ID || ''),
      clientSecret: String(env.GITHUB_CLIENT_SECRET || ''),
      sessionSecret: String(env.SESSION_SECRET || ''),
      org: String(env.GITHUB_ORG || 'smartport-ntume')
    },
    project: {
      fullName: String(env.PROJECT_REPO || 'smartport-ntume/SmartPort-Project-Control'),
      url: String(env.PROJECT_REPO_URL || 'https://github.com/smartport-ntume/SmartPort-Project-Control.git'),
      path: projectRepoPath,
      branch: String(env.PROJECT_BRANCH || 'main'),
      autoPull: bool(env.GIT_AUTO_PULL, true),
      autoPush: bool(env.GIT_AUTO_PUSH, true),
      pullIntervalMs: integer(env.GIT_PULL_INTERVAL_MS, 10_000),
      authorName: String(env.GIT_AUTHOR_NAME || 'SmartPort Local Backend'),
      authorEmail: String(env.GIT_AUTHOR_EMAIL || 'smartport-local@users.noreply.github.com')
    },
    codex: {
      enabled: bool(env.LOCAL_CODEX_ENABLED, true),
      requirePm: bool(env.LOCAL_CODEX_REQUIRE_PM, true),
      bin: String(env.CODEX_BIN || 'codex'),
      model: String(env.CODEX_MODEL || ''),
      timeoutMs: integer(env.CODEX_TIMEOUT_MS, 900_000, 10_000),
      maxActiveJobs: integer(env.CODEX_MAX_ACTIVE_JOBS, 5, 1),
      libreOfficeBin: String(env.LIBREOFFICE_BIN || 'soffice'),
      keepWorkspace: bool(env.KEEP_CODEX_WORKSPACE, false)
    },
    snapshot: {
      enabled: bool(env.PUBLIC_SNAPSHOT_ENABLED, false),
      publicRepoPath,
      publicRepoUrl: String(env.PUBLIC_REPO_URL || 'https://github.com/smartport-ntume/SmartPort-Progress-Hub.git'),
      branch: String(env.PUBLIC_REPO_BRANCH || 'main'),
      file: String(env.PUBLIC_SNAPSHOT_FILE || 'data/public-snapshot.json')
    }
  };
}

export function configProblems(config) {
  const problems = [];
  try {
    const frontend = new URL(config.frontendUrl);
    if (!['http:', 'https:'].includes(frontend.protocol)) throw new Error();
  } catch (_) {
    problems.push('FRONTEND_URL must be a valid HTTP(S) URL');
  }
  if (!config.github.clientId) problems.push('GITHUB_CLIENT_ID is missing');
  if (!config.github.clientSecret) problems.push('GITHUB_CLIENT_SECRET is missing');
  if (config.github.sessionSecret.length < 32) problems.push('SESSION_SECRET must contain at least 32 characters');
  if (!config.publicBaseUrl) problems.push('PUBLIC_BASE_URL is missing');
  else {
    try {
      const url = new URL(config.publicBaseUrl);
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
        problems.push('PUBLIC_BASE_URL must use HTTPS except for localhost development');
      }
      if (url.pathname !== '/' || url.search || url.hash) {
        problems.push('PUBLIC_BASE_URL must be an origin without a path, query, or fragment');
      }
    } catch (_) {
      problems.push('PUBLIC_BASE_URL is not a valid URL');
    }
  }
  if (!['127.0.0.1', 'localhost', '::1'].includes(config.host)) {
    problems.push('HOST must stay on loopback; expose the service through Tailscale Serve');
  }
  if (path.resolve(config.project.path) === path.resolve(config.rootDir)) {
    problems.push('PROJECT_REPO_PATH must be a dedicated Project-Control clone, not the Hub source directory');
  }
  if (!/^[^/\s]+\/[^/\s]+$/.test(config.project.fullName)) {
    problems.push('PROJECT_REPO must use owner/repository format');
  }
  if (!config.allowedOrigins.length) problems.push('ALLOWED_ORIGINS is empty');
  for (const origin of config.allowedOrigins) {
    try {
      const url = new URL(origin);
      const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
      if (url.origin !== origin || (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))) {
        problems.push('ALLOWED_ORIGINS entries must be HTTPS origins, except localhost development: ' + origin);
      }
    } catch (_) {
      problems.push('Invalid ALLOWED_ORIGINS entry: ' + origin);
    }
  }
  if (config.snapshot.enabled && !config.snapshot.publicRepoPath) {
    problems.push('PUBLIC_REPO_PATH is required when PUBLIC_SNAPSHOT_ENABLED=true');
  } else if (config.snapshot.enabled && (
    path.resolve(config.snapshot.publicRepoPath) === path.resolve(config.rootDir) ||
    path.resolve(config.snapshot.publicRepoPath) === path.resolve(config.project.path)
  )) {
    problems.push('PUBLIC_REPO_PATH must be a separate dedicated public clone');
  }
  return problems;
}
