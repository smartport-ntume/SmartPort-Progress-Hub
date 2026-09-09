import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/index.js';

const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');

function proposal(id, team = 'CTL') {
  return {
    target_type: 'SUBTASK',
    target_id: id,
    progress: 50,
    status: 'On Track',
    blocker: '',
    evidence: `${team} test evidence`,
    summary: `${id} progressed`,
    confidence: 0.8,
    rationale: 'Report evidence supports this update.'
  };
}

test('personal weekly analysis derives categories and required scope from Private Git', async t => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });

  let capturedContext = null;
  const createdIssueBodies = [];
  const workPackages = {
    work_packages: [
      { id: 'WP-C1', name: 'Control', owner: 'CTL' },
      { id: 'WP-S1', name: 'Cross-team parent', owner: 'PER' },
      { id: 'WP-P1', name: 'Perception', owner: 'PER' }
    ]
  };
  const subtasks = {
    subtasks: [
      { id: 'due', parent_wp: 'WP-C1', name: 'Due soon', owner_team: 'CTL', end: '2026-09-19', actual_progress: 10 },
      { id: 'omitted', parent_wp: 'WP-S1', name: 'Omitted by browser', owner_team: 'STM', end: '2026-09-29', actual_progress: 20 },
      { id: 'overdue', parent_wp: 'WP-C1', name: 'Overdue', owner_team: 'CTL', end: '2026-09-01', actual_progress: 40 },
      { id: 'future', parent_wp: 'WP-C1', name: 'Too late', owner_team: 'CTL', end: '2026-10-10', actual_progress: 0 },
      { id: 'done', parent_wp: 'WP-C1', name: 'Finished', owner_team: 'CTL', end: '2026-09-08', actual_progress: 100 },
      { id: 'other', parent_wp: 'WP-P1', name: 'Other member', owner_team: 'PER', end: '2026-09-15', actual_progress: 10 }
    ]
  };
  const teamConfig = {
    schema_version: '1.0',
    categories: [
      { id: 'CTL', name: '控制', color: '#5277bb', active: true },
      { id: 'STM', name: '狀態機＋任務', color: '#c37b4a', active: true },
      { id: 'PER', name: '感知', color: '#8a6bb8', active: true }
    ],
    members: [
      { id: 'member-1', name: '黃志峰', active: true },
      { id: 'member-2', name: '其他成員', active: true }
    ],
    category_owners: { CTL: 'member-1', STM: 'member-1', PER: 'member-2' }
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = String(init.method || (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (url.pathname.endsWith('/contents/weekly_reports/2026/report.docx')) {
      return Response.json({ name: 'report.docx', content: Buffer.from('weekly report').toString('base64') });
    }
    if (url.pathname.endsWith('/contents/project/work_packages.json')) {
      return Response.json({ sha: 'wp-sha', content: encoded(workPackages) });
    }
    if (url.pathname.endsWith('/contents/project/subtasks.json')) {
      return Response.json({ sha: 'sub-sha', content: encoded(subtasks) });
    }
    if (url.pathname.endsWith('/contents/project/team_config.json')) {
      return Response.json({ sha: 'team-sha', content: encoded(teamConfig) });
    }
    if (url.pathname.endsWith('/issues') && method === 'GET') return Response.json([]);
    if (url.pathname.endsWith('/issues') && method === 'POST') {
      const requestBody = JSON.parse(String(init.body || '{}'));
      createdIssueBodies.push(requestBody.body);
      return Response.json({
        number: createdIssueBodies.length,
        title: requestBody.title,
        body: requestBody.body,
        state: 'open',
        html_url: `https://github.example/issues/${createdIssueBodies.length}`,
        user: { login: 'vincent' },
        created_at: '2026-09-09T00:00:00Z',
        updated_at: '2026-09-09T00:00:00Z'
      }, { status: 201 });
    }
    throw new Error(`Unexpected GitHub request: ${method} ${url.pathname}${url.search}`);
  };

  const env = {
    PROJECT_REPO: 'example/private-project',
    INTERNAL_AGENT_BEARER: 'internal-secret',
    LOCAL_GITHUB_TOKEN: 'github-token',
    LOCAL_CODEX_RUNNER: async ({ context }) => {
      capturedContext = context;
      return {
        report_summary: 'Reviewed',
        review: {
          overall_assessment: 'Needs evidence.',
          completeness_score: 70,
          evidence_score: 60,
          schedule_alignment_score: 80,
          strengths: [],
          missing_items: ['Add links'],
          actions: ['Update evidence']
        },
        warnings: [],
        proposals: [proposal('due'), proposal('omitted', 'STM'), proposal('future'), proposal('other', 'PER')]
      };
    }
  };
  const response = await app.fetch(new Request('https://backend.example/api/reports/analyze', {
    method: 'POST',
    headers: {
      Authorization: 'Bearer internal-secret',
      'Content-Type': 'application/json',
      'X-SmartPort-Actor': 'vincent'
    },
    body: JSON.stringify({
      report_date: '2026-09-09',
      owner_team: 'PER',
      owner_teams: ['PER'],
      member_id: 'member-1',
      member_name: 'Spoofed Name',
      scope_subtask_ids: ['due', 'future', 'other'],
      report_path: 'weekly_reports/2026/report.docx'
    })
  }), env, {});

  assert.equal(response.status, 200);
  const result = await response.json();
  assert.deepEqual(capturedContext.owner_teams, ['CTL', 'STM']);
  assert.deepEqual(capturedContext.required_scope_subtask_ids, ['due', 'omitted', 'overdue']);
  assert.deepEqual(capturedContext.work_packages.map(item => item.id), ['WP-C1', 'WP-S1']);
  assert.deepEqual(capturedContext.subtasks.map(item => item.id), ['due', 'omitted', 'overdue']);
  assert.equal(result.report.member_name, '黃志峰');
  assert.deepEqual(result.report.owner_teams, ['CTL', 'STM']);
  assert.deepEqual(result.proposals.map(item => item.target_id), ['due', 'omitted']);
  assert.equal(createdIssueBodies.length, 2);
  assert.ok(result.analysis.warnings.some(item => item.includes('Required scope restored from Private Git')));
  assert.ok(result.analysis.warnings.some(item => item.includes('future')));
  assert.ok(result.analysis.warnings.some(item => item.includes('outside this member')));
});
