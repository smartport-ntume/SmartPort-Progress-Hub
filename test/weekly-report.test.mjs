import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import mammoth from 'mammoth';

async function browserWeeklyModules({ includeDocx = false } = {}) {
  const window = {};
  const context = vm.createContext({
    window, Date, JSON, Map, Set, Intl, Blob, Uint8Array, ArrayBuffer,
    TextEncoder, TextDecoder, setTimeout, clearTimeout, crypto
  });
  const modelCode = await readFile(new URL('../js/weekly-report-model.js', import.meta.url), 'utf8');
  vm.runInContext(modelCode, context);
  if (includeDocx) {
    const vendorCode = await readFile(new URL('../vendor/docx-9.5.1.iife.js', import.meta.url), 'utf8');
    vm.runInContext(vendorCode, context);
    window.docx = context.docx;
    const docxCode = await readFile(new URL('../js/weekly-report-docx.js', import.meta.url), 'utf8');
    vm.runInContext(docxCode, context);
  }
  return window;
}

function fixture() {
  return {
    teamConfig: {
      categories: [
        { id: 'CTL', name: '控制', color: '#5277bb', active: true },
        { id: 'STM', name: '狀態機＋任務', color: '#c37b4a', active: true },
        { id: 'PER', name: '感知', color: '#8a6bb8', active: true }
      ],
      members: [
        { id: 'member-1', name: '黃志峰', active: true, weekly_report_required: true },
        { id: 'member-2', name: '其他成員', active: true, weekly_report_required: true }
      ],
      category_owners: { CTL: 'member-1', STM: 'member-1', PER: 'member-2' }
    },
    workPackages: [
      { id: 'WP-C1', name: 'Basic Motion', owner: 'CTL' },
      { id: 'WP-S1', name: 'Mission Flow', owner: 'STM' }
    ],
    subtasks: [
      { id: 'C1.1', parent_wp: 'WP-C1', name: '閉迴路測試', owner_team: 'CTL', start: '2026-08-01', end: '2026-09-01', actual_progress: 60, status: 'At Risk', expected_evidence: ['測試紀錄'] },
      { id: 'S1.1', parent_wp: 'WP-S1', name: '任務流程整合', owner_team: 'STM', start: '2026-09-01', end: '2026-09-20', actual_progress: 30, status: 'On Track' },
      { id: 'S1.2', parent_wp: 'WP-S1', name: '異常復歸', owner_team: 'STM', start: '2026-09-25', end: '2026-10-09', actual_progress: 0, status: 'Not Updated' },
      { id: 'later', parent_wp: 'WP-C1', name: '超出範圍', owner_team: 'CTL', end: '2026-10-10', actual_progress: 0 },
      { id: 'done', parent_wp: 'WP-C1', name: '已完成', owner_team: 'CTL', end: '2026-09-05', actual_progress: 100 },
      { id: 'other', parent_wp: 'WP-P1', name: '其他人工作', owner_team: 'PER', end: '2026-09-08', actual_progress: 10 }
    ]
  };
}

test('personal weekly scope inherits every category owned by one member', async () => {
  const window = await browserWeeklyModules();
  const model = window.SmartPortWeeklyReport.build({
    ...fixture(),
    memberId: 'member-1',
    reportDate: '2026-09-09'
  });
  assert.deepEqual(Array.from(model.ownerTeams), ['CTL', 'STM']);
  assert.deepEqual(Array.from(model.tasks, item => item.id), ['C1.1', 'S1.1', 'S1.2']);
  assert.deepEqual({ ...model.counts }, { total: 3, overdue: 1, active: 1, upcoming: 1 });
  assert.equal(model.periodStart, '2026-09-03');
  assert.equal(model.cutoffDate, '2026-10-09');
  assert.equal(window.SmartPortWeeklyReport.parseDate('2026-02-30'), null);
});

test('generated personal weekly report is a readable DOCX with scoped task IDs', async () => {
  const window = await browserWeeklyModules({ includeDocx: true });
  const model = window.SmartPortWeeklyReport.build({
    ...fixture(),
    memberId: 'member-1',
    reportDate: '2026-09-09'
  });
  const blob = await window.SmartPortWeeklyDocx.create(model);
  const buffer = Buffer.from(await blob.arrayBuffer());
  assert.ok(buffer.length > 10_000);
  assert.ok(buffer.length < 10 * 1024 * 1024);
  assert.equal(buffer.subarray(0, 2).toString(), 'PK');
  const extracted = await mammoth.extractRawText({ buffer });
  assert.match(extracted.value, /每週個人工作進度報告/);
  assert.match(extracted.value, /黃志峰/);
  assert.match(extracted.value, /C1\.1/);
  assert.match(extracted.value, /S1\.2/);
  assert.doesNotMatch(extracted.value, /其他人工作/);
});
