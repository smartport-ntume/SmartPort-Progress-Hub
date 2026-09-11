import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { WeeklyReviewService, selectedProposalNumbers, assertExpectedProgress } from '../local-server/weekly-review-service.mjs';
import { GatewayJobHandler } from '../local-server/gateway-job-handler.mjs';

function database(tables) {
  return { from(table) {
    const filters=[];let patch=null;
    const result=()=>{
      const rows=(tables[table]||[]).filter(row=>filters.every(([key,value])=>row[key]===value));
      if(patch)rows.forEach(row=>Object.assign(row,structuredClone(patch)));
      return {data:rows,error:null};
    };
    const query={select(){return this;},eq(key,value){filters.push([key,value]);return this;},update(value){patch=value;return this;},
      async maybeSingle(){const r=result();return {...r,data:r.data[0]||null};},then(resolve,reject){return Promise.resolve(result()).then(resolve,reject);}};
    return query;
  }};
}

function fixture() {
  const proposals=[1,2].map(n=>({issue_number:n,target_type:'SUBTASK',target_id:'C'+n,progress:20*n,status:'On Track',
    source_report_path:'weekly_reports/report.docx',source_submission_id:'s1',source_analysis_job_id:'a1',review_status:'PENDING'}));
  const row={id:'s1',batch_id:'b1',member_id:'m1',is_current:true,job_id:'a1',analysis_job_key:'a1',status:'completed',
    report_path:'weekly_reports/report.docx',review_job_id:'r1',review_status:'REVIEWING',analysis_result:{proposals:structuredClone(proposals)}};
  const job={id:'r1',actor_id:'pm',actor_login:'pm',kind:'review_weekly_submission',status:'running',payload:{
    submission_id:'s1',analysis_job_id:'a1',decision:'approve',issue_numbers:[1,2],feedback:'checked',
    expected:{1:{progress:0,status:'On Track'},2:{progress:0,status:'On Track'}}}};
  const tables={weekly_report_submissions:[row],profiles:[{user_id:'pm',active:true,role:'PM',can_trigger_codex:true}],gateway_jobs:[job]};
  const supabase=database(tables),writes=[];
  const records=new Map(proposals.map(p=>[p.issue_number,{actual_progress:0,status:'On Track'}]));
  let failNumber=null;
  const request=async(path,method,payload)=>{
    const match=/\/proposals\/(\d+)\/(preview|approve|reject)/.exec(path);
    if(!match)throw new Error('unexpected request '+path);
    const number=Number(match[1]),proposal=proposals.find(p=>p.issue_number===number);
    if(match[2]==='preview')return {proposal:structuredClone(proposal),record:structuredClone(records.get(number))};
    if(number===failNumber)throw new Error('simulated write failure');
    assert.equal(payload.weekly_review_job_id,job.id);
    writes.push([number,match[2]]);proposal.review_status=match[2]==='approve'?'APPROVED':'REJECTED';
    if(match[2]==='approve')Object.assign(records.get(number),{actual_progress:proposal.progress,last_update_proposal:number});
    return {ok:true};
  };
  return {proposals,row,job,tables,supabase,writes,records,service:new WeeklyReviewService({supabase,request}),fail(n){failNumber=n;}};
}

test('whole-report review validates selection and every current progress before writing',async()=>{
  const f=fixture();f.job.payload.issue_numbers=[999];
  await assert.rejects(()=>f.service.review(f.job),/weekly_proposal_not_in_this_analysis/);
  f.job.payload.issue_numbers=[1,2];f.records.get(2).actual_progress=10;
  await assert.rejects(()=>f.service.review(f.job),/進度已變更/);
  assert.deepEqual(f.writes,[]);
});

test('selected changes are approved together and unselected changes are rejected',async()=>{
  const f=fixture();f.job.payload.issue_numbers=[1];
  const result=await f.service.review(f.job);
  assert.equal(result.review_status,'APPROVED');assert.deepEqual(f.writes,[[1,'approve'],[2,'reject']]);
  assert.equal(f.row.pm_feedback,'checked');assert.equal(f.row.review_result.decisions.length,2);
});

test('failed whole-report review resumes only unfinished decisions',async()=>{
  const f=fixture();f.fail(2);
  await assert.rejects(()=>f.service.review(f.job),/simulated write failure/);
  assert.deepEqual(f.row.review_result.decisions,[{issue_number:1,status:'APPROVED'}]);
  f.fail(null);f.job.id='r2';f.row.review_job_id='r2';
  await f.service.review(f.job);
  assert.deepEqual(f.writes,[[1,'approve'],[2,'approve']]);assert.equal(f.row.review_status,'APPROVED');
});

