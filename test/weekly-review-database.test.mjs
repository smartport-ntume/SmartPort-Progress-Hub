import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const pm='00000000-0000-4000-8000-000000000001';
const engineer='00000000-0000-4000-8000-000000000002';
const member='00000000-0000-4000-8000-000000000003';
const batchId='00000000-0000-4000-8000-000000000010';
const token='test-only-weekly-token-1234567890';

test('Postgres enforces weekly review permissions, report versions, durable feedback and review recovery', async t => {
  const db=new PGlite();t.after(()=>db.close());
  await db.exec(`
    create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as
      $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb default '{}');
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$ select string_to_array($1,'/') $$;
    create publication supabase_realtime;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant select,insert,delete on storage.objects to authenticated;
  `);
  const migrations=['202609030001_gateway.sql','202609080001_team_config.sql',
    '202609100001_weekly_discord_automation.sql','202609100002_passwordless_weekly_portal.sql',
    '202609110002_weekly_review_cycle.sql'];
  for(const name of migrations){
    let sql=await readFile(new URL('../supabase/migrations/'+name,import.meta.url),'utf8');
    // Supabase installs pgcrypto. PGlite's PostgreSQL core already supplies gen_random_uuid;
    // none of these migrations uses an extension-only cryptographic function.
    sql=sql.replace('create extension if not exists pgcrypto;','');
    await db.exec(sql);
  }
  await db.query(`insert into auth.users(id,email) values ($1,'pm@example.test'),($2,'engineer@example.test'),($3,'member@example.test')`,[pm,engineer,member]);
  await db.query(`update public.profiles set role=case user_id when $1::uuid then 'PM' when $2::uuid then 'ENGINEER' else 'DENIED' end,can_trigger_codex=user_id=$1::uuid`,[pm,engineer]);
  const payload={team_config:{members:[{id:'member-1',name:'測試成員',active:true}],categories:[{id:'CTL',active:true}],category_owners:{CTL:'member-1'}},report_date:'2099-01-05'};
  await db.query(`insert into public.weekly_report_batches(id,week_key,report_date,due_at,accept_until,token,payload,pm_user_id)
    values($1,'2099-W01','2099-01-05','2099-01-12T04:00:00Z','2099-01-19T04:00:00Z',$2,$3,$4)`,[batchId,token,JSON.stringify(payload),pm]);
  async function asUser(id){await db.exec('reset role');await db.query(`select set_config('request.jwt.claim.sub',$1,false)`,[id||'']);await db.exec('set role authenticated');}
  async function admin(){await db.exec('reset role');}
  async function rpc(name,args=[]){const {rows}=await db.query(`select to_jsonb(public.${name}(${args.map((_,i)=>'$'+(i+1)).join(',')})) as value`,args);return rows[0].value;}
  async function submit(){
    await asUser(member);
    const grant=await rpc('prepare_weekly_report_upload',[token,'member-1','report.docx','application/octet-stream',100]);
    await db.query(`insert into storage.objects(bucket_id,name,metadata) values('weekly-reports',$1,'{"size":100}')`,[grant.storage_path]);
    return rpc('submit_weekly_report',[token,grant.upload_id]);
  }
  async function complete(submission,label='done'){
    await admin();
    const result={report:{path:`weekly_reports/2099/${submission.submission_id}.docx`,html_url:'https://github.com/example/report'},
      analysis:{report_summary:label,review:{completeness_score:80,missing_items:['補充測試證據']}},proposals:[]};
    await db.query(`update public.gateway_jobs set status='completed',result=$2,finished_at=now() where id=$1`,[submission.job_id,JSON.stringify(result)]);
  }
  await t.test('anonymous and engineers cannot access PM actions or private report details',async()=>{
    await asUser(null);await assert.rejects(()=>rpc('list_pm_weekly_reports'),/pm_role_required/);
    await asUser(member);await assert.rejects(()=>rpc('get_pm_weekly_report',[batchId]),/pm_role_required/);
    await asUser(engineer);await assert.rejects(()=>rpc('enqueue_weekly_report_action',['resend',batchId,{},'denied-action']),/pm_role_required/);
    await assert.rejects(()=>db.query(`update public.weekly_report_submissions set review_status='APPROVED'`),/permission denied/);
  });
  const first=await submit();await complete(first);
  await t.test('feedback survives expiration of the temporary job record',async()=>{
    await admin();await db.query('delete from public.gateway_jobs where id=$1',[first.job_id]);
    await asUser(member);
    const feedback=await rpc('get_weekly_report_feedback',[token,'member-1']);
    assert.equal(feedback.versions[0].review.completeness_score,80);
    assert.equal(feedback.versions[0].revision,1);
    assert.equal(JSON.stringify(feedback).includes('weekly_reports/'),false);
    await assert.rejects(()=>rpc('get_weekly_report_feedback',['not-a-valid-token','member-1']),/invalid_weekly_report_link/);
  });
  const second=await submit();await complete(second);
  await t.test('a new submission supersedes the pending old version',async()=>{
    await asUser(pm);
    const old=(await rpc('get_pm_weekly_report',[first.submission_id])).submission;
    assert.equal(old.is_current,false);assert.equal(old.review_status,'SUPERSEDED');
    const latest=(await rpc('get_pm_weekly_report',[second.submission_id])).submission;
    assert.equal(latest.revision,2);
    await assert.rejects(()=>rpc('enqueue_weekly_report_action',['approve',first.submission_id,{analysis_job_id:first.job_id,issue_numbers:[]},'old-version-approve']),/weekly_submission_superseded/);
    await assert.rejects(()=>rpc('enqueue_weekly_report_action',['approve',second.submission_id,{analysis_job_id:first.job_id,issue_numbers:[]},'stale-analysis-approve']),/weekly_analysis_changed/);
  });
  let approval;
  await t.test('queued PM review reserves the version and blocks racing resubmission',async()=>{
    await asUser(pm);
    const args=['approve',second.submission_id,{analysis_job_id:second.job_id,issue_numbers:[],feedback:'可結案'},'approve-current-report'];
    approval=await rpc('enqueue_weekly_report_action',args);
    assert.equal((await rpc('enqueue_weekly_report_action',args)).id,approval.id);
    await assert.rejects(()=>submit(),/weekly_report_review_in_progress/);
  });
  await t.test('failed reviews remain reserved until an explicit resume',async()=>{
    await admin();await db.query(`update public.gateway_jobs set status='failed',error='simulated failure' where id=$1`,[approval.id]);
    await asUser(pm);
    assert.equal((await rpc('get_pm_weekly_report',[second.submission_id])).submission.review_status,'REVIEW_FAILED');
    await assert.rejects(()=>rpc('enqueue_weekly_report_action',['retry',second.submission_id,{},'unsafe-regrade-after-partial']),/weekly_report_job_in_progress/);
    const resumed=await rpc('enqueue_weekly_report_action',['resume_review',second.submission_id,{expected:{},issue_numbers:[]},'resume-failed-review']);
    assert.equal(resumed.payload.decision,'approve');assert.equal(resumed.payload.feedback,'可結案');
    await admin();
    await db.query(`update public.weekly_report_submissions set review_status='APPROVED',pm_feedback='完成審核',reviewed_at=now() where id=$1`,[second.submission_id]);
    await db.query(`update public.gateway_jobs set status='completed',result='{"ok":true}',finished_at=now() where id=$1`,[resumed.id]);
  });
  const third=await submit();await complete(third);
  await t.test('resubmission preserves approved history and records a new revision',async()=>{
    await asUser(member);const versions=(await rpc('get_weekly_report_feedback',[token,'member-1'])).versions;
    assert.equal(versions[0].revision,3);assert.equal(versions[1].review_status,'APPROVED');
    assert.equal(versions[1].pm_feedback,'完成審核');assert.equal(versions[1].is_current,false);
  });
  await t.test('a returned report requires reanalysis or a new revision before another review',async()=>{
    await asUser(pm);
    await assert.rejects(()=>rpc('enqueue_weekly_report_action',['return',third.submission_id,
      {analysis_job_id:third.job_id,issue_numbers:[]},'return-without-reason']),/return_reason_required/);
    const returned=await rpc('enqueue_weekly_report_action',['return',third.submission_id,
      {analysis_job_id:third.job_id,issue_numbers:[],feedback:'請補上證據'},'return-with-feedback']);
    await admin();
    await db.query(`update public.weekly_report_submissions set review_status='CHANGES_REQUESTED',pm_feedback='請補上證據' where id=$1`,[third.submission_id]);
    await db.query(`update public.gateway_jobs set status='completed',result='{"ok":true}',finished_at=now() where id=$1`,[returned.id]);
    await asUser(pm);
    await assert.rejects(()=>rpc('enqueue_weekly_report_action',['approve',third.submission_id,
      {analysis_job_id:third.job_id,issue_numbers:[]},'approve-returned-report']),/weekly_report_returned_reanalyze_or_resubmit/);
  });
  await t.test('reanalysis reuses the archive and cannot be triggered by an unauthorized PM',async()=>{
    await admin();await db.query('update public.profiles set can_trigger_codex=false where user_id=$1',[pm]);
    await asUser(pm);await assert.rejects(()=>rpc('enqueue_weekly_report_action',['retry',third.submission_id,{},'no-codex-retry']),/local_codex_not_allowed/);
    await admin();await db.query('update public.profiles set can_trigger_codex=true where user_id=$1',[pm]);
    await asUser(pm);
    const retry=await rpc('enqueue_weekly_report_action',['retry',third.submission_id,{},'retry-original-file']);
    assert.equal(retry.kind,'analyze_weekly_report');
    const row=(await rpc('get_pm_weekly_report',[third.submission_id])).submission;
    assert.equal(row.analysis_job_key,retry.id);assert.ok(row.report_path.startsWith('weekly_reports/'));
    assert.equal(row.pm_feedback,'請補上證據');
    await complete({submission_id:third.submission_id,job_id:retry.id},'regraded');
    await asUser(pm);const detail=await rpc('get_pm_weekly_report',[third.submission_id]);
    assert.equal(detail.runs.length,2);assert.equal(detail.submission.analysis_result.analysis.report_summary,'regraded');
    const batches=await rpc('list_pm_weekly_reports');assert.equal(batches.batches[0].submissions.length,3);
  });
});
