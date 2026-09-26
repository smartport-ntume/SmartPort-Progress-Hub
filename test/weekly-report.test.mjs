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
  const feedbackCode = await readFile(new URL('../js/weekly-feedback-routing.js', import.meta.url), 'utf8');
  vm.runInContext(feedbackCode, context);
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
    checkpoints: [
      { id: 'CP0', date: '2026-09-07', name: 'Baseline' },
      { id: 'CP1', date: '2026-10-01', name: 'Basic Motion' },
      { id: 'CP2', date: '2026-11-01', name: 'Dynamic Safety' }
    ],
    checkpointReferences: [
      {
        checkpoint: 'CP1',
        level: 'ACL-1',
        capability: '• 可執行直行、定速與基本路徑追蹤',
        review_checks: '• 驗證 speed / steering tracking\n• 確認 E-stop 可進入停止鏈'
      }
    ],
    subtasks: [
      { id: 'C1.1', parent_wp: 'WP-C1', name: '閉迴路測試', owner_team: 'CTL', start: '2026-08-01', end: '2026-09-01', actual_progress: 60, status: 'At Risk', expected_evidence: ['測試紀錄'] },
      { id: 'S1.1', parent_wp: 'WP-S1', name: '任務流程整合', owner_team: 'STM', start: '2026-09-01', end: '2026-09-20', actual_progress: 30, status: 'On Track' },
      { id: 'S1.2', parent_wp: 'WP-S1', name: '異常復歸', owner_team: 'STM', start: '2026-09-25', end: '2026-10-09', target_cp: 'CP1', actual_progress: 0, status: 'Not Updated' },
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
  assert.deepEqual({ ...model.counts }, { total: 3, overdue: 1, active: 1, upcoming: 1, dueByCheckpoint: 2 });
  assert.equal(model.periodStart, '2026-09-03');
  assert.deepEqual({ ...model.nextCheckpoint }, {
    id: 'CP1', date: '2026-10-01', dateDisplay: '2026/10/01', daysRemaining: 22, name: 'Basic Motion', acl: 'ACL-1',
    capability: '• 可執行直行、定速與基本路徑追蹤',
    reviewChecks: '• 驗證 speed / steering tracking\n• 確認 E-stop 可進入停止鏈'
  });
  assert.equal(model.cutoffDate, '2026-10-01');
  assert.equal(window.SmartPortWeeklyReport.nextCheckpointOf(fixture().checkpoints, '2026-10-01').id, 'CP2');
  assert.equal(window.SmartPortWeeklyReport.parseDate('2026-02-30'), null);
});

test('without a future checkpoint, personal weekly scope contains overdue work only', async () => {
  const window = await browserWeeklyModules({ includeDocx: true });
  const data = fixture();
  const model = window.SmartPortWeeklyReport.build({
    ...data,
    checkpoints: [{ id: 'CP0', date: '2026-09-01' }],
    subtasks: [
      { id: 'overdue', owner_team: 'CTL', end: '2026-09-08', actual_progress: 20 },
      { id: 'future', owner_team: 'CTL', end: '2026-09-20', actual_progress: 0 }
    ],
    memberId: 'member-1',
    reportDate: '2026-09-09'
  });
  assert.equal(model.nextCheckpoint, null);
  assert.deepEqual(Array.from(model.tasks, item => item.id), ['overdue']);
  const blob = await window.SmartPortWeeklyDocx.create(model);
  const extracted = await mammoth.extractRawText({ buffer: Buffer.from(await blob.arrayBuffer()) });
  assert.match(extracted.value, /後續 CP/);
  assert.match(extracted.value, /僅追蹤逾期未完成項目/);
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
  assert.match(extracted.value, /下一個檢核點預覽/);
  assert.match(extracted.value, /CP1　Basic Motion/);
  assert.match(extracted.value, /倒數 22 天/);
  assert.match(extracted.value, /車輛能力 \/\s*Capability/);
  assert.match(extracted.value, /可執行直行、定速與基本路徑追蹤/);
  assert.match(extracted.value, /Review \/ Check/);
  assert.match(extracted.value, /確認 E-stop 可進入停止鏈/);
  assert.match(extracted.value, /逾期未完成 1 項/);
  assert.match(extracted.value, /黃志峰/);
  assert.match(extracted.value, /C1\.1/);
  assert.match(extracted.value, /S1\.2/);
  assert.doesNotMatch(extracted.value, /其他人工作/);
});

