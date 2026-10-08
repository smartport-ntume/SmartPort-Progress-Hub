import test from 'node:test';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import * as docx from 'docx';
import { WeeklyReportAutomation, weeklySchedule, manualWeeklySchedule } from '../local-server/weekly-report-automation.mjs';
import { previousReviewHandoff } from '../local-server/weekly-review-handoff.mjs';

const options={enabled:true,timezone:'Asia/Taipei',publishWeekday:1,publishHour:13,publishMinute:0,
  dueDays:7,dueHour:12,dueMinute:0,catchUpDays:7,reminderEnabled:false,
  portalUrl:'https://example.test/weekly-submit.html',discordWebhookUrl:'https://discord.com/api/webhooks/123/test'};
const payload=()=>({project:{name:'SmartPort'},report_date:'2026-09-07',
  team_config:{schema_version:'1.0',members:[{id:'m1',name:'成員甲'},{id:'m2',name:'成員乙'}],
    categories:[{id:'CTL',name:'控制',active:true},{id:'PER',name:'感知',active:true}],category_owners:{CTL:'m1',PER:'m2'}},
  work_packages:[],subtasks:[],checkpoints:[],checkpoint_references:[]});

function fixture(){
  const db={weekly_report_batches:[{id:'old',week_key:'2026-W37',report_date:'2026-09-07',payload:payload(),
    discord_message_id:'["old-message"]',discord_message_sent_at:'2026-09-07T05:00:00Z',status:'OPEN',accept_until:'2099-01-01'}],
    weekly_report_submissions:[{id:'s1',batch_id:'old',member_id:'m1',revision:1,is_current:true,status:'completed',review_status:'APPROVED',pm_feedback:'甲：請補介面測試紀錄',reviewed_at:'2026-09-14T04:00:00Z'},
      {id:'s2',batch_id:'old',member_id:'m2',revision:1,is_current:true,status:'completed',review_status:'PENDING'}],
    profiles:[{user_id:'pm',login:'pm',role:'PM',active:true,can_trigger_codex:true}]};
  const requests=[],writes=[];
  const supabase={from(table){
    let filters=[],sort=null,limit=null,patch=null,insert=null;
    const query={select(){return this;},eq(k,v){filters.push(row=>row[k]===v);return this;},lt(k,v){filters.push(row=>row[k]<v);return this;},
      order(k,o){sort=[k,o];return this;},limit(n){limit=n;return this;},update(v){patch=v;return this;},insert(v){insert=v;return this;},
      async maybeSingle(){return run(true);},async single(){return run(true);},then(resolve,reject){return Promise.resolve(run(false)).then(resolve,reject);}};
    function run(single){
      if(insert){const row={id:'new',status:'OPEN',...structuredClone(insert)};db[table].push(row);writes.push({table,insert});return {data:structuredClone(row),error:null};}
      let rows=db[table].filter(row=>filters.every(f=>f(row)));
      if(sort)rows.sort((a,b)=>String(a[sort[0]]).localeCompare(String(b[sort[0]]))*(sort[1]?.ascending===false?-1:1));
      if(limit!=null)rows=rows.slice(0,limit);
      if(patch){rows.forEach(row=>Object.assign(row,structuredClone(patch)));writes.push({table,patch});}
      return {data:structuredClone(single?rows[0]||null:rows),error:null};
    }
    return query;
  }};
  const files={'project/project.json':{name:'SmartPort'},'project/team_config.json':payload().team_config,
    'project/subtasks.json':{subtasks:[]},'project/work_packages.json':{work_packages:[]},
    'project/checkpoints.json':{checkpoints:[]},'project/reference_model.json':{acl_levels:[]}};
  let now=new Date('2026-09-14T05:01:00Z');
  const automation=new WeeklyReportAutomation({supabase,projectStore:{async readJson(path){return structuredClone(files[path]);}},options,now:()=>now,
    logger:{info(){},error(){}},fetchFn:async(url,init)=>{requests.push(init);return {ok:true,async json(){return {id:'message-'+requests.length};}};}});
  return {db,requests,writes,files,automation,setNow(value){now=new Date(value);},schedule:()=>weeklySchedule(now,options)};
}

