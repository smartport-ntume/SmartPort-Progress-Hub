import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/202609030001_gateway.sql', import.meta.url);
const teamMigrationUrl = new URL('../supabase/migrations/202609080001_team_config.sql', import.meta.url);
const weeklyAutomationMigrationUrl = new URL(
  '../supabase/migrations/202609100001_weekly_discord_automation.sql',
  import.meta.url
);

test('Supabase migration keeps browser writes behind RLS and a role-checking RPC', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /alter table public\.gateway_jobs enable row level security/i);
  assert.match(sql, /revoke all on public\.gateway_jobs from anon, authenticated/i);
  assert.match(sql, /create or replace function public\.enqueue_gateway_job/i);
  assert.match(sql, /p_kind = 'analyze_weekly_report'[\s\S]*v_profile\.role <> 'PM'[\s\S]*not v_profile\.can_trigger_codex/i);
  assert.match(sql, /p_kind = any\(v_pm_only\) and v_profile\.role <> 'PM'/i);
  assert.match(sql, /file_size_limit[\s\S]*10485760/i);
  assert.match(sql, /alter publication supabase_realtime add table public\.gateway_jobs/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete).*gateway_jobs to authenticated/i);
  assert.match(
    sql,
    /grant select, insert, update, delete\s+on table[\s\S]*public\.reference_snapshots,[\s\S]*public\.agent_state,[\s\S]*to service_role/i
  );
});

test('team configuration jobs stay PM-only and validate bounded structured payloads', async () => {
  const sql = await readFile(teamMigrationUrl, 'utf8');
  assert.match(sql, /gateway_jobs_kind_check[\s\S]*'write_team_config'/i);
  assert.match(sql, /v_pm_only[\s\S]*'write_team_config'/i);
  assert.match(sql, /p_kind = 'write_team_config'[\s\S]*jsonb_typeof\(v_payload -> 'categories'\)[\s\S]*jsonb_array_length/i);
  assert.match(sql, /jsonb_typeof\(v_payload -> 'members'\)[\s\S]*300/i);
  assert.match(sql, /jsonb_typeof\(v_payload -> 'category_owners'\)[\s\S]*30/i);
  assert.match(sql, /p_kind = any\(v_pm_only\) and v_profile\.role <> 'PM'/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete).*gateway_jobs to authenticated/i);
});

test('weekly portal uses token-scoped RPCs, one-time uploads, and the existing analysis queue', async () => {
  const sql = await readFile(weeklyAutomationMigrationUrl, 'utf8');
  assert.match(sql, /create table if not exists public\.weekly_report_batches/i);
  assert.match(sql, /create table if not exists public\.weekly_report_upload_grants/i);
  assert.match(sql, /create table if not exists public\.weekly_report_submissions/i);
  assert.match(sql, /alter table public\.weekly_report_batches enable row level security/i);
  assert.match(sql, /revoke all on public\.weekly_report_batches from anon, authenticated/i);
  assert.match(sql, /create or replace function public\.get_weekly_report_batch/i);
  assert.match(sql, /create or replace function public\.prepare_weekly_report_upload/i);
  assert.match(sql, /expires_at[\s\S]*interval '15 minutes'/i);
  assert.match(sql, /create policy smartport_weekly_portal_insert[\s\S]*smartport_valid_weekly_upload_path/i);
  assert.match(sql, /create or replace function public\.submit_weekly_report/i);
  assert.match(sql, /'analyze_weekly_report'[\s\S]*'weekly-portal:' \|\| v_grant\.id::text/i);
  assert.match(sql, /weekly_report_submissions[\s\S]*status = new\.status/i);
  assert.match(sql, /too_many_weekly_report_resubmissions/i);
  assert.doesNotMatch(sql, /grant (insert|update|delete).*weekly_report_batches to authenticated/i);
});
