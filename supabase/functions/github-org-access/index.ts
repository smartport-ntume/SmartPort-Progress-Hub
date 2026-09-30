import { createClient } from 'npm:@supabase/supabase-js@2.114.0';
import { verifyMembership } from './verify.mjs';
const cors = { 'Access-Control-Allow-Origin': 'https://smartport-ntume.github.io', 'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
Deno.serve(async request => {
  const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (request.method !== 'POST') return reply({ error: 'Method not allowed' }, 405);
  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: { persistSession: false, autoRefreshToken: false } });
  try {
    const jwt = request.headers.get('Authorization')?.replace(/^Bearer\s+/i, '') || '';
    const { data: { user }, error } = await db.auth.getUser(jwt);
    if (error || !user) return reply({ error: '登入已失效，請重新登入。' }, 401);
    const { data: profile, error: profileError } = await db.from('profiles').select('role,active').eq('user_id', user.id).single();
    if (profileError) return reply({ error: '找不到使用者權限資料，請聯絡管理員。' }, 503);
    if (!profile.active) return reply({ error: '此帳號已停用，請聯絡 PM。' }, 403);
    // Existing explicit grants, including PM and Guest, are not overwritten.
    if (profile.role !== 'DENIED') return reply({ ok: true, role: profile.role });
    const body = await request.json();
    if (typeof body.provider_token !== 'string' || body.provider_token.length > 4096) return reply({ error: '請重新登入 GitHub。' }, 400);
    const login = await verifyMembership(user, body.provider_token);
    const { data: updated, error: updateError } = await db.from('profiles').update({ role: 'ENGINEER', can_trigger_codex: false, login }).eq('user_id', user.id).eq('role', 'DENIED').eq('active', true).select('role').maybeSingle();
    if (updateError || !updated) return reply({ error: '權限已變更，請重新整理後重試。' }, 409);
    return reply({ ok: true, role: updated.role });
  } catch (error) {
    // Do not log credentials or echo upstream responses.
    return reply({ error: error instanceof Error && !/fetch|JSON|timeout/i.test(error.message) ? error.message : '組織驗證暫時失敗，請重新登入或稍後重試。' }, 403);
  }
});
