import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../supabase/migrations/202609030001_gateway.sql', import.meta.url);

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