test('legacy archived step plans carry by current revision without changing review state or archived files',async()=>{
  const f=fixture(),batch=f.db.weekly_report_batches[0],row=f.db.weekly_report_submissions[0];
  batch.payload.subtasks=[{id:'C1.1',name:'CAN Interface',owner_team:'CTL',parent_wp:'WP-C1'}];
  row.report_path='weekly_reports/2026-W37/m1-v1.docx';
  const make=async name=>docx.Packer.toBuffer(new docx.Document({sections:[{children:[
    new docx.Paragraph('C1.1　CAN Interface'),new docx.Paragraph('完成工項的步驟'),
    new docx.Paragraph('1. '+name+'（75％）'),new docx.Paragraph('☑ 已完成 ☐ 進行中 ☐ 未開始'),
    new docx.Paragraph('本週新增成果與進度說明')]}]}));
  let archive=await make('介面測試'),reads=0;
  f.automation.projectStore.readBuffer=async path=>{reads++;assert.equal(path,row.report_path);return archive;};
  const before=structuredClone(f.db);
  const gate=await f.automation.reviewGate(f.schedule(),{readOnly:true});
  assert.equal(gate.ready,false,'an outstanding PM review still blocks automatic publication');
  assert.deepEqual(gate.review.members[0].task_steps[0].steps,[{name:'介面測試',completion_percent:75,status:'completed'}]);
  assert.equal(gate.review.members[1].task_steps.length,0,'another member never inherits this plan');
  await f.automation.reviewGate(f.schedule(),{readOnly:true});assert.equal(reads,1,'the same archive is parsed once');
  assert.deepEqual(f.db,before);assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);
  row.revision=2;row.report_path='weekly_reports/2026-W37/m1-v2.docx';archive=await make('新版整合測試');
  const updated=await f.automation.reviewGate(f.schedule(),{readOnly:true});
  assert.equal(reads,2);assert.equal(updated.review.members[0].task_steps[0].steps[0].name,'新版整合測試');
});

test('latest revisions must all have PM decisions; missing, failed, pending and replacement uploads hold the next batch',()=>{
  const {db}=fixture(),batch=db.weekly_report_batches[0],rows=db.weekly_report_submissions;
  for(const state of [null,{status:'failed'},{status:'queued'},{status:'running'},{status:'completed',review_status:'PENDING'},
    {status:'completed',review_status:'REVIEWING'},{status:'completed',review_status:'REVIEW_FAILED'}]){
    const gate=previousReviewHandoff(batch,state?[rows[0],{...rows[1],...state}]:[rows[0]]);
    assert.equal(gate.ready,false);assert.equal(gate.blocked[0].member_id,'m2');
  }
  rows[1].review_status='CHANGES_REQUESTED';rows[1].pm_feedback='乙：請补定位佐證';
  assert.equal(previousReviewHandoff(batch,rows).ready,true);
  const replacement={...rows[1],id:'s3',revision:2,status:'queued',review_status:'PENDING'};
  assert.equal(previousReviewHandoff(batch,[{...rows[1],is_current:false},rows[0],replacement]).ready,false);
  assert.equal(previousReviewHandoff(null).ready,true,'the first batch needs no previous review');
});

