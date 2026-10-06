import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('PDF database grants, assignment checks, durable revisions and recovery', async t => {
  const db = new PGlite(); t.after(() => db.close());
  await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
    create schema auth; create schema storage;
    create table auth.users(id uuid primary key,email text,raw_user_meta_data jsonb default '{}');
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
    create table storage.objects(id uuid primary key default gen_random_uuid(),bucket_id text,name text,metadata jsonb default '{}');
    alter table storage.objects enable row level security;
    create function storage.foldername(text) returns text[] language sql immutable as $$select string_to_array($1,'/')$$;
    create publication supabase_realtime;
    grant usage on schema public,auth,storage to anon,authenticated,service_role;
    grant select,insert,update,delete on storage.objects to authenticated;`);
  for (const name of (await readdir(new URL('../supabase/migrations/', import.meta.url))).filter(n => n.endsWith('.sql')).sort()) {
    const sql = (await readFile(new URL('../supabase/migrations/' + name, import.meta.url), 'utf8')).replace('create extension if not exists pgcrypto;', '');
    await db.exec(sql);
  }
  // The new migration can be run again without losing history or grants.
  await db.exec(await readFile(new URL('../supabase/migrations/202610060001_technical_documents.sql', import.meta.url), 'utf8'));
  const pm = '00000000-0000-4000-8000-000000000001', user = '00000000-0000-4000-8000-000000000002';
  const other = '00000000-0000-4000-8000-000000000003', engineer = '00000000-0000-4000-8000-000000000004';
  const batch = '00000000-0000-4000-8000-000000000010', token = 'private-test-link-1234567890123456';
  const project = { team_config: { members: [{ id: 'm1', name: '測試成員' }, { id: 'm2', name: '其他成員' }], categories: [{ id: 'CTL' }, { id: 'PER' }], category_owners: { CTL: 'm1', PER: 'm2' } },
    work_packages: [{ id: 'WP-C1', name: 'Basic Motion' }], subtasks: [
      { id: 'C1.1', parent_wp: 'WP-C1', name: 'CAN Command / Feedback Interface', owner_team: 'CTL', actual_progress: 100, end: '2020-01-01' },
      { id: 'C1.2', parent_wp: 'WP-C1', name: 'Future stage', owner_team: 'CTL', start: '2099-01-01' },
      { id: 'P1.1', parent_wp: 'WP-C1', name: 'Other member', owner_team: 'PER' }
    ] };
  await db.query("insert into auth.users(id) values($1),($2),($3),($4)", [pm, user, other, engineer]);
  await db.query("update public.profiles set role=case user_id when $1::uuid then 'PM' when $2::uuid then 'ENGINEER' else 'DENIED' end, login='test'", [pm, engineer]);
  await db.query("insert into public.project_snapshots(audience,payload) values('MEMBER',$1)", [project]);
  // Deliberately overdue, and its frozen weekly scope contains no subtasks.
  await db.query(`insert into public.weekly_report_batches(id,week_key,report_date,due_at,accept_until,token,payload,pm_user_id)
    values($1,'2020-W01','2020-01-01','2020-01-08','2020-01-09',$2,$3,$4)`, [batch, token, { team_config: project.team_config }, pm]);
  const admin = () => db.exec('reset role');
  async function asUser(id) { await admin(); await db.query("select set_config('request.jwt.claim.sub',$1,false)", [id || '']); await db.exec('set role authenticated'); }
  async function rpc(name, args) { return (await db.query(`select public.${name}(${args.map((_, i) => '$' + (i + 1)).join(',')}) value`, args)).rows[0].value; }
  const prepare = (task = 'C1.1', document = null) => rpc('prepare_technical_document_upload', [token, 'm1', task, document, '介面定義', '技術文件.pdf', 100]);
  const upload = grant => db.query("insert into storage.objects(bucket_id,name) values('technical-documents',$1)", [grant.storage_path]);
  let first, queued, document;
  await t.test('requires session, open token and current member; guest dashboard cannot see documents', async () => {
    await asUser(null); await assert.rejects(() => prepare(), /session_required/);
    await asUser(user);
    await assert.rejects(() => rpc('get_technical_document_portal', ['bad', 'm1']), /invalid_document_link/);
    await assert.rejects(() => rpc('get_technical_document_portal', [token, 'absent']), /member_not_in_batch/);
    await assert.rejects(() => rpc('list_technical_documents', ['C1.1']), /role_required/);
    await assert.rejects(() => db.query('select * from public.technical_document_versions'), /permission denied/);
    await assert.rejects(() => rpc('smartport_document_list', [null, null]), /permission denied/);
    const scope = await rpc('get_technical_document_portal', [token, 'm1']);
    assert.deepEqual(scope.tasks.map(t => t.id), ['C1.1', 'C1.2'], 'includes completed and future tasks outside weekly scope');
    assert.equal(scope.tasks[0].wp_name, 'Basic Motion');
    await assert.rejects(() => prepare('P1.1'), /not_assigned/);
    for (const size of [0, null, 10485761]) await assert.rejects(() => rpc('prepare_technical_document_upload', [token, 'm1', 'C1.1', null, 'Title', 'x.pdf', size]), /max_10mb/);
    await assert.rejects(() => rpc('prepare_technical_document_upload', [token, 'm1', 'C1.1', null, 'Title', 'x.exe', 100]), /pdf_required/);
  });
  await t.test('one-use storage grants are session-bound; submit is idempotent with no progress change', async () => {
    first = await prepare();
    await asUser(other); await assert.rejects(() => upload(first), /row-level security/);
    await assert.rejects(() => rpc('submit_technical_document', [token, first.upload_id]), /expired_or_invalid/);
    await asUser(user); await assert.rejects(() => rpc('submit_technical_document', [token, first.upload_id]), /not_uploaded/);
    await upload(first); queued = await rpc('submit_technical_document', [token, first.upload_id]);
    assert.deepEqual(await rpc('submit_technical_document', [token, first.upload_id]), queued);
    await assert.rejects(() => upload(first), /row-level security/);
    const visible = await rpc('get_technical_document_portal', [token, 'm1']); document = visible.versions[0].document_id;
    for (const field of ['created_by', 'storage_path', 'job_id', 'batch_id']) assert.equal(visible.versions[0][field], undefined);
    await asUser(pm);
    await assert.rejects(() => rpc('enqueue_gateway_job', ['archive_technical_document', { version_id: first.upload_id }, 'bypass-document']), /unsupported_job_kind/);
    await admin();
    assert.equal((await db.query("select payload#>>'{subtasks,0,actual_progress}' progress from project_snapshots")).rows[0].progress, '100');
  });
  await t.test('failed jobs can retry from a new portal session and archived versions survive queue cleanup', async () => {
    await admin();
    const original = (await db.query('select job_id from technical_document_versions where id=$1', [first.upload_id])).rows[0].job_id;
    await db.query("update gateway_jobs set status='failed',error='Agent interrupted' where id=$1", [original]);
    await asUser(other); await rpc('submit_technical_document', [token, first.upload_id]);
    await admin(); const next = (await db.query('select job_id from technical_document_versions where id=$1', [first.upload_id])).rows[0].job_id;
    assert.notEqual(next, original);
    await db.query("update gateway_jobs set status='failed',error='stale job' where id=$1", [original]);
    assert.equal((await db.query('select status from technical_document_versions where id=$1', [first.upload_id])).rows[0].status, 'queued');
    await db.query("update technical_document_versions set status='archived',repository_path='WP-C1_Test/C1.1_Test/a.pdf',html_url='https://github.com/test/docs/blob/abc/a.pdf',commit_sha='abc' where id=$1", [first.upload_id]);
    await db.query("update gateway_jobs set status='completed' where id=$1", [next]);
    await db.query('delete from gateway_jobs where id=$1', [next]);
    await asUser(engineer); assert.equal((await rpc('list_technical_documents', ['C1.1']))[0].status, 'archived');
    await asUser(user); const second = await prepare('C1.1', document); assert.equal(second.revision, 2);
    await upload(second); await rpc('submit_technical_document', [token, second.upload_id]);
    const versions = (await rpc('get_technical_document_portal', [token, 'm1'])).versions;
    assert.equal(versions.length, 2); assert.equal(versions.find(v => v.revision === 1).status, 'archived');
    await assert.rejects(() => prepare('C1.2', document), /revision_target_invalid/);
  });
  await t.test('assignment changes and closed batches stop new uploads', async () => {
    await asUser(user); const grant = await prepare('C1.2'); await upload(grant);
    await admin(); await db.query("update project_snapshots set payload=jsonb_set(payload,'{team_config,category_owners,CTL}','\"m2\"')");
    await asUser(user); await assert.rejects(() => rpc('submit_technical_document', [token, grant.upload_id]), /not_assigned/);
    await admin(); await db.query("update weekly_report_batches set status='CLOSED' where id=$1", [batch]);
    await asUser(user); await assert.rejects(() => prepare(), /closed_or_invalid/);
  });
});