test('a failed review can skip an outdated pending proposal while retaining prior approvals',async()=>{
  const f=fixture();f.fail(2);await assert.rejects(()=>f.service.review(f.job));
  f.fail(null);f.job.payload.issue_numbers=[1];
  await f.service.review(f.job);
  assert.deepEqual(f.writes,[[1,'approve'],[2,'reject']]);
});

test('returning a report requires feedback and does not write baseline progress',async()=>{
  const f=fixture();f.job.payload.decision='return';f.job.payload.feedback='';
  await assert.rejects(()=>f.service.review(f.job),/return_reason_required/);
  f.job.payload.feedback='補充測試紀錄';await f.service.review(f.job);
  assert.deepEqual(f.writes,[[1,'reject'],[2,'reject']]);assert.equal(f.row.review_status,'CHANGES_REQUESTED');
});

test('a report with no proposed updates still supports a PM decision',async()=>{
  const f=fixture();f.row.analysis_result.proposals=[];f.job.payload.issue_numbers=[];
  await f.service.review(f.job);assert.equal(f.row.review_status,'APPROVED');assert.deepEqual(f.writes,[]);
});

test('server guards reject superseded reports, forged review jobs and revoked PM permissions',async()=>{
  const f=fixture();
  await assert.rejects(()=>f.service.guardProposal(f.proposals[0],null,'approve'),/週報管理中心/);
  f.row.is_current=false;
  await assert.rejects(()=>f.service.assertAnalysis({submission_id:'s1',analysis_job_id:'a1'}),/superseded/);
  await assert.rejects(()=>f.service.guardProposal(f.proposals[0],'r1','approve'),/superseded/);
  f.row.is_current=true;f.tables.profiles[0].active=false;
  await assert.rejects(()=>f.service.review(f.job),/no_longer_authorized/);
  assert.deepEqual(f.writes,[]);
});

test('a recorded proposal write can recover a lost GitHub issue acknowledgment',()=>{
  const p={issue_number:1,target_id:'C1',progress:40,status:'On Track'};
  assert.doesNotThrow(()=>assertExpectedProgress(p,{last_update_proposal:1,actual_progress:40,status:'On Track'},{progress:0,status:'On Track'}));
  assert.throws(()=>assertExpectedProgress(p,{last_update_proposal:2,actual_progress:40,status:'On Track'},{progress:0,status:'On Track'}),/進度已變更/);
  assert.throws(()=>selectedProposalNumbers([1,3],[p]),/not_in_this_analysis/);
});

test('retry reads the archived report without downloading deleted temporary storage',async()=>{
  const row={id:'s1',job_id:'a2',storage_path:'portal/b/m/u/report.docx',report_path:'weekly_reports/original.docx',
    filename:'report.docx',member_id:'m1',member_name:'成員',is_current:true,revision:2};
  const supabase=database({weekly_report_submissions:[row]});
  supabase.storage={from(){throw new Error('temporary storage must not be used');}};
  const service={assertPm:async()=>{},assertAnalysis:async()=>{},supersedeObsolete:async()=>{}};
  const handler=new GatewayJobHandler({supabase,weeklyReview:service,internalBearer:'test',env:{},app:{async fetch(request){
    assert.equal(new URL(request.url).pathname,'/api/reports/analyze');
    const payload=await request.json();assert.equal(payload.report_path,row.report_path);assert.equal(payload.analysis_job_id,'a2');
    assert.equal(payload.report_revision,2);return Response.json({analysis:{report_summary:'regraded'},proposals:[]});
  }}});
  await handler.handle({id:'a2',kind:'analyze_weekly_report',payload:{submission_id:'s1',storage_path:row.storage_path}});
});

test('portal and PM center share report-level status and choose the current submission',async()=>{
  const window={};vm.runInNewContext(await readFile(new URL('../js/weekly-review-model.js',import.meta.url),'utf8'),{window});
  const model=window.SmartPortWeeklyReview;
  assert.equal(model.status({status:'completed',review_status:'APPROVED'}).label,'已核准');
  assert.equal(model.status({status:'completed',review_status:'CHANGES_REQUESTED'}).label,'退回補件');
  assert.equal(model.status({status:'completed',is_current:false,review_status:'SUPERSEDED'}).key,'superseded');
  const rows=[{member_id:'m1',revision:1,review_status:'APPROVED',is_current:false},{member_id:'m1',revision:2,status:'queued',is_current:true}];
  assert.equal(model.latest(rows,'m1').revision,2);
  assert.equal(model.taipeiInput('2026-09-14T05:00:00Z'),'2026-09-14T13:00');
});
