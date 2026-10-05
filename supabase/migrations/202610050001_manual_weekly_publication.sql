-- Requires 202609250001_weekly_editable_feedback.sql. Safe to run again.
-- New publication requests use the existing PM-only Agent queue.
begin;

create or replace function public.enqueue_weekly_publication(
  p_action text, p_payload jsonb, p_idempotency_key text
) returns public.gateway_jobs language plpgsql security definer set search_path = '' as $$
declare
  u uuid := auth.uid(); p public.profiles%rowtype; j public.gateway_jobs%rowtype;
  b public.weekly_report_batches%rowtype; body jsonb; report_day date; due timestamptz; week text;
begin
  select * into p from public.profiles where user_id=u and active and role='PM';
  if not found then raise exception 'pm_role_required' using errcode='42501'; end if;
  if p_action is null or p_action not in ('preview_publish','publish','preview_update','update') then
    raise exception 'unsupported_weekly_publication_action'; end if;
  if p_payload is null or jsonb_typeof(p_payload)<>'object' or octet_length(p_payload::text)>4096 then
    raise exception 'invalid_weekly_publication_payload'; end if;
  if char_length(coalesce(p_idempotency_key,'')) not between 8 and 128 then raise exception 'invalid_idempotency_key'; end if;
  perform pg_advisory_xact_lock(hashtextextended(u::text,0));
  select * into j from public.gateway_jobs where actor_id=u and idempotency_key=p_idempotency_key;
  if found then return j; end if;
  if (select count(*) from public.gateway_jobs where actor_id=u and status in ('queued','running'))>=20 then
    raise exception 'too_many_active_jobs'; end if;

  body := jsonb_build_object('action','publication_' || p_action);
  if p_action in ('preview_update','update') then
    select * into b from public.weekly_report_batches where id=(p_payload->>'batch_id')::uuid;
    if not found then raise exception 'weekly_batch_not_found'; end if;
    if b.status<>'OPEN' then raise exception 'weekly_batch_closed'; end if;
    week := b.week_key;
    body := body || jsonb_build_object('batch_id',b.id);
  else
    if coalesce(p_payload->>'report_date','') !~ '^\d{4}-\d{2}-\d{2}$' then raise exception 'invalid_weekly_publication_date'; end if;
    report_day := (p_payload->>'report_date')::date;
    due := (p_payload->>'due_at')::timestamptz;
    if extract(isodow from report_day)<>1 or report_day < date_trunc('week',now() at time zone 'Asia/Taipei')::date then
      raise exception 'weekly_publication_requires_current_or_future_week'; end if;
    if due is null or due<=now() or due<=(report_day::timestamp at time zone 'Asia/Taipei') then
      raise exception 'invalid_weekly_publication_deadline'; end if;
    week := to_char(report_day,'IYYY-"W"IW');
    body := body || jsonb_build_object('report_date',report_day,'due_at',due);
  end if;
  if p_action in ('publish','update') then
    if coalesce(p_payload->>'preview_token','') !~ '^[a-f0-9]{64}$' then raise exception 'weekly_publication_preview_required'; end if;
    body := body || jsonb_build_object('preview_token',p_payload->>'preview_token');
  end if;
  body := body || jsonb_build_object('publication_week',week);
  perform pg_advisory_xact_lock(hashtextextended('weekly-publication:' || week,0));
  if p_action in ('publish','update') and exists (
    select 1 from public.gateway_jobs g where g.kind='manage_weekly_batch' and g.status in ('queued','running')
      and g.payload->>'action' in ('publication_publish','publication_update','resend')
      and (g.payload->>'publication_week'=week or g.payload->>'batch_id' in
        (select id::text from public.weekly_report_batches where week_key=week))
  ) then raise exception 'weekly_publication_in_progress'; end if;
  insert into public.gateway_jobs(actor_id,actor_login,kind,payload,idempotency_key)
    values(u,coalesce(nullif(p.login,''),p.display_name,u::text),'manage_weekly_batch',body,p_idempotency_key)
    returning * into j;
  return j;
end; $$;

create or replace function public.smartport_weekly_publication_version() returns integer
language sql stable set search_path = '' as $$ select 1; $$;

revoke all on function public.enqueue_weekly_publication(text,jsonb,text) from public,anon;
grant execute on function public.enqueue_weekly_publication(text,jsonb,text) to authenticated;
revoke all on function public.smartport_weekly_publication_version() from public,anon;
grant execute on function public.smartport_weekly_publication_version() to authenticated,service_role;
commit;
