import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pageUrl = new URL('../weekly-submit.html', import.meta.url);
const scriptUrl = new URL('../js/weekly-submit.js', import.meta.url);
const migrationUrl = new URL(
  '../supabase/migrations/202609100002_passwordless_weekly_portal.sql',
  import.meta.url
);
const doctorUrl = new URL('../local-server/supabase-agent-doctor.mjs', import.meta.url);

test('weekly submission page creates an isolated anonymous session without a password form', async () => {
  const [page, script] = await Promise.all([
    readFile(pageUrl, 'utf8'),
    readFile(scriptUrl, 'utf8')
  ]);
  assert.match(script, /storageKey:\s*'smartport\.weekly\.auth'/);
  assert.match(script, /client\.auth\.signInAnonymously\(\)/);
  assert.doesNotMatch(script, /signInWithPassword|runtime\.guestEmail|guestPassword|guestLoginForm/);
  assert.doesNotMatch(page, /訪客密碼|guestPassword|guestLoginForm|showPassword/);
  assert.match(page, /不需要帳號或密碼/);
});

test('passwordless weekly RPCs still require an Auth session and a private batch token', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /create or replace function public\.get_weekly_report_batch/i);
  assert.match(sql, /create or replace function public\.prepare_weekly_report_upload/i);
  assert.match(sql, /create or replace function public\.submit_weekly_report/i);
  assert.equal((sql.match(/if auth\.uid\(\) is null then/gi) || []).length, 3);
  assert.doesNotMatch(sql, /smartport_role\(\)/i);
  assert.match(sql, /char_length\(coalesce\(p_token, ''\)\) not between 24 and 128/i);
  assert.match(sql, /where token = p_token/i);
  assert.match(sql, /g\.created_by = auth\.uid\(\)/i);
  assert.match(sql, /expires_at > now\(\)/i);
  assert.match(sql, /too_many_weekly_report_resubmissions/i);
  assert.match(sql, /revoke all on function public\.submit_weekly_report\(text, uuid\) from public, anon/i);
  assert.match(sql, /create or replace function public\.smartport_weekly_portal_version\(\)/i);
});

test('agent doctor detects whether the passwordless portal migration is installed', async () => {
  const doctor = await readFile(doctorUrl, 'utf8');
  assert.match(doctor, /rpc\('smartport_weekly_portal_version'\)/);
  assert.match(doctor, /Passwordless weekly portal migration/);
});
