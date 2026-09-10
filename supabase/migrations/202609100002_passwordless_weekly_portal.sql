-- Let weekly-report recipients use their private batch URL without a shared Guest password.
-- The browser creates a Supabase anonymous Auth session, so auth.uid(), audit ownership,
-- one-time Storage grants, expiry checks, and per-member resubmission limits still apply.

begin;

create or replace function public.get_weekly_report_batch(p_token text)
returns jsonb
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_batch public.weekly_report_batches%rowtype;
  v_submissions jsonb;
begin
  if auth.uid() is null then
    raise exception 'weekly_portal_session_required' using errcode = '42501';
  end if;
  if char_length(coalesce(p_token, '')) not between 24 and 128 then
    raise exception 'invalid_weekly_report_link';
  end if;

  select * into v_batch
  from public.weekly_report_batches
  where token = p_token;
  if not found then raise exception 'weekly_report_link_not_found'; end if;

  select coalesce(jsonb_agg(jsonb_build_object(
    'id', s.id,
    'member_id', s.member_id,
    'member_name', s.member_name,
    'status', s.status,
    'late', s.late,
    'submitted_at', s.submitted_at,
    'error', case when s.status = 'failed' then s.error else null end
  ) order by s.submitted_at desc), '[]'::jsonb)
  into v_submissions
  from public.weekly_report_submissions s
  where s.batch_id = v_batch.id;

  return jsonb_build_object(
    'id', v_batch.id,
    'week_key', v_batch.week_key,
    'report_date', v_batch.report_date,
    'due_at', v_batch.due_at,
    'accept_until', v_batch.accept_until,
    'status', v_batch.status,
    'can_submit', v_batch.status = 'OPEN' and now() <= v_batch.accept_until,
    'payload', v_batch.payload,
    'submissions', v_submissions
  );
end;
$$;

revoke all on function public.get_weekly_report_batch(text) from public, anon;
grant execute on function public.get_weekly_report_batch(text) to authenticated;

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
    and status = 'OPEN'
    and now() <= accept_until;
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

revoke all on function public.prepare_weekly_report_upload(text, text, text, text, integer) from public, anon;
grant execute on function public.prepare_weekly_report_upload(text, text, text, text, integer) to authenticated;

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
    and status = 'OPEN'
    and now() <= accept_until;
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

revoke all on function public.submit_weekly_report(text, uuid) from public, anon;
grant execute on function public.submit_weekly_report(text, uuid) to authenticated;

create or replace function public.smartport_weekly_portal_version()
returns integer
language sql
stable
security definer
set search_path = ''
as $$
  select 2
$$;

revoke all on function public.smartport_weekly_portal_version() from public, anon, authenticated;
grant execute on function public.smartport_weekly_portal_version() to service_role;

commit;
