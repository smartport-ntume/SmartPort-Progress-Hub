import { corsHeaders, safeReturnUrl } from './cors.js';

const GH_API = 'https://api.github.com';

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

async function repoAccess(repo, token) {
  const info = await github(`/repos/${repo}`, token);
  const p = info.permissions || {};
  let permission = 'none';
  if (p.admin) permission = 'admin';
  else if (p.maintain) permission = 'maintain';
  else if (p.push) permission = 'write';
  else if (p.triage) permission = 'triage';
  else if (p.pull) permission = 'read';

  const canWrite = !!(p.admin || p.maintain || p.push);
  return {
    permission,
    can_write: canWrite,
    can_approve: canWrite,
    role: canWrite ? 'PM' : 'ENGINEER'
  };
}

function localCodexRequiresPm(env) {
  return env.LOCAL_CODEX_REQUIRE_PM === true || /^(1|true|yes|on)$/i.test(String(env.LOCAL_CODEX_REQUIRE_PM || ''));
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

function oauthState(returnTo) {
  const nonce = crypto.randomUUID();
  const target = bytesToB64url(new TextEncoder().encode(returnTo));
  return { nonce, state: nonce + '.' + target };
}

function returnUrlFromState(state, expectedNonce, env) {
  try {
    const separator = String(state || '').indexOf('.');
    if (separator < 0 || state.slice(0, separator) !== expectedNonce) return '';
    const decoded = new TextDecoder().decode(b64urlToBytes(state.slice(separator + 1)));
    return safeReturnUrl(decoded, env);
  } catch (_) {
    return '';
  }
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

const OPENAI_API = 'https://api.openai.com/v1';

function safePathPart(v, fallback='item') {
  const x=String(v||'').trim().replace(/[^A-Za-z0-9._-]+/g,'-').replace(/^-+|-+$/g,'');
  return x||fallback;
}

function b64ToBytes(v) {
  const raw=atob(String(v||'').replace(/\s/g,''));
  const out=new Uint8Array(raw.length);
  for(let i=0;i<raw.length;i++)out[i]=raw.charCodeAt(i);
  return out;
}

function reportMime(filename, supplied='') {
  const n=String(filename||'').toLowerCase();
  if(n.endsWith('.docx'))return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if(n.endsWith('.doc'))return 'application/msword';
  return supplied||'application/octet-stream';
}

async function reportStorageToken(repo, userToken, env) {
  const access=await repoAccess(repo,userToken);
  if(access.can_write)return userToken;
  if(env.REPORT_REPO_TOKEN)return env.REPORT_REPO_TOKEN;
  return null;
}

async function uploadWeeklyReport(repo, userToken, env, payload, author) {
  const filename=String(payload.filename||'').trim();
  const ext=(filename.split('.').pop()||'').toLowerCase();
  if(!['doc','docx'].includes(ext))throw new Error('weekly_report_file_must_be_doc_or_docx');
  const reportDate=String(payload.report_date||'').trim();
  if(!/^\d{4}-\d{2}-\d{2}$/.test(reportDate))throw new Error('invalid_report_date');
  const ownerTeam=String(payload.owner_team||'').trim();
  if(!ownerTeam)throw new Error('owner_team_required');
  const b64=String(payload.data_base64||'').replace(/^data:[^,]+,/,'').replace(/\s/g,'');
  if(!b64)throw new Error('report_file_empty');
  const approximateBytes=Math.floor(b64.length*3/4);
  if(approximateBytes>10*1024*1024)throw new Error('report_file_too_large_10mb_max');
  const storageToken=await reportStorageToken(repo,userToken,env);
  if(!storageToken)throw new Error('REPORT_REPO_TOKEN_required_for_engineer_upload');
  const year=reportDate.slice(0,4),team=safePathPart(ownerTeam,'TEAM');
  const stamp=new Date().toISOString().replace(/[-:.TZ]/g,'').slice(0,14);
  const cleanName=safePathPart(filename,'weekly-report.'+ext);
  const path=`weekly_reports/${year}/${reportDate}/${team}/${stamp}_${cleanName}`;
  const result=await github(`/repos/${repo}/contents/${path}`,storageToken,{
    method:'PUT',
    body:JSON.stringify({message:`Weekly report: ${reportDate} ${ownerTeam} by ${author}`,content:b64})
  });
  return{
    path,
    filename:cleanName,
    mime_type:reportMime(cleanName,payload.mime_type),
    size:approximateBytes,
    html_url:result?.content?.html_url||`https://github.com/${repo}/blob/main/${path}`,
    commit_sha:result?.commit?.sha||null
  };
}

async function openAIJson(res) {
  const text=await res.text();
  let body=null;try{body=text?JSON.parse(text):null}catch(_){body=text}
  if(!res.ok)throw new Error(`OpenAI ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);
  return body;
}

function responseOutputText(response) {
  if(response?.output_text)return response.output_text;
  for(const item of response?.output||[]){
    for(const part of item?.content||[]){if(part?.type==='output_text'&&part.text)return part.text;}
  }
  return '';
}

async function analyzeWeeklyReportAI(repo, token, env, payload, author) {
  const useLocalCodex=typeof env.LOCAL_CODEX_RUNNER==='function';
  if(!useLocalCodex&&!env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY_not_configured');
  const reportPath=String(payload.report_path||'');
  if(!reportPath.startsWith('weekly_reports/'))throw new Error('invalid_weekly_report_path');
  const reportDate=String(payload.report_date||'').trim();
  const ownerTeam=String(payload.owner_team||'').trim();
  if(!reportDate||!ownerTeam)throw new Error('report_date_and_owner_team_required');

  const [reportFile,wpFile,subFile]=await Promise.all([
    github(`/repos/${repo}/contents/${reportPath}`,token),
    getJsonFile(repo,'project/work_packages.json',token),
    getJsonFile(repo,'project/subtasks.json',token)
  ]);
  const filename=reportFile.name||reportPath.split('/').pop()||'weekly-report.docx';
  const fileBytes=b64ToBytes(reportFile.content||'');
  const wps=wpFile.json.work_packages||[],subs=subFile.json.subtasks||[];
  const context={
    report_date:reportDate,
    owner_team:ownerTeam,
    work_packages:wps.map(w=>({id:w.id,name:w.name,owner:w.owner,start:w.start,end:w.end,actual_progress:w.actual_progress??null,status:w.status||'Not Updated',description:w.description||''})),
    subtasks:subs.map(x=>({id:x.id,parent_wp:x.parent_wp,name:x.name,owner_team:x.owner_team,start:x.start,end:x.end,target_cp:x.target_cp||'',actual_progress:x.actual_progress??null,status:x.status||'Not Updated',description:x.description||''}))
  };
  const schema={
    type:'object',additionalProperties:false,required:['report_summary','warnings','proposals'],properties:{
      report_summary:{type:'string',maxLength:8000},warnings:{type:'array',maxItems:50,items:{type:'string',maxLength:2000}},
      proposals:{type:'array',maxItems:200,items:{type:'object',additionalProperties:false,required:['target_type','target_id','progress','status','blocker','evidence','summary','confidence','rationale'],properties:{
        target_type:{type:'string',enum:['WP','SUBTASK']},target_id:{type:'string',maxLength:128},progress:{type:'number',minimum:0,maximum:100},
        status:{type:'string',enum:['On Track','At Risk','Blocked','Delayed','Completed']},blocker:{type:'string',maxLength:4000},evidence:{type:'string',maxLength:12000},summary:{type:'string',maxLength:8000},confidence:{type:'number',minimum:0,maximum:1},rationale:{type:'string',maxLength:8000}
      }}}
    }
  };

  let analysis;
  if(useLocalCodex){
    analysis=await env.LOCAL_CODEX_RUNNER({
      repo,reportPath,reportDate,ownerTeam,author,filename,fileBytes,context,schema
    });
  }else{
    const form=new FormData();
    form.append('purpose','user_data');
    form.append('file',new Blob([fileBytes],{type:reportMime(filename)}),filename);
    const uploaded=await openAIJson(await fetch(`${OPENAI_API}/files`,{
      method:'POST',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`},body:form
    }));
    let response=null;
    try{
      response=await openAIJson(await fetch(`${OPENAI_API}/responses`,{
        method:'POST',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`,'Content-Type':'application/json'},
        body:JSON.stringify({
          model:env.OPENAI_MODEL||'gpt-5-mini',store:false,
          instructions:'You are the SmartPort weekly-report progress mapper. Convert only evidence supported by the uploaded weekly report into proposed project updates. Compare the report against the supplied current WP/Subtask baseline. Prefer SUBTASK updates when a specific task is identifiable. Use WP only when the report materially updates the whole work package or no specific Subtask fits. progress is the proposed absolute progress percentage after this report, not a weekly delta. Never lower an existing progress value. Do not invent evidence, blockers, tests, completion, dates, or targets. If a percentage is not stated, estimate conservatively from concrete completed deliverables relative to the task description and explain the estimate in rationale. Only map work owned by the selected Owner Team. Return an empty proposals array when evidence is insufficient.',
          input:[{role:'user',content:[
            {type:'input_text',text:`Map this SmartPort weekly report into proposed WP/Subtask progress updates. Project context JSON:\n${JSON.stringify(context)}`},
            {type:'input_file',file_id:uploaded.id}
          ]}],
          text:{format:{type:'json_schema',name:'smartport_weekly_progress_mapping',strict:true,schema}}
        })
      }));
    }finally{
      if(uploaded?.id)fetch(`${OPENAI_API}/files/${encodeURIComponent(uploaded.id)}`,{method:'DELETE',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`}}).catch(()=>{});
    }
    const raw=responseOutputText(response);
    if(!raw)throw new Error('OpenAI_returned_no_structured_output');
    try{analysis=JSON.parse(raw)}catch(_){throw new Error('OpenAI_structured_output_parse_failed')}
  }
  analysis.warnings=Array.isArray(analysis.warnings)?analysis.warnings:[];
  analysis.proposals=Array.isArray(analysis.proposals)?analysis.proposals:[];

  const index=new Map();
  for(const w of wps)index.set(`WP:${w.id}`,{...w,_team:w.owner||''});
  for(const x of subs)index.set(`SUBTASK:${x.id}`,{...x,_team:x.owner_team||''});
  const existing=await listProposals(repo,token);
  const existingKeys=new Set(existing.filter(p=>p.source_report_path===reportPath&&p.review_status!=='REJECTED').map(p=>`${String(p.target_type).toUpperCase()}:${p.target_id}`));
  const created=[];
  const analysisId=crypto.randomUUID();
  for(const a of analysis.proposals){
    const type=String(a.target_type||'').toUpperCase(),id=String(a.target_id||'').trim(),key=`${type}:${id}`;
    const target=index.get(key);
    if(!target){analysis.warnings.push(`Ignored unknown target ${key}`);continue;}
    if(String(target._team)!==ownerTeam){analysis.warnings.push(`Ignored ${id}: owner ${target._team} does not match report team ${ownerTeam}`);continue;}
    if(existingKeys.has(key)){analysis.warnings.push(`Skipped duplicate ${id}: this report already has a non-rejected proposal`);continue;}
    const current=Number(target.actual_progress??0)||0;
    const proposed=Math.max(current,Math.min(100,Number(a.progress)||0));
    const p={
      report_date:reportDate,owner_team:ownerTeam,target_type:type,target_id:id,progress:proposed,status:a.status,
      blocker:a.blocker||'',evidence:a.evidence||'',summary:a.summary||'',source_report_path:reportPath,ai_generated:true,
      ai_confidence:Number(a.confidence)||0,ai_rationale:a.rationale||'',analysis_id:analysisId
    };
    const title=`[WEEKLY-AI][${reportDate}][${ownerTeam}] ${type} ${id}`;
    const issue=await github(`/repos/${repo}/issues`,token,{method:'POST',body:JSON.stringify({title,body:proposalBody(p,author)})});
    created.push(parseProposalIssue(issue));
  }
  const model=useLocalCodex?(env.LOCAL_CODEX_MODEL||'Codex account'):(env.OPENAI_MODEL||'gpt-5-mini');
  return{analysis:{report_summary:analysis.report_summary||'',warnings:analysis.warnings,analysis_id:analysisId,model},proposals:created,report:{path:reportPath,filename}};
}