test('Word places edited feedback inside the matching task and retains completed and standalone WP follow-ups',async()=>{
  const window=await browserWeeklyModules({includeDocx:true});
  const items=[
    {target_type:'SUBTASK',target_id:'S1.1',missing_items:['S1.1 補齊狀態轉移測試'],actions:['S1.1 下週驗證復歸']},
    {target_type:'WP',target_id:'WP-C1',missing_items:['WP-C1 補測試影片'],actions:[]},
    {target_type:'SUBTASK',target_id:'done',missing_items:['已完成工作仍需佐證'],actions:[]},
    {target_type:'WP',target_id:'WP-closed',missing_items:[],actions:['独立 WP 補結案文件']},
    {target_type:'GENERAL',target_id:'',missing_items:['整體摘要補日期'],actions:[]}
  ];
  const data=fixture();
  const model=window.SmartPortWeeklyReport.build({...data,memberId:'member-1',reportDate:'2026-09-09',
    previousReview:{week_key:'2026-W36',members:[{member_id:'member-1',revision:2,review_status:'APPROVED',pm_feedback:'PM 回饋原文',task_feedback:items}]}});
  assert.equal(model.tasks.find(task=>task.id==='done').scope,'FOLLOWUP');
  assert.equal(model.tasks.find(task=>task.id==='S1.1').reviewFeedback[0].missing_items[0],items[0].missing_items[0]);
  assert.equal(model.tasks.flatMap(task=>task.reviewFeedback).filter(item=>item.target_id==='WP-C1').length,1);
  assert.equal(model.followupFeedback[0].target_id,'WP-closed');
  const blob=await window.SmartPortWeeklyDocx.create(model);
  const text=(await mammoth.extractRawText({buffer:Buffer.from(await blob.arrayBuffer())})).value;
  for(const item of items)for(const line of [...item.missing_items,...item.actions])assert.ok(text.includes(line),line);
  assert.ok(text.includes('PM 回饋原文'));
  const taskStart=text.indexOf('S1.1　任務流程整合'),feedbackAt=text.indexOf('S1.1 補齊狀態轉移測試');
  assert.ok(taskStart<feedbackAt&&feedbackAt<text.indexOf('本週實際工作與成果',taskStart),'feedback is inside the matching fill-in task');
  assert.equal(text.split('WP-C1 補測試影片').length,2,'WP advice is not repeated for every child');
});

test('Word routes legacy mixed feedback into task fill-in sections without PM target selection',async()=>{
  const window=await browserWeeklyModules({includeDocx:true});
  const model=window.SmartPortWeeklyReport.build({...fixture(),memberId:'member-1',reportDate:'2026-09-09',
    previousReview:{week_key:'2026-W36',members:[{member_id:'member-1',review_status:'APPROVED',pm_feedback:'PM 整體回饋',
      task_feedback:[{target_type:'GENERAL',target_id:'',missing_items:['S1.1：請補介面測試','S1.2：請補異常復歸紀錄'],actions:['統一填報日期']}]}]}});
  assert.equal(model.tasks.find(task=>task.id==='S1.1').reviewFeedback[0].target_id,'S1.1');
  assert.equal(model.tasks.find(task=>task.id==='S1.2').reviewFeedback[0].target_id,'S1.2');
  assert.equal(model.previousReview.generalFeedback.length,1);
  const blob=await window.SmartPortWeeklyDocx.create(model);
  const text=(await mammoth.extractRawText({buffer:Buffer.from(await blob.arrayBuffer())})).value;
  assert.ok(text.indexOf('S1.1　任務流程整合')<text.indexOf('S1.1：請補介面測試'));
  assert.ok(text.indexOf('S1.2　異常復歸')<text.indexOf('S1.2：請補異常復歸紀錄'));
  assert.equal(text.split('S1.1：請補介面測試').length,2);
});
