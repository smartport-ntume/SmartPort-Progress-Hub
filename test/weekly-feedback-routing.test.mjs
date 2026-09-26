import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { assignTaskFeedback } from '../worker/src/weekly-feedback.js';

const context = {
  team_config: { category_owners: { STM: 'm1', CTL: 'm2' } },
  work_packages: [{ id: 'WP-S1', owner: 'STM', name: '任務與狀態整合' }, { id: 'WP-C1', owner: 'CTL', name: '路徑追蹤控制' }],
  subtasks: [
    ...['S1.1', 'S1.2', 'S1.4', 'S1.10'].map((id, i) => ({ id, owner_team: 'STM', parent_wp: 'WP-S1', name: ['任務介面整合', '定位驗證資料', '停止狀態驗證', '異常復歸驗證'][i] })),
    { id: 'C1.1', owner_team: 'CTL', parent_wp: 'WP-C1', name: '轉向補償測試' }
  ]
};
const general = (missing_items, actions = []) => [{ target_type: 'GENERAL', target_id: '', missing_items, actions }];
const find = (items, id) => items.find(item => item.target_id === id);

test('old GENERAL feedback splits into the named tasks and common advice stays report-wide', () => {
  const source = general(['S1.1：請補介面版本與測試紀錄', 'S1.2：請補座標框架與單位', 'S1.4：請補停止距離', '統一填報日期及報告期間'],
    ['S1.1：完成測試後整理日誌', '確認 S1.1、S1.2、S1.4 的共同 CP1 交付關係']);
  const original = structuredClone(source);
  const result = assignTaskFeedback(source, context, 'm1');
  assert.equal(result.length, 5);
  assert.deepEqual(find(result, 'S1.1').actions, ['S1.1：完成測試後整理日誌']);
  assert.deepEqual(find(result, 'S1.2').missing_items, ['S1.2：請補座標框架與單位']);
  assert.equal(find(result, 'WP-S1').target_type, 'WP');
  assert.deepEqual(find(result, '').missing_items, ['統一填報日期及報告期間']);
  assert.deepEqual(source, original);
  assert.deepEqual(assignTaskFeedback(result, context, 'm1'), result);
});

test('task headings win over dependency mentions and IDs never match partial IDs or another owner', () => {
  const result = assignTaskFeedback(general(['S1.1：補上與 S1.2 的介面測試', 'S1.10：補復歸證據', 'C1.1：配合 S1.1 測試', 'XS1.1：不是工作 ID']), context, 'm1');
  assert.equal(find(result, 'S1.1').missing_items.length, 1);
  assert.deepEqual(find(result, 'S1.10').missing_items, ['S1.10：補復歸證據']);
  assert.equal(find(result, 'S1.2'), undefined);
  assert.equal(find(result, 'C1.1'), undefined);
  assert.equal(find(result, '').missing_items.length, 2);
});

test('unique full work names map automatically while explicit historical targets and cleared feedback survive', () => {
  const result = assignTaskFeedback([
    ...general(['請補停止狀態驗證的測試影片']),
    { target_type: 'WP', target_id: 'WP-archived', missing_items: [], actions: ['保留已歸檔工作的追蹤事項'] }
  ], context, 'm1');
  assert.equal(find(result, 'S1.4').missing_items.length, 1);
  assert.equal(find(result, 'WP-archived').actions.length, 1);
  assert.deepEqual(assignTaskFeedback([], context, 'm1'), []);
});

test('a legacy multiline paragraph separates task headings and keeps each heading with its explanation', () => {
  const result = assignTaskFeedback(general(['S1.1：補測試紀錄\n包含介面版本與執行日期\nS1.2：補回歸測試\n包含單位與座標框架']), context, 'm1');
  assert.deepEqual(result.map(item => item.target_id), ['S1.1', 'S1.2']);
  assert.equal(find(result, 'S1.1').missing_items[0], 'S1.1：補測試紀錄\n包含介面版本與執行日期');
  assert.deepEqual(assignTaskFeedback(result, context, 'm1'), result);
});

test('browser and Agent use identical grouping and merged cards respect storage line limits', async () => {
  const source = [...general(Array.from({ length: 40 }, (_, i) => `S1.1：第一批證據 ${i}`)),
    ...general(Array.from({ length: 35 }, (_, i) => `S1.1：第二批證據 ${i}`))];
  const result = assignTaskFeedback(source, context, 'm1');
  assert.deepEqual(result.map(item => item.missing_items.length), [50, 25]);
  const window = {};
  vm.runInNewContext(await readFile(new URL('../js/weekly-feedback-routing.js', import.meta.url), 'utf8'), { window });
  assert.deepEqual(JSON.parse(JSON.stringify(window.SmartPortWeeklyFeedback.assign(source, context, 'm1'))), result);
});
