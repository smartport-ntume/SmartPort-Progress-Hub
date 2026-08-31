import app from './main.js';

const GH_API='https://api.github.com';

function json(data,status=200,headers={}){return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}})}
function cors(origin,frontendUrl){const allowed=new URL(frontendUrl).origin;return{'Access-Control-Allow-Origin':origin===allowed?origin:allowed,'Access-Control-Allow-Credentials':'true','Access-Control-Allow-Headers':'Content-Type, Authorization','Access-Control-Allow-Methods':'GET,POST,PUT,DELETE,OPTIONS','Vary':'Origin'}}
function b64urlToBytes(s){s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');while(s.length%4)s+='=';return Uint8Array.from(atob(s),c=>c.charCodeAt(0))}
async function sessionKey(secret){const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt'])}
async function unseal(value,secret){try{const[ivPart,dataPart]=String(value||'').split('.');if(!ivPart||!dataPart)return null;const key=await sessionKey(secret);const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64urlToBytes(ivPart)},key,b64urlToBytes(dataPart));const data=JSON.parse(new TextDecoder().decode(decrypted));if(!data.exp||Date.now()>data.exp)return null;return data}catch(_){return null}}
async function tokenFromRequest(req,env){const auth=req.headers.get('Authorization')||'';if(!auth.startsWith('Bearer ')||!env.SESSION_SECRET)return null;const s=await unseal(auth.slice(7),env.SESSION_SECRET);return s?.token||null}
async function github(path,token){const res=await fetch(GH_API+path,{headers:{'Accept':'application/vnd.github+json','Authorization':`Bearer ${token}`,'User-Agent':'SmartPort-Progress-Hub/0.6','X-GitHub-Api-Version':'2022-11-28'}});const text=await res.text();let body=null;try{body=text?JSON.parse(text):null}catch(_){body=text}if(!res.ok)throw new Error(`GitHub ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);return body}
function decodeUtf8Base64(v){return decodeURIComponent(escape(atob(v.replace(/\n/g,''))))}
async function getJson(repo,path,token){const f=await github(`/repos/${repo}/contents/${path}`,token);return JSON.parse(decodeUtf8Base64(f.content))}

async function loadReference(repo,token){
  const paths=[
    'project/reference_model.json',
    'project/technical_requirements/ctl.json',
    'project/technical_requirements/loc.json',
    'project/technical_requirements/nav_a.json',
    'project/technical_requirements/nav_b.json',
    'project/technical_requirements/per.json',
    'project/technical_requirements/per_b.json',
    'project/technical_requirements/stm_a.json',
    'project/technical_requirements/stm_b.json',
    'project/technical_requirements/interfaces.json',
    'project/technical_requirements/odd_allocation.json',
    'project/technical_requirements/traceability.json'
  ];
  const [reference,ctl,loc,navA,navB,perA,perB,stmA,stmB,interfaces,odd,trace]=await Promise.all(paths.map(p=>getJson(repo,p,token)));
  return {
    reference,
    technical_requirements:{
      source:'跨運車文件報告_v1(2).pptx slides 60-70',
      status:'Preliminary / TBD as stated in source',
      groups:[
        {group:'CTL',requirements:ctl.requirements||[]},
        {group:'LOC',requirements:loc.requirements||[]},
        {group:'NAV',requirements:[...(navA.requirements||[]),...(navB.requirements||[])]},
        {group:'PER',requirements:[...(perA.requirements||[]),...(perB.requirements||[])]},
        {group:'STM',requirements:[...(stmA.requirements||[]),...(stmB.requirements||[])]}
      ],
      interfaces:interfaces.interfaces||[],
      odd_allocation:odd.odd_allocation||[],
      fsr_traceability:trace.fsr_traceability||[],
      open_gates:trace.open_gates||[]
    }
  };
}

export default{async fetch(request,env,ctx){const url=new URL(request.url);if(url.pathname==='/api/project/reference'){const C=cors(request.headers.get('Origin')||'',env.FRONTEND_URL);if(request.method==='OPTIONS')return new Response(null,{status:204,headers:C});if(request.method!=='GET')return json({error:'method not allowed'},405,C);try{const token=await tokenFromRequest(request,env);if(!token)return json({error:'unauthorized'},401,C);return json(await loadReference(env.PROJECT_REPO,token),200,C)}catch(e){return json({error:e.message||String(e)},500,C)}}return app.fetch(request,env,ctx)}};
