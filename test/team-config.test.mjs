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

test('one category owner is inherited by every Subtask in that category', () => {
  const workPackages = [{ id: 'WP-C1', owner: 'CTL' }];
  const subtasks = [
    { id: 'C1.1', parent_wp: 'WP-C1', owner_team: 'CTL' },
    { id: 'C1.2', parent_wp: 'WP-C1', owner_team: 'CTL' }
  ];
  const valid = {
    schema_version: '1.0',
    categories: [{ id: 'CTL', name: '控制', color: '#5277bb', active: true, order: 1 }],
    members: [{ id: 'member-1', name: '王小明', active: true, weekly_report_required: true }],
    category_owners: { CTL: 'member-1' }
  };
  const normalized = validateTeamConfig(valid, { workPackages, subtasks });
  assert.equal(normalized.category_owners.CTL, 'member-1');

  const inactiveOwner = structuredClone(valid);
  inactiveOwner.members[0].active = false;
  assert.throws(
    () => validateTeamConfig(inactiveOwner, { workPackages, subtasks }),
    /inactive_team_owner_member:member-1/
  );

  const unknownCategory = structuredClone(valid);
  unknownCategory.category_owners.PER = 'member-1';
  assert.throws(
    () => validateTeamConfig(unknownCategory, { workPackages, subtasks }),
    /unknown_team_owner_category:PER/
  );
});

test('a member may own multiple categories', () => {
  const value = {
    categories: [
      { id: 'CTL', name: '控制' },
      { id: 'STM', name: '狀態機＋任務' }
    ],
    members: [{ id: 'member-1', name: '王小明', active: true }],
    category_owners: { CTL: 'member-1', STM: 'member-1' }
  };
  const normalized = validateTeamConfig(value, {
    workPackages: [{ owner: 'CTL' }, { owner: 'STM' }],
    subtasks: []
  });
  assert.deepEqual(normalized.category_owners, { CTL: 'member-1', STM: 'member-1' });
});

test('first preview assignments migrate to category owners without re-entry', () => {
  const legacy = {
    categories: [{ id: 'CTL', name: '控制' }],
    members: [{ id: 'member-1', name: '王小明', category_id: 'CTL' }],
    assignments: { 'C1.1': 'member-1' }
  };
  const normalized = normalizeTeamConfig(legacy, {
    referencedCategoryIds: ['CTL'],
    subtasks: [{ id: 'C1.1', owner_team: 'CTL' }]
  });
  assert.equal(normalized.category_owners.CTL, 'member-1');
  assert.equal('assignments' in normalized, false);
  assert.equal('category_id' in normalized.members[0], false);
});

test('Guest team configuration keeps category labels but removes the private roster', () => {
  const full = {
    categories: [{ id: 'CTL', name: '控制', color: '#5277bb' }],
    members: [{ id: 'member-1', name: '王小明' }],
    category_owners: { CTL: 'member-1' }
  };
  const guest = guestTeamConfig(full, { referencedCategoryIds: ['CTL'] });
  assert.equal(guest.categories[0].name, '控制');
  assert.deepEqual(guest.members, []);
  assert.deepEqual(guest.category_owners, {});
  assert.equal(JSON.stringify(guest).includes('王小明'), false);
});

test('browser report scope inherits category owner and includes unfinished work due by next month', async () => {
  const code = await readFile(new URL('../js/team-config.js', import.meta.url), 'utf8');
  const window = {};
  vm.runInNewContext(code, { window, Date, JSON, Set, Map });
  const config = {
    category_owners: { CTL: 'member-1', STM: 'member-1', PER: 'member-2' }
  };
  const subtasks = [
    { id: 'overdue', owner_team: 'CTL', end: '2026-09-01', actual_progress: 60 },
    { id: 'due', owner_team: 'STM', end: '2026-10-07', actual_progress: 0 },
    { id: 'later', owner_team: 'CTL', end: '2026-10-08', actual_progress: 20 },
    { id: 'done', owner_team: 'CTL', end: '2026-09-03', actual_progress: 100 },
    { id: 'other', owner_team: 'PER', end: '2026-09-04', actual_progress: 10 }
  ];
  const scope = window.SmartPortTeam.reportScope(
    config,
    subtasks,
    'member-1',
    new Date('2026-09-07T12:00:00Z')
  );
  assert.deepEqual(Array.from(scope, item => item.id), ['overdue', 'due']);
});
