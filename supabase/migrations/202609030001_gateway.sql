-- SmartPort Supabase Gateway
-- Supabase is an authenticated relay/cache. Private Git remains the source of truth.

begin;

create extension if not exists pgcrypto;

create table if not exists public.profiles (
  user_id uuid primary key references auth.users(id) on delete cascade,
  login text not null default '',
  display_name text not null default '',
  avatar_url text not null default '',
  role text not null default 'DENIED'
    check (role in ('DENIED', 'GUEST', 'ENGINEER', 'PM')),
  can_trigger_codex boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.project_snapshots (
  audience text primary key check (audience in ('GUEST', 'MEMBER')),
  payload jsonb not null,
  source_commit text not null default '',
  updated_by_agent text not null default '',
  updated_at timestamptz not null default now(),
  check (octet_length(payload::text) <= 5242880)
);

create table if not exists public.reference_snapshots (
  audience text primary key check (audience in ('GUEST', 'MEMBER')),
  payload jsonb not null,
  source_commit text not null default '',
  updated_by_agent text not null default '',
  updated_at timestamptz not null default now(),
  check (octet_length(payload::text) <= 5242880)
);

create table if not exists public.proposal_snapshots (
  id text primary key default 'all' check (id = 'all'),
  payload jsonb not null default '{"proposals":[]}'::jsonb,
  updated_by_agent text not null default '',
  updated_at timestamptz not null default now(),
  check (octet_length(payload::text) <= 5242880)
);

create table if not exists public.gateway_jobs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references auth.users(id) on delete restrict,
  actor_login text not null,
  kind text not null check (kind in (
    'write_work_packages',
    'write_fsr',
    'write_checkpoints',
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
  )),
  payload jsonb not null default '{}'::jsonb,
  status text not null default 'queued'
    check (status in ('queued', 'running', 'completed', 'failed', 'cancelled')),
  result jsonb,
  error text,
  idempotency_key text not null,
  attempt_count integer not null default 0 check (attempt_count between 0 and 5),
  agent_id text,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now(),
  unique (actor_id, idempotency_key),
  check (char_length(idempotency_key) between 8 and 128),
  check (octet_length(payload::text) <= 4194304),
  check (result is null or octet_length(result::text) <= 4194304),
  check (error is null or char_length(error) <= 8000)
);

create index if not exists gateway_jobs_queue_idx
  on public.gateway_jobs (status, created_at)
  where status = 'queued';
create index if not exists gateway_jobs_actor_idx
  on public.gateway_jobs (actor_id, created_at desc);

