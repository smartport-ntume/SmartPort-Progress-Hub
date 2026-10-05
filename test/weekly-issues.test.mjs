import test from 'node:test';
import assert from 'node:assert/strict';
import { extractWeeklyIssues, normalizeWeeklyIssues } from '../worker/src/weekly-issues.js';

const heading = '5　跨任務問題與決策需求　ISSUES AND DECISIONS';
const report = `${heading}

跨組依賴／共通風險

請整合列出跨任務問題；如無請填「無」。

請控制組於 10/09 提供 P1.4 所需的 CAN 介面。
目前測試等待 WP-C1 的訊號確認。

需要 PM 決策

請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。

請 PM 於 10/08 確認：方案 A 共用測試場，或方案 B 分時測試。
`;

test('extracts both Word fields verbatim and excludes the former PM review form', () => {
  const source = extractWeeklyIssues(report + '\n6　PM 審閱　PM REVIEW\n\nPM 回饋\n不可算成員回報');
  assert.equal(source.cross_task_issues.status, 'reported');
  assert.equal(source.cross_task_issues.reported_text, '請控制組於 10/09 提供 P1.4 所需的 CAN 介面。\n目前測試等待 WP-C1 的訊號確認。');
  assert.match(source.decision_requests.reported_text, /方案 A.*方案 B/);
  assert.doesNotMatch(source.source_text, /不可算成員回報/);
  assert.match(source.source_text, /請整合列出/, 'complete original remains available separately');
});

test('explicit none, a blank template, a missing section and renamed fields remain distinct', () => {
  const source = extractWeeklyIssues(`${heading}\n跨組依賴／共通風險\n無。\n需要 PM 決策\n請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。\n`);
  assert.equal(source.cross_task_issues.status, 'none');
  assert.equal(source.cross_task_issues.reported_text, '無。');
  assert.equal(source.decision_requests.status, 'not_filled');
  assert.equal(extractWeeklyIssues('本週完成 P1.4').cross_task_issues.status, 'not_found');
  const renamed = extractWeeklyIssues(`${heading}\n跨組協作\n需要控制組支援\n`);
  assert.equal(renamed.cross_task_issues.status, 'not_found');
  assert.match(renamed.source_text, /需要控制組支援/, 'unrecognized labels must not erase original content');
  assert.equal(extractWeeklyIssues(`${heading}\n跨組依賴／共通風險\n無法取得資料，需要協助\n`).cross_task_issues.status, 'reported');
});

test('original Word answers survive omitted AI output and incorrect no-issue summaries', () => {
  const source = extractWeeklyIssues(report);
  const missing = normalizeWeeklyIssues(null, source);
  assert.equal(missing.cross_task_issues.reported_text, source.cross_task_issues.reported_text);
  const misleading = normalizeWeeklyIssues({cross_task_issues:{status:'none',reported_text:'無',summary:'本週無問題'}}, source);
  assert.equal(misleading.cross_task_issues.status, 'reported');
  assert.equal(misleading.cross_task_issues.summary, '');
  assert.equal(normalizeWeeklyIssues(null), null, 'legacy reports require regrading, not an invented empty assessment');
});

test('prior PM comments quoting the same section are not treated as this week’s answer', () => {
  const source = extractWeeklyIssues(`上期 PM 意見\n${heading}\n跨組依賴／共通風險\n上期尚待支援\n本週任務明細\n${report}`);
  assert.doesNotMatch(source.source_text, /上期尚待支援/);
  assert.match(source.cross_task_issues.reported_text, /10\/09/);
});

test('only source-supported metadata is retained and requests never become progress proposals', () => {
  const source = extractWeeklyIssues(report);
  const ai = structuredClone(source);
  Object.assign(ai.cross_task_issues, {summary:'等待控制組提供介面',related_ids:['P1.4','WP-C1','invented'],requested_from:'控制組',deadline:'10/09',options:'購買新設備'});
  const result = normalizeWeeklyIssues(ai, source);
  assert.equal(result.cross_task_issues.summary, '等待控制組提供介面');
  assert.deepEqual(result.cross_task_issues.related_ids, ['P1.4','WP-C1']);
  assert.equal(result.cross_task_issues.requested_from, '控制組');
  assert.equal(result.cross_task_issues.deadline, '10/09');
  assert.equal(result.cross_task_issues.options, '');
  assert.equal(result.proposals, undefined);
  ai.cross_task_issues.reported_text='P1.40 需控制組協助';
  ai.cross_task_issues.related_ids=['P1.4','P1.40'];
  assert.deepEqual(normalizeWeeklyIssues(ai).cross_task_issues.related_ids,['P1.40']);
});