test('scheduler sends nothing until all reports are reviewed, then sends fresh per-member feedback once',async()=>{
  const f=fixture();
  const blocked=await f.automation.publish(f.schedule());
  assert.equal(blocked.deferred,true);assert.equal(f.requests.length,0);assert.equal(f.db.weekly_report_batches.length,1);
  assert.match(f.db.weekly_report_batches[0].last_error,/成員乙（待 PM 審核）/);
  f.db.weekly_report_submissions[1].review_status='CHANGES_REQUESTED';
  f.db.weekly_report_submissions[1].pm_feedback='乙：請補定位佐證';
  f.db.weekly_report_submissions[1].reviewed_at='2026-09-14T05:05:00Z';
  f.setNow('2026-09-15T05:10:00Z');
  const result=await f.automation.publish(f.schedule());assert.equal(result.sent,true);assert.equal(f.requests.length,1);
  const next=f.db.weekly_report_batches[1];assert.equal(next.payload.previous_review.week_key,'2026-W37');
  const form=f.requests[0].body;
  assert.match(JSON.parse(form.get('payload_json')).content,/已帶入 2026-W37/);
  for(const [index,own,other] of [[0,'甲：請補介面測試紀錄','乙：請補定位佐證'],[1,'乙：請補定位佐證','甲：請補介面測試紀錄']]){
    const buffer=Buffer.from(await form.get('files['+index+']').arrayBuffer());
    const text=(await mammoth.extractRawText({buffer})).value;
    assert.ok(text.includes(own));assert.ok(!text.includes(other));
    assert.match(text,/本週回覆與處理結果/);assert.match(text,/上期審閱紀錄/);
  }
  await f.automation.publish(f.schedule());assert.equal(f.requests.length,1,'restart/catch-up does not duplicate delivery');
  assert.equal(f.db.weekly_report_batches[0].last_error,null);
});

test('an existing unsent batch cannot bypass review and its old payload is refreshed before delivery',async()=>{
  const f=fixture();
  const draft={id:'draft',week_key:'2026-W38',report_date:'2026-09-14',payload:payload(),due_at:'2026-09-21T04:00:00Z',status:'OPEN',accept_until:'2099-01-01',token:'draft-token'};
  f.db.weekly_report_batches.push(draft);
  await assert.rejects(()=>f.automation.sendDiscord(structuredClone(draft),f.schedule()),/等待.*PM 審核/);
  await assert.rejects(()=>f.automation.resendBatch('draft','resend-1'),/等待.*PM 審核/);
  assert.equal(f.requests.length,0);assert.equal(draft.delivery_job_id,undefined,'blocked resend does not reset delivery state');
  f.db.weekly_report_submissions[1].review_status='APPROVED';f.db.weekly_report_submissions[1].pm_feedback='乙的最新 PM 意見';
  f.files['project/subtasks.json'].subtasks=[{id:'P1',name:'已完成',owner_team:'PER',actual_progress:100}];
  await f.automation.publish(f.schedule());
  assert.equal(draft.payload.report_date,'2026-09-14');
  assert.equal(draft.payload.subtasks[0].actual_progress,100);
  assert.equal(draft.payload.previous_review.members[1].pm_feedback,'乙的最新 PM 意見');
});

test('PM cross-task handling notes reach only the matching member in the next Word',async()=>{
  const f=fixture(),decision='跨任務處理：採方案 A，請控制組於 10/09 提供 CAN 介面。';
  f.db.weekly_report_submissions[0].pm_feedback=decision;
  f.db.weekly_report_submissions[0].analysis_result={analysis:{review:{issues_and_decisions:{cross_task_issues:{reported_text:'尚待 PM 決策'}}}}};
  f.db.weekly_report_submissions[1].review_status='APPROVED';
  await f.automation.publish(f.schedule());
  const form=f.requests[0].body;
  const own=(await mammoth.extractRawText({buffer:Buffer.from(await form.get('files[0]').arrayBuffer())})).value;
  const other=(await mammoth.extractRawText({buffer:Buffer.from(await form.get('files[1]').arrayBuffer())})).value;
  assert.ok(own.includes(decision));assert.ok(!other.includes(decision));
  assert.ok(!own.includes('尚待 PM 決策'),'member source must not replace the PM decision');
  assert.match(own,/上期 PM 意見/);assert.match(own,/本週回覆與處理結果/);
  assert.doesNotMatch(own,/PM REVIEW|PM 姓名：/);
});

