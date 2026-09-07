import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import app from '../worker/src/public.js';
import { loadConfig, agentConfigProblems } from './config.mjs';
import { runCommand } from './command.mjs';
import { CodexWeeklyRunner } from './codex-runner.mjs';
import { GatewayJobHandler } from './gateway-job-handler.mjs';
import { GitRepositoryStore } from './git-store.mjs';
import { createLocalGitHubFetch } from './github-local-fetch.mjs';
import { SupabaseRealtimeAgent } from './supabase-realtime-agent.mjs';
import { SupabaseSnapshotPublisher } from './supabase-sync.mjs';

const config = loadConfig();
const problems = agentConfigProblems(config);
if (problems.length) {
  throw new Error('Supabase Agent configuration is incomplete:\n- ' + problems.join('\n- '));
}

async function githubAgentToken() {
  if (config.github.agentToken) return config.github.agentToken;
  try {
    const result = await runCommand('gh', ['auth', 'token'], {
      timeoutMs: 15_000,
      maxOutputBytes: 64 * 1024
    });
    const token = result.stdout.trim();
    if (token) return token;
  } catch (_) {}
  throw new Error('GitHub agent credential missing: set GITHUB_AGENT_TOKEN or run gh auth login');
}

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

const githubToken = await githubAgentToken();
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = createLocalGitHubFetch({
  nativeFetch,
  store: projectStore,
  managedWriteTokens: [githubToken]
});

const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  global: { fetch: globalThis.fetch }
});
const internalBearer = randomBytes(32).toString('base64url');
const codexRunner = new CodexWeeklyRunner({
  ...config.codex,
  runtimeDir: path.join(config.runtimeDir, 'codex')
});
const workerEnv = {
  PROJECT_REPO: config.project.fullName,
  GITHUB_ORG: config.github.org,
  INTERNAL_AGENT_BEARER: internalBearer,
  LOCAL_GITHUB_TOKEN: githubToken,
  REPORT_REPO_TOKEN: githubToken,
  LOCAL_CODEX_MODEL: config.codex.model || 'Codex account',
  LOCAL_CODEX_REQUIRE_PM: false,
  LOCAL_CODEX_RUNNER: input => codexRunner.analyze(input),
  LOCAL_JOB_QUEUE: null,
  ALLOWED_ORIGINS: ''
};
const handler = new GatewayJobHandler({
  app,
  env: workerEnv,
  internalBearer,
  supabase,
  reportBucket: config.supabase.reportBucket
});
const publisher = new SupabaseSnapshotPublisher({
  supabase,
  projectStore,
  agentId: config.supabase.agentId,
  loadProposals: () => handler.listProposals()
});

async function execute(job) {
  const result = await handler.handle(job);
  let gatewaySync = null;
  const warnings = [];
  try {
    gatewaySync = await publisher.publishAll();
  } catch (error) {
    warnings.push('gateway_snapshot_sync_failed: ' + (error.message || String(error)));
  }
  const retention = await supabase.rpc('prune_gateway_data');
  if (retention.error) warnings.push('gateway_retention_failed: ' + retention.error.message);
  const envelope = result && typeof result === 'object'
    ? { ...result }
    : { ok: true, value: result };
  if (gatewaySync) envelope.gateway_sync = gatewaySync;
  if (retention.data) envelope.gateway_retention = retention.data;
  if (warnings.length) envelope.gateway_warning = warnings.join('; ');
  return envelope;
}

const packageVersion = '0.8.0';
const agent = new SupabaseRealtimeAgent({
  supabase,
  agentId: config.supabase.agentId,
  version: packageVersion,
  handleJob: execute
});

const abandoned = await supabase.rpc('fail_abandoned_gateway_jobs', {
  p_agent_id: config.supabase.agentId
});
if (abandoned.error) {
  throw new Error('Could not recover abandoned jobs: ' + abandoned.error.message);
}
const pruned = await supabase.rpc('prune_gateway_data');
if (pruned.error) throw new Error('Could not apply Gateway retention: ' + pruned.error.message);

try {
  await publisher.publishAll();
} catch (error) {
  process.stderr.write('Initial snapshot publish needs attention: ' + (error.message || String(error)) + '\n');
}

await agent.start();
process.stdout.write(
  'SmartPort Supabase Agent connected\n' +
  'Agent: ' + config.supabase.agentId + '\n' +
  'Project repository: ' + config.project.fullName + ' (' + config.project.branch + ')\n' +
  'Mode: Realtime events + reconnect catch-up; no interval polling\n'
);

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await agent.stop();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
