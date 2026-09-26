import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { weeklyRecordVersion } from '../worker/src/weekly-proposal.js';
import { JSDOM } from 'jsdom';
import { zeroAnalysis, screenshotFailures } from './fixtures/weekly-input-failures.mjs';

const sources=await Promise.all(['weekly-feedback-routing.js','weekly-review-model.js','weekly-center.js'].map(name=>readFile(new URL('../js/'+name,import.meta.url),'utf8')));
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const proposals=[1,2].map(n=>({issue_number:n,target_type:'SUBTASK',target_id:'C'+n,progress:n*20,status:'On Track',summary:'完成測試',evidence:'測試紀錄'}));

function database(){
  return {members:[{id:'m1',name:'有提案成員'},{id:'m2',name:'空白範本成員'},{id:'m3',name:'讀取失敗甲'},{id:'m4',name:'讀取失敗乙'},{id:'m5',name:'失敗審核成員'}],
    rows:[zeroAnalysis(),zeroAnalysis(),...screenshotFailures,screenshotFailures[0]].map((analysis,i)=>({
      id:'s'+(i+1),member_id:'m'+(i+1),member_name:'成員'+(i+1),status:'completed',is_current:true,revision:1,
      submitted_at:'2026-09-14T04:00:00Z',job_id:'a'+i,analysis_job_key:'a'+i,
      review_status:i===4?'REVIEW_FAILED':'PENDING',review_job_id:i===4?'old-review':null,review_result:{decisions:[]},
      analysis_result:{analysis:structuredClone(analysis),proposals:i===0?structuredClone(proposals):[]}
    })),calls:[],jobs:new Map(),next:1};
}

async function fixture(t,db=database(),storage={}){
  const dom=new JSDOM('<main id="reports"></main>',{url:'https://weekly.test',runScripts:'outside-only'});
  const {window}=dom,doc=window.document;
  t.after(()=>window.close());
  for(const [key,value] of Object.entries(storage))window.sessionStorage.setItem(key,value);
  window.confirm=()=>true;
  sources.forEach(source=>window.eval(source));
  const waiters=new Map(),watched=[];
  const API={
    async listWeeklyReports(){return {batches:[{id:'b1',week_key:'2026-W37',report_date:'2026-09-14',due_at:'2026-09-21T04:00:00Z',members:db.members,
      submissions:db.rows.map(({analysis_result,...row})=>structuredClone(row))}]};},
    async getWeeklyReport(id){return {week_key:'2026-W37',submission:structuredClone(db.rows.find(r=>r.id===id)),runs:[]};},
    async loadSnapshot(){return db.snapshot || {subtasks:proposals.map(p=>({id:p.target_id,actual_progress:0,status:'On Track'})),work_packages:[]};},
    async saveWeeklyFeedback(id,payload){
      const row=db.rows.find(r=>r.id===id);
      if(payload.feedback_version!==(row.feedback_version||0))throw new Error('weekly_feedback_changed_refresh_required');
      const saved={pm_feedback:payload.feedback,pm_task_feedback:structuredClone(payload.task_feedback),feedback_version:(row.feedback_version||0)+1};
      Object.assign(row,saved);return saved;
    },
    async weeklyReportAction(action,id,payload){
      assert.equal([...db.jobs.values()].some(j=>j.target===id&&j.status==='queued'),false,'same report must not be enqueued twice');
      const row=db.rows.find(r=>r.id===id),job={id:'j'+db.next++,target:id,action,status:'queued'};
      db.calls.push({action,id,payload:structuredClone(payload)});db.jobs.set(job.id,job);
      if(action==='retry'){row.status='queued';row.job_id=job.id;row.analysis_job_key=job.id;}
      else {row.review_status='REVIEWING';row.review_job_id=job.id;}
      return {job};
    },
    async waitForAnalysisJob(id){watched.push(id);return new Promise((resolve,reject)=>waiters.set(id,{resolve,reject}));}
  };
  await window.SmartPortWeeklyCenter.mount(doc.querySelector('#reports'),{API,me:{can_approve:true,can_trigger_codex:true},onChange:async()=>{}});
  async function click(selector){const el=doc.querySelector(selector);assert.ok(el,'missing '+selector);assert.ok(!el.disabled,'disabled '+selector);el.click();await flush();}
  async function finish(id,{release=false}={}){
    const job=db.jobs.get(id),row=db.rows.find(r=>r.id===job.target);job.status=release?'failed':'completed';
    row.status=release?'failed':'completed';row.review_status='PENDING';row.review_job_id=null;
    if(!release)row.analysis_result={analysis:zeroAnalysis(),proposals:structuredClone(proposals)};
    if(release)waiters.get(id).reject(new Error('weekly_analysis_incomplete'));
    else waiters.get(id).resolve(structuredClone(job));
    await flush();
  }
  return {db,doc,window,watched,click,finish};
}

