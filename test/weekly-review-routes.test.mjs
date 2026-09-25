import test from 'node:test';
import assert from 'node:assert/strict';
import app from '../worker/src/public.js';
import { WeeklyReportAutomation } from '../local-server/weekly-report-automation.mjs';
import { weeklyRecordVersion } from '../worker/src/weekly-proposal.js';
import { assertExpectedProgress } from '../local-server/weekly-review-service.mjs';

test('internal proposal routes enforce the report guard before any baseline or issue mutation',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const payload={target_type:'SUBTASK',target_id:'C1',progress:50,status:'On Track',source_report_path:'weekly_reports/report.docx',source_submission_id:'s1'};
  const issue={number:1,title:'[WEEKLY-AI] C1',body:`<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\n${JSON.stringify(payload)}\n-->`,state:'open'};
  const writes=[];
  globalThis.fetch=async(input,init={})=>{
    const url=new URL(input instanceof Request?input.url:String(input));const method=init.method||'GET';
    if(url.pathname==='/repos/example/private-project')return Response.json({permissions:{push:true}});
    if(url.pathname.endsWith('/issues/1')){
      if(method==='PATCH'){writes.push(JSON.parse(init.body));Object.assign(issue,JSON.parse(init.body));}
      return Response.json(issue);
    }
    if(url.pathname.endsWith('/contents/project/subtasks.json')){
      if(method==='PUT'){writes.push('baseline');return Response.json({content:{sha:'new'}});}
      return Response.json({sha:'old',content:Buffer.from(JSON.stringify({subtasks:[{id:'C1',actual_progress:10,status:'On Track'}]})).toString('base64')});
    }
    throw new Error('Unexpected '+method+' '+url.pathname);
  };
  const guarded=[];
  const env={PROJECT_REPO:'example/private-project',INTERNAL_AGENT_BEARER:'secret',LOCAL_GITHUB_TOKEN:'token',
    LOCAL_WEEKLY_REVIEW_GUARD:async(p,job,action)=>{guarded.push(action);if(action!=='supersede')throw new Error('weekly_submission_superseded');}};
  const call=(action,method='POST')=>app.fetch(new Request('http://local-agent/api/reports/proposals/1/'+action,{
    method,headers:{Authorization:'Bearer secret','Content-Type':'application/json','X-SmartPort-Actor':'pm'},
    ...(method==='POST'?{body:JSON.stringify({weekly_review_job_id:'r1'})}:{})
  }),env,{});
  const preview=await call('preview','GET');const previewBody=await preview.json();
  assert.equal(preview.status,200,JSON.stringify(previewBody));assert.equal(previewBody.record.actual_progress,10);
  for(const action of ['approve','reject']){
    const response=await call(action);assert.ok(response.status>=400);assert.match(await response.text(),/weekly_submission_superseded/);
  }
  assert.deepEqual(writes,[]);assert.deepEqual(guarded,['approve','reject']);
  assert.equal((await call('supersede')).status,200);
  assert.equal(writes.length,1);assert.equal(writes[0].title,'[SUPERSEDED] [WEEKLY-AI] C1');
});

test('manual Discord resend reuses the batch token and does not reset delivery on the same job twice',async()=>{
  const batch={id:'batch-1',week_key:'2026-W38',report_date:'2026-09-14',status:'OPEN',accept_until:'2099-01-01',token:'original-token',
    discord_message_id:'["old-message"]',discord_message_sent_at:'2026-09-14T05:00:00Z'};
  let resets=0;
  const query={select(){return this;},eq(){return this;},async maybeSingle(){return {data:{...batch}};},
    update(patch){Object.assign(batch,patch);resets++;return this;},then(resolve,reject){return Promise.resolve({data:null,error:null}).then(resolve,reject);}};
  const automation=new WeeklyReportAutomation({supabase:{from(){return query;}},projectStore:{},options:{enabled:true}});
  automation.reviewGate=async()=>({ready:true,review:null});
  let sends=0;
  automation.sendDiscord=async row=>{assert.equal(row.token,'original-token');if(row.discord_message_sent_at)return {alreadySent:true};sends++;batch.discord_message_sent_at='2026-09-14T05:01:00Z';return {sent:true};};
  await automation.resendBatch('batch-1','job-1');await automation.resendBatch('batch-1','job-1');
  assert.equal(resets,1);assert.equal(sends,1);
  await automation.resendBatch('batch-1','job-2');assert.equal(resets,2);assert.equal(sends,2);
});

