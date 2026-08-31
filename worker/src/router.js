import app from './index.js';

const GH_API = 'https://api.github.com';

function cors(requestOrigin, frontendUrl) {
  const allowedOrigin = new URL(frontendUrl).origin;
  const origin = requestOrigin === allowedOrigin ? requestOrigin : allowedOrigin;
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'Vary': 'Origin'
  };
}

function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers }
  });
}

async function github(path, token, options = {}) {
  const res = await fetch(GH_API + path, {
    ...options,
    headers: {
      'Accept': 'application/vnd.github+json',
      'Authorization': `Bearer ${token}`,
      'User-Agent': 'SmartPort-Progress-Hub/0.6',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(options.headers || {})
    }
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = text; }
  if (!res.ok) throw new Error(`GitHub ${res.status}: ${typeof body === 'string' ? body : JSON.stringify(body)}`);
  return body;
}

function b64decode(v) {
  return decodeURIComponent(escape(atob(v.replace(/\n/g, ''))));
}

function b64encode(v) {
  return btoa(unescape(encodeURIComponent(v)));
}

async function getJsonFile(repo, path, token) {
  const data = await github(`/repos/${repo}/contents/${path}`, token);
  return { json: JSON.parse(b64decode(data.content)), sha: data.sha };
}

async function putJsonFile(repo, path, payload, token, message) {
  let sha;
  try { sha = (await github(`/repos/${repo}/contents/${path}`, token)).sha; } catch (_) {}
  return github(`/repos/${repo}/contents/${path}`, token, {
    method: 'PUT',
    body: JSON.stringify({
      message,
      content: b64encode(JSON.stringify(payload, null, 2) + '\n'),
      ...(sha ? { sha } : {})
    })
  });
}

function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.get('Cookie') || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function b64urlToBytes(s) {
  s = String(s || '').replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function sessionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['decrypt']);
}

async function unseal(value, secret) {
  try {
    const [ivPart, dataPart] = String(value || '').split('.');
    if (!ivPart || !dataPart) return null;
    const key = await sessionKey(secret);
    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(ivPart) },
      key,
      b64urlToBytes(dataPart)
    );
    const data = JSON.parse(new TextDecoder().decode(decrypted));
    if (!data.exp || Date.now() > data.exp) return null;
    return data;
  } catch (_) {
    return null;
  }
}

async function tokenFromSession(req, env) {
  const auth = req.headers.get('Authorization') || '';
  if (auth.startsWith('Bearer ') && env.SESSION_SECRET) {
    const session = await unseal(auth.slice(7), env.SESSION_SECRET);
    if (session?.token) return session.token;
  }
  const c = parseCookies(req);
  if (!c.sp_session || !env.SESSION_SECRET) return null;
  const session = await unseal(c.sp_session, env.SESSION_SECRET);
  return session?.token || null;
}

async function repoAccess(repo, token) {
  const info = await github(`/repos/${repo}`, token);
  const p = info.permissions || {};
  return {
    can_write: !!(p.admin || p.maintain || p.push),
    permission: p.admin ? 'admin' : p.maintain ? 'maintain' : p.push ? 'write' : p.triage ? 'triage' : p.pull ? 'read' : 'none'
  };
}

function pickExecution(existing = {}, source = {}) {
  const out = {};
  const candidates = {
    actual_progress: [existing.actual_progress, existing.actualProgress, source.actualProgress],
    self_progress: [existing.self_progress, existing.selfProgress, source.selfProgress],
    status: [existing.status, source.status],
    history: [existing.history, source.history],
    blockers: [existing.blockers, source.blockers],
    evidence: [existing.evidence, source.evidence],
    pm_comments: [existing.pm_comments, existing.pmComments, source.pmComments],
    blocker: [existing.blocker],
    pm_comment: [existing.pm_comment, existing.pmComment],
    actual_evidence: [existing.actual_evidence, existing.evidenceNote],
    last_update: [existing.last_update],
    last_update_summary: [existing.last_update_summary],
    last_update_by: [existing.last_update_by]
  };
  for (const [key, vals] of Object.entries(candidates)) {
    const value = vals.find(v => v !== undefined && v !== null && v !== '');
    if (value !== undefined) out[key] = value;
  }
  if (!out.status) out.status = 'Not Updated';
  return out;
}

