-- Editable per-work-package feedback, PM progress correction and unrestricted late intake.
-- Run after 202609110002_weekly_review_cycle.sql, then update/restart the Agent.
begin;
-- Storage RLS must agree with the portal RPCs; only each upload grant expires.
create or replace function public.smartport_valid_weekly_upload_path(p_name text)
returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce(auth.uid() is not null and exists (
    select 1 from public.weekly_report_upload_grants g
    join public.weekly_report_batches b on b.id=g.batch_id
    where g.storage_path=p_name and g.created_by=auth.uid()
      and g.used_at is null and g.expires_at>now() and b.status='OPEN'
  ),false)
$$;
alter table public.weekly_report_submissions
  add column if not exists pm_task_feedback jsonb,
  add column if not exists feedback_version integer not null default 0;

create or replace function public.smartport_validate_task_feedback(p_items jsonb, p_batch jsonb, p_member text)
returns void language plpgsql set search_path = '' as $$
declare item jsonb; line jsonb; field text; target jsonb;
begin
  if jsonb_typeof(p_items) is distinct from 'array' or jsonb_array_length(p_items)>200
    or octet_length(p_items::text)>60000 then raise exception 'invalid_weekly_task_feedback'; end if;
  for item in select value from jsonb_array_elements(p_items) loop
    if jsonb_typeof(item) is distinct from 'object'
      or coalesce(item->>'target_type','') not in ('WP','SUBTASK','GENERAL')
      or jsonb_typeof(item->'target_id') is distinct from 'string'
      or char_length(item->>'target_id')>128 then raise exception 'invalid_weekly_feedback_target'; end if;
    if item->>'target_type'='GENERAL' then
      if item->>'target_id'<>'' then raise exception 'invalid_weekly_feedback_target'; end if;
    elsif item->>'target_type'='SUBTASK' then
      if not exists(select 1 from jsonb_array_elements(coalesce(p_batch->'subtasks','[]')) task
        where task->>'id'=item->>'target_id'
          and p_batch #>> array['team_config','category_owners',task->>'owner_team']=p_member)
        then raise exception 'weekly_feedback_target_not_owned'; end if;
    else
      if not exists(select 1 from jsonb_array_elements(coalesce(p_batch->'work_packages','[]')) wp
        where wp->>'id'=item->>'target_id' and (
          p_batch #>> array['team_config','category_owners',wp->>'owner']=p_member or exists(
            select 1 from jsonb_array_elements(coalesce(p_batch->'subtasks','[]')) task
            where task->>'parent_wp'=wp->>'id'
              and p_batch #>> array['team_config','category_owners',task->>'owner_team']=p_member)))
        then raise exception 'weekly_feedback_target_not_owned'; end if;
    end if;
    foreach field in array array['missing_items','actions'] loop
      if jsonb_typeof(item->field) is distinct from 'array' or jsonb_array_length(item->field)>50
        then raise exception 'invalid_weekly_feedback_text'; end if;
      for line in select value from jsonb_array_elements(item->field) loop
        if jsonb_typeof(line)<>'string' or char_length(line #>> '{}')>2000 then raise exception 'invalid_weekly_feedback_text'; end if;
      end loop;
    end loop;
  end loop;
end; $$;

create or replace function public.save_weekly_report_feedback(p_id uuid, p_analysis_job_id uuid,
  p_feedback text, p_task_feedback jsonb, p_feedback_version integer)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare s public.weekly_report_submissions%rowtype; b public.weekly_report_batches%rowtype;
begin
  if public.smartport_role() is distinct from 'PM' then raise exception 'pm_role_required' using errcode='42501'; end if;
  select * into s from public.weekly_report_submissions where id=p_id;
  if not found then raise exception 'weekly_submission_not_found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(s.batch_id::text || ':' || s.member_id,0));
  select * into s from public.weekly_report_submissions where id=p_id for update;
  if not s.is_current then raise exception 'weekly_submission_superseded'; end if;
  if s.status<>'completed' or s.review_status not in ('PENDING','APPROVED','CHANGES_REQUESTED') then
    raise exception 'weekly_report_review_in_progress'; end if;
  if p_analysis_job_id is distinct from coalesce(s.analysis_job_key,s.job_id) then raise exception 'weekly_analysis_changed_refresh_required'; end if;
  if p_feedback_version is distinct from s.feedback_version then raise exception 'weekly_feedback_changed_refresh_required'; end if;
  if char_length(coalesce(p_feedback,''))>4000 then raise exception 'weekly_feedback_too_long'; end if;
  if s.review_status='CHANGES_REQUESTED' and btrim(coalesce(p_feedback,''))='' then raise exception 'return_reason_required'; end if;
  select * into b from public.weekly_report_batches where id=s.batch_id;
  perform public.smartport_validate_task_feedback(p_task_feedback,b.payload,s.member_id);
  update public.weekly_report_submissions set pm_feedback=coalesce(p_feedback,''),pm_task_feedback=p_task_feedback,
    feedback_version=feedback_version+1 where id=p_id returning * into s;
  return jsonb_build_object('pm_feedback',s.pm_feedback,'pm_task_feedback',s.pm_task_feedback,'feedback_version',s.feedback_version);
end; $$;
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
    'can_submit',b.status='OPEN','payload',b.payload,'submissions',rows);
end; $$;

create or replace function public.get_weekly_report_feedback(p_token text, p_member_id text)
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
    'summary',s.analysis_result #>> '{analysis,report_summary}', 'task_feedback',s.pm_task_feedback
  ) order by s.revision desc),'[]'::jsonb) into rows from public.weekly_report_submissions s
    where s.batch_id=b and s.member_id=p_member_id;
  return jsonb_build_object('versions',rows);
