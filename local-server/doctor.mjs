import path from 'node:path';
import { promises as fs } from 'node:fs';
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
  const caddy = await runCommand(config.caddy.bin, ['version'], { timeoutMs: 15_000 });
  add('Caddy', true, caddy.stdout.trim() || caddy.stderr.trim());
} catch (error) {
  add('Caddy', false, error.message);
}

try {
  await fs.access(config.caddy.envFile);
  const caddyEnv = await fs.readFile(config.caddy.envFile, 'utf8');
  const domain = caddyEnv.match(/^\s*SMARTPORT_DOMAIN\s*=\s*([^\s#]+)\s*$/m)?.[1] || '';
  let expectedDomain = '';
  try { expectedDomain = new URL(config.publicBaseUrl).hostname; } catch (_) {}
  add(
    'Caddy hostname',
    !!domain && domain === expectedDomain && !domain.includes('.example.'),
    domain ? `${domain}${domain === expectedDomain ? '' : `; expected ${expectedDomain}`}` : 'SMARTPORT_DOMAIN is missing'
  );
  const validate = await runCommand(config.caddy.bin, [
    'validate', '--config', config.caddy.configFile, '--envfile', config.caddy.envFile
  ], { timeoutMs: 30_000, allowNonZero: true });
  add(
    'Caddy configuration',
    validate.code === 0,
    validate.code === 0 ? config.caddy.configFile : (validate.stderr || validate.stdout).trim()
  );
} catch (error) {
  add('Caddy configuration', false, error.code === 'ENOENT' ? 'copy .env.caddy.example to .env.caddy' : error.message);
}

for (const check of checks) {
  process.stdout.write((check.ok ? '[OK] ' : '[!!] ') + check.name + ': ' + check.detail + '\n');
}
if (checks.some(check => !check.ok)) process.exitCode = 1;