test('an agent wake-up honors publish time, polls waiting reviews and catches up after a missed week',async()=>{
  const f=fixture(),arms=[];f.automation.stopped=false;f.automation.arm=when=>arms.push(when.toISOString());
  await f.automation.tick();assert.equal(f.requests.length,0);assert.equal(arms.at(-1),'2026-09-14T05:16:00.000Z');
  f.setNow('2026-09-21T04:59:00Z');f.automation.wakeAfterReview();assert.equal(arms.at(-1),'2026-09-21T04:59:00.000Z');
  f.db.weekly_report_submissions[1].review_status='APPROVED';
  f.setNow('2026-09-21T05:01:00Z');await f.automation.tick();
  assert.equal(f.db.weekly_report_batches[1].week_key,'2026-W39','no obsolete unissued batch is created while waiting');
  assert.equal(f.requests.length,1);
  assert.equal(f.db.weekly_report_batches[1].payload.previous_review.week_key,'2026-W37');
});

test('PM completing review before the next scheduled time does not publish early',async()=>{
  const f=fixture();f.db.weekly_report_submissions[1].review_status='APPROVED';
  f.setNow('2026-09-14T04:59:00Z');f.automation.stopped=false;
  const arms=[];f.automation.arm=when=>arms.push(when.toISOString());
  await f.automation.tick();assert.equal(f.requests.length,0);assert.equal(f.db.weekly_report_batches.length,1);
  assert.equal(arms.at(-1),'2026-09-14T05:00:00.000Z');
});

test('feedback changing while preparing attachments prevents any message from being sent',async()=>{
  const f=fixture();f.db.weekly_report_submissions[1].review_status='APPROVED';
  const gate=f.automation.reviewGate.bind(f.automation);let calls=0;
  f.automation.reviewGate=async schedule=>{calls++;if(calls===3)f.db.weekly_report_submissions[1].review_status='PENDING';return gate(schedule);};
  const result=await f.automation.publish(f.schedule());
  assert.equal(result.deferred,true);assert.equal(f.requests.length,0);
});


const manualInput=()=>({report_date:'2026-09-14',due_at:'2026-09-21T04:00:00Z'});
async function confirm(f,input=manualInput(),id='manual-1') {
  const preview=await f.automation.previewPublication(input);
  const job={id,actor_login:'pm'};
  return {preview,job,input:{...input,preview_token:preview.preview_token}};
}
async function attachmentText(request,index=0){
  const file=request.body.get(`files[${index}]`);
  return (await mammoth.extractRawText({buffer:Buffer.from(await file.arrayBuffer())})).value;
}
function addMember(f,n){
  const config=f.files['project/team_config.json'];
  config.members.push({id:'m'+n,name:'成員'+n});
  config.categories.push({id:'TEAM'+n,name:'組'+n,active:true});
  config.category_owners['TEAM'+n]='m'+n;
  f.db.weekly_report_batches[0].payload.team_config=structuredClone(config);
}

test('manual preview is read-only and includes missing and pending members without their draft feedback',async()=>{
  const f=fixture();addMember(f,3);
  f.db.weekly_report_submissions[1].pm_feedback='未確認草稿勿發布';
  f.db.weekly_report_submissions[1].pm_task_feedback=[{target_id:'P1',actions:['未確認任務草稿']}];
  const before=structuredClone(f.db),c=await confirm(f);
  assert.deepEqual(c.preview.counts,{REVIEWED:1,MISSING:1,PENDING:1,NOT_REQUIRED:0});
  assert.deepEqual(f.db,before);assert.equal(f.writes.length,0);assert.equal(f.requests.length,0);
  const result=await f.automation.publishManually(c.input,c.job);
  assert.equal(result.memberCount,3);assert.equal(result.revision,1);
  const current=f.db.weekly_report_batches[1];
  assert.deepEqual(f.db.weekly_report_submissions,before.weekly_report_submissions);
  assert.deepEqual(f.db.weekly_report_batches[0],before.weekly_report_batches[0],'old missing record and portal are not changed');
  assert.equal(current.payload.previous_review.members[1].pm_feedback,'');
  const texts=await Promise.all([0,1,2].map(i=>attachmentText(f.requests[0],i)));
  assert.match(texts[0],/甲：請補介面測試紀錄/);
  assert.match(texts[1],/上期 PM 回饋待補/);assert.match(texts[2],/上期未繳交/);
  assert.doesNotMatch(texts.join(''),/未確認草稿勿發布|未確認任務草稿/);
  const message=JSON.parse(f.requests[0].body.get('payload_json'));
  assert.match(message.content,/上期未繳或待審者也有本期附件/);
  assert.ok(message.content.includes(current.token));
  assert.deepEqual(message.allowed_mentions,{parse:[]});
});