function proposalBody(p, author) {
  const payload = {
    schema_version: '1.0',
    kind: 'weekly_progress_proposal',
    submitted_by: author,
    submitted_at: new Date().toISOString(),
    report_date: p.report_date,
    owner_team: p.owner_team,
    target_type: p.target_type,
    target_id: p.target_id,
    progress: Number(p.progress),
    status: p.status,
    blocker: p.blocker || '',
    evidence: p.evidence || '',
    summary: p.summary || '',
    source_report_path: p.source_report_path || '',
    ai_generated: !!p.ai_generated,
    ai_confidence: p.ai_confidence == null ? null : Number(p.ai_confidence),
    ai_rationale: p.ai_rationale || '',
    analysis_id: p.analysis_id || ''
  };
  return `## Weekly Progress Proposal\n\n- **Report Date:** ${payload.report_date}\n- **Owner Team:** ${payload.owner_team}\n- **Target:** ${payload.target_type} ${payload.target_id}\n- **Proposed Progress:** ${payload.progress}%\n- **Status:** ${payload.status}\n- **Blocker:** ${payload.blocker || '—'}\n- **Evidence:** ${payload.evidence || '—'}\n- **Source Report:** ${payload.source_report_path || '—'}\n- **Origin:** ${payload.ai_generated ? 'AI mapped' : 'Manual'}${payload.ai_confidence == null ? '' : ` · confidence ${Math.round(payload.ai_confidence * 100)}%`}\n${payload.ai_rationale ? `- **AI Rationale:** ${payload.ai_rationale}\n` : ''}\n## Summary\n${payload.summary || '—'}\n\n<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\n${JSON.stringify(payload)}\n-->`;
}

