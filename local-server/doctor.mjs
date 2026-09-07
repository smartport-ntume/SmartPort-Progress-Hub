import path from 'node:path';
import { loadConfig, configProblems } from './config.mjs';
import { GitRepositoryStore } from './git-store.mjs';
import { CodexWeeklyRunner } from './codex-runner.mjs';
import { runCommand } from './command.mjs';

const config = loadConfig();
const checks = [];
const add = (name, ok, detail) => checks.push({ name, ok, detail });

const problems = configProblems(config);
add('Configuration', problems.length === 0, problems.length ? problems.join('; ') : 'complete');

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
  add('Project clone', false, error.message + '; starting the server will attempt the first clone');
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

try {
  const tailscale = await runCommand('tailscale', ['status', '--json'], {
    timeoutMs: 15_000,
    allowNonZero: true
  });
  add('Tailscale', tailscale.code === 0, tailscale.code === 0 ? 'connected' : 'not connected');
} catch (_) {
  add('Tailscale', false, 'not installed or not on PATH');
}

try {
  const serve = await runCommand('tailscale', ['serve', 'status'], {
    timeoutMs: 15_000,
    allowNonZero: true
  });
  let expectedHost = '';
  try { expectedHost = new URL(config.publicBaseUrl).hostname; } catch (_) {}
  const configured = serve.code === 0 && (!expectedHost || (serve.stdout + serve.stderr).includes(expectedHost));
  add('Tailscale Serve', configured, configured ? expectedHost : 'run tailscale serve --bg ' + config.port);
} catch (_) {
  add('Tailscale Serve', false, 'not configured');
}

for (const check of checks) {
  process.stdout.write((check.ok ? '[OK] ' : '[!!] ') + check.name + ': ' + check.detail + '\n');
}
if (checks.some(check => !check.ok)) process.exitCode = 1;
