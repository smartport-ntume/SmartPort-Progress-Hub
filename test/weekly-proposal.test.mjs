import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWeeklyProposal, normalizeWeeklyProposal, proposalAlreadyApplied, weeklyRecordVersion } from '../worker/src/weekly-proposal.js';
import { assertExpectedProgress } from '../local-server/weekly-review-service.mjs';

const workRecord = () => ({schema_version:'1.1',issue_number:11,target_type:'SUBTASK',target_id:'C3.4',
  report_date:'2026-09-14',report_member_name:'測試成員',progress:null,reported_progress:null,status:null,blocker:null,
  evidence:'遠端 E-stop 測試完成，本地停止鏈待整合',summary:'完成遠端測試；本地整合尚在進行',
  confidence:0.8,rationale:'只有部分測試，無整體完成百分比',verification_note:'待補本地與遠端整合測試紀錄'});
const expected = record => ({progress:record.actual_progress??null,status:record.status||'',
  record_version:weeklyRecordVersion(record)});

test('work records preserve unknown and known percentages, blockers and prior evidence through approval and retry',()=>{
  for(const actual of [null,65]){
    const record={actual_progress:actual,status:'At Risk',blocker:'等候本地整合',actual_evidence:'上期證據',self_progress:60};
    const p=workRecord(),before=expected(record);
    assert.doesNotThrow(()=>assertExpectedProgress(p,record,before));
    applyWeeklyProposal(record,p);
    assert.equal(record.actual_progress,actual);assert.equal(record.self_progress,60);
    assert.equal(record.status,'At Risk');assert.equal(record.blocker,'等候本地整合');
    assert.match(record.actual_evidence,/上期證據/);assert.match(record.actual_evidence,/遠端 E-stop/);
    assert.match(record.last_update_summary,/待確認：待補本地/);
    const saved=structuredClone(record);
    assert.equal(proposalAlreadyApplied(record,p),true);
    assert.doesNotThrow(()=>assertExpectedProgress(p,record,before));
    applyWeeklyProposal(record,p);assert.deepEqual(record,saved,'retry does not duplicate evidence');
  }
});

test('explicit self-reported task completion remains a selectable candidate with verification context',()=>{
  const p={...workRecord(),target_id:'C1.1',progress:100,reported_progress:100,
    status:'In Progress',verification_note:'100% 為成員自報，尚待 PM 確認驗收證據'};
  const normalized=normalizeWeeklyProposal(p);
  assert.equal(normalized.progress,100);assert.equal(normalized.reported_progress,100);
  const record={actual_progress:null};applyWeeklyProposal(record,p);
  assert.equal(record.actual_progress,100);assert.equal(record.self_progress,100);
  assert.match(record.last_update_summary,/成員自報/);
});

test('step-only work records preserve ordered states and do not convert the current step into completion',()=>{
  const steps='1. 介面定義（已完成）\n2. CAN 收送測試（進行中）\n3. 整合驗證（未開始）\n目前第 2 步／共 3 步';
  const normalized=normalizeWeeklyProposal({...workRecord(),summary:steps,evidence:steps,status:'In Progress'});
  assert.equal(normalized.summary,steps);assert.equal(normalized.evidence,steps);
  const record={actual_progress:30};
  applyWeeklyProposal(record,{...workRecord(),...normalized});
  assert.equal(record.actual_progress,30);
  assert.equal(record.self_progress,undefined);
  assert.ok(record.actual_evidence.includes(steps));
  assert.ok(record.last_update_summary.includes(steps));
});

test('record proposals reject missing evidence, invented zero conversions and stale work-record snapshots',()=>{
  const p=workRecord();
  for(const progress of [undefined,'', '50',-1,101])assert.throws(()=>normalizeWeeklyProposal({...p,progress}),/invalid_progress/);
  assert.throws(()=>normalizeWeeklyProposal({...p,evidence:''}),/requires_report_evidence/);
  const record={actual_progress:null,status:'On Track',blocker:'blocked'};
  const before=expected(record);
  for(const patch of [{actual_progress:0},{blocker:'changed'},{last_update_summary:'另一位 PM 更新'},{self_progress:20}]){
    assert.throws(()=>assertExpectedProgress(p,{...record,...patch},before),/進度已變更/);
  }
  assert.throws(()=>assertExpectedProgress({...p,progress:10},{...record,actual_progress:50},expected({...record,actual_progress:50})),/低於目前/);
});