test('both screenshot failures expose retry and explain why there are no selectable progress changes',async t=>{
  const f=await fixture(t);
  for(const member of ['m3','m4']){
    await f.click(`[data-member="${member}"]`);
    const detail=f.doc.querySelector('[data-field="detail"]');
    assert.match(detail.textContent,/批改未完成，尚未產生可勾選的進度更新/);
    assert.equal(detail.querySelector('.weekly-center-scores'),null);
    assert.equal(detail.querySelector('[data-action="approve"]'),null);
    assert.equal(detail.querySelector('[data-action="select-all"]'),null);
    assert.equal(detail.querySelector('[data-action="retry"]').disabled,false);
  }
  assert.match(f.doc.querySelector('[data-field="counts"]').textContent,/失敗 3/);
  await f.click('[data-action="refresh"]');
  assert.match(f.doc.querySelector('[data-member="m3"]').textContent,/批改未完成/,'refresh must retain inspected failure classification');
});

test('PM can queue both retries, keep refreshing, and approve another report without losing draft selections',async t=>{
  const f=await fixture(t);
  await f.click('[data-member="m3"]');await f.click('[data-action="retry"]');
  assert.equal(f.doc.querySelector('[data-action="refresh"]').disabled,false);
  await f.click('[data-member="m4"]');await f.click('[data-action="retry"]');
  assert.deepEqual(f.db.calls.map(c=>c.id),['s3','s4']);
  assert.match(f.doc.querySelector('[data-field="jobs"]').textContent,/有 2 項操作/);
  await f.click('[data-member="m3"]');
  assert.equal(f.doc.querySelector('[data-action="retry"]'),null,'queued report cannot be queued again');
  await f.click('[data-member="m1"]');await f.click('[data-action="select-all"]');
  f.doc.querySelector('[data-field="feedback"]').value='請保留測試紀錄。';
  await f.finish('j1');
  assert.match(f.doc.querySelector('[data-field="detail"]').textContent,/有提案成員/);
  assert.equal(f.doc.querySelector('[data-field="feedback"]').value,'請保留測試紀錄。');
  assert.equal(f.doc.querySelectorAll('[data-proposal]:checked').length,2);
  assert.doesNotMatch(f.doc.querySelector('[data-member="m3"]').textContent,/批改未完成/,'completed reanalysis must drop the cached old refusal');
  await f.click('[data-action="approve"]');
  assert.deepEqual(f.db.calls.at(-1).payload.issue_numbers,[1,2]);
  assert.equal(f.db.calls.at(-1).payload.feedback,'請保留測試紀錄。');
  assert.deepEqual(f.db.calls.at(-1).payload.expected,{1:{progress:0,status:'On Track'},2:{progress:0,status:'On Track'}});
});

test('a valid zero-score report without proposals can be approved explicitly without progress updates',async t=>{
  const f=await fixture(t);await f.click('[data-member="m2"]');
  assert.ok(f.doc.querySelector('.weekly-center-scores'));
  assert.equal(f.doc.querySelector('[data-action="select-all"]'),null);
  assert.equal(f.doc.querySelector('[data-action="approve"]').textContent,'核准週報（不更新進度）');
  await f.click('[data-action="approve"]');
  assert.deepEqual(f.db.calls[0].payload.issue_numbers,[]);
});

