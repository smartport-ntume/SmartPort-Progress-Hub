import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import app from '../worker/src/public.js';
import { runCommand } from '../local-server/command.mjs';
import { GitRepositoryStore } from '../local-server/git-store.mjs';
import { createLocalGitHubFetch, LOCAL_WRITE_TOKEN } from '../local-server/github-local-fetch.mjs';
import { GatewayJobHandler } from '../local-server/gateway-job-handler.mjs';
import { SupabaseSnapshotPublisher } from '../local-server/supabase-sync.mjs';

test('CP job writes both Git documents and publishes the same date for members and guests', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-checkpoint-roundtrip-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git'), seed = path.join(root, 'seed');
  await runCommand('git', ['init', '--bare', '--initial-branch=main', remote]);
  await runCommand('git', ['init', '--initial-branch=main', seed]);
  const documents = {
    'project/project.json': { name: 'Test project' },
    'project/work_packages.json': { work_packages: [] },
    'project/subtasks.json': { subtasks: [] },
    'safety/fsr.json': { functional_safety_requirements: [] },
    'project/checkpoints.json': { checkpoints: [{ id: 'CP1', date: '2026-10-11', acl: 'ACL-1' }] },
    'project/reference_model.json': { acl_levels: [{ checkpoint: 'CP1', date: '10/11', level: 'ACL-1' }] },
    'project/item_functions.json': {}
  };
  for (const name of ['ctl','loc','nav_a','nav_b','per','per_b','stm_a','stm_b','interfaces','odd_allocation','traceability']) {
    documents[`project/technical_requirements/${name}.json`] = {};
  }
  for (const [file, value] of Object.entries(documents)) {
    await fs.mkdir(path.dirname(path.join(seed, file)), { recursive: true });
    await fs.writeFile(path.join(seed, file), JSON.stringify(value));
  }
  await runCommand('git', ['-C',seed,'add','.']);
  await runCommand('git', ['-C',seed,'-c','user.name=Test','-c','user.email=test@example.com','commit','-m','fixture']);
  await runCommand('git', ['-C',seed,'remote','add','origin',remote]);
  await runCommand('git', ['-C',seed,'push','-u','origin','main']);
  const store = new GitRepositoryStore({ repoPath: path.join(root,'managed'), repoUrl: remote,
    fullName: 'example/private-project', branch: 'main', autoPull: true, autoPush: true });
  await store.ensureReady();
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  globalThis.fetch = createLocalGitHubFetch({ store, nativeFetch: async () => { throw new Error('Unexpected external request'); } });
  const env = { PROJECT_REPO: store.fullName, INTERNAL_AGENT_BEARER: 'test-agent', LOCAL_GITHUB_TOKEN: LOCAL_WRITE_TOKEN };
  const handler = new GatewayJobHandler({ app, env, internalBearer: env.INTERNAL_AGENT_BEARER, supabase: {} });
  const patch = { date: '2026-10-25', acl: 'ACL-1', name: 'Motion', capability: 'New capability',
    review_checks: 'New checks', fsrTarget: 'M2', criteria: [], fsr_targets: [] };
  const result = await handler.handle({ kind: 'patch_checkpoint', actor_login: 'pm', payload: { id: 'CP1', patch } });
  const readRemote = async file => JSON.parse((await runCommand('git', ['--git-dir',remote,'show',`main:${file}`])).stdout);
  assert.equal((await readRemote('project/checkpoints.json')).checkpoints[0].date, '2026-10-25');
  assert.equal((await readRemote('project/reference_model.json')).acl_levels[0].date, '10/25');
  assert.deepEqual(result.checkpoint, { id: 'CP1', ...patch });
  assert.equal(result.reference.review_checks, 'New checks');

  const rows = new Map(); let failReference = true;
  const publisher = new SupabaseSnapshotPublisher({ projectStore: store, agentId: 'test',
    loadProposals: async () => { assert.fail('CP sync must not load proposals'); },
    supabase: { from(table) { return { async upsert(value) {
      if (table === 'reference_snapshots' && failReference) return { error: { message: 'reference unavailable' } };
      rows.set(table, structuredClone(value)); return { data: value };
    } }; } }
  });
  await assert.rejects(publisher.publishAfterJob('patch_checkpoint'), /reference unavailable/);
  const commit = await store.headSha();
  failReference = false;
  await handler.handle({ kind: 'refresh_snapshots', actor_login: 'pm', payload: { scope: 'checkpoints' } });
  await publisher.publishAfterJob('refresh_snapshots', { scope: 'checkpoints' });
  assert.equal(await store.headSha(), commit, 'snapshot retry must not create another Git commit');
  for (const audience of ['MEMBER','GUEST']) {
    const project = rows.get('project_snapshots').find(row => row.audience === audience);
    const reference = rows.get('reference_snapshots').find(row => row.audience === audience);
    assert.equal(project.payload.checkpoints[0].date, '2026-10-25');
    assert.equal(reference.payload.reference.acl_levels[0].date, '10/25');
    assert.equal(project.source_commit, commit);
    assert.equal(reference.source_commit, commit);
  }
});
