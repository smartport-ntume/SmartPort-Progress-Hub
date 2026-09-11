-- Requires the existing Gateway, team configuration and passwordless portal migrations.
-- Report history survives gateway job retention. All PM mutations use the existing Agent queue.
begin;

alter table public.weekly_report_submissions
  add column if not exists revision integer not null default 1,
  add column if not exists is_current boolean not null default true,
  add column if not exists superseded_by uuid,
  add column if not exists report_path text,
  add column if not exists report_html_url text,
  add column if not exists analysis_result jsonb,
  add column if not exists analysis_job_key uuid,
  add column if not exists review_status text not null default 'PENDING',
  add column if not exists review_job_id uuid references public.gateway_jobs(id) on delete set null,
  add column if not exists pm_feedback text not null default '',
  add column if not exists review_result jsonb,
  add column if not exists reviewed_at timestamptz,
  add column if not exists reviewed_by uuid references auth.users(id) on delete set null;

alter table public.weekly_report_batches
  add column if not exists delivery_job_id uuid;

alter table public.weekly_report_submissions
  add constraint weekly_review_status_check check (review_status in
    ('PENDING', 'REVIEWING', 'APPROVED', 'CHANGES_REQUESTED', 'SUPERSEDED', 'REVIEW_FAILED')),
  add constraint weekly_review_result_size check (
    (analysis_result is null or octet_length(analysis_result::text) <= 4194304)
    and (review_result is null or octet_length(review_result::text) <= 4194304)
    and char_length(pm_feedback) <= 4000);

with versions as (
  select id, row_number() over (partition by batch_id, member_id order by submitted_at, id) n,
    first_value(id) over (partition by batch_id, member_id order by submitted_at desc, id desc) latest
  from public.weekly_report_submissions
)
update public.weekly_report_submissions s set revision = v.n, is_current = s.id = v.latest,
  superseded_by = case when s.id <> v.latest then v.latest end,
  review_status = case when s.id <> v.latest then 'SUPERSEDED' else s.review_status end
from versions v where s.id = v.id;

update public.weekly_report_submissions s
set report_path = j.result #>> '{report,path}',
    report_html_url = j.result #>> '{report,html_url}', analysis_result = j.result, analysis_job_key = j.id
from public.gateway_jobs j where j.id = s.job_id and j.result is not null;

create unique index weekly_current_submission_idx
  on public.weekly_report_submissions(batch_id, member_id) where is_current;
create unique index weekly_submission_revision_idx
  on public.weekly_report_submissions(batch_id, member_id, revision);
create index weekly_submission_report_path_idx on public.weekly_report_submissions(report_path);

create table public.weekly_report_analysis_runs (
  id uuid primary key, -- Durable job identity; deliberately not a foreign key to expiring jobs.
  submission_id uuid not null references public.weekly_report_submissions(id) on delete cascade,
  status text not null,
  result jsonb,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  check (result is null or octet_length(result::text) <= 4194304)
);
alter table public.weekly_report_analysis_runs enable row level security;
revoke all on public.weekly_report_analysis_runs from public, anon, authenticated;
grant select, insert, update, delete on public.weekly_report_analysis_runs to service_role;

alter table public.gateway_jobs drop constraint gateway_jobs_kind_check;
alter table public.gateway_jobs add constraint gateway_jobs_kind_check check (kind in (
  'write_work_packages','write_fsr','write_checkpoints','write_team_config',
  'create_subtask','update_subtask','archive_subtask','patch_checkpoint',
  'write_reference_model','write_item_functions','write_technical_requirements',
  'create_manual_proposal','approve_proposal','reject_proposal','analyze_weekly_report',
  'refresh_snapshots','review_weekly_submission','manage_weekly_batch'
));

create or replace function public.smartport_version_weekly_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
declare v_old public.weekly_report_submissions%rowtype;
begin
  perform pg_advisory_xact_lock(hashtextextended(new.batch_id::text || ':' || new.member_id, 0));
  select * into v_old from public.weekly_report_submissions
    where batch_id = new.batch_id and member_id = new.member_id and is_current for update;
  if found then
    if v_old.review_status in ('REVIEWING', 'REVIEW_FAILED') or exists (
      select 1 from public.gateway_jobs where id = v_old.review_job_id and status in ('queued','running')
    ) then raise exception 'weekly_report_review_in_progress'; end if;
    new.revision := v_old.revision + 1;
    update public.weekly_report_submissions set is_current = false, superseded_by = new.id,
      review_status = case when review_status = 'APPROVED' then review_status else 'SUPERSEDED' end
      where id = v_old.id;
    update public.gateway_jobs set status = 'cancelled', error = 'Replaced by a newer submission',
      finished_at = now() where id = v_old.job_id and status = 'queued';
  end if;
  return new;
