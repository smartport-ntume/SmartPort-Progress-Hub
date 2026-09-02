from pathlib import Path

BUILD_OLD='20260902.1420'
BUILD_NEW='20260902.1750'

# --- Worker: weekly report archive + AI mapping ---
p=Path('worker/src/index.js')
s=p.read_text(encoding='utf-8')
marker='function proposalBody(p, author) {'
if marker not in s:
    raise SystemExit('proposalBody marker not found')
if 'async function analyzeWeeklyReportAI' not in s:
    helper=r'''const OPENAI_API = 'https://api.openai.com/v1';

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
  if(!env.OPENAI_API_KEY)throw new Error('OPENAI_API_KEY_not_configured');
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
  const form=new FormData();
  form.append('purpose','user_data');
  form.append('file',new Blob([fileBytes],{type:reportMime(filename)}),filename);
  const uploaded=await openAIJson(await fetch(`${OPENAI_API}/files`,{
    method:'POST',headers:{'Authorization':`Bearer ${env.OPENAI_API_KEY}`},body:form
  }));

  const wps=wpFile.json.work_packages||[],subs=subFile.json.subtasks||[];
  const context={
    report_date:reportDate,
    owner_team:ownerTeam,
    work_packages:wps.map(w=>({id:w.id,name:w.name,owner:w.owner,start:w.start,end:w.end,actual_progress:w.actual_progress??null,status:w.status||'Not Updated',description:w.description||''})),
    subtasks:subs.map(x=>({id:x.id,parent_wp:x.parent_wp,name:x.name,owner_team:x.owner_team,start:x.start,end:x.end,target_cp:x.target_cp||'',actual_progress:x.actual_progress??null,status:x.status||'Not Updated',description:x.description||''}))
  };
  const schema={
    type:'object',additionalProperties:false,required:['report_summary','warnings','proposals'],properties:{
      report_summary:{type:'string'},warnings:{type:'array',items:{type:'string'}},
      proposals:{type:'array',items:{type:'object',additionalProperties:false,required:['target_type','target_id','progress','status','blocker','evidence','summary','confidence','rationale'],properties:{
        target_type:{type:'string',enum:['WP','SUBTASK']},target_id:{type:'string'},progress:{type:'number',minimum:0,maximum:100},
        status:{type:'string',enum:['On Track','At Risk','Blocked','Delayed','Completed']},blocker:{type:'string'},evidence:{type:'string'},summary:{type:'string'},confidence:{type:'number',minimum:0,maximum:1},rationale:{type:'string'}
      }}}
    }
  };

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
  let analysis;try{analysis=JSON.parse(raw)}catch(_){throw new Error('OpenAI_structured_output_parse_failed')}
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
  return{analysis:{report_summary:analysis.report_summary||'',warnings:analysis.warnings,analysis_id:analysisId,model:env.OPENAI_MODEL||'gpt-5-mini'},proposals:created,report:{path:reportPath,filename}};
}

'''
    s=s.replace(marker,helper+marker,1)

old="    summary: p.summary || ''\n  };"
new="    summary: p.summary || '',\n    source_report_path: p.source_report_path || '',\n    ai_generated: !!p.ai_generated,\n    ai_confidence: p.ai_confidence == null ? null : Number(p.ai_confidence),\n    ai_rationale: p.ai_rationale || '',\n    analysis_id: p.analysis_id || ''\n  };"
if old not in s:
    raise SystemExit('proposal payload pattern not found')
s=s.replace(old,new,1)

old2="- **Evidence:** ${payload.evidence || '—'}\\n\\n## Summary"
new2="- **Evidence:** ${payload.evidence || '—'}\\n- **Source Report:** ${payload.source_report_path || '—'}\\n- **Origin:** ${payload.ai_generated ? 'AI mapped' : 'Manual'}${payload.ai_confidence == null ? '' : ` · confidence ${Math.round(payload.ai_confidence * 100)}%`}\\n${payload.ai_rationale ? `- **AI Rationale:** ${payload.ai_rationale}\\n` : ''}\\n## Summary"
if old2 not in s:
    raise SystemExit('proposal body evidence pattern not found')
s=s.replace(old2,new2,1)

route_marker="      if (url.pathname === '/api/reports/proposals' && request.method === 'GET') {"
if route_marker not in s:
    raise SystemExit('proposal route marker not found')
if "url.pathname === '/api/reports/upload'" not in s:
    routes=r'''      if (url.pathname === '/api/reports/upload' && request.method === 'POST') {
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
        const payload=await request.json();
        try{return json(await analyzeWeeklyReportAI(repo,token,env,payload,me.login),200,C);}
        catch(e){
          const msg=e.message||String(e);
          const status=msg.includes('OPENAI_API_KEY')?503:500;
          return json({error:msg,message:msg,report_path:payload?.report_path||''},status,C);
        }
      }

'''
    s=s.replace(route_marker,routes+route_marker,1)
p.write_text(s,encoding='utf-8')

