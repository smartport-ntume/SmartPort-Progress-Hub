import test from 'node:test';
import assert from 'node:assert/strict';
import mammoth from 'mammoth';
import { WeeklyReportAutomation, weeklySchedule } from '../local-server/weekly-report-automation.mjs';
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
