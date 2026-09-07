import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { runCommand } from '../local-server/command.mjs';
import {
  GitConflictError,
  GitRepositoryStore,
  safeRepositoryPath
} from '../local-server/git-store.mjs';

async function git(cwd, args) {
  return runCommand('git', ['-C', cwd, ...args]);
}

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-git-store-'));
  const remote = path.join(base, 'remote.git');
  const seed = path.join(base, 'seed');
  const managed = path.join(base, 'managed');
  t.after(() => fs.rm(base, { recursive: true, force: true }));

  await runCommand('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runCommand('git', ['init', '--initial-branch=main', seed]);
  await fs.mkdir(path.join(seed, 'project'), { recursive: true });
  await fs.writeFile(path.join(seed, 'project', 'sample.json'), '{"version":1}\n');
  await git(seed, ['add', '.']);
  await git(seed, ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'seed']);
  await git(seed, ['remote', 'add', 'origin', remote]);
  await git(seed, ['push', '-u', 'origin', 'main']);

  const store = new GitRepositoryStore({
    repoPath: managed,
    repoUrl: remote,
    branch: 'main',
    fullName: 'example/private-project',
    autoPull: true,
    autoPush: true,
    pullIntervalMs: 1
  });
  await store.ensureReady();
  return { remote, managed, store };
}

test('safeRepositoryPath accepts files and rejects traversal', () => {
  assert.equal(safeRepositoryPath('project/work_packages.json'), 'project/work_packages.json');
  for (const value of ['', '../secret', 'project/../secret', '/../../secret', 'project//file', '.git/config', 'file:stream']) {
    assert.throws(() => safeRepositoryPath(value), /invalid_repository_path/);
  }
});

test('GitRepositoryStore commits and pushes one validated file', async t => {
  const { remote, store } = await fixture(t);
  const expectedSha = await store.blobSha('project/sample.json');
  const result = await store.writeJson('project/sample.json', { version: 2 }, {
    expectedSha,
    message: 'Update project sample'
  });

  assert.equal(result.changed, true);
  assert.match(result.commitSha, /^[0-9a-f]{40}$/);
  const remoteFile = await runCommand('git', [
    '--git-dir', remote, 'show', 'main:project/sample.json'
  ]);
  assert.deepEqual(JSON.parse(remoteFile.stdout), { version: 2 });

  const unchanged = await store.writeJson('project/sample.json', { version: 2 }, {
    expectedSha: result.sha
  });
  assert.equal(unchanged.changed, false);
});

test('GitRepositoryStore refuses stale writes', async t => {
  const { store } = await fixture(t);
  await assert.rejects(
    store.writeJson('project/sample.json', { version: 3 }, {
      expectedSha: '0000000000000000000000000000000000000000'
    }),
    error => error instanceof GitConflictError && error.status === 409
  );
});

test('GitRepositoryStore never follows a repository symlink outside its clone', async t => {
  const { managed, store } = await fixture(t);
  const outside = path.join(path.dirname(managed), 'outside-secret.json');
  await fs.writeFile(outside, '{"secret":true}\n');
  try {
    await fs.symlink(outside, path.join(managed, 'project', 'escape.json'));
  } catch (error) {
    if (['EPERM', 'EACCES'].includes(error.code)) return;
    throw error;
  }
  await assert.rejects(
    store.readBuffer('project/escape.json', { refresh: false }),
    /repository_symlink_files_are_not_allowed/
  );
});
