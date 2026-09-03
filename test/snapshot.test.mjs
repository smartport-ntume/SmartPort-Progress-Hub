import test from 'node:test';
import assert from 'node:assert/strict';
import { sanitizeSnapshot } from '../local-server/snapshot.mjs';

test('sanitizeSnapshot exposes only fixed allowlisted fields', () => {
  const snapshot = sanitizeSnapshot({
    project: { name: 'SmartPort', phase: 'Build', internal_notes: 'secret', title: { nested_secret: 'private' } },
    workPackages: [{
      id: 'WP-01', name: 'Control', owner: 'CTL', actual_progress: 20,
      description: 'private detail', blocker: 'private blocker', password: 'never', ifs: ['IF-01', { private: 'hidden' }]
    }],
    subtasks: [{
      id: 'ST-01', parent_wp: 'WP-01', owner_team: 'CTL', status: 'On Track',
      evidence: 'private evidence', last_week: 'private update'
    }],
    fsrs: [{ id: 'FSR-01', maturity: 'M1', requirement: 'private requirement text' }],
    checkpoints: [{
      id: 'CP-01', date: '2026-12-31',
      criteria: [['WP-01', 80], { private: 'hidden' }, ['WP-02', { private: 'hidden' }]],
      pm_comment: 'private'
    }],
    sourceCommit: 'abc123'
  });

  assert.equal(snapshot.project.internal_notes, undefined);
  assert.equal(snapshot.project.title, undefined);
  assert.equal(snapshot.work_packages[0].description, undefined);
  assert.equal(snapshot.work_packages[0].blocker, undefined);
  assert.deepEqual(snapshot.work_packages[0].ifs, ['IF-01']);
  assert.equal(snapshot.subtasks[0].evidence, undefined);
  assert.equal(snapshot.subtasks[0].last_week, undefined);
  assert.equal(snapshot.functional_safety_requirements[0].requirement, undefined);
  assert.equal(snapshot.checkpoints[0].pm_comment, undefined);
  assert.deepEqual(snapshot.checkpoints[0].criteria, [['WP-01', 80]]);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
  assert.equal(snapshot.source_commit, 'abc123');
});