end; $$;
create trigger weekly_submission_version before insert on public.weekly_report_submissions
  for each row execute function public.smartport_version_weekly_submission();

create or replace function public.smartport_sync_weekly_submission()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  insert into public.weekly_report_analysis_runs(id, submission_id, status, result, error, finished_at)
    select new.id, s.id, new.status, new.result, new.error, new.finished_at
    from public.weekly_report_submissions s where s.job_id = new.id
    on conflict (id) do update set status = excluded.status, result = excluded.result,
      error = excluded.error, finished_at = excluded.finished_at;
  update public.weekly_report_submissions set status = new.status,
    analysis_job_key = new.id,
    error = case when new.status = 'failed' then new.error else null end,
    analysis_result = case when new.status = 'completed' then new.result else analysis_result end,
    report_path = coalesce(new.result #>> '{report,path}', report_path),
    report_html_url = coalesce(new.result #>> '{report,html_url}', report_html_url)
    where job_id = new.id;
  if new.kind = 'review_weekly_submission' then
    update public.weekly_report_submissions set
      review_status = case new.status when 'running' then 'REVIEWING'
        when 'failed' then 'REVIEW_FAILED' when 'cancelled' then 'REVIEW_FAILED' else review_status end,
      error = case when new.status in ('failed','cancelled') then new.error else error end
      where review_job_id = new.id;
  end if;
  return new;
end; $$;

-- Keep roster status visible to holders of the existing batch link. Detailed feedback is
-- returned separately and excludes Git paths, internal job errors and the project context.
create or replace function public.get_weekly_report_batch(p_token text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b public.weekly_report_batches%rowtype; rows jsonb;
begin
  if auth.uid() is null then raise exception 'weekly_portal_login_required' using errcode='42501'; end if;
  if char_length(coalesce(p_token,'')) not between 24 and 128 then raise exception 'invalid_weekly_report_link'; end if;
  select * into b from public.weekly_report_batches where token = p_token;
  if not found then raise exception 'weekly_report_link_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'member_id',s.member_id,'member_name',s.member_name,'status',s.status,
    'revision',s.revision,'is_current',s.is_current,'review_status',s.review_status,
    'late',s.late,'submitted_at',s.submitted_at,'reviewed_at',s.reviewed_at
  ) order by s.submitted_at desc, s.revision desc),'[]'::jsonb) into rows
    from public.weekly_report_submissions s where s.batch_id=b.id;
  return jsonb_build_object('id',b.id,'week_key',b.week_key,'report_date',b.report_date,
    'due_at',b.due_at,'accept_until',b.accept_until,'status',b.status,
    'can_submit',b.status='OPEN' and now()<=b.accept_until,'payload',b.payload,'submissions',rows);
end; $$;

create function public.get_weekly_report_feedback(p_token text, p_member_id text)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare b uuid; rows jsonb;
begin
  if auth.uid() is null then raise exception 'weekly_portal_login_required' using errcode='42501'; end if;
  if char_length(coalesce(p_token,'')) not between 24 and 128 then raise exception 'invalid_weekly_report_link'; end if;
  select id into b from public.weekly_report_batches where token=p_token;
  if b is null then raise exception 'weekly_report_link_not_found'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',s.id,'revision',s.revision,'is_current',s.is_current,'status',s.status,
    'review_status',s.review_status,'pm_feedback',s.pm_feedback,'reviewed_at',s.reviewed_at,
    'submitted_at',s.submitted_at,'review',s.analysis_result #> '{analysis,review}',
    'summary',s.analysis_result #>> '{analysis,report_summary}'
  ) order by s.revision desc),'[]'::jsonb) into rows from public.weekly_report_submissions s
    where s.batch_id=b and s.member_id=p_member_id;
  return jsonb_build_object('versions',rows);
end; $$;

create function public.list_pm_weekly_reports(p_before date default null)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare rows jsonb;
begin
  if public.smartport_role() is distinct from 'PM' then raise exception 'pm_role_required' using errcode='42501'; end if;
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',b.id,'week_key',b.week_key,'report_date',b.report_date,'due_at',b.due_at,
    'accept_until',b.accept_until,'status',b.status,'token',b.token,
    'discord_message_sent_at',b.discord_message_sent_at,'last_error',b.last_error,
    'members',b.payload #> '{team_config,members}',
    'submissions',coalesce((select jsonb_agg(jsonb_build_object(
      'id',s.id,'member_id',s.member_id,'member_name',s.member_name,'revision',s.revision,
      'is_current',s.is_current,'status',s.status,'review_status',s.review_status,
      'job_id',s.job_id,'analysis_job_key',s.analysis_job_key,'review_job_id',s.review_job_id,'late',s.late,'error',s.error,
      'submitted_at',s.submitted_at,'reviewed_at',s.reviewed_at
    ) order by s.revision desc) from public.weekly_report_submissions s where s.batch_id=b.id),'[]'::jsonb)
  ) order by b.report_date desc),'[]'::jsonb) into rows from (
    select * from public.weekly_report_batches where p_before is null or report_date < p_before
    order by report_date desc limit 26
  ) b;
  return jsonb_build_object('batches',rows);