function flattenV041(baseline, currentRegistry) {
  if (!baseline || !Array.isArray(baseline.tasks)) throw new Error('Invalid v0.4.1 baseline: tasks[] is required');
  if (baseline.version && String(baseline.version) !== '0.4.1') throw new Error(`Expected v0.4.1 baseline, got ${baseline.version}`);

  const current = new Map((currentRegistry?.subtasks || []).map(s => [s.id, s]));
  const subtasks = [];
  const countsByWp = {};

  for (const wp of baseline.tasks) {
    const children = Array.isArray(wp.subtasks) ? wp.subtasks : [];
    countsByWp[wp.id] = children.length;
    for (const s of children) {
      if (!s?.id) continue;
      const old = current.get(s.id) || {};
      const item = {
        id: s.id,
        parent_wp: s.parentId || wp.id,
        name: s.name || '',
        owner_team: s.owner || wp.owner || '',
        start: s.start || '',
        end: s.end || '',
        weight: Number.isFinite(Number(s.weight)) ? Number(s.weight) : 1,
        target_cp: old.target_cp || '',
        ifs: Array.isArray(s.ifs) ? s.ifs : [],
        fsrs: Array.isArray(s.fsrs) ? s.fsrs : [],
        keywords: Array.isArray(s.keywords) ? s.keywords : [],
        description: s.description || old.description || '',
        expected_evidence: Array.isArray(s.expectedEvidence) ? s.expectedEvidence : (Array.isArray(old.expected_evidence) ? old.expected_evidence : []),
        ...pickExecution(old, s)
      };
      if (old.github_issue) item.github_issue = old.github_issue;
      subtasks.push(item);
    }
  }

  const ids = new Set(subtasks.map(s => s.id));
  if (ids.size !== subtasks.length) throw new Error('Duplicate Subtask IDs detected in v0.4.1 baseline');

  return { subtasks, countsByWp };
}

async function importV041(request, env) {
  const C = cors(request.headers.get('Origin') || '', env.FRONTEND_URL);
  if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: C });
  if (request.method !== 'POST') return json({ error: 'method not allowed' }, 405, C);

  const token = await tokenFromSession(request, env);
  if (!token) return json({ error: 'unauthorized' }, 401, C);

  const repo = env.PROJECT_REPO;
  const access = await repoAccess(repo, token);
  if (!access.can_write) return json({ error: 'forbidden', message: 'PM / write permission required' }, 403, C);

  const incoming = await request.json();
  const baseline = incoming?.baseline || incoming;
  const current = await getJsonFile(repo, 'project/subtasks.json', token);
  const { subtasks, countsByWp } = flattenV041(baseline, current.json);

  const payload = {
    schema_version: '1.0',
    status: 'v0.4.1 complete baseline migrated to GitHub',
    description: 'Complete executable Subtask registry flattened from SmartPort Progress Hub v0.4.1 project_baseline.json. Existing GitHub Issue mappings and execution state are preserved by ID.',
    source_version: baseline.version || '0.4.1',
    migrated_at: new Date().toISOString(),
    subtasks
  };

  await putJsonFile(repo, 'project/subtasks.json', payload, token, `Hub: import v0.4.1 complete Subtask baseline (${subtasks.length})`);
  return json({
    ok: true,
    count: subtasks.length,
    wp_count: Object.keys(countsByWp).length,
    counts_by_wp: countsByWp,
    preserved_issue_mappings: subtasks.filter(s => !!s.github_issue).length
  }, 200, C);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === '/api/admin/import-v041-baseline') {
      try {
        return await importV041(request, env);
      } catch (e) {
        const C = cors(request.headers.get('Origin') || '', env.FRONTEND_URL);
        return json({ error: e.message || String(e) }, 500, C);
      }
    }
    return app.fetch(request, env, ctx);
  }
};
