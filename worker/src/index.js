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

function cookie(name, value, maxAge) {
  const bits = [`${name}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'Secure', 'SameSite=None'];
  if (maxAge != null) bits.push(`Max-Age=${maxAge}`);
  return bits.join('; ');
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

function bytesToB64url(bytes) {
  let s = '';
  bytes.forEach(b => { s += String.fromCharCode(b); });
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlToBytes(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Uint8Array.from(atob(s), c => c.charCodeAt(0));
}

async function sessionKey(secret) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

async function seal(value, secret) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await sessionKey(secret);
  const plaintext = new TextEncoder().encode(JSON.stringify(value));
  const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return `${bytesToB64url(iv)}.${bytesToB64url(encrypted)}`;
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const C = cors(request.headers.get('Origin') || '', env.FRONTEND_URL);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: C });
    }

    try {
      if (url.pathname === '/api/health') {
        return json({ ok: true, service: 'smartport-progress-hub-api' }, 200, C);
      }

      if (url.pathname === '/auth/login') {
        if (!env.GITHUB_CLIENT_ID) return json({ error: 'GITHUB_CLIENT_ID not configured' }, 500, C);
        const state = crypto.randomUUID();
        const redirectUri = `${url.origin}/auth/callback`;
        const gh = new URL('https://github.com/login/oauth/authorize');
        gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        gh.searchParams.set('redirect_uri', redirectUri);
        gh.searchParams.set('scope', 'repo read:org');
        gh.searchParams.set('state', state);
        return new Response(null, {
          status: 302,
          headers: {
            Location: gh.toString(),
            'Set-Cookie': cookie('sp_state', state, 600),
            ...C
          }
        });
      }

      if (url.pathname === '/auth/callback') {
        const cookies = parseCookies(request);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        if (!code || state !== cookies.sp_state) return json({ error: 'OAuth state mismatch' }, 400, C);
        if (!env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) {
          return json({ error: 'Cloudflare secrets are not configured' }, 500, C);
        }

        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: env.GITHUB_CLIENT_ID,
            client_secret: env.GITHUB_CLIENT_SECRET,
            code,
            redirect_uri: `${url.origin}/auth/callback`
          })
        });
        const t = await tokenRes.json();
        if (!t.access_token) return json({ error: 'GitHub OAuth authorization failed', detail: t }, 401, C);

        const maxAgeSec = Math.min(Number(t.expires_in || 28800), 28800);
        const sealed = await seal({ token: t.access_token, exp: Date.now() + maxAgeSec * 1000 }, env.SESSION_SECRET);
        const target = `${env.FRONTEND_URL.replace(/\/$/, '')}/#sp_session=${encodeURIComponent(sealed)}`;
        return new Response(null, {
          status: 302,
          headers: {
            Location: target,
            'Set-Cookie': cookie('sp_session', sealed, maxAgeSec),
            ...C
          }
        });
      }

      if (url.pathname === '/auth/logout') {
        return new Response(null, {
          status: 302,
          headers: {
            Location: env.FRONTEND_URL,
            'Set-Cookie': cookie('sp_session', '', 0),
            ...C
          }
        });
      }

      const token = await tokenFromSession(request, env);
      if (!token) return json({ error: 'unauthorized', login: `${url.origin}/auth/login` }, 401, C);

      const repo = env.PROJECT_REPO;

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const me = await github('/user', token);
        return json({ login: me.login, avatar_url: me.avatar_url }, 200, C);
      }

      if (url.pathname === '/api/project/snapshot' && request.method === 'GET') {
        const [project, wp, subtasks, fsr, cp] = await Promise.all([
          getJsonFile(repo, 'project/project.json', token),
          getJsonFile(repo, 'project/work_packages.json', token),
          getJsonFile(repo, 'project/subtasks.json', token),
          getJsonFile(repo, 'safety/fsr.json', token),
          getJsonFile(repo, 'project/checkpoints.json', token)
        ]);
        return json({
          project: project.json,
          work_packages: wp.json.work_packages || [],
          subtasks: subtasks.json.subtasks || [],
          functional_safety_requirements: fsr.json.functional_safety_requirements || [],
          checkpoints: cp.json.checkpoints || []
        }, 200, C);
      }

      if (url.pathname === '/api/project/work-packages' && request.method === 'PUT') {
        await putJsonFile(repo, 'project/work_packages.json', await request.json(), token, 'Hub: update work packages');
        return json({ ok: true }, 200, C);
      }

      if (url.pathname === '/api/safety/fsr' && request.method === 'PUT') {
        await putJsonFile(repo, 'safety/fsr.json', await request.json(), token, 'Hub: update FSR baseline');
        return json({ ok: true }, 200, C);
      }

      if (url.pathname === '/api/project/checkpoints' && request.method === 'PUT') {
        await putJsonFile(repo, 'project/checkpoints.json', await request.json(), token, 'Hub: update checkpoints');
        return json({ ok: true }, 200, C);
      }

      if (url.pathname === '/api/project/subtasks' && request.method === 'POST') {
        const item = await request.json();
        const issue = await github(`/repos/${repo}/issues`, token, {
          method: 'POST',
          body: JSON.stringify({
            title: `[${item.id}] ${item.name}`,
            body: `## Subtask Metadata\n- **Subtask ID:** ${item.id}\n- **Parent WP:** ${item.parent_wp}\n- **Owner Team:** ${item.owner_team || ''}\n- **Schedule:** ${item.start || ''} → ${item.end || ''}\n- **Target Checkpoint:** ${item.target_cp || ''}\n- **IF:** ${(item.ifs || []).join(', ')}\n- **FSR:** ${(item.fsrs || []).join(', ')}\n`
          })
        });
        const reg = await getJsonFile(repo, 'project/subtasks.json', token);
        reg.json.subtasks = reg.json.subtasks || [];
        reg.json.subtasks.push({ ...item, github_issue: issue.number });
        await putJsonFile(repo, 'project/subtasks.json', reg.json, token, `Hub: add subtask ${item.id}`);
        return json({ ...item, github_issue: issue.number }, 201, C);
      }

      const m = url.pathname.match(/^\/api\/project\/subtasks\/([^/]+)$/);
      if (m) {
        const id = decodeURIComponent(m[1]);
        const reg = await getJsonFile(repo, 'project/subtasks.json', token);
        const idx = (reg.json.subtasks || []).findIndex(x => x.id === id);
        if (idx < 0) return json({ error: 'subtask not found' }, 404, C);

        if (request.method === 'PUT') {
          const item = await request.json();
          const old = reg.json.subtasks[idx];
          reg.json.subtasks[idx] = { ...old, ...item };
          await putJsonFile(repo, 'project/subtasks.json', reg.json, token, `Hub: update subtask ${id}`);
          if (old.github_issue) {
            await github(`/repos/${repo}/issues/${old.github_issue}`, token, {
              method: 'PATCH',
              body: JSON.stringify({ title: `[${item.id || id}] ${item.name || old.name}` })
            });
          }
          return json(reg.json.subtasks[idx], 200, C);
        }

        if (request.method === 'DELETE') {
          const old = reg.json.subtasks[idx];
          reg.json.subtasks.splice(idx, 1);
          await putJsonFile(repo, 'project/subtasks.json', reg.json, token, `Hub: archive subtask ${id}`);
          if (old.github_issue) {
            await github(`/repos/${repo}/issues/${old.github_issue}`, token, {
              method: 'PATCH',
              body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' })
            });
          }
          return new Response(null, { status: 204, headers: C });
        }
      }

      return json({ error: 'not found' }, 404, C);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, C);
    }
  }
};