end; $$;

create function public.get_pm_weekly_report(p_submission_id uuid)
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare s public.weekly_report_submissions%rowtype; b public.weekly_report_batches%rowtype; runs jsonb;
begin
  if public.smartport_role() is distinct from 'PM' then raise exception 'pm_role_required' using errcode='42501'; end if;
  select * into s from public.weekly_report_submissions where id=p_submission_id;
  if not found then raise exception 'weekly_submission_not_found'; end if;
  select * into b from public.weekly_report_batches where id=s.batch_id;
  select coalesce(jsonb_agg(jsonb_build_object('id',r.id,'status',r.status,'created_at',r.created_at,
    'finished_at',r.finished_at,'error',r.error) order by r.created_at desc),'[]'::jsonb) into runs
    from public.weekly_report_analysis_runs r where r.submission_id=s.id;
  return jsonb_build_object('submission',to_jsonb(s),'week_key',b.week_key,'runs',runs);
end; $$;

create function public.enqueue_weekly_report_action(
  p_action text, p_id uuid, p_payload jsonb, p_idempotency_key text
) returns public.gateway_jobs language plpgsql security definer set search_path = '' as $$
declare u uuid:=auth.uid(); p public.profiles%rowtype; s public.weekly_report_submissions%rowtype;
  b public.weekly_report_batches%rowtype; j public.gateway_jobs%rowtype;
  kind text; body jsonb; teams jsonb;
