-- Optional stage PDFs. Files live in a private GitHub repository; this is the
-- durable upload/version index. Apply after all earlier migrations. Rerunnable.
begin;

alter table public.gateway_jobs drop constraint gateway_jobs_kind_check;
alter table public.gateway_jobs add constraint gateway_jobs_kind_check check (kind in (
  'write_work_packages','write_fsr','write_checkpoints','write_team_config',
  'create_subtask','update_subtask','archive_subtask','patch_checkpoint',
  'write_reference_model','write_item_functions','write_technical_requirements',
  'create_manual_proposal','approve_proposal','reject_proposal','analyze_weekly_report',
  'refresh_snapshots','review_weekly_submission','manage_weekly_batch','archive_technical_document'
));

create table if not exists public.technical_document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  revision integer not null check (revision > 0),
  batch_id uuid not null references public.weekly_report_batches(id),
  member_id text not null,
  member_name text not null,
  subtask_id text not null,
  subtask_name text not null,
  wp_id text not null,
  wp_name text not null,
  title text not null check (char_length(title) between 1 and 100),
  filename text not null,
  size_bytes integer not null check (size_bytes between 1 and 10485760),
  created_by uuid not null references auth.users(id),
  storage_path text not null unique,
  expires_at timestamptz not null default now() + interval '15 minutes',
  created_at timestamptz not null default now(),
  status text not null default 'uploading' check (status in ('uploading','queued','running','archived','failed')),
  job_id uuid references public.gateway_jobs(id) on delete set null,
  error text,
  repository text,
  repository_path text,
  commit_sha text,
  blob_sha text,
  html_url text,
  archived_at timestamptz,
  unique(document_id,revision),
  check (status <> 'archived' or (repository_path is not null and html_url is not null and commit_sha is not null))
);
create index if not exists technical_documents_task_idx on public.technical_document_versions(subtask_id,created_at desc);
create index if not exists technical_documents_member_idx on public.technical_document_versions(member_id,created_at desc);
alter table public.technical_document_versions enable row level security;
revoke all on public.technical_document_versions from anon,authenticated;
grant all on public.technical_document_versions to service_role;

