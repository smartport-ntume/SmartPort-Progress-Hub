-- Editable team roster and one responsible member inherited by each work category.
-- Private Git remains the source of truth; Supabase only relays the PM write job.

begin;

alter table public.gateway_jobs
  drop constraint if exists gateway_jobs_kind_check;

alter table public.gateway_jobs
  add constraint gateway_jobs_kind_check check (kind in (
    'write_work_packages',
    'write_fsr',
    'write_checkpoints',
    'write_team_config',
    'create_subtask',
    'update_subtask',
    'archive_subtask',
    'patch_checkpoint',
    'write_reference_model',
    'write_item_functions',
    'write_technical_requirements',
    'create_manual_proposal',
    'approve_proposal',
    'reject_proposal',
    'analyze_weekly_report',
    'refresh_snapshots'
  ));

create or replace function public.enqueue_gateway_job(
  p_kind text,
  p_payload jsonb,
  p_idempotency_key text
)
returns public.gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_profile public.profiles%rowtype;
  v_job public.gateway_jobs%rowtype;
  v_payload jsonb := coalesce(p_payload, '{}'::jsonb);
  v_pm_only constant text[] := array[
    'write_work_packages', 'write_fsr', 'write_checkpoints',
    'write_team_config',
    'create_subtask', 'update_subtask', 'archive_subtask',
    'patch_checkpoint', 'write_reference_model', 'write_item_functions',
    'write_technical_requirements', 'approve_proposal', 'reject_proposal',
    'refresh_snapshots'
  ];
begin
  if v_user is null then
    raise exception 'authentication_required' using errcode = '42501';
  end if;

  select * into v_profile
  from public.profiles
  where user_id = v_user and active;

  if not found or v_profile.role not in ('ENGINEER', 'PM') then
    raise exception 'role_not_authorized' using errcode = '42501';
  end if;

  if p_kind is null or p_kind not in (
    'write_work_packages', 'write_fsr', 'write_checkpoints',
    'write_team_config',
    'create_subtask', 'update_subtask', 'archive_subtask',
    'patch_checkpoint', 'write_reference_model', 'write_item_functions',
    'write_technical_requirements', 'create_manual_proposal',
    'approve_proposal', 'reject_proposal', 'analyze_weekly_report',
    'refresh_snapshots'
  ) then
    raise exception 'unsupported_job_kind';
  end if;

  if p_kind = any(v_pm_only) and v_profile.role <> 'PM' then
    raise exception 'pm_role_required' using errcode = '42501';
  end if;

  if p_kind = 'create_manual_proposal' and v_profile.role not in ('ENGINEER', 'PM') then
    raise exception 'engineer_or_pm_role_required' using errcode = '42501';
  end if;

  if p_kind = 'analyze_weekly_report'
    and (v_profile.role <> 'PM' or not v_profile.can_trigger_codex) then
    raise exception 'local_codex_not_allowed_for_this_account' using errcode = '42501';
  end if;

  if octet_length(v_payload::text) > 4194304 then
    raise exception 'job_payload_too_large';
  end if;

  if char_length(coalesce(p_idempotency_key, '')) not between 8 and 128 then
    raise exception 'invalid_idempotency_key';
  end if;

  if p_kind = 'analyze_weekly_report' then
    if position(v_user::text || '/' in coalesce(v_payload ->> 'storage_path', '')) <> 1 then
      raise exception 'invalid_weekly_report_storage_path' using errcode = '42501';
    end if;
    if coalesce(v_payload ->> 'report_date', '') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'invalid_report_date';
    end if;
    if coalesce(v_payload ->> 'owner_team', '') !~ '^[A-Z][A-Z0-9/_-]{0,31}$' then
      raise exception 'invalid_owner_team';
    end if;
  end if;

  if p_kind = 'write_work_packages'
    and jsonb_typeof(v_payload -> 'work_packages') is distinct from 'array' then
    raise exception 'work_packages_array_required';
  end if;
  if p_kind = 'write_fsr'
    and jsonb_typeof(v_payload -> 'functional_safety_requirements') is distinct from 'array' then
    raise exception 'functional_safety_requirements_array_required';
  end if;
  if p_kind = 'write_checkpoints'
    and jsonb_typeof(v_payload -> 'checkpoints') is distinct from 'array' then
    raise exception 'checkpoints_array_required';
  end if;
  if p_kind = 'write_team_config' then
    if jsonb_typeof(v_payload -> 'categories') is distinct from 'array' then
      raise exception 'team_categories_array_required';
    end if;
    if jsonb_array_length(v_payload -> 'categories') not between 1 and 30 then
      raise exception 'team_categories_count_invalid';
    end if;
    if jsonb_typeof(v_payload -> 'members') is distinct from 'array' then
      raise exception 'team_members_array_required';
    end if;
    if jsonb_array_length(v_payload -> 'members') > 300 then
      raise exception 'too_many_team_members';
    end if;
    if jsonb_typeof(v_payload -> 'category_owners') is distinct from 'object' then
      raise exception 'team_category_owners_object_required';
    end if;
    if (select count(*) from jsonb_object_keys(v_payload -> 'category_owners')) > 30 then
      raise exception 'too_many_team_category_owners';
    end if;
  end if;

  select * into v_job
  from public.gateway_jobs
  where actor_id = v_user and idempotency_key = p_idempotency_key;
  if found then
    return v_job;
  end if;

  if (
    select count(*)
    from public.gateway_jobs
    where actor_id = v_user and status in ('queued', 'running')
  ) >= 20 then
    raise exception 'too_many_active_jobs';
  end if;

  insert into public.gateway_jobs (
    actor_id, actor_login, kind, payload, idempotency_key
  ) values (
    v_user,
    coalesce(nullif(v_profile.login, ''), v_profile.display_name, v_user::text),
    p_kind,
    v_payload,
    p_idempotency_key
  )
  returning * into v_job;

  return v_job;
end;
$$;

revoke all on function public.enqueue_gateway_job(text, jsonb, text) from public;
grant execute on function public.enqueue_gateway_job(text, jsonb, text) to authenticated;

commit;