test('reloading restores multiple job watchers without disabling other members',async t=>{
  const first=await fixture(t);
  await first.click('[data-member="m3"]');await first.click('[data-action="retry"]');
  await first.click('[data-member="m4"]');await first.click('[data-action="retry"]');
  const second=await fixture(t,first.db,{'smartport.weeklyCenterJobs':first.window.sessionStorage.getItem('smartport.weeklyCenterJobs')});
  assert.deepEqual(second.watched,['j1','j2']);
  await second.click('[data-member="m1"]');
  assert.equal(second.doc.querySelector('[data-action="approve"]').disabled,false);
  assert.equal(second.doc.querySelector('[data-action="refresh"]').disabled,false);
});

test('a failed review with no writes can release its lock and regrade the archived report',async t=>{
  const f=await fixture(t);await f.click('[data-member="m5"]');
  assert.equal(f.doc.querySelector('[data-action="resume_review"]').textContent,'解除失敗審核');
  await f.click('[data-action="resume_review"]');await f.finish('j1',{release:true});
  assert.match(f.doc.querySelector('[data-field="message"]').textContent,/失敗審核已解除/);
  await f.click('[data-action="retry"]');
  assert.deepEqual(f.db.calls.map(c=>c.action),['resume_review','retry']);
});

test('malformed saved jobs do not stop the PM center from loading',async t=>{
  const f=await fixture(t,undefined,{'smartport.weeklyCenterJobs':'invalid JSON'});
  await f.click('[data-member="m3"]');
  assert.equal(f.doc.querySelector('[data-action="retry"]').disabled,false);
});


test('PM can select work records with unknown completion and see self-report verification before approval',async t=>{
  const db=database();
  db.rows[0].analysis_result.proposals=[
    {...proposals[0],schema_version:'1.1',progress:null,status:null,blocker:null,verification_note:'本地 E-stop 待驗證'},
    {...proposals[1],schema_version:'1.1',progress:100,reported_progress:100,verification_note:'100% 為自報，待 PM 確認'}
  ];
  db.snapshot={subtasks:proposals.map(p=>({id:p.target_id,actual_progress:null,status:'In Progress'}))};
  const f=await fixture(t,db);await f.click('[data-member="m1"]');
  const detail=f.doc.querySelector('[data-field="detail"]');
  assert.match(detail.textContent,/工作紀錄更新（百分比不變）/);
  assert.match(detail.textContent,/未填 → 保留目前進度/);
  assert.match(detail.textContent,/成員自報完成度：100%（待 PM 確認）/);
  assert.match(detail.textContent,/本地 E-stop 待驗證/);
  assert.doesNotMatch(detail.textContent,/null%/);
  await f.click('[data-action="select-all"]');await f.click('[data-action="approve"]');
  assert.deepEqual(db.calls[0].payload.issue_numbers,[1,2]);
  assert.equal(db.calls[0].payload.expected['1'].progress,null);
  assert.equal(db.calls[0].payload.expected['1'].record_version,weeklyRecordVersion(db.snapshot.subtasks[0]));
});

test('PM center identifies who blocks the next weekly handoff and shows readiness after review',async t=>{
  const db=database();
  db.rows.forEach(row=>{row.review_status='APPROVED';row.analysis_result.analysis=zeroAnalysis();});
  db.rows[4].review_status='PENDING';
  const f=await fixture(t,db);
  assert.match(f.doc.querySelector('[data-field="handoff"]').textContent,/失敗審核成員（待 PM 審核）/);
  db.rows[4].review_status='CHANGES_REQUESTED';db.rows[4].pm_feedback='下期請補測試紀錄';
  await f.click('[data-action="refresh"]');
  assert.match(f.doc.querySelector('[data-field="handoff"]').textContent,/全員已完成 PM 審閱/);
});

test('PM edits task advice and progress before approving without overwriting the AI source',async t=>{
  const db=database();db.rows[0].analysis_result.analysis.review.task_feedback=[{target_type:'SUBTASK',target_id:'C1',missing_items:['AI 缺漏'],actions:['AI 下一步']}];
  const f=await fixture(t,db);await f.click('[data-member="m1"]');
  f.doc.querySelector('[data-feedback-missing]').value='PM 修改缺漏\n補影片';
  f.doc.querySelector('[data-feedback-actions]').value='PM 指定下一步';
  f.doc.querySelector('[data-progress="1"]').value='15';
  f.doc.querySelector('[data-proposal="1"]').checked=true;
  await f.click('[data-action="approve"]');
  assert.deepEqual(f.db.calls[0].payload.progress_overrides,{'1':15});
  assert.equal(f.db.calls[0].payload.task_feedback[0].missing_items[1],'補影片');
  assert.equal(f.db.calls[0].payload.task_feedback[0].actions[0],'PM 指定下一步');
  assert.equal(db.rows[0].analysis_result.analysis.review.task_feedback[0].actions[0],'AI 下一步');
});

