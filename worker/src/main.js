import app from './index.js';
import { V041_SUBTASKS_GZIP_B64 } from './v041-subtasks.js';
import { corsHeaders } from './cors.js';

const GH_API='https://api.github.com';

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}})}
function b64urlToBytes(s){s=s.replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function sessionKey(secret){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt'])}
async function unseal(value,secret){try{const[ivPart,dataPart]=String(value||'').split('.');if(!ivPart||!dataPart)return null;const key=await sessionKey(secret);const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64urlToBytes(ivPart)},key,b64urlToBytes(dataPart));const data=JSON.parse(new TextDecoder().decode(decrypted));if(!data.exp||Date.now()>data.exp)return null;return data}catch(_){return null}}
async function tokenFromRequest(req,env){const auth=req.headers.get('Authorization')||'';if(env.INTERNAL_AGENT_BEARER&&env.LOCAL_GITHUB_TOKEN&&auth===`Bearer ${env.INTERNAL_AGENT_BEARER}`)return env.LOCAL_GITHUB_TOKEN;if(!auth.startsWith('Bearer ')||!env.SESSION_SECRET)return null;const s=await unseal(auth.slice(7),env.SESSION_SECRET);return s?.token||null}
async function github(path,token,options={}){const res=await fetch(GH_API+path,{...options,headers:{'Accept':'application/vnd.github+json','Authorization':`Bearer ${token}`,'User-Agent':'SmartPort-Progress-Hub/0.6','X-GitHub-Api-Version':'2022-11-28','Content-Type':'application/json',...(options.headers||{})}});const text=await res.text();let body=null;try{body=text?JSON.parse(text):null}catch(_){body=text}if(!res.ok)throw new Error(`GitHub ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);return body}
function decodeUtf8Base64(v){return decodeURIComponent(escape(atob(v.replace(/\n/g,''))))}
function encodeUtf8Base64(v){return btoa(unescape(encodeURIComponent(v)))}
async function ungzipBase64(b64){const raw=Uint8Array.from(atob(b64),c=>c.charCodeAt(0));const stream=new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'));return new Response(stream).text()}

async function restoreV041(req,env,C){
  const token=await tokenFromRequest(req,env);if(!token)return json({error:'unauthorized'},401,C);
  const repo=env.PROJECT_REPO;
  const repoInfo=await github(`/repos/${repo}`,token);const p=repoInfo.permissions||{};if(!(p.admin||p.maintain||p.push))return json({error:'forbidden',message:'PM/write permission required'},403,C);
  const current=await github(`/repos/${repo}/contents/project/subtasks.json`,token);
  const currentJson=JSON.parse(decodeUtf8Base64(current.content));
  if((currentJson.subtasks||[]).length>6)return json({ok:true,skipped:true,count:(currentJson.subtasks||[]).length},200,C);
  const baseline=JSON.parse(await ungzipBase64(V041_SUBTASKS_GZIP_B64));
  const existing=new Map((currentJson.subtasks||[]).map(x=>[x.id,x]));
  const preserveKeys=['github_issue','actual_progress','self_progress','status','blocker','blockers','actual_evidence','pm_comment','pm_comments','last_update','last_update_by','last_update_summary','last_week','this_week'];
  baseline.subtasks=baseline.subtasks.map(b=>{const old=existing.get(b.id)||{};const out={...b};for(const k of preserveKeys)if(old[k]!==undefined)out[k]=old[k];return out});
  baseline.status='Full v0.4.1 Subtask baseline migrated to GitHub-backed registry';
  baseline.description='Executable Subtask registry restored from SmartPort Progress Hub v0.4.1. Existing GitHub Issue mappings and approved execution status are preserved.';
  await github(`/repos/${repo}/contents/project/subtasks.json`,token,{method:'PUT',body:JSON.stringify({message:'Hub migration: restore full v0.4.1 Subtask baseline',content:encodeUtf8Base64(JSON.stringify(baseline,null,2)+'\n'),sha:current.sha})});
  return json({ok:true,count:baseline.subtasks.length},200,C);
}

export default{async fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/api/admin/restore-v041-subtasks'){const C=corsHeaders(request.headers.get('Origin')||'',env);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:C});if(request.method!=='POST')return json({error:'method not allowed'},405,C);try{return await restoreV041(request,env,C)}catch(e){return json({error:e.message||String(e)},500,C)}}return app.fetch(request,env,ctx)}};