-- A shared portal link identifies a batch, not a verified person. Scope it to
-- an active member in that batch AND the CURRENT project assignments.
create or replace function public.smartport_document_scope(p_token text,p_member_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare b public.weekly_report_batches%rowtype; s jsonb; m jsonb; tasks jsonb;
begin
  if auth.uid() is null then raise exception 'document_portal_session_required' using errcode='42501'; end if;
  if char_length(coalesce(p_token,'')) not between 24 and 128 then raise exception 'invalid_document_link'; end if;
  select * into b from public.weekly_report_batches where token=p_token and status='OPEN';
  if not found then raise exception 'document_link_closed_or_invalid'; end if;
  if not exists(select 1 from jsonb_array_elements(coalesce(b.payload#>'{team_config,members}','[]')) bm
    where bm->>'id'=p_member_id and coalesce((bm->>'active')::boolean,true)) then
    raise exception 'document_member_not_in_batch'; end if;
  select payload into s from public.project_snapshots where audience='MEMBER';
  select x into m from jsonb_array_elements(coalesce(s#>'{team_config,members}','[]')) x
    where x->>'id'=p_member_id and coalesce((x->>'active')::boolean,true);
  if m is null then raise exception 'document_member_inactive'; end if;
  select coalesce(jsonb_agg(jsonb_build_object('id',t->>'id','name',t->>'name',
    'wp_id',w->>'id','wp_name',w->>'name') order by t->>'id'),'[]') into tasks
  from jsonb_array_elements(coalesce(s->'subtasks','[]')) t
  join jsonb_array_elements(coalesce(s->'work_packages','[]')) w on w->>'id'=t->>'parent_wp'
  where s#>>array['team_config','category_owners',t->>'owner_team']=p_member_id
    and coalesce((t->>'archived')::boolean,false)=false
    and exists(select 1 from jsonb_array_elements(coalesce(s#>'{team_config,categories}','[]')) c
      where c->>'id'=t->>'owner_team' and coalesce((c->>'active')::boolean,true));
  return jsonb_build_object('batch_id',b.id,'pm_user_id',b.pm_user_id,'member_name',m->>'name','tasks',tasks);
end; $$;

create or replace function public.smartport_document_list(p_subtask_id text,p_member_id text)
returns jsonb language sql stable security definer set search_path='' as $$
  select coalesce(jsonb_agg(jsonb_build_object(
    'id',id,'document_id',document_id,'revision',revision,'subtask_id',subtask_id,
    'title',title,'member_name',member_name,'filename',filename,'size_bytes',size_bytes,
    'status',status,'created_at',created_at,'archived_at',archived_at,'html_url',html_url,
    'error',error) order by created_at desc),'[]')
  from public.technical_document_versions
  where (p_subtask_id is null or subtask_id=p_subtask_id)
    and (p_member_id is null or member_id=p_member_id) and status<>'uploading';
$$;

create or replace function public.get_technical_document_portal(p_token text,p_member_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb;
begin
  s:=public.smartport_document_scope(p_token,p_member_id);
  return jsonb_build_object('tasks',s->'tasks','versions',public.smartport_document_list(null,p_member_id));
end; $$;

create or replace function public.list_technical_documents(p_subtask_id text)
returns jsonb language plpgsql security definer set search_path='' as $$
begin
  if coalesce(public.smartport_role(),'') not in ('ENGINEER','PM') or auth.uid() is null then
    raise exception 'document_member_role_required' using errcode='42501'; end if;
  return public.smartport_document_list(p_subtask_id,null);
end; $$;

create or replace function public.prepare_technical_document_upload(
  p_token text,p_member_id text,p_subtask_id text,p_document_id uuid,p_title text,p_filename text,p_size_bytes integer
) returns jsonb language plpgsql security definer set search_path='' as $$
declare s jsonb; task jsonb; previous public.technical_document_versions%rowtype;
  v public.technical_document_versions%rowtype; doc uuid:=coalesce(p_document_id,gen_random_uuid()); rev integer;
begin
  s:=public.smartport_document_scope(p_token,p_member_id);
  select x into task from jsonb_array_elements(s->'tasks') x where x->>'id'=p_subtask_id;
  if task is null then raise exception 'document_task_not_assigned'; end if;
  if p_size_bytes is null or p_size_bytes not between 1 and 10485760 then raise exception 'document_pdf_max_10mb'; end if;
  if coalesce(p_filename,'') !~* '\.pdf$' or char_length(p_filename)>240 then raise exception 'document_pdf_required'; end if;
  if char_length(trim(coalesce(p_title,''))) not between 1 and 100 then raise exception 'document_title_required'; end if;
  perform pg_advisory_xact_lock(hashtextextended('document-member:'||p_member_id,0));
  if (select count(*) from public.technical_document_versions where member_id=p_member_id
    and (status in ('queued','running') or (status='uploading' and expires_at>now())))>=10 then
    raise exception 'too_many_pending_document_uploads'; end if;
  perform pg_advisory_xact_lock(hashtextextended(doc::text,0));
  select * into previous from public.technical_document_versions where document_id=doc order by revision desc limit 1;
  if p_document_id is not null and (previous.id is null or previous.member_id<>p_member_id or previous.subtask_id<>p_subtask_id) then
    raise exception 'document_revision_target_invalid'; end if;
  rev:=coalesce(previous.revision,0)+1;
  insert into public.technical_document_versions(document_id,revision,batch_id,member_id,member_name,
    subtask_id,subtask_name,wp_id,wp_name,title,filename,size_bytes,created_by,storage_path)
  values(doc,rev,(s->>'batch_id')::uuid,p_member_id,s->>'member_name',p_subtask_id,
    coalesce(previous.subtask_name,task->>'name'),coalesce(previous.wp_id,task->>'wp_id'),
    coalesce(previous.wp_name,task->>'wp_name'),coalesce(previous.title,trim(p_title)),p_filename,p_size_bytes,
    auth.uid(),'pdf/'||gen_random_uuid()::text||'.pdf') returning * into v;
  return jsonb_build_object('upload_id',v.id,'bucket','technical-documents','storage_path',v.storage_path,'revision',rev);
end; $$;

create or replace function public.smartport_document_upload_allowed(p_path text)
returns boolean language sql stable security definer set search_path='' as $$
  select exists(select 1 from public.technical_document_versions v
    join public.weekly_report_batches b on b.id=v.batch_id
    where v.storage_path=p_path and v.created_by=auth.uid() and v.status='uploading'
      and v.expires_at>now() and b.status='OPEN');
$$;

insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types)
values('technical-documents','technical-documents',false,10485760,array['application/pdf'])
on conflict(id) do update set public=false,file_size_limit=10485760,allowed_mime_types=array['application/pdf'];
drop policy if exists technical_pdf_upload on storage.objects;
create policy technical_pdf_upload on storage.objects for insert to authenticated
with check(bucket_id='technical-documents' and public.smartport_document_upload_allowed(name));

-- The same call safely resumes a completed upload or retries a failed archive.
-- Once queued, the file cannot be replaced or deleted by the browser.
create or replace function public.submit_technical_document(p_token text,p_upload_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare v public.technical_document_versions%rowtype; s jsonb; pm_login text; job uuid:=gen_random_uuid();
begin
  select * into v from public.technical_document_versions where id=p_upload_id for update;
  if not found then raise exception 'document_upload_not_found'; end if;
  s:=public.smartport_document_scope(p_token,v.member_id);
  if not exists(select 1 from jsonb_array_elements(s->'tasks') t where t->>'id'=v.subtask_id) then
    raise exception 'document_task_not_assigned'; end if;
  if v.status='uploading' and (v.created_by<>auth.uid() or v.expires_at<=now()) then
    raise exception 'document_upload_expired_or_invalid'; end if;
  if v.status in ('queued','running','archived') then
    return jsonb_build_object('id',v.id,'status',v.status); end if;
  if not exists(select 1 from storage.objects where bucket_id='technical-documents' and name=v.storage_path) then
    raise exception 'document_file_not_uploaded'; end if;
  select login into pm_login from public.profiles where user_id=(s->>'pm_user_id')::uuid and active and role='PM';
  if pm_login is null then raise exception 'document_pm_no_longer_authorized'; end if;
  insert into public.gateway_jobs(id,actor_id,actor_login,kind,payload,idempotency_key)
    values(job,(s->>'pm_user_id')::uuid,pm_login,'archive_technical_document',jsonb_build_object('version_id',v.id),'document:'||job::text);
  update public.technical_document_versions set status='queued',job_id=job,error=null where id=v.id;
  return jsonb_build_object('id',v.id,'status','queued');
end; $$;

create or replace function public.smartport_document_job_state()
returns trigger language plpgsql security definer set search_path='' as $$
begin
  if new.kind='archive_technical_document' then
    update public.technical_document_versions set
      status=case when new.status in ('failed','cancelled','completed') then 'failed' else new.status end,
      error=case when new.status in ('failed','cancelled') then left(coalesce(new.error,'歸檔中斷，請重試。'),1000)
        when new.status='completed' then '文件尚未完成歸檔，請重試。' else null end
    where job_id=new.id and status<>'archived';
  end if;
  return new;
end; $$;
drop trigger if exists technical_document_job_state on public.gateway_jobs;
create trigger technical_document_job_state after update of status on public.gateway_jobs
for each row execute function public.smartport_document_job_state();

revoke all on function public.smartport_document_scope(text,text),public.smartport_document_list(text,text),
  public.smartport_document_job_state() from public,anon,authenticated;
revoke all on function public.get_technical_document_portal(text,text),public.list_technical_documents(text),
  public.prepare_technical_document_upload(text,text,text,uuid,text,text,integer),
  public.smartport_document_upload_allowed(text),public.submit_technical_document(text,uuid) from public,anon;
grant execute on function public.get_technical_document_portal(text,text),public.list_technical_documents(text),
  public.prepare_technical_document_upload(text,text,text,uuid,text,text,integer),
  public.smartport_document_upload_allowed(text),public.submit_technical_document(text,uuid) to authenticated;
commit;