end; $$;

create or replace function public.get_pm_weekly_report(p_submission_id uuid)
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
  return jsonb_build_object('submission',to_jsonb(s),'week_key',b.week_key,'runs',runs,'feedback_context',b.payload);
end; $$;

create or replace function public.prepare_weekly_report_upload(
  p_token text,
  p_member_id text,
  p_filename text,
  p_mime_type text,
  p_size_bytes integer
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.weekly_report_batches%rowtype;
  v_member jsonb;
  v_id uuid := gen_random_uuid();
  v_filename text;
  v_path text;
begin
  if auth.uid() is null then
    raise exception 'weekly_portal_session_required' using errcode = '42501';
  end if;
  if char_length(coalesce(p_token, '')) not between 24 and 128 then
    raise exception 'invalid_weekly_report_link';
  end if;
  if p_member_id is null or p_member_id !~ '^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$' then
    raise exception 'invalid_weekly_member';
  end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760 then
    raise exception 'weekly_report_file_too_large_10mb_max';
  end if;

  select * into v_batch
  from public.weekly_report_batches
  where token = p_token
    and status = 'OPEN';
  if not found then raise exception 'weekly_report_link_closed_or_invalid'; end if;

  select member into v_member
  from jsonb_array_elements(coalesce(v_batch.payload #> '{team_config,members}', '[]'::jsonb)) member
  where member ->> 'id' = p_member_id
    and coalesce((member ->> 'active')::boolean, true)
    and coalesce((member ->> 'weekly_report_required')::boolean, true)
  limit 1;
  if v_member is null then raise exception 'weekly_member_not_in_batch'; end if;

  v_filename := left(regexp_replace(coalesce(p_filename, ''), '[^A-Za-z0-9._-]+', '_', 'g'), 180);
  if v_filename = '' or lower(v_filename) !~ '\.(doc|docx)$' then
    raise exception 'weekly_report_file_must_be_doc_or_docx';
  end if;
  v_path := 'portal/' || v_batch.id::text || '/' || p_member_id || '/' || v_id::text || '/' || v_filename;

  if (
    select count(*) from public.weekly_report_upload_grants
    where created_by = auth.uid() and used_at is null and expires_at > now()
  ) >= 10 then
    raise exception 'too_many_pending_weekly_uploads';
  end if;

  insert into public.weekly_report_upload_grants (
    id, batch_id, member_id, member_name, created_by, storage_path,
    filename, mime_type, size_bytes, expires_at
  ) values (
    v_id, v_batch.id, p_member_id, left(v_member ->> 'name', 80), auth.uid(), v_path,
    v_filename, left(coalesce(p_mime_type, 'application/octet-stream'), 160),
    p_size_bytes, now() + interval '15 minutes'
  );

  return jsonb_build_object(
    'upload_id', v_id,
    'bucket', 'weekly-reports',
    'storage_path', v_path,
    'expires_at', now() + interval '15 minutes'
  );
end;
$$;

create or replace function public.submit_weekly_report(
  p_token text,
  p_upload_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_batch public.weekly_report_batches%rowtype;
  v_grant public.weekly_report_upload_grants%rowtype;
  v_existing public.weekly_report_submissions%rowtype;
  v_submission_id uuid := gen_random_uuid();
  v_job_id uuid := gen_random_uuid();
  v_pm_login text;
  v_owner_teams text[];
begin
  if auth.uid() is null then
    raise exception 'weekly_portal_session_required' using errcode = '42501';
  end if;
  if char_length(coalesce(p_token, '')) not between 24 and 128 then
    raise exception 'invalid_weekly_report_link';
  end if;

  select s.* into v_existing
  from public.weekly_report_submissions s
  join public.weekly_report_upload_grants g on g.id = s.upload_grant_id
  join public.weekly_report_batches b on b.id = s.batch_id
  where s.upload_grant_id = p_upload_id
    and g.created_by = auth.uid()
    and b.token = p_token;
  if found then
    return jsonb_build_object('submission_id', v_existing.id, 'job_id', v_existing.job_id, 'status', v_existing.status);
  end if;

  select * into v_grant
  from public.weekly_report_upload_grants
  where id = p_upload_id and created_by = auth.uid() and used_at is null and expires_at > now()
  for update;
  if not found then raise exception 'weekly_upload_grant_expired_or_invalid'; end if;

  select * into v_batch
  from public.weekly_report_batches
  where id = v_grant.batch_id
    and token = p_token
    and status = 'OPEN';
  if not found then raise exception 'weekly_report_link_closed_or_invalid'; end if;

  if not exists (
    select 1 from storage.objects
    where bucket_id = 'weekly-reports' and name = v_grant.storage_path
  ) then
    raise exception 'weekly_report_upload_not_found';
  end if;

  select array_agg(category ->> 'id' order by coalesce((category ->> 'order')::integer, 999))
  into v_owner_teams
  from jsonb_array_elements(coalesce(v_batch.payload #> '{team_config,categories}', '[]'::jsonb)) category
  where coalesce((category ->> 'active')::boolean, true)
    and jsonb_extract_path_text(
      v_batch.payload, 'team_config', 'category_owners', category ->> 'id'
    ) = v_grant.member_id;
  if coalesce(array_length(v_owner_teams, 1), 0) = 0 then
    raise exception 'weekly_member_has_no_responsible_category';
  end if;

  select coalesce(nullif(login, ''), nullif(display_name, ''), v_batch.pm_user_id::text)
  into v_pm_login
  from public.profiles
  where user_id = v_batch.pm_user_id and active and role = 'PM' and can_trigger_codex;
  if v_pm_login is null then raise exception 'weekly_batch_pm_no_longer_authorized'; end if;

  if (
    select count(*) from public.weekly_report_submissions
    where batch_id = v_batch.id and member_id = v_grant.member_id
  ) >= 5 then
    raise exception 'too_many_weekly_report_resubmissions';
  end if;

  insert into public.gateway_jobs (
    id, actor_id, actor_login, kind, payload, idempotency_key
  ) values (
    v_job_id,
    v_batch.pm_user_id,
    left(v_pm_login, 100),
    'analyze_weekly_report',
    jsonb_build_object(
      'submission_id', v_submission_id,
      'storage_path', v_grant.storage_path,
      'filename', v_grant.filename,
      'report_date', v_batch.report_date::text,
      'owner_team', v_owner_teams[1],
      'owner_teams', to_jsonb(v_owner_teams),
      'member_id', v_grant.member_id,
      'member_name', v_grant.member_name,
      'scope_subtask_ids', '[]'::jsonb,
      'source', 'weekly_portal'
    ),
    'weekly-portal:' || v_grant.id::text
  );

  insert into public.weekly_report_submissions (
    id, batch_id, upload_grant_id, member_id, member_name, submitted_by,
    storage_path, filename, job_id, status, late
  ) values (
    v_submission_id, v_batch.id, v_grant.id, v_grant.member_id, v_grant.member_name,
    auth.uid(), v_grant.storage_path, v_grant.filename, v_job_id, 'queued', now() > v_batch.due_at
  );

  update public.weekly_report_upload_grants set used_at = now() where id = v_grant.id;

  return jsonb_build_object(
    'submission_id', v_submission_id,
    'job_id', v_job_id,
    'status', 'queued',
    'late', now() > v_batch.due_at
  );
end;
$$;

create or replace function public.enqueue_weekly_report_action(
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
        if p_payload ? 'feedback_version' and (p_payload->>'feedback_version')::integer is distinct from s.feedback_version then
          raise exception 'weekly_feedback_changed_refresh_required'; end if;
        if p_payload ? 'task_feedback' then
          perform public.smartport_validate_task_feedback(p_payload->'task_feedback',b.payload,s.member_id);
        end if;
        if p_payload ? 'progress_overrides' then
          if jsonb_typeof(p_payload->'progress_overrides') is distinct from 'object' then raise exception 'invalid_pm_progress_overrides'; end if;
          if exists(select 1 from jsonb_each(p_payload->'progress_overrides') entry where
            not exists(select 1 from jsonb_array_elements(coalesce(s.analysis_result->'proposals','[]')) proposal
              where proposal->>'issue_number'=entry.key)
            or (jsonb_typeof(entry.value) not in ('number','null'))
            or (jsonb_typeof(entry.value)='number' and ((entry.value #>> '{}')::numeric<0 or (entry.value #>> '{}')::numeric>100)))
            then raise exception 'invalid_pm_progress_overrides'; end if;
        end if;
        body:=jsonb_build_object('submission_id',s.id,'analysis_job_id',coalesce(s.analysis_job_key,s.job_id),'decision',p_action,
          'issue_numbers',p_payload->'issue_numbers','feedback',coalesce(p_payload->>'feedback',''),
          'expected',coalesce(p_payload->'expected','{}'::jsonb),
          'progress_overrides',coalesce(p_payload->'progress_overrides','{}'::jsonb),
          'task_feedback',coalesce(p_payload->'task_feedback',s.pm_task_feedback));
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

create or replace function public.smartport_weekly_review_version() returns integer
language sql stable set search_path = '' as $$ select 2; $$;
revoke all on function public.smartport_validate_task_feedback(jsonb,jsonb,text) from public,anon,authenticated;
revoke all on function public.save_weekly_report_feedback(uuid,uuid,text,jsonb,integer) from public,anon;
grant execute on function public.save_weekly_report_feedback(uuid,uuid,text,jsonb,integer) to authenticated;
commit;
