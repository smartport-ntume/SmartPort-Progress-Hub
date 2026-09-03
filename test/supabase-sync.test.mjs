import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseSnapshotPublisher } from '../local-server/supabase-sync.mjs';

test('Supabase Guest project snapshot matches the full Member snapshot', async () => {
  const documents = {
    'project/project.json': {
      name: 'SmartPort', scope: 'Full project scope', target_date: '2026-12-31', methodology: 'V-model'
    },
    'project/work_packages.json': {
      work_packages: [{
        id: 'WP-01', name: 'Control', description: 'Full work-package description',
        evidence: ['design.pdf'], keywords: ['control']
      }]
    },
    'project/subtasks.json': {
      subtasks: [{
        id: 'ST-01', parent_wp: 'WP-01', description: 'Full subtask description',
        expected_evidence: ['test-report.pdf'], blockers: ['hardware'],
        pm_comments: ['reviewed'], github_issue: 42
      }]
    },
    'safety/fsr.json': {
      functional_safety_requirements: [{ id: 'FSR-01', requirement: 'Complete safety requirement' }]
    },
    'project/checkpoints.json': {
      checkpoints: [{
        id: 'CP-01', fsr_targets: ['FSR-01'], review_checks: ['Evidence complete']
      }]
    }
  };
  const projectStore = {
    async refreshForRead() {},
    async readJson(path) { return structuredClone(documents[path]); },
    async headSha() { return 'abc123'; }
  };
  let publishedRows;
  const supabase = {
    from(table) {
      assert.equal(table, 'project_snapshots');
      return {
        async upsert(rows, options) {
          publishedRows = rows;
          assert.deepEqual(options, { onConflict: 'audience' });
          return { data: rows, error: null };
        }
      };
    }
  };
  const publisher = new SupabaseSnapshotPublisher({
    supabase,
    projectStore,
    agentId: 'test-agent',
    loadProposals: async () => ({ proposals: [] })
  });

  const result = await publisher.publishProject();
  const member = publishedRows.find(row => row.audience === 'MEMBER');
  const guest = publishedRows.find(row => row.audience === 'GUEST');

  assert.equal(publishedRows.length, 2);
  assert.deepEqual(guest.payload, member.payload);
  assert.equal(guest.payload.project.scope, 'Full project scope');
  assert.equal(guest.payload.work_packages[0].description, 'Full work-package description');
  assert.equal(guest.payload.subtasks[0].github_issue, 42);
  assert.equal(guest.payload.functional_safety_requirements[0].requirement, 'Complete safety requirement');
  assert.deepEqual(guest.payload.checkpoints[0].review_checks, ['Evidence complete']);
  assert.deepEqual(result, {
    source_commit: 'abc123',
    generated_at: guest.payload.generated_at,
    work_packages: 1,
    subtasks: 1
  });
});