test('approval uses the reviewed file SHA and stops when the baseline changes before writing',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const proposal={target_type:'WP',target_id:'W1',progress:50,status:'On Track'};
  const issue={number:1,title:'[WEEKLY-AI] W1',body:`<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\n${JSON.stringify(proposal)}\n-->`};
  let sha='reviewed',reads=0,issueWrites=0,baselineWrites=0;
  globalThis.fetch=async(input,init={})=>{
    const path=new URL(String(input)).pathname;
    if(path==='/repos/example/project')return Response.json({permissions:{push:true}});
    if(path.endsWith('/issues/1')){if(init.method==='PATCH')issueWrites++;return Response.json(issue);}
    if(path.endsWith('/contents/project/work_packages.json')){
      if(init.method==='PUT'){
        if(JSON.parse(init.body).sha!==sha)return Response.json({message:'Concurrent update: SHA mismatch'},{status:409});
        baselineWrites++;return Response.json({content:{sha:'written'}});
      }
      reads++;
      return Response.json({sha,content:Buffer.from(JSON.stringify({work_packages:[{id:'W1',actual_progress:10,status:'On Track'}]})).toString('base64')});
    }
    throw new Error('Unexpected '+path);
  };
  const response=await app.fetch(new Request('http://local-agent/api/reports/proposals/1/approve',{
    method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:'{}'
  }),{PROJECT_REPO:'example/project',INTERNAL_AGENT_BEARER:'secret',LOCAL_GITHUB_TOKEN:'token',
    LOCAL_WEEKLY_REVIEW_GUARD:async()=>{sha='concurrent';}},{});
  assert.ok(response.status>=400);assert.match(await response.text(),/SHA mismatch/);
  assert.equal(reads,1);assert.equal(baselineWrites,0);assert.equal(issueWrites,0);
});

test('approving a work record through the API preserves null progress and linked issue status',async t=>{
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const p={schema_version:'1.1',target_type:'SUBTASK',target_id:'C3.4',report_date:'2026-09-14',progress:null,status:null,blocker:null,
    source_report_path:'weekly_reports/report.docx',source_submission_id:'s1',evidence:'遠端停止已測試',summary:'完成遠端測試',verification_note:'本地停止待驗證'};
  const issue={number:1,title:'[WEEKLY-AI] C3.4',body:`<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\n${JSON.stringify(p)}\n-->`};
  const record={id:'C3.4',github_issue:88,actual_progress:null,status:'In Progress',blocker:'等待本地整合',actual_evidence:'既有測試記錄'};
  let saved,linkedBody;
  globalThis.fetch=async(input,init={})=>{
    const path=new URL(String(input)).pathname;
    if(path==='/repos/example/project')return Response.json({permissions:{push:true}});
    if(path.endsWith('/issues/1')){if(init.method==='PATCH')Object.assign(issue,JSON.parse(init.body));return Response.json(issue);}
    if(path.endsWith('/issues/88')){if(init.method==='PATCH')linkedBody=JSON.parse(init.body).body;return Response.json({body:'## Project Status\nOld status'});}
    if(path.endsWith('/contents/project/subtasks.json')){
      if(init.method==='PUT'){saved=JSON.parse(Buffer.from(JSON.parse(init.body).content,'base64').toString());return Response.json({content:{sha:'new'}});}
      return Response.json({sha:'old',content:Buffer.from(JSON.stringify({subtasks:[record]})).toString('base64')});
    }
    throw new Error('unexpected '+path);
  };
  const expected={progress:null,status:'In Progress',record_version:weeklyRecordVersion(record)};
  const response=await app.fetch(new Request('http://local-agent/api/reports/proposals/1/approve',{
    method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},body:JSON.stringify({expected_current:expected})
  }),{PROJECT_REPO:'example/project',INTERNAL_AGENT_BEARER:'secret',LOCAL_GITHUB_TOKEN:'token',
    LOCAL_WEEKLY_REVIEW_GUARD:async(proposal,job,action,current,wanted)=>assertExpectedProgress(proposal,current,wanted)},{});
  assert.equal(response.status,200,await response.text());
  assert.equal(saved.subtasks[0].actual_progress,null);assert.equal(saved.subtasks[0].status,'In Progress');
  assert.equal(saved.subtasks[0].blocker,'等待本地整合');assert.match(saved.subtasks[0].actual_evidence,/既有測試記錄/);
  assert.match(saved.subtasks[0].last_update_summary,/本地停止待驗證/);
  assert.match(linkedBody,/Actual Progress:\*\* 未填/);assert.doesNotMatch(linkedBody,/0%|null/);
  assert.match(issue.title,/^\[APPROVED\]/);
});

