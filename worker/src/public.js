import app from './reference.js';

const GH_API='https://api.github.com';

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}})}
function cors(origin,frontendUrl){const allowed=new URL(frontendUrl).origin;return{'Access-Control-Allow-Origin':origin===allowed?origin:allowed,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Vary':'Origin'}}
function b64urlToBytes(s){s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function sessionKey(secret){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt'])}
async function unseal(value,secret){try{const[ivPart,dataPart]=String(value||'').split('.');if(!ivPart||!dataPart)return null;const key=await sessionKey(secret);const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64urlToBytes(ivPart)},key,b64urlToBytes(dataPart));const data=JSON.parse(new TextDecoder().decode(decrypted));if(!data.exp||Date.now()>data.exp)return null;return data}catch(_){return null}}
function parseCookies(req){const out={};for(const part of(req.headers.get('Cookie')||'').split(';')){const i=part.indexOf('=');if(i<0)continue;out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim())}return out}
async function tokenFromRequest(req,env){if(!env.SESSION_SECRET)return null;const auth=req.headers.get('Authorization')||'';if(auth.startsWith('Bearer ')){const s=await unseal(auth.slice(7),env.SESSION_SECRET);if(s?.token)return s.token}const c=parseCookies(req);if(c.sp_session){const s=await unseal(c.sp_session,env.SESSION_SECRET);if(s?.token)return s.token}return null}
async function ghRaw(path,token,options={}){return fetch(GH_API+path,{...options,headers:{'Accept':'application/vnd.github+json','Authorization':`Bearer ${token}`,'User-Agent':'SmartPort-Progress-Hub/0.6','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json',...(options.headers||{})}})}
async function github(path,token,options={}){const res=await ghRaw(path,token,options);const text=await res.text();let body=null;try{body=text?JSON.parse(text):null}catch(_){body=text}if(!res.ok)throw new Error(`GitHub ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);return body}
function decodeUtf8Base64(v){return decodeURIComponent(escape(atob(v.replace(/\n/g,''))))}
function encodeUtf8Base64(v){return btoa(unescape(encodeURIComponent(v)))}
async function getJson(repo,path,token){const f=await github(`/repos/${repo}/contents/${path}`,token);return JSON.parse(decodeUtf8Base64(f.content))}
async function canWrite(repo,token){const r=await github(`/repos/${repo}`,token);const p=r.permissions||{};return!!(p.admin||p.maintain||p.push)}

function sanitizeWp(w){return{id:w.id,name:w.name||'',owner:w.owner||'',group:w.group||'',start:w.start||'',end:w.end||'',description:w.description||'',actual_progress:w.actual_progress??w.actualProgress??w.progress??null,status:w.status||'Not Updated'}}
function sanitizeCp(cp){return{id:cp.id,date:cp.date||'',acl:cp.acl||'',name:cp.name||'',capability:cp.capability||'',review_checks:cp.review_checks||''}}

async function putPublicSnapshot(repo,payload,token){
  const path='data/public_snapshot.json';
  for(let attempt=0;attempt<2;attempt++){
    let sha;
    try{sha=(await github(`/repos/${repo}/contents/${path}`,token)).sha}catch(_){}
    const res=await ghRaw(`/repos/${repo}/contents/${path}`,token,{method:'PUT',body:JSON.stringify({message:'Hub: sync public read-only snapshot',content:encodeUtf8Base64(JSON.stringify(payload,null,2)+'\n'),...(sha?{sha}:{})})});
    if(res.ok)return res.json();
    const text=await res.text();
    if(res.status===409&&attempt===0)continue;
    throw new Error(`GitHub ${res.status}: ${text}`);
  }
}

async function syncPublic(request,env,C){
  const token=await tokenFromRequest(request,env);if(!token)return json({error:'unauthorized'},401,C);
  if(!(await canWrite(env.PROJECT_REPO,token)))return json({error:'forbidden',message:'PM / Write permission required'},403,C);
  const publicRepo=env.PUBLIC_REPO||'smartport-ntume/SmartPort-Progress-Hub';
  if(!(await canWrite(publicRepo,token)))return json({error:'forbidden',message:`Your GitHub account cannot write ${publicRepo}.`},403,C);

  const [wp,cp]=await Promise.all([
    getJson(env.PROJECT_REPO,'project/work_packages.json',token),
    getJson(env.PROJECT_REPO,'project/checkpoints.json',token)
  ]);

  const payload={
    schema_version:'1.0',
    visibility:'public_read_only',
    generated_at:new Date().toISOString(),
    note:'Public whitelist snapshot. Internal FSR, IF, TR, evidence, comments, issues and review data are excluded.',
    project:{name:'SmartPort SC Autonomous Prototype',mode:'Public Read Only'},
    work_packages:(wp.work_packages||[]).map(sanitizeWp),
    subtasks:[],
    checkpoints:(cp.checkpoints||[]).map(sanitizeCp),
    functional_safety_requirements:[]
  };

  await putPublicSnapshot(publicRepo,payload,token);
  return json({ok:true,generated_at:payload.generated_at,work_packages:payload.work_packages.length,checkpoints:payload.checkpoints.length},200,C);
}

export default{async fetch(request,env,ctx){
  const url=new URL(request.url);
  if(url.pathname!=='/api/public/sync')return app.fetch(request,env,ctx);
  const C=cors(request.headers.get('Origin')||'',env.FRONTEND_URL);
  if(request.method==='OPTIONS')return new Response(null,{status:204,headers:C});
  if(request.method!=='POST')return json({error:'method not allowed'},405,C);
  try{return await syncPublic(request,env,C)}catch(e){return json({error:e.message||String(e)},500,C)}
}};