begin
  select * into p from public.profiles where user_id=u and active and role='PM';
  if not found then raise exception 'pm_role_required' using errcode='42501'; end if;
  if char_length(coalesce(p_idempotency_key,'')) not between 8 and 128 then raise exception 'invalid_idempotency_key'; end if;
  if p_action is null or p_action not in ('approve','return','retry','resume_review','resend','extend') then
    raise exception 'unsupported_weekly_action'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>65536 then
    raise exception 'invalid_weekly_action_payload'; end if;
  -- Serializes double clicks and keeps the existing per-user active-job bound meaningful.
  perform pg_advisory_xact_lock(hashtextextended(u::text,0));
  select * into j from public.gateway_jobs where actor_id=u and idempotency_key=p_idempotency_key;
  if found then return j; end if;
  if (select count(*) from public.gateway_jobs where actor_id=u and status in ('queued','running'))>=20 then
    raise exception 'too_many_active_jobs'; end if;
  if p_action in ('approve','return','retry','resume_review') then
    select * into s from public.weekly_report_submissions where id=p_id;
    if not found then raise exception 'weekly_submission_not_found'; end if;
    perform pg_advisory_xact_lock(hashtextextended(s.batch_id::text || ':' || s.member_id,0));
    select * into s from public.weekly_report_submissions where id=p_id for update;
    if not s.is_current then raise exception 'weekly_submission_superseded'; end if;
    if s.review_status='APPROVED' then raise exception 'weekly_report_already_approved'; end if;
    if exists(select 1 from public.gateway_jobs where id=s.review_job_id and status in ('queued','running')) then
      raise exception 'weekly_report_review_in_progress'; end if;
    select * into b from public.weekly_report_batches where id=s.batch_id;
    if p_action='retry' then
      if not p.can_trigger_codex then raise exception 'local_codex_not_allowed_for_this_account' using errcode='42501'; end if;
      if s.status in ('queued','running') or s.review_status in ('REVIEWING','REVIEW_FAILED') then
        raise exception 'weekly_report_job_in_progress'; end if;
      select coalesce(jsonb_agg(c->>'id'),'[]'::jsonb) into teams
        from jsonb_array_elements(b.payload #> '{team_config,categories}') c
        where b.payload #>> array['team_config','category_owners',c->>'id'] = s.member_id;
      if jsonb_array_length(teams)=0 then raise exception 'weekly_report_member_has_no_responsible_category'; end if;
      kind:='analyze_weekly_report';
      body:=jsonb_build_object('submission_id',s.id,'storage_path',s.storage_path,'filename',s.filename,
        'report_date',b.report_date,'owner_team',teams->>0,'owner_teams',teams,
        'member_id',s.member_id,'member_name',s.member_name,'scope_subtask_ids','[]'::jsonb);
    else
      if p_action='resume_review' then
        if s.review_status<>'REVIEW_FAILED' then raise exception 'weekly_review_not_failed'; end if;
        select payload into body from public.gateway_jobs where id=s.review_job_id;
        body:=coalesce(body,s.review_result->'request');
        if body is null then raise exception 'weekly_review_request_missing'; end if;
        body:=body||jsonb_build_object('expected',coalesce(p_payload->'expected',body->'expected','{}'::jsonb));
        if p_payload ? 'issue_numbers' then
          if jsonb_typeof(p_payload->'issue_numbers') is distinct from 'array'
            or jsonb_array_length(p_payload->'issue_numbers')>200 then raise exception 'invalid_weekly_proposal_selection'; end if;
          body:=body||jsonb_build_object('issue_numbers',p_payload->'issue_numbers');
        end if;
      else
        if s.review_status in ('REVIEWING','REVIEW_FAILED') then raise exception 'resume_existing_weekly_review_first'; end if;
        if s.review_status='CHANGES_REQUESTED' then raise exception 'weekly_report_returned_reanalyze_or_resubmit'; end if;
        if s.status<>'completed' or s.analysis_result is null then raise exception 'weekly_analysis_not_complete'; end if;
        if coalesce(p_payload->>'analysis_job_id','')<>coalesce(s.analysis_job_key::text,s.job_id::text,'') then
          raise exception 'weekly_analysis_changed_refresh_required'; end if;
        if jsonb_typeof(p_payload->'issue_numbers') is distinct from 'array'
          or jsonb_array_length(p_payload->'issue_numbers')>200 then raise exception 'invalid_weekly_proposal_selection'; end if;
        if char_length(coalesce(p_payload->>'feedback',''))>4000 then raise exception 'weekly_feedback_too_long'; end if;
        if p_action='return' and btrim(coalesce(p_payload->>'feedback',''))='' then raise exception 'return_reason_required'; end if;
        body:=jsonb_build_object('submission_id',s.id,'analysis_job_id',coalesce(s.analysis_job_key,s.job_id),'decision',p_action,
          'issue_numbers',p_payload->'issue_numbers','feedback',coalesce(p_payload->>'feedback',''),
          'expected',coalesce(p_payload->'expected','{}'::jsonb));
      end if;
      kind:='review_weekly_submission';
    end if;
  else
    select * into b from public.weekly_report_batches where id=p_id for update;
    if not found then raise exception 'weekly_batch_not_found'; end if;
    kind:='manage_weekly_batch';
    body:=jsonb_build_object('batch_id',b.id,'action',p_action);
    if p_action='extend' then
      if (p_payload->>'due_at')::timestamptz is null
        or (p_payload->>'due_at')::timestamptz <= greatest(b.due_at,now()) then raise exception 'extension_must_be_later'; end if;
      body:=body||jsonb_build_object('due_at',(p_payload->>'due_at')::timestamptz);
    end if;
  end if;
  insert into public.gateway_jobs(actor_id,actor_login,kind,payload,idempotency_key)
    values(u,coalesce(nullif(p.login,''),p.display_name,u::text),kind,body,p_idempotency_key) returning * into j;
  if p_action='retry' then
    update public.weekly_report_submissions set job_id=j.id,analysis_job_key=j.id,status='queued',error=null,review_status='PENDING',
      review_job_id=null where id=s.id;
  elsif kind='review_weekly_submission' then
    update public.weekly_report_submissions set review_job_id=j.id,review_status='REVIEWING',error=null,
      review_result=coalesce(review_result,'{}'::jsonb)||jsonb_build_object('request',body) where id=s.id;
  end if;
  return j;
end; $$;

create function public.smartport_weekly_review_version() returns integer
language sql stable set search_path = '' as $$ select 1; $$;

revoke all on function public.get_weekly_report_feedback(text,text) from public,anon;
revoke all on function public.list_pm_weekly_reports(date) from public,anon;
revoke all on function public.get_pm_weekly_report(uuid) from public,anon;
revoke all on function public.enqueue_weekly_report_action(text,uuid,jsonb,text) from public,anon;
revoke all on function public.smartport_weekly_review_version() from public,anon;
grant execute on function public.get_weekly_report_feedback(text,text) to authenticated;
grant execute on function public.list_pm_weekly_reports(date) to authenticated;
grant execute on function public.get_pm_weekly_report(uuid) to authenticated;
grant execute on function public.enqueue_weekly_report_action(text,uuid,jsonb,text) to authenticated;
grant execute on function public.smartport_weekly_review_version() to authenticated,service_role;

commit;
