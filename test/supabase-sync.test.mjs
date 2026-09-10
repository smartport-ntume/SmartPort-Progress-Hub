import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SupabaseSnapshotPublisher,
  refreshWeeklyBatchMemberNames
} from '../local-server/supabase-sync.mjs';

test('open weekly batches refresh display names without changing their frozen scope', () => {
  const original = {
    report_date: '2026-09-07',
    subtasks: [{ id: 'ST-01', end: '2026-09-20' }],
    team_config: {
      members: [
        { id: 'member-1', name: '舊名字', active: true },
        { id: 'member-2', name: '保留名字', active: true }
      ],
      category_owners: { CTL: 'member-1' }
    }
  };
  const refreshed = refreshWeeklyBatchMemberNames(original, {
    members: [
      { id: 'member-1', name: '新名字' },
      { id: 'member-2', name: '保留名字' }
    ]
  });

  assert.equal(refreshed.team_config.members[0].name, '新名字');
  assert.deepEqual(refreshed.subtasks, original.subtasks);
  assert.deepEqual(refreshed.team_config.category_owners, { CTL: 'member-1' });
  assert.equal(original.team_config.members[0].name, '舊名字');
});

test('snapshot publisher updates only changed names in open weekly batches', async () => {
  const batches = [
    { id: 'batch-1', payload: { team_config: { members: [{ id: 'member-1', name: '舊名字' }] } } },
    { id: 'batch-2', payload: { team_config: { members: [{ id: 'member-1', name: '新名字' }] } } }
  ];
  const updates = [];
  const supabase = {
    from(table) {
      assert.equal(table, 'weekly_report_batches');
      return {
        select(columns) {
          assert.equal(columns, 'id,payload');
          return {
            eq(column, value) {
              assert.deepEqual([column, value], ['status', 'OPEN']);
              return {
                async gte(dateColumn, cutoff) {
                  assert.equal(dateColumn, 'accept_until');
                  assert.equal(cutoff, '2026-09-10T00:00:00.000Z');
                  return { data: batches, error: null };
                }
              };
            }
          };
        },
        update(value) {
          return {
            async eq(column, id) {
              updates.push({ value, column, id });
              return { data: null, error: null };
            }
          };
        }
      };
    }
  };
  const publisher = new SupabaseSnapshotPublisher({
    supabase,
    projectStore: {},
    agentId: 'test-agent',
    loadProposals: async () => ({ proposals: [] }),
    syncWeeklyMemberNames: true
  });

  const result = await publisher.publishWeeklyMemberNames(
    { members: [{ id: 'member-1', name: '新名字' }] },
    new Date('2026-09-10T00:00:00.000Z')
  );
  assert.deepEqual(result, { checked: 2, updated: 1 });
  assert.equal(updates.length, 1);
  assert.equal(updates[0].id, 'batch-1');
  assert.equal(updates[0].value.payload.team_config.members[0].name, '新名字');
});

test('Supabase Guest keeps full project content but not the private team roster', async () => {
  const documents = {
    'project/project.json': {
      name: 'SmartPort', scope: 'Full project scope', target_date: '2026-12-31', methodology: 'V-model'
    },
    'project/work_packages.json': {
      work_packages: [{
        id: 'WP-01', name: 'Control', owner: 'CTL', description: 'Full work-package description',
        evidence: ['design.pdf'], keywords: ['control']
      }]
    },
    'project/subtasks.json': {
      subtasks: [{
        id: 'ST-01', parent_wp: 'WP-01', owner_team: 'CTL', description: 'Full subtask description',
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
    },
    'project/team_config.json': {
      schema_version: '1.0',
      categories: [{ id: 'CTL', name: '控制', color: '#5277bb', active: true, order: 1 }],
      members: [{ id: 'member-1', name: '王小明', active: true }],
      category_owners: { CTL: 'member-1' }
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
  assert.notDeepEqual(guest.payload, member.payload);
  assert.equal(guest.payload.project.scope, 'Full project scope');
  assert.equal(guest.payload.work_packages[0].description, 'Full work-package description');
  assert.equal(guest.payload.subtasks[0].github_issue, 42);
  assert.equal(guest.payload.functional_safety_requirements[0].requirement, 'Complete safety requirement');
  assert.deepEqual(guest.payload.checkpoints[0].review_checks, ['Evidence complete']);
  assert.equal(guest.payload.team_config.categories[0].name, '控制');
  assert.deepEqual(guest.payload.team_config.members, []);
  assert.deepEqual(guest.payload.team_config.category_owners, {});
  assert.equal(member.payload.team_config.members[0].name, '王小明');
  assert.equal(member.payload.team_config.category_owners.CTL, 'member-1');
  assert.deepEqual(result, {
    source_commit: 'abc123',
    generated_at: guest.payload.generated_at,
    work_packages: 1,
    subtasks: 1
  });
});
