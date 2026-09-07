import http from 'node:http';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import app from '../worker/src/public.js';
import { loadConfig, configProblems } from './config.mjs';
import { GitRepositoryStore } from './git-store.mjs';
import { createLocalGitHubFetch, LOCAL_READ_TOKEN, LOCAL_WRITE_TOKEN } from './github-local-fetch.mjs';
import { LocalJobQueue } from './job-queue.mjs';
import { CodexWeeklyRunner } from './codex-runner.mjs';
import { SnapshotPublisher } from './snapshot.mjs';
import { serveStaticFile } from './static-files.mjs';

const MAX_BODY_BYTES = 16 * 1024 * 1024;
const config = loadConfig();
const problems = configProblems(config);
if (problems.length) {
  throw new Error('Local backend configuration is incomplete:\n- ' + problems.join('\n- '));
}

await fs.mkdir(config.runtimeDir, { recursive: true });

const projectStore = new GitRepositoryStore({
  repoPath: config.project.path,
  repoUrl: config.project.url,
  branch: config.project.branch,
  fullName: config.project.fullName,
  autoPull: config.project.autoPull,
  autoPush: config.project.autoPush,
  pullIntervalMs: config.project.pullIntervalMs,
  authorName: config.project.authorName,
  authorEmail: config.project.authorEmail
});
await projectStore.ensureReady();
await projectStore.assertClean();
if (config.project.autoPull) await projectStore.pull();

let publicStore = null;
if (config.snapshot.enabled) {
  publicStore = new GitRepositoryStore({
    repoPath: config.snapshot.publicRepoPath,
    repoUrl: config.snapshot.publicRepoUrl,
    branch: config.snapshot.branch,
    fullName: 'smartport-ntume/SmartPort-Progress-Hub',
    autoPull: true,
    autoPush: true,
    pullIntervalMs: config.project.pullIntervalMs,
    authorName: config.project.authorName,
    authorEmail: config.project.authorEmail
  });
}

const snapshotPublisher = new SnapshotPublisher({
  enabled: config.snapshot.enabled,
  projectStore,
  publicStore,
  file: config.snapshot.file
});
const codexRunner = new CodexWeeklyRunner({
  ...config.codex,
  runtimeDir: path.join(config.runtimeDir, 'codex')
});
const jobQueue = new LocalJobQueue({
  historyFile: path.join(config.runtimeDir, 'jobs', 'history.json'),
  maxActive: config.codex.maxActiveJobs
});

const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = createLocalGitHubFetch({ nativeFetch, store: projectStore });

const workerEnv = {
  FRONTEND_URL: config.frontendUrl,
  ALLOWED_ORIGINS: config.allowedOrigins.join(','),
  PROJECT_REPO: config.project.fullName,
  GITHUB_ORG: config.github.org,
  GITHUB_CLIENT_ID: config.github.clientId,
  GITHUB_CLIENT_SECRET: config.github.clientSecret,
  SESSION_SECRET: config.github.sessionSecret,
  GUEST_REPO_TOKEN: LOCAL_READ_TOKEN,
  REPORT_REPO_TOKEN: LOCAL_WRITE_TOKEN,
  LOCAL_CODEX_MODEL: config.codex.model || 'Codex account',
  LOCAL_CODEX_REQUIRE_PM: config.codex.requirePm,
  LOCAL_CODEX_RUNNER: input => codexRunner.analyze(input),
  LOCAL_JOB_QUEUE: jobQueue,
  LOCAL_SNAPSHOT_PUBLISHER: config.snapshot.enabled
    ? () => snapshotPublisher.publish()
    : null,
  LOCAL_STATUS_PROVIDER: async () => {
    let repository;
    try { repository = await projectStore.status(); }
    catch (error) { repository = { ready: false, error: error.message || String(error) }; }
    const [codex, jobs] = await Promise.all([codexRunner.status(), jobQueue.summary()]);
    return {
      ready: repository.ready !== false && repository.clean !== false,
      repository,
      codex,
      jobs,
      snapshot: snapshotPublisher.status()
    };
  }
};

function publicRequestUrl(request) {
  const forwarded = String(request.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const protocol = forwarded || (request.socket.encrypted ? 'https' : 'http');
  const host = request.headers.host || '127.0.0.1:' + config.port;
  const base = config.publicBaseUrl || protocol + '://' + host;
  return new URL(request.url || '/', base).toString();
}

async function requestBuffer(request) {
  const parts = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw Object.assign(new Error('request_body_too_large'), { status: 413 });
    parts.push(chunk);
  }
  return parts.length ? Buffer.concat(parts) : null;
}

async function toFetchRequest(request) {
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    if (Array.isArray(value)) value.forEach(item => headers.append(name, item));
    else if (value != null) headers.set(name, value);
  }
  const body = ['GET', 'HEAD'].includes(request.method || 'GET') ? null : await requestBuffer(request);
  return new Request(publicRequestUrl(request), {
    method: request.method,
    headers,
    ...(body ? { body } : {})
  });
}

async function sendFetchResponse(nodeResponse, fetchResponse) {
  const headers = {};
  fetchResponse.headers.forEach((value, key) => { headers[key] = value; });
  if (typeof fetchResponse.headers.getSetCookie === 'function') {
    const cookies = fetchResponse.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
  }
  const body = fetchResponse.status === 204
    ? null
    : Buffer.from(await fetchResponse.arrayBuffer());
  nodeResponse.writeHead(fetchResponse.status, headers);
  nodeResponse.end(body);
}

const server = http.createServer(async (request, response) => {
  try {
    const pathname = new URL(request.url || '/', 'http://local').pathname;
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/auth/')) {
      if (config.serveFrontend && await serveStaticFile(request, response, config.rootDir, {
        allowPublicSnapshot: config.snapshot.enabled
      })) return;
      response.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    const fetchRequest = await toFetchRequest(request);
    await sendFetchResponse(response, await app.fetch(fetchRequest, workerEnv, {}));
  } catch (error) {
    const status = Number(error?.status) || 500;
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error?.message || String(error) }));
  }
});

server.listen(config.port, config.host, () => {
  process.stdout.write(
    'SmartPort Local Backend listening on http://' + config.host + ':' + config.port + '\n' +
    'Public URL: ' + config.publicBaseUrl + '\n' +
    'Project repository: ' + config.project.fullName + ' (' + config.project.branch + ')\n'
  );
});

function shutdown() {
  server.close(() => process.exit(0));
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