# --- Gantt: outline = team; fill width = actual progress ---
p=Path('js/app.js')
s=p.read_text(encoding='utf-8')
old="bar.style.background=teamColor[owner]||'#667085';bar.title=`${t.id} · ${t.name}\\n${t.start} → ${t.end}`;bar.onclick=()=>t._kind==='wp'?openWpDetail(t.id):openSubtaskDetail(t.id);bar.innerHTML=`<div class=\"fill\" style=\"width:${p||0}%\"></div><div class=\"bar-label\">${esc(t.id)} · ${esc(t.name||'')}</div>`;"
new="bar.style.setProperty('--bar-color',teamColor[owner]||'#667085');bar.title=`${t.id} · ${t.name}\\n${t.start} → ${t.end}\\nProgress: ${p==null?'Not Updated':p+'%'}`;bar.onclick=()=>t._kind==='wp'?openWpDetail(t.id):openSubtaskDetail(t.id);bar.innerHTML=`<div class=\"fill\" style=\"width:${p==null?0:p}%\"></div><div class=\"bar-label\">${esc(t.id)} · ${esc(t.name||'')}${p==null?'':' · '+p+'%'}</div>`;"
if old not in s:
    raise SystemExit('Gantt bar render pattern not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')

p=Path('css/app.css')
s=p.read_text(encoding='utf-8')
old=".bar{position:absolute;height:24px;top:12px;border-radius:6px;cursor:pointer;box-shadow:inset 0 0 0 1px rgba(0,0,0,.08);transition:filter .12s,transform .12s}.bar:hover{filter:brightness(1.06);transform:translateY(-1px)}.bar .fill{height:100%;border-radius:6px;background:rgba(255,255,255,.32);border-right:2px solid rgba(255,255,255,.9)}.bar-label{position:absolute;left:7px;top:4px;color:#fff;font-size:11px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:95%}"
new=".bar{position:absolute;height:24px;top:12px;border-radius:6px;cursor:pointer;border:2px solid var(--bar-color,#667085);background:rgba(255,255,255,.72);overflow:hidden;transition:filter .12s,transform .12s}.bar:hover{filter:brightness(1.02);transform:translateY(-1px)}.bar .fill{height:100%;background:var(--bar-color,#667085);opacity:.34;border-radius:3px 0 0 3px}.bar-label{position:absolute;left:7px;right:5px;top:3px;color:#25324a;font-size:11px;font-weight:600;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;text-shadow:0 1px 1px rgba(255,255,255,.9)}"
if old not in s:
    raise SystemExit('Gantt CSS pattern not found')
s=s.replace(old,new,1)
p.write_text(s,encoding='utf-8')

# --- Worker config ---
p=Path('worker/wrangler.toml')
s=p.read_text(encoding='utf-8')
if 'OPENAI_MODEL' not in s:
    s=s.replace('GITHUB_CLIENT_ID = "Ov23liGRrIsBDpAtXDck"','GITHUB_CLIENT_ID = "Ov23liGRrIsBDpAtXDck"\nOPENAI_MODEL = "gpt-5-mini"')
if '#   OPENAI_API_KEY' not in s:
    s=s.replace('#   GUEST_REPO_TOKEN   # fine-grained GitHub token, Contents: Read-only, SmartPort-Project-Control only','#   GUEST_REPO_TOKEN   # fine-grained GitHub token, Contents: Read-only, SmartPort-Project-Control only\n#   OPENAI_API_KEY     # OpenAI API key used only by Worker for weekly-report mapping\n#   REPORT_REPO_TOKEN  # service token for Engineer report uploads; Contents: Read/Write on Project-Control')
p.write_text(s,encoding='utf-8')

# --- Build + README ---
for name in ['index.html','README.md']:
    p=Path(name);s=p.read_text(encoding='utf-8')
    if BUILD_OLD not in s:
        raise SystemExit(f'build {BUILD_OLD} missing in {name}')
    s=s.replace(BUILD_OLD,BUILD_NEW)
    p.write_text(s,encoding='utf-8')

p=Path('README.md');s=p.read_text(encoding='utf-8')
if '## AI Weekly Report Intake' not in s:
    insert='''\n## AI Weekly Report Intake\n\nOrganization members can upload `.doc` / `.docx` weekly reports from **Workflow → Weekly Reports**. The original file is archived under `weekly_reports/<year>/<date>/<team>/` in the private Project-Control repository. The Worker then uses the OpenAI Responses API with Structured Outputs to map evidence-supported report content into WP/Subtask Proposed Updates. AI proposals never update the formal baseline directly; PM approval remains mandatory.\n\nCloudflare Runtime Secrets required for the full workflow:\n\n- `OPENAI_API_KEY` — OpenAI API access; never expose it to the browser.\n- `REPORT_REPO_TOKEN` — required when Engineer accounts are read-only; fine-grained GitHub token with **Contents: Read/Write** restricted to `SmartPort-Project-Control`. The Worker constrains uploads to `weekly_reports/`.\n\nThe Worker variable `OPENAI_MODEL` defaults to `gpt-5-mini`.\n'''
    s=s.replace('\n## Main workflow\n',insert+'\n## Main workflow\n')
p.write_text(s,encoding='utf-8')

print('Applied Weekly AI intake, GitHub archive, and progress-fill Gantt; build',BUILD_NEW)
