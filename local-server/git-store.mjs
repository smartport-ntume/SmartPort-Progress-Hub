import { promises as fs } from 'node:fs';
import path from 'node:path';
import { AsyncMutex } from './mutex.mjs';
import { runCommand } from './command.mjs';

export class GitConflictError extends Error {
  constructor(message) {
    super(message);
    this.name = 'GitConflictError';
    this.status = 409;
  }
}

export function safeRepositoryPath(value) {
  const normalized = String(value || '').replaceAll('\\', '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('\0')) throw new Error('invalid_repository_path');
  const parts = normalized.split('/');
  if (parts.some(part =>
    !part || part === '.' || part === '..' || /^\.git$/i.test(part) ||
    /[:\x00-\x1f]/.test(part) || /[. ]$/.test(part)
  )) throw new Error('invalid_repository_path');
  return parts.join('/');
}

export class GitRepositoryStore {
  constructor(options) {
    this.repoPath = options.repoPath;
    this.repoUrl = options.repoUrl;
    this.branch = options.branch || 'main';
    this.fullName = options.fullName;
    this.autoPull = options.autoPull !== false;
    this.autoPush = options.autoPush !== false;
    this.pullIntervalMs = Number(options.pullIntervalMs) || 10_000;
    this.authorName = options.authorName || 'SmartPort Local Backend';
    this.authorEmail = options.authorEmail || 'smartport-local@users.noreply.github.com';
    this.onCommitted = options.onCommitted || null;
    this.mutex = new AsyncMutex();
    this.lastPullAt = 0;
    this.readyPromise = null;
    this.pullPromise = null;
  }

  async git(args, options = {}) {
    return runCommand('git', ['-C', this.repoPath, ...args], {
      timeoutMs: 180_000,
      ...options
    });
  }

  async ensureReady({ cloneIfMissing = true } = {}) {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = (async () => {
      let hasGit = false;
      try {
        hasGit = (await fs.stat(path.join(this.repoPath, '.git'))).isDirectory();
      } catch (_) {}

      if (!hasGit) {
        if (!cloneIfMissing) throw new Error('managed_repository_not_cloned');
        await fs.mkdir(path.dirname(this.repoPath), { recursive: true });
        let entries = [];
        try { entries = await fs.readdir(this.repoPath); } catch (_) {}
        if (entries.length) throw new Error('PROJECT_REPO_PATH exists but is not an empty Git repository');
        await runCommand('git', [
          'clone', '--branch', this.branch, '--single-branch', this.repoUrl, this.repoPath
        ], { timeoutMs: 300_000 });
      }

      const inside = await this.git(['rev-parse', '--is-inside-work-tree']);
      if (inside.stdout.trim() !== 'true') throw new Error('PROJECT_REPO_PATH is not a Git worktree');
      const branch = (await this.git(['branch', '--show-current'])).stdout.trim();
      if (branch && branch !== this.branch) {
        throw new Error('Managed repository must stay on branch ' + this.branch + '; current branch is ' + branch);
      }
      return true;
    })().catch(error => {
      this.readyPromise = null;
      throw error;
    });
    return this.readyPromise;
  }

  async assertClean() {
    const result = await this.git(['status', '--porcelain']);
    if (result.stdout.trim()) {
      throw new Error('managed_repository_dirty: use a dedicated clone and resolve local changes first');
    }
  }

  async pullUnlocked() {
    if (!this.autoPull) return;
    await this.assertClean();
    await this.git(['fetch', '--prune', 'origin', this.branch]);
    await this.git(['merge', '--ff-only', 'origin/' + this.branch]);
    this.lastPullAt = Date.now();
  }

  async pull() {
    await this.ensureReady();
    return this.mutex.run(() => this.pullUnlocked());
  }

  async refreshForRead() {
    await this.ensureReady();
    if (!this.autoPull || Date.now() - this.lastPullAt < this.pullIntervalMs) return;
    if (!this.pullPromise) {
      this.pullPromise = this.pull().finally(() => { this.pullPromise = null; });
    }
    await this.pullPromise;
  }

  absolutePath(relativePath) {
    const safe = safeRepositoryPath(relativePath);
    const absolute = path.resolve(this.repoPath, safe);
    const root = path.resolve(this.repoPath) + path.sep;
    if (!absolute.startsWith(root)) throw new Error('invalid_repository_path');
    return { safe, absolute };
  }

  async realRepositoryRoot() {
    return fs.realpath(path.resolve(this.repoPath));
  }

  async assertRealPathInside(absolutePath) {
    const [root, real] = await Promise.all([
      this.realRepositoryRoot(),
      fs.realpath(absolutePath)
    ]);
    if (real !== root && !real.startsWith(root + path.sep)) {
      throw new Error('repository_path_escapes_managed_clone');
    }
    return real;
  }

  async readBuffer(relativePath, { refresh = true } = {}) {
    if (refresh) await this.refreshForRead();
    const { absolute } = this.absolutePath(relativePath);
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) throw new Error('repository_symlink_files_are_not_allowed');
    return fs.readFile(await this.assertRealPathInside(absolute));
  }

  async readJson(relativePath, options = {}) {
    return JSON.parse((await this.readBuffer(relativePath, options)).toString('utf8'));
  }

  async blobSha(relativePath) {
    const { safe } = this.absolutePath(relativePath);
    const result = await this.git(['ls-files', '--stage', '--', safe]);
    const match = result.stdout.match(/^[0-9]+\s+([0-9a-f]{40,64})\s+[0-9]+\t/);
    return match ? match[1] : null;
  }

  async writeBuffer(relativePath, buffer, options = {}) {
    const safe = safeRepositoryPath(relativePath);
    const message = String(options.message || 'SmartPort Local Backend: update ' + safe).slice(0, 240);
    const expectedSha = options.expectedSha || null;
    await this.ensureReady();

    return this.mutex.run(async () => {
      if (this.autoPull) await this.pullUnlocked();
      else await this.assertClean();

      const currentSha = await this.blobSha(safe);
      if (expectedSha && currentSha !== expectedSha) {
        throw new GitConflictError('Repository file changed before write: ' + safe);
      }

      const { absolute } = this.absolutePath(safe);
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await this.assertRealPathInside(path.dirname(absolute));
      try {
        const stat = await fs.lstat(absolute);
        if (stat.isSymbolicLink()) throw new Error('repository_symlink_files_are_not_allowed');
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
      }
      const temporary = absolute + '.smartport-' + process.pid + '-' + Date.now();
      await fs.writeFile(temporary, buffer);
      await fs.rename(temporary, absolute);
      await this.git(['add', '--', safe]);

      const changed = await this.git(['diff', '--cached', '--quiet', '--', safe], { allowNonZero: true });
      if (changed.code === 0) {
        return { changed: false, sha: currentSha, commitSha: await this.headSha(), path: safe };
      }

      await this.git([
        '-c', 'user.name=' + this.authorName,
        '-c', 'user.email=' + this.authorEmail,
        'commit', '-m', message, '--', safe
      ]);
      const commitSha = await this.headSha();
      if (this.autoPush) {
        await this.git(['push', 'origin', 'HEAD:' + this.branch], { timeoutMs: 300_000 });
      }
      this.lastPullAt = Date.now();
      const sha = await this.blobSha(safe);
      const result = { changed: true, sha, commitSha, path: safe };
      if (this.onCommitted) await this.onCommitted(result);
      return result;
    });
  }

  async writeJson(relativePath, payload, options = {}) {
    const text = JSON.stringify(payload, null, 2) + '\n';
    return this.writeBuffer(relativePath, Buffer.from(text, 'utf8'), options);
  }

  async headSha() {
    return (await this.git(['rev-parse', 'HEAD'])).stdout.trim();
  }

  async status() {
    await this.ensureReady({ cloneIfMissing: false });
    const [head, branch, changes] = await Promise.all([
      this.headSha(),
      this.git(['branch', '--show-current']),
      this.git(['status', '--porcelain'])
    ]);
    return {
      ready: true,
      branch: branch.stdout.trim(),
      head: head,
      clean: !changes.stdout.trim(),
      auto_pull: this.autoPull,
      auto_push: this.autoPush
    };
  }
}
