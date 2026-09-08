import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import {
  defaultTeamConfig,
  guestTeamConfig,
  normalizeTeamConfig,
  validateTeamConfig
} from '../worker/src/team-config.js';

test('team configuration starts with four requested groups and preserves referenced legacy groups', () => {
  const defaults = defaultTeamConfig();
  assert.deepEqual(defaults.categories.map(item => item.id), ['CTL', 'LOC/NAV', 'PER', 'STM']);

  const normalized = normalizeTeamConfig(null, { referencedCategoryIds: ['CTL', 'VERIFY'] });
  assert.deepEqual(normalized.categories.map(item => item.id), ['CTL', 'LOC/NAV', 'PER', 'STM', 'VERIFY']);
  assert.equal(normalized.categories.find(item => item.id === 'VERIFY').name, '驗證');
});

test('team configuration enforces one same-category owner per known Subtask', () => {
  const workPackages = [{ id: 'WP-C1', owner: 'CTL' }];
  const subtasks = [{ id: 'C1.1', parent_wp: 'WP-C1', owner_team: 'CTL' }];
  const valid = {
    schema_version: '1.0',
    categories: [{ id: 'CTL', name: '控制', color: '#5277bb', active: true, order: 1 }],
    members: [{ id: 'member-1', name: '王小明', category_id: 'CTL', active: true, weekly_report_required: true }],
    assignments: { 'C1.1': 'member-1' }
  };
  assert.equal(validateTeamConfig(valid, { workPackages, subtasks }).assignments['C1.1'], 'member-1');

  const wrongCategory = structuredClone(valid);
  wrongCategory.categories.push({ id: 'PER', name: '感知', color: '#8a6bb8', active: true, order: 2 });
  wrongCategory.members[0].category_id = 'PER';
  assert.throws(
    () => validateTeamConfig(wrongCategory, { workPackages, subtasks }),
    /assignment_category_mismatch:C1\.1/
  );

  const unknownTask = structuredClone(valid);
  unknownTask.assignments['C9.9'] = 'member-1';
  assert.throws(
    () => validateTeamConfig(unknownTask, { workPackages, subtasks }),
    /unknown_assignment_subtask:C9\.9/
  );
});

test('Guest team configuration keeps category labels but removes the private roster', () => {
  const full = {
    categories: [{ id: 'CTL', name: '控制', color: '#5277bb' }],
    members: [{ id: 'member-1', name: '王小明', category_id: 'CTL' }],
    assignments: { 'C1.1': 'member-1' }
  };
  const guest = guestTeamConfig(full, { referencedCategoryIds: ['CTL'] });
  assert.equal(guest.categories[0].name, '控制');
  assert.deepEqual(guest.members, []);
  assert.deepEqual(guest.assignments, {});
  assert.equal(JSON.stringify(guest).includes('王小明'), false);
});

test('browser report scope includes only assigned unfinished work due by next month', async () => {
  const code = await readFile(new URL('../js/team-config.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(code, { window, Date, JSON, Set, Map });
  const config = {
    assignments: {
      overdue: 'member-1',
      due: 'member-1',
      later: 'member-1',
      done: 'member-1',
      other: 'member-2'
    }
  };
  const subtasks = [
    { id: 'overdue', end: '2026-09-01', actual_progress: 60 },
    { id: 'due', end: '2026-10-07', actual_progress: 0 },
    { id: 'later', end: '2026-10-08', actual_progress: 20 },
    { id: 'done', end: '2026-09-03', actual_progress: 100 },
    { id: 'other', end: '2026-09-04', actual_progress: 10 }
  ];
  const scope = window.SmartPortTeam.reportScope(
    config,
    subtasks,
    'member-1',
    new Date('2026-09-07T12:00:00Z')
  );
  assert.deepEqual(Array.from(scope, item => item.id), ['overdue', 'due']);
});