test('manual publish works before the scheduled hour and with automatic publication disabled',async()=>{
  const f=fixture();f.setNow('2026-09-14T01:00:00Z');f.automation.options={...options,enabled:false};
  const c=await confirm(f);await f.automation.publishManually(c.input,c.job);
  assert.equal(f.requests.length,1);
});

test('manual publication and automatic catch-up serialize and never resend after PM finishes later',async()=>{
  const f=fixture(),c=await confirm(f);
  await Promise.all([f.automation.publishManually(c.input,c.job),f.automation.publish(f.schedule())]);
  assert.equal(f.requests.length,1);assert.equal(f.db.weekly_report_batches.length,2);
  f.db.weekly_report_submissions[1].review_status='APPROVED';
  f.db.weekly_report_submissions[1].pm_feedback='後來完成的意見';
  await f.automation.publish(f.schedule());
  await f.automation.publishManually(c.input,c.job);
  assert.equal(f.requests.length,1);
  assert.doesNotMatch(await attachmentText(f.requests[0],1),/後來完成的意見/);
  await assert.rejects(()=>f.automation.previewPublication(manualInput()),/此週已發布/);
});

test('a changed roster, official progress or confirmed feedback invalidates the preview without sending',async()=>{
  for(const change of [f=>addMember(f,3),f=>{f.files['project/subtasks.json'].subtasks.push({id:'C1',name:'新工作',owner_team:'CTL',actual_progress:30});},
    f=>{f.db.weekly_report_submissions[0].pm_feedback='更新確認意見';}]){
    const f=fixture(),c=await confirm(f);change(f);
    await assert.rejects(()=>f.automation.publishManually(c.input,c.job),/重新預覽/);
    assert.equal(f.requests.length,0);assert.equal(f.db.weekly_report_batches.length,1);
  }
});

test('feedback update publishes v2 with reviewed feedback while preserving portal, scope, baseline and submissions',async()=>{
  const f=fixture(),c=await confirm(f);await f.automation.publishManually(c.input,c.job);
  const batch=f.db.weekly_report_batches[1],before=structuredClone(batch);
  f.db.weekly_report_submissions.push({id:'current-submission',batch_id:batch.id,member_id:'m1',revision:1,is_current:true,status:'queued',review_status:'PENDING'});
  const submissions=structuredClone(f.db.weekly_report_submissions);
  f.db.weekly_report_submissions[1].review_status='APPROVED';
  f.db.weekly_report_submissions[1].pm_feedback='乙已確認的更新意見';
  f.files['project/subtasks.json'].subtasks=[{id:'P1',name:'新基準',owner_team:'PER',actual_progress:70}];
  const update=await confirm(f,{batch_id:batch.id},'manual-update');
  assert.equal(update.preview.revision,2);
  await f.automation.publishManually(update.input,update.job);
  assert.equal(f.requests.length,2);assert.equal(f.db.weekly_report_batches.length,2);
  for(const key of ['id','token','due_at','accept_until','pm_user_id'])assert.equal(batch[key],before[key]);
  for(const key of ['team_config','subtasks','work_packages','checkpoints'])assert.deepEqual(batch.payload[key],before.payload[key]);
  assert.deepEqual(f.db.weekly_report_submissions.at(-1),submissions.at(-1));
  assert.match(JSON.parse(f.requests[1].body.get('payload_json')).content,/更新版 v2/);
  assert.match(f.requests[1].body.get('files[1]').name,/_v2\.docx$/);
  assert.match(await attachmentText(f.requests[1],1),/乙已確認的更新意見/);
  assert.match(await attachmentText(f.requests[1],1),/發布更新版 v2/);
  assert.doesNotMatch(await attachmentText(f.requests[0],1),/乙已確認的更新意見/);
  await f.automation.publishManually(update.input,update.job);
  await f.automation.publish(f.schedule());assert.equal(f.requests.length,2,'job replay and scheduler do not create v3');
});