function parseProposalIssue(issue) {
  const body = issue.body || '';
  const m = body.match(/<!-- SMARTPORT_WEEKLY_PROPOSAL_V1\s*\n([\s\S]*?)\n-->/);
  if (!m) return null;
  let payload;
  try { payload = JSON.parse(m[1]); } catch (_) { return null; }
  let review_status = 'PENDING';
  if (issue.title.startsWith('[APPROVED]')) review_status = 'APPROVED';
  else if (issue.title.startsWith('[REJECTED]')) review_status = 'REJECTED';
  return {
    issue_number: issue.number,
    title: issue.title,
    state: issue.state,
    html_url: issue.html_url,
    author: issue.user?.login || payload.submitted_by,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    review_status,
    ...payload
  };
}

async function listProposals(repo, token) {
  const issues = await github(`/repos/${repo}/issues?state=all&per_page=100&sort=created&direction=desc`, token);
  return issues.map(parseProposalIssue).filter(Boolean);
}

function applyProposalToRecord(item, p) {
  item.actual_progress = Number(p.progress);
  item.status = p.status;
  item.blocker = p.blocker || '';
  item.actual_evidence = p.evidence || '';
  item.last_update = p.report_date;
  item.last_update_summary = p.summary || '';
  item.last_update_by = p.submitted_by || '';
  return item;
}

