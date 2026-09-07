import path from 'node:path';
import { createClient } from '@supabase/supabase-js';
import { loadConfig, agentConfigProblems } from './config.mjs';
import { CodexWeeklyRunner } from './codex-runner.mjs';
import { runCommand } from './command.mjs';
import { GitRepositoryStore } from './git-store.mjs';

const config = loadConfig();
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const problems = agentConfigProblems(config);
add('Supabase Agent configuration', problems.length === 0, problems.length ? problems.join('; ') : 'complete');

try {
  const git = await runCommand('git', ['--version'], { timeoutMs: 15_000 });
  add('Git', true, git.stdout.trim());
} catch (error) {
  add('Git', false, error.message);
}

const store = new GitRepositoryStore({
  repoPath: config.project.path,
  repoUrl: config.project.url,
  branch: config.project.branch,
  fullName: config.project.fullName,
  autoPull: false,
  autoPush: false,
  authorName: config.project.authorName,
  authorEmail: config.project.authorEmail
});
try {
  await store.ensureReady({ cloneIfMissing: false });
  const status = await store.status();
  add('Project clone', status.clean, status.branch + ' @ ' + status.head.slice(0, 8) + (status.clean ? '' : ' (dirty)'));
} catch (error) {
  add('Project clone', false, error.message + '; starting the agent can perform the first clone');
}

let resolvedGitHubToken = config.github.agentToken;
if (!resolvedGitHubToken) {
  try {
    const token = await runCommand('gh', ['auth', 'token'], { timeoutMs: 15_000, maxOutputBytes: 64 * 1024 });
    resolvedGitHubToken = token.stdout.trim();
  } catch (_) {}
}
add('GitHub API credential', !!resolvedGitHubToken, resolvedGitHubToken ? 'available locally' : 'run gh auth login or set GITHUB_AGENT_TOKEN');
if (resolvedGitHubToken) {
  try {
    const response = await fetch(`https://api.github.com/repos/${config.project.fullName}`, {
      headers: {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${resolvedGitHubToken}`,
        'User-Agent': 'SmartPort-Progress-Hub/0.8'
      }
    });
    add('GitHub private repository API', response.ok, response.ok ? 'repository metadata readable' : `GitHub HTTP ${response.status}`);
  } catch (error) {
    add('GitHub private repository API', false, error.message);
  }
} else {
  add('GitHub private repository API', false, 'skipped until a local credential is available');
}

if (!problems.length) {
  try {
    const supabase = createClient(config.supabase.url, config.supabase.serviceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false }
    });
    const { error } = await supabase.from('gateway_jobs').select('id').limit(1);
    add('Supabase migration', !error, error ? error.message : 'gateway_jobs is available');
  } catch (error) {
    add('Supabase migration', false, error.message);
  }
} else {
  add('Supabase migration', false, 'skipped until configuration is complete');
}

const codex = new CodexWeeklyRunner({
  ...config.codex,
  runtimeDir: path.join(config.runtimeDir, 'codex')
});
const codexStatus = await codex.status();
add('Codex CLI', codexStatus.available, codexStatus.version || 'not found');
add('Codex login', codexStatus.authenticated, codexStatus.authenticated ? 'authenticated' : 'run codex login');
add(
  'Codex automation flags',
  codexStatus.compatible,
  codexStatus.compatible ? 'compatible' : 'update Codex CLI; missing ' + (codexStatus.missing_flags || []).join(', ')
);

for (const check of checks) {
  process.stdout.write((check.ok ? '[OK] ' : '[!!] ') + check.name + ': ' + check.detail + '\n');
}
if (checks.some(check => !check.ok)) process.exitCode = 1;