test('interrupted manual delivery resumes only remaining chunks from the confirmed snapshot, even across weeks',async()=>{
  const f=fixture();for(let i=3;i<=6;i++)addMember(f,i);
  const send=f.automation.fetchFn;let fail=true,attempts=0;
  f.automation.fetchFn=async(...args)=>{attempts++;if(attempts===2&&fail)throw new Error('simulated network failure');return send(...args);};
  const c=await confirm(f);await assert.rejects(()=>f.automation.publishManually(c.input,c.job),/simulated network failure/);
  const batch=f.db.weekly_report_batches[1];
  assert.equal(JSON.parse(batch.discord_message_id).length,1);assert.equal(batch.discord_message_sent_at,null);
  f.db.weekly_report_submissions.push({id:'s6',batch_id:'old',member_id:'m6',is_current:true,revision:1,status:'completed',review_status:'APPROVED',pm_feedback:'發送途中才完成的意見'});
  f.files['project/team_config.json'].members[5].name='新名字';
  const resume=await f.automation.previewPublication({batch_id:batch.id});
  assert.equal(resume.resume,true);assert.equal(resume.revision,1);
  assert.equal(resume.members[5].member_name,'成員6');assert.equal(resume.members[5].state,'MISSING');
  fail=false;f.setNow('2026-09-22T05:00:00Z');
  await f.automation.publishManually(c.input,c.job);
  assert.equal(f.requests.length,2);assert.equal(f.requests[1].body.get('files[1]'),null);
  const text=await attachmentText(f.requests[1]);assert.match(text,/上期未繳交/);assert.doesNotMatch(text,/發送途中才完成的意見|新名字/);
  await f.automation.publishManually(c.input,c.job);assert.equal(f.requests.length,2);
});

test('automatic catch-up resumes a confirmed partial manual edition but respects a closed batch',async()=>{
  const f=fixture();let fail=true;const send=f.automation.fetchFn;
  f.automation.fetchFn=(...args)=>{if(fail)throw new Error('temporary network failure');return send(...args);};
  const c=await confirm(f);await assert.rejects(()=>f.automation.publishManually(c.input,c.job),/temporary/);
  const batch=f.db.weekly_report_batches[1];batch.status='CLOSED';fail=false;
  await assert.rejects(()=>f.automation.publish(f.schedule()),/weekly_batch_closed/);assert.equal(f.requests.length,0);
  batch.status='OPEN';await f.automation.publish(f.schedule());assert.equal(f.requests.length,1);
});

test('first publication and new members need no previous feedback; invalid dates and deadlines are rejected',async()=>{
  const f=fixture();f.db.weekly_report_batches=[];f.db.weekly_report_submissions=[];
  const c=await confirm(f);assert.equal(c.preview.counts.NOT_REQUIRED,2);
  await f.automation.publishManually(c.input,c.job);assert.equal(f.requests.length,1);
  const now=new Date('2026-09-14T05:00:00Z');
  for(const report_date of ['2026-02-30','2026-09-15','2026-09-07'])assert.throws(()=>manualWeeklySchedule({...manualInput(),report_date},now));
  for(const due_at of ['invalid','2026-09-14T04:00:00Z'])assert.throws(()=>manualWeeklySchedule({...manualInput(),due_at},now));
  const next=manualWeeklySchedule({report_date:'2026-12-28',due_at:'2027-01-04T04:00:00Z'},now);
  assert.equal(next.weekKey,'2026-W53');
});