async function updateSubtaskIssueStatus(repo, subtask, p, token) {
  if (!subtask.github_issue) return;
  const issue = await github(`/repos/${repo}/issues/${subtask.github_issue}`, token);
  const body = issue.body || '';
  const replacement = `## Project Status\n\n- **Actual Progress:** ${Number(p.progress)}%\n- **Self-reported Progress:** ${Number(p.progress)}%\n- **Status:** ${p.status}\n- **Blocker:** ${p.blocker || '—'}\n- **Evidence:** ${p.evidence || '—'}\n- **Last Approved Update:** ${p.report_date}`;
  const next = body.match(/## Project Status[\s\S]*?(?=\n## |\n> |$)/)
    ? body.replace(/## Project Status[\s\S]*?(?=\n## |\n> |$)/, replacement)
    : `${body}\n\n${replacement}`;
  await github(`/repos/${repo}/issues/${subtask.github_issue}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ body: next })
  });
}

async function approveProposal(repo, issueNumber, token) {
  const issue = await github(`/repos/${repo}/issues/${issueNumber}`, token);
  const p = parseProposalIssue(issue);
  if (!p) throw new Error('Invalid weekly proposal issue');
  if (p.review_status !== 'PENDING') throw new Error(`Proposal already ${p.review_status}`);

  if (String(p.target_type).toUpperCase() === 'WP') {
    const file = await getJsonFile(repo, 'project/work_packages.json', token);
    const idx = (file.json.work_packages || []).findIndex(x => x.id === p.target_id);
    if (idx < 0) throw new Error(`WP not found: ${p.target_id}`);
    applyProposalToRecord(file.json.work_packages[idx], p);
    await putJsonFile(repo, 'project/work_packages.json', file.json, token, `PM Approve: weekly update ${p.target_id}`);
  } else if (String(p.target_type).toUpperCase() === 'SUBTASK') {
    const file = await getJsonFile(repo, 'project/subtasks.json', token);
    const idx = (file.json.subtasks || []).findIndex(x => x.id === p.target_id);
    if (idx < 0) throw new Error(`Subtask not found: ${p.target_id}`);
    applyProposalToRecord(file.json.subtasks[idx], p);
    await putJsonFile(repo, 'project/subtasks.json', file.json, token, `PM Approve: weekly update ${p.target_id}`);
    await updateSubtaskIssueStatus(repo, file.json.subtasks[idx], p, token);
  } else {
    throw new Error(`Unsupported target_type: ${p.target_type}`);
  }

  const cleanTitle = issue.title.replace(/^\[(APPROVED|REJECTED)\]\s*/, '');
  await github(`/repos/${repo}/issues/${issueNumber}`, token, {
    method: 'PATCH',
    body: JSON.stringify({ title: `[APPROVED] ${cleanTitle}`, state: 'closed', state_reason: 'completed' })
  });
  return { ok: true, target_type: p.target_type, target_id: p.target_id };
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const C = corsHeaders(request.headers.get('Origin') || '', env);

    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: C });

    try {
      if (url.pathname === '/api/health') {
        let local = null;
        if (typeof env.LOCAL_STATUS_PROVIDER === 'function') {
          try { local = await env.LOCAL_STATUS_PROVIDER(); }
          catch (error) { local = { ready: false, error: error.message || String(error) }; }
        }
        return json({
          ok: local ? local.ready !== false : true,
          service: 'smartport-progress-hub-api',
          mode: local ? 'local' : 'cloud',
          ...(local ? { local } : {})
        }, local?.ready === false ? 503 : 200, C);
      }

      if (url.pathname === '/auth/login') {
        if (!env.GITHUB_CLIENT_ID) return json({ error: 'GITHUB_CLIENT_ID not configured' }, 500, C);
        const returnTo = safeReturnUrl(url.searchParams.get('return_to'), env) || safeReturnUrl(env.FRONTEND_URL, env);
        const { nonce, state } = oauthState(returnTo);
        const redirectUri = `${url.origin}/auth/callback`;
        const gh = new URL('https://github.com/login/oauth/authorize');
        gh.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
        gh.searchParams.set('redirect_uri', redirectUri);
        gh.searchParams.set('scope', 'repo read:org');
        gh.searchParams.set('state', state);
        return new Response(null, { status: 302, headers: { Location: gh.toString(), 'Set-Cookie': cookie('sp_state', nonce, 600), ...C } });
      }

      if (url.pathname === '/auth/callback') {
        const cookies = parseCookies(request);
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');
        const returnTo = returnUrlFromState(state, cookies.sp_state, env);
        if (!code || !returnTo) return json({ error: 'OAuth state mismatch' }, 400, C);
        if (!env.GITHUB_CLIENT_SECRET || !env.SESSION_SECRET) return json({ error: 'Server secrets are not configured' }, 500, C);
        const tokenRes = await fetch('https://github.com/login/oauth/access_token', {
          method: 'POST',
          headers: { 'Accept': 'application/json', 'Content-Type': 'application/json', 'User-Agent': 'SmartPort-Progress-Hub/0.6' },
          body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, code, redirect_uri: `${url.origin}/auth/callback` })
        });
        const t = await tokenRes.json();
        if (!t.access_token) return json({ error: 'GitHub OAuth authorization failed', detail: t }, 401, C);
        const maxAgeSec = Math.min(Number(t.expires_in || 28800), 28800);
        const sealed = await seal({ token: t.access_token, exp: Date.now() + maxAgeSec * 1000 }, env.SESSION_SECRET);
        const target = new URL(returnTo);
        target.hash = 'sp_session=' + sealed;
        return new Response(null, { status: 302, headers: { Location: target.toString(), 'Set-Cookie': cookie('sp_session', sealed, maxAgeSec), ...C } });
      }

      if (url.pathname === '/auth/logout') {
        const returnTo = safeReturnUrl(url.searchParams.get('return_to'), env) || safeReturnUrl(env.FRONTEND_URL, env);
        return new Response(null, { status: 302, headers: { Location: returnTo, 'Set-Cookie': cookie('sp_session', '', 0), ...C } });
      }

      const token = await tokenFromSession(request, env);
      if (!token) return json({ error: 'unauthorized', login: `${url.origin}/auth/login` }, 401, C);
      const repo = env.PROJECT_REPO;

      if (url.pathname === '/api/me' && request.method === 'GET') {
        const [me, access] = await Promise.all([github('/user', token), repoAccess(repo, token)]);
        return json({
          login: me.login,
          avatar_url: me.avatar_url,
          role: access.role,
          repository_permission: access.permission,
          can_write: access.can_write,
          can_approve: access.can_approve,
          can_trigger_codex: !localCodexRequiresPm(env) || access.can_approve
        }, 200, C);
      }

      if (url.pathname === '/api/admin/public-snapshot' && request.method === 'POST') {
        const access = await repoAccess(repo, token);
        if (!access.can_approve) return json({ error: 'forbidden', message: 'PM permission required' }, 403, C);
        if (typeof env.LOCAL_SNAPSHOT_PUBLISHER !== 'function') {
          return json({ error: 'public_snapshot_not_configured' }, 503, C);
        }
        return json(await env.LOCAL_SNAPSHOT_PUBLISHER(), 200, C);
      }

      if (url.pathname === '/api/reports/upload' && request.method === 'POST') {
        const me=await github('/user',token);
        const payload=await request.json();
        try{
          const report=await uploadWeeklyReport(repo,token,env,payload,me.login);
          return json({ok:true,report},201,C);
        }catch(e){
          const status=String(e.message||'').includes('REPORT_REPO_TOKEN')?503:400;
          return json({error:e.message||String(e),message:e.message||String(e)},status,C);
        }
      }

      if (url.pathname === '/api/reports/analyze' && request.method === 'POST') {
        const me=await github('/user',token);
        if(localCodexRequiresPm(env)){
          const access=await repoAccess(repo,token);
          if(!access.can_approve){
            return json({error:'pm_permission_required_for_local_codex',message:'PM permission is required to trigger Local Codex'},403,C);
          }
        }
        const payload=await request.json();
        try{
          if(env.LOCAL_JOB_QUEUE&&typeof env.LOCAL_JOB_QUEUE.enqueue==='function'){
            const job=await env.LOCAL_JOB_QUEUE.enqueue({
              type:'weekly-report-analysis',
              submitted_by:me.login,
              report_path:payload?.report_path||''
            },()=>analyzeWeeklyReportAI(repo,token,env,payload,me.login));
            return json({job},202,C);
          }
          return json(await analyzeWeeklyReportAI(repo,token,env,payload,me.login),200,C);
        }
        catch(e){
          const msg=e.message||String(e);
          const status=Number(e?.status)||(msg.includes('OPENAI_API_KEY')?503:500);
          return json({error:msg,message:msg,report_path:payload?.report_path||''},status,C);
        }
      }

      const analysisJobMatch=url.pathname.match(/^\/api\/reports\/jobs\/([A-Za-z0-9-]+)$/);
      if(analysisJobMatch&&request.method==='GET'){
        if(!env.LOCAL_JOB_QUEUE||typeof env.LOCAL_JOB_QUEUE.get!=='function'){
          return json({error:'local_job_queue_not_configured'},404,C);
        }
        const job=await env.LOCAL_JOB_QUEUE.get(analysisJobMatch[1]);
        if(!job)return json({error:'analysis_job_not_found'},404,C);
        const viewer=await github('/user',token);
        if(job.submitted_by&&job.submitted_by!==viewer.login){
          const access=await repoAccess(repo,token);
          if(!access.can_approve)return json({error:'analysis_job_forbidden'},403,C);
        }
        return json({job},200,C);
      }

      if (url.pathname === '/api/reports/proposals' && request.method === 'GET') {
        return json({ proposals: await listProposals(repo, token) }, 200, C);
      }

      if (url.pathname === '/api/reports/proposals' && request.method === 'POST') {
        const me = await github('/user', token);
        const p = await request.json();
        if (!p.report_date || !p.owner_team || !p.target_type || !p.target_id || p.progress === '' || p.progress == null || !p.status) {
          return json({ error: 'missing required proposal fields' }, 400, C);
        }
        const progress = Number(p.progress);
        if (!Number.isFinite(progress) || progress < 0 || progress > 100) return json({ error: 'progress must be 0-100' }, 400, C);
        const title = `[WEEKLY][${p.report_date}][${p.owner_team}] ${p.target_type} ${p.target_id}`;
        const issue = await github(`/repos/${repo}/issues`, token, {
          method: 'POST',
          body: JSON.stringify({ title, body: proposalBody(p, me.login) })
        });
        return json({ proposal: parseProposalIssue(issue) }, 201, C);
      }

      const approveMatch = url.pathname.match(/^\/api\/reports\/proposals\/(\d+)\/approve$/);
      if (approveMatch && request.method === 'POST') {
        const access = await repoAccess(repo, token);
        if (!access.can_approve) return json({ error: 'forbidden', message: 'PM permission required' }, 403, C);
        return json(await approveProposal(repo, Number(approveMatch[1]), token), 200, C);
      }

      const rejectMatch = url.pathname.match(/^\/api\/reports\/proposals\/(\d+)\/reject$/);
      if (rejectMatch && request.method === 'POST') {
        const access = await repoAccess(repo, token);
        if (!access.can_approve) return json({ error: 'forbidden', message: 'PM permission required' }, 403, C);
        const issueNumber = Number(rejectMatch[1]);
        const reason = (await request.json().catch(() => ({}))).reason || '';
        const issue = await github(`/repos/${repo}/issues/${issueNumber}`, token);
        const p = parseProposalIssue(issue);
        if (!p) return json({ error: 'invalid weekly proposal' }, 400, C);
        const cleanTitle = issue.title.replace(/^\[(APPROVED|REJECTED)\]\s*/, '');
        const body = `${issue.body || ''}\n\n## PM Review\n**Rejected:** ${reason || 'No reason provided'}`;
        await github(`/repos/${repo}/issues/${issueNumber}`, token, { method: 'PATCH', body: JSON.stringify({ title: `[REJECTED] ${cleanTitle}`, body, state: 'closed', state_reason: 'not_planned' }) });
        return json({ ok: true }, 200, C);
      }

      const isProjectWrite = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) &&
        (url.pathname.startsWith('/api/project/') || url.pathname.startsWith('/api/safety/'));
      if (isProjectWrite) {
        const access = await repoAccess(repo, token);
        if (!access.can_write) return json({ error: 'forbidden', message: 'This GitHub account has read-only access to SmartPort-Project-Control.', role: access.role, repository_permission: access.permission }, 403, C);
      }

      if (url.pathname === '/api/project/snapshot' && request.method === 'GET') {
        const [project, wp, subtasks, fsr, cp] = await Promise.all([
          getJsonFile(repo, 'project/project.json', token),
          getJsonFile(repo, 'project/work_packages.json', token),
          getJsonFile(repo, 'project/subtasks.json', token),
          getJsonFile(repo, 'safety/fsr.json', token),
          getJsonFile(repo, 'project/checkpoints.json', token)
        ]);
        return json({ project: project.json, work_packages: wp.json.work_packages || [], subtasks: subtasks.json.subtasks || [], functional_safety_requirements: fsr.json.functional_safety_requirements || [], checkpoints: cp.json.checkpoints || [] }, 200, C);
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
        const issue = await github(`/repos/${repo}/issues`, token, { method: 'POST', body: JSON.stringify({ title: `[${item.id}] ${item.name}`, body: `## Subtask Metadata\n- **Subtask ID:** ${item.id}\n- **Parent WP:** ${item.parent_wp}\n- **Owner Team:** ${item.owner_team || ''}\n- **Schedule:** ${item.start || ''} → ${item.end || ''}\n- **Target Checkpoint:** ${item.target_cp || ''}\n- **IF:** ${(item.ifs || []).join(', ')}\n- **FSR:** ${(item.fsrs || []).join(', ')}\n` }) });
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
          if (old.github_issue) await github(`/repos/${repo}/issues/${old.github_issue}`, token, { method: 'PATCH', body: JSON.stringify({ title: `[${item.id || id}] ${item.name || old.name}` }) });
          return json(reg.json.subtasks[idx], 200, C);
        }
        if (request.method === 'DELETE') {
          const old = reg.json.subtasks[idx];
          reg.json.subtasks.splice(idx, 1);
          await putJsonFile(repo, 'project/subtasks.json', reg.json, token, `Hub: archive subtask ${id}`);
          if (old.github_issue) await github(`/repos/${repo}/issues/${old.github_issue}`, token, { method: 'PATCH', body: JSON.stringify({ state: 'closed', state_reason: 'not_planned' }) });
          return new Response(null, { status: 204, headers: C });
        }
      }

      return json({ error: 'not found' }, 404, C);
    } catch (e) {
      return json({ error: e.message || String(e) }, 500, C);
    }
  }
};