test('PM-corrected progress is written and audited, and an interrupted approval resumes the same correction',async t=>{
  const {withPmProgress}=await import('../worker/src/weekly-proposal.js');
  const original=globalThis.fetch;t.after(()=>globalThis.fetch=original);
  const p={schema_version:'1.1',target_type:'SUBTASK',target_id:'C1',report_date:'2026-09-25',progress:100,reported_progress:100,
    status:'Completed',blocker:null,evidence:'自報已完成',summary:'自報完成，待 PM 驗證',source_report_path:'weekly_reports/test.docx'};
  const issue={number:1,title:'[WEEKLY-AI] C1',body:`<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\n${JSON.stringify(p)}\n-->`};
  let record={id:'C1',actual_progress:60,status:'In Progress',actual_evidence:'既有紀錄'},failClose=true;
  const expected={progress:60,status:record.status,record_version:weeklyRecordVersion(record)};
  globalThis.fetch=async(input,init={})=>{
    const path=new URL(String(input)).pathname;
    if(path==='/repos/example/project')return Response.json({permissions:{push:true}});
    if(path.endsWith('/issues/1')){
      if(init.method==='PATCH'){
        if(failClose){failClose=false;return Response.json({message:'temporary issue write failure'},{status:500});}
        Object.assign(issue,JSON.parse(init.body));
      }
      return Response.json(issue);
    }
    if(path.endsWith('/contents/project/subtasks.json')){
      if(init.method==='PUT'){record=JSON.parse(Buffer.from(JSON.parse(init.body).content,'base64').toString()).subtasks[0];return Response.json({content:{sha:'written'}});}
      return Response.json({sha:'current',content:Buffer.from(JSON.stringify({subtasks:[record]})).toString('base64')});
    }
    throw new Error('Unexpected '+path);
  };
  const env={PROJECT_REPO:'example/project',INTERNAL_AGENT_BEARER:'secret',LOCAL_GITHUB_TOKEN:'token',
    LOCAL_WEEKLY_REVIEW_GUARD:async(proposal,job,action,current,wanted)=>{
      const corrected=withPmProgress(proposal,{1:20},current);assertExpectedProgress(corrected,current,wanted);return corrected;
    }};
  const call=()=>app.fetch(new Request('http://local-agent/api/reports/proposals/1/approve',{
    method:'POST',headers:{Authorization:'Bearer secret','Content-Type':'application/json'},
    body:JSON.stringify({weekly_review_job_id:'r1',expected_current:expected,progress_overrides:{1:99}})
  }),env,{});
  assert.ok((await call()).status>=400);
  assert.equal(record.actual_progress,20);assert.equal(record.self_progress,100);assert.equal(record.status,'In Progress');
  const response=await call();assert.equal(response.status,200,await response.text());
  assert.equal(record.actual_evidence.split('自報已完成').length,2);
  assert.match(issue.body,/PM 核定：20%/);assert.match(issue.body,/"progress":100/);
});