test('progress zero and blank retain their different meanings and out-of-range input cannot enqueue review',async t=>{
  const f=await fixture(t);await f.click('[data-member="m1"]');
  await f.click('[data-action="select-all"]');
  f.doc.querySelector('[data-progress="1"]').value='101';
  await f.click('[data-action="approve"]');assert.equal(f.db.calls.length,0);
  assert.match(f.doc.querySelector('[data-field="message"]').textContent,/0～100/);
  f.doc.querySelector('[data-progress="1"]').value='0';f.doc.querySelector('[data-progress="2"]').value='';
  await f.click('[data-action="approve"]');assert.deepEqual(f.db.calls[0].payload.progress_overrides,{'1':0,'2':null});
});


test('saving edited advice persists without closing review and a second save uses the latest version',async t=>{
  const f=await fixture(t);await f.click('[data-member="m1"]');
  await f.click('[data-action="add-feedback"]');
  const editors=f.doc.querySelectorAll('.weekly-center-feedback-editor');const editor=editors[editors.length-1];
  assert.equal(editor.querySelector('select'),null);
  editor.querySelector('[data-feedback-missing]').value='C1：待補測試影片';
  editor.querySelector('[data-feedback-actions]').value='C1：下週驗證';
  f.doc.querySelector('[data-field="feedback"]').value='PM 意見';
  await f.click('[data-action="save-feedback"]');
  assert.equal(f.db.rows[0].review_status,'PENDING');assert.equal(f.db.calls.length,0);
  assert.equal(f.db.rows[0].feedback_version,1);assert.equal(f.db.rows[0].pm_task_feedback.at(-1).actions[0],'C1：下週驗證');
  f.doc.querySelector('[data-field="feedback"]').value='PM 修正版';
  await f.click('[data-action="save-feedback"]');assert.equal(f.db.rows[0].feedback_version,2);
  await f.click('[data-member="m2"]');await f.click('[data-member="m1"]');
  assert.equal(f.doc.querySelector('[data-field="feedback"]').value,'PM 修正版');
  assert.equal([...f.doc.querySelectorAll('[data-feedback-actions]')].at(-1).value,'C1：下週驗證');
  f.doc.querySelector('[data-field="feedback"]').value='';
  await f.click('[data-action="save-feedback"]');await f.click('[data-action="refresh"]');
  assert.equal(f.doc.querySelector('[data-field="feedback"]').value,'');
});

test('old mixed advice opens as automatically matched cards and PM saves without choosing targets',async t=>{
  const db=database();
  db.snapshot={team_config:{category_owners:{STM:'m1'}},work_packages:[{id:'WP-S1',owner:'STM',name:'任務整合'}],
    subtasks:['S1.1','S1.2','S1.4'].map(id=>({id,name:id,owner_team:'STM',parent_wp:'WP-S1'}))};
  db.rows[0].analysis_result.analysis.review.task_feedback=[{target_type:'GENERAL',target_id:'',missing_items:['S1.1：缺測試紀錄','S1.2：缺回歸測試','S1.4：缺停止距離'],actions:['統一填報日期']}];
  const f=await fixture(t,db);await f.click('[data-member="m1"]');
  assert.equal(f.doc.querySelector('[data-feedback-target]'),null);
  assert.match(f.doc.querySelector('[data-feedback-id="S1.1"]').textContent,/WP-S1.*S1.1/);
  f.doc.querySelector('[data-feedback-id="S1.1"] [data-feedback-missing]').value='S1.1：PM 修正後的測試要求';
  await f.click('[data-action="save-feedback"]');
  assert.equal(db.rows[0].pm_task_feedback.find(item=>item.target_id==='S1.1').missing_items[0],'S1.1：PM 修正後的測試要求');
  assert.equal(db.rows[0].pm_task_feedback.find(item=>item.target_type==='GENERAL').actions[0],'統一填報日期');
});