create table if not exists public.agent_state (
  agent_id text primary key,
  status text not null check (status in ('online', 'busy', 'offline', 'error')),
  version text not null default '',
  current_job_id uuid references public.gateway_jobs(id) on delete set null,
  last_error text,
  connected_at timestamptz,
  last_seen_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.audit_log (
  id bigint generated always as identity primary key,
  actor_id uuid references auth.users(id) on delete set null,
  actor_login text not null default '',
  event text not null,
  job_id uuid references public.gateway_jobs(id) on delete set null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  check (octet_length(metadata::text) <= 65536)
);

create index if not exists audit_log_created_idx
  on public.audit_log (created_at desc);

create or replace function public.smartport_touch_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists profiles_touch_updated_at on public.profiles;
create trigger profiles_touch_updated_at
before update on public.profiles
for each row execute function public.smartport_touch_updated_at();

drop trigger if exists gateway_jobs_touch_updated_at on public.gateway_jobs;
create trigger gateway_jobs_touch_updated_at
before update on public.gateway_jobs
for each row execute function public.smartport_touch_updated_at();

drop trigger if exists agent_state_touch_updated_at on public.agent_state;
create trigger agent_state_touch_updated_at
before update on public.agent_state
for each row execute function public.smartport_touch_updated_at();

create or replace function public.smartport_create_profile()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.profiles (user_id, login, display_name, avatar_url, role)
  values (
    new.id,
    coalesce(
      new.raw_user_meta_data ->> 'user_name',
      new.raw_user_meta_data ->> 'preferred_username',
      split_part(coalesce(new.email, ''), '@', 1),
      ''
    ),
    coalesce(new.raw_user_meta_data ->> 'full_name', new.raw_user_meta_data ->> 'name', ''),
    coalesce(new.raw_user_meta_data ->> 'avatar_url', ''),
    'DENIED'
  )
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists smartport_auth_user_created on auth.users;
create trigger smartport_auth_user_created
after insert on auth.users
for each row execute function public.smartport_create_profile();

insert into public.profiles (user_id, login, display_name, avatar_url, role)
select
  id,
  coalesce(
    raw_user_meta_data ->> 'user_name',
    raw_user_meta_data ->> 'preferred_username',
    split_part(coalesce(email, ''), '@', 1),
    ''
  ),
  coalesce(raw_user_meta_data ->> 'full_name', raw_user_meta_data ->> 'name', ''),
  coalesce(raw_user_meta_data ->> 'avatar_url', ''),
  'DENIED'
from auth.users
on conflict (user_id) do nothing;

create or replace function public.smartport_role()
returns text
language sql
stable
security definer
set search_path = ''
as $$
  select case when p.active then p.role else 'DENIED' end
  from public.profiles p
  where p.user_id = auth.uid()
$$;

create or replace function public.smartport_can_trigger_codex()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce((
    select p.active and p.role = 'PM' and p.can_trigger_codex
    from public.profiles p
    where p.user_id = auth.uid()
  ), false)
$$;

revoke all on function public.smartport_role() from public;
revoke all on function public.smartport_can_trigger_codex() from public;
grant execute on function public.smartport_role() to authenticated;
grant execute on function public.smartport_can_trigger_codex() to authenticated;

alter table public.profiles enable row level security;
alter table public.project_snapshots enable row level security;
alter table public.reference_snapshots enable row level security;
alter table public.proposal_snapshots enable row level security;
alter table public.gateway_jobs enable row level security;
alter table public.agent_state enable row level security;
alter table public.audit_log enable row level security;

drop policy if exists profiles_read_self on public.profiles;
create policy profiles_read_self on public.profiles
for select to authenticated
using (user_id = auth.uid());

drop policy if exists project_snapshots_read_by_role on public.project_snapshots;
create policy project_snapshots_read_by_role on public.project_snapshots
for select to authenticated
using (
  (audience = 'GUEST' and public.smartport_role() in ('GUEST', 'ENGINEER', 'PM'))
  or (audience = 'MEMBER' and public.smartport_role() in ('ENGINEER', 'PM'))
);

drop policy if exists reference_snapshots_read_by_role on public.reference_snapshots;
create policy reference_snapshots_read_by_role on public.reference_snapshots
for select to authenticated
using (
  (audience = 'GUEST' and public.smartport_role() in ('GUEST', 'ENGINEER', 'PM'))
  or (audience = 'MEMBER' and public.smartport_role() in ('ENGINEER', 'PM'))
);

drop policy if exists proposal_snapshots_read_members on public.proposal_snapshots;
create policy proposal_snapshots_read_members on public.proposal_snapshots
for select to authenticated
using (public.smartport_role() in ('ENGINEER', 'PM'));

drop policy if exists gateway_jobs_read_own_or_pm on public.gateway_jobs;
create policy gateway_jobs_read_own_or_pm on public.gateway_jobs
for select to authenticated
using (actor_id = auth.uid() or public.smartport_role() = 'PM');

drop policy if exists agent_state_read_members on public.agent_state;
create policy agent_state_read_members on public.agent_state
for select to authenticated
using (public.smartport_role() in ('ENGINEER', 'PM'));

drop policy if exists audit_log_read_pm on public.audit_log;
create policy audit_log_read_pm on public.audit_log
for select to authenticated
using (public.smartport_role() = 'PM');

revoke all on public.profiles from anon, authenticated;
revoke all on public.project_snapshots from anon, authenticated;
revoke all on public.reference_snapshots from anon, authenticated;
revoke all on public.proposal_snapshots from anon, authenticated;
revoke all on public.gateway_jobs from anon, authenticated;
revoke all on public.agent_state from anon, authenticated;
revoke all on public.audit_log from anon, authenticated;

grant select on public.profiles to authenticated;
grant select on public.project_snapshots to authenticated;
grant select on public.reference_snapshots to authenticated;
grant select on public.proposal_snapshots to authenticated;
grant select on public.gateway_jobs to authenticated;
grant select on public.agent_state to authenticated;
grant select on public.audit_log to authenticated;

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
    if coalesce(v_payload ->> 'owner_team', '') not in ('CTL', 'LOC/NAV', 'PER', 'STM', 'VERIFY') then
      raise exception 'invalid_owner_team';
    end if;
  end if;

  if p_kind = 'write_work_packages' and jsonb_typeof(v_payload -> 'work_packages') is distinct from 'array' then
    raise exception 'work_packages_array_required';
  end if;
  if p_kind = 'write_fsr' and jsonb_typeof(v_payload -> 'functional_safety_requirements') is distinct from 'array' then
    raise exception 'functional_safety_requirements_array_required';
  end if;
  if p_kind = 'write_checkpoints' and jsonb_typeof(v_payload -> 'checkpoints') is distinct from 'array' then
    raise exception 'checkpoints_array_required';
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

create or replace function public.claim_gateway_job(p_job_id uuid, p_agent_id text)
returns public.gateway_jobs
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_job public.gateway_jobs%rowtype;
begin
  update public.gateway_jobs
  set
    status = 'running',
    agent_id = left(coalesce(p_agent_id, 'local-agent'), 128),
    attempt_count = attempt_count + 1,
    started_at = coalesce(started_at, now()),
    error = null
  where id = p_job_id
    and status = 'queued'
    and attempt_count < 5
  returning * into v_job;
  return v_job;
end;
$$;

revoke all on function public.claim_gateway_job(uuid, text) from public, anon, authenticated;
grant execute on function public.claim_gateway_job(uuid, text) to service_role;

create or replace function public.fail_abandoned_gateway_jobs(p_agent_id text)
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_count integer;
begin
  update public.gateway_jobs
  set
    status = 'failed',
    error = 'local_agent_stopped_before_recording_completion; review Git history before retrying',
    finished_at = now()
  where status = 'running'
    and (
      agent_id = p_agent_id
      or updated_at < now() - interval '2 hours'
    );
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

revoke all on function public.fail_abandoned_gateway_jobs(text) from public, anon, authenticated;
grant execute on function public.fail_abandoned_gateway_jobs(text) to service_role;

create or replace function public.prune_gateway_data()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_jobs integer;
  v_audit integer;
begin
  delete from public.gateway_jobs
  where status in ('completed', 'failed', 'cancelled')
    and finished_at < now() - interval '30 days';
  get diagnostics v_jobs = row_count;

  delete from public.audit_log
  where created_at < now() - interval '90 days';
  get diagnostics v_audit = row_count;

  return jsonb_build_object('jobs_deleted', v_jobs, 'audit_deleted', v_audit);
end;
$$;

revoke all on function public.prune_gateway_data() from public, anon, authenticated;
grant execute on function public.prune_gateway_data() to service_role;

create or replace function public.smartport_audit_job_state()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    insert into public.audit_log (actor_id, actor_login, event, job_id, metadata)
    values (new.actor_id, new.actor_login, 'job_queued', new.id, jsonb_build_object('kind', new.kind));
  elsif old.status is distinct from new.status then
    insert into public.audit_log (actor_id, actor_login, event, job_id, metadata)
    values (
      new.actor_id,
      new.actor_login,
      'job_' || new.status,
      new.id,
      jsonb_build_object('kind', new.kind, 'agent_id', new.agent_id)
    );
  end if;
  return new;
end;
$$;

drop trigger if exists gateway_jobs_audit on public.gateway_jobs;
create trigger gateway_jobs_audit
after insert or update of status on public.gateway_jobs
for each row execute function public.smartport_audit_job_state();

alter table public.gateway_jobs replica identity full;

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'gateway_jobs'
  ) then
    alter publication supabase_realtime add table public.gateway_jobs;
  end if;
end;
$$;

insert into storage.buckets (
  id, name, public, file_size_limit, allowed_mime_types
) values (
  'weekly-reports',
  'weekly-reports',
  false,
  10485760,
  array[
    'application/msword',
    'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    'application/octet-stream'
  ]
)
on conflict (id) do update set
  public = false,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

drop policy if exists smartport_weekly_report_insert on storage.objects;
create policy smartport_weekly_report_insert on storage.objects
for insert to authenticated
with check (
  bucket_id = 'weekly-reports'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.smartport_can_trigger_codex()
);

drop policy if exists smartport_weekly_report_delete_own on storage.objects;
create policy smartport_weekly_report_delete_own on storage.objects
for delete to authenticated
using (
  bucket_id = 'weekly-reports'
  and (storage.foldername(name))[1] = auth.uid()::text
  and public.smartport_can_trigger_codex()
);

commit;
