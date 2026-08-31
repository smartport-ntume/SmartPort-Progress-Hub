import app from './main.js';

const GH_API='https://api.github.com';

function json(data,status=200,headers={}){
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
}

function cors(origin,frontendUrl){
  const allowed=new URL(frontendUrl).origin;
  return {
    'Access-Control-Allow-Origin':origin===allowed?origin:allowed,
    'Access-Control-Allow-Credentials':'true',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Vary':'Origin'
  };
}

function b64urlToBytes(s){
  s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4)s+='=';
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}

async function sessionKey(secret){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,['decrypt']);
}

async function unseal(value,secret){
  try{
    const[ivPart,dataPart]=String(value||'').split('.');
    if(!ivPart||!dataPart)return null;
    const key=await sessionKey(secret);
    const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64urlToBytes(ivPart)},key,b64urlToBytes(dataPart));
    const data=JSON.parse(new TextDecoder().decode(decrypted));
    if(!data.exp||Date.now()>data.exp)return null;
    return data;
  }catch(_){return null;}
}

function parseCookies(req){
  const out={};
  for(const part of(req.headers.get('Cookie')||'').split(';')){
    const i=part.indexOf('=');
    if(i<0)continue;
    out[part.slice(0,i).trim()]=decodeURIComponent(part.slice(i+1).trim());
  }
  return out;
}

async function tokenFromRequest(req,env){
  if(!env.SESSION_SECRET)return null;
  const auth=req.headers.get('Authorization')||'';
  if(auth.startsWith('Bearer ')){
    const s=await unseal(auth.slice(7),env.SESSION_SECRET);
    if(s?.token)return s.token;
  }
  const c=parseCookies(req);
  if(c.sp_session){
    const s=await unseal(c.sp_session,env.SESSION_SECRET);
    if(s?.token)return s.token;
  }
  return null;
}

async function github(path,token,options={}){
  const res=await fetch(GH_API+path,{
    ...options,
    headers:{
      'Accept':'application/vnd.github+json',
      'Authorization':`Bearer ${token}`,
      'User-Agent':'SmartPort-Progress-Hub/0.6',
      'X-GitHub-Api-Version':'2022-11-28',
      'Content-Type':'application/json',
      ...(options.headers||{})
    }
  });
  const text=await res.text();
  let body=null;
  try{body=text?JSON.parse(text):null}catch(_){body=text}
  if(!res.ok){
    const err=new Error(`GitHub ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);
    err.status=res.status;
    err.body=body;
    throw err;
  }
  return body;
}

function decodeUtf8Base64(v){return decodeURIComponent(escape(atob(v.replace(/\n/g,''))))}
function encodeUtf8Base64(v){return btoa(unescape(encodeURIComponent(v)))}
function clone(v){return JSON.parse(JSON.stringify(v))}

async function getJsonFile(repo,path,token){
  const f=await github(`/repos/${repo}/contents/${path}`,token);
  return{json:JSON.parse(decodeUtf8Base64(f.content)),sha:f.sha};
}

async function getJson(repo,path,token){return(await getJsonFile(repo,path,token)).json}

async function putJson(repo,path,payload,token,message){
  let sha;
  try{sha=(await github(`/repos/${repo}/contents/${path}`,token)).sha}catch(_){}
  return github(`/repos/${repo}/contents/${path}`,token,{
    method:'PUT',
    body:JSON.stringify({message,content:encodeUtf8Base64(JSON.stringify(payload,null,2)+'\n'),...(sha?{sha}:{})})
  });
}

async function updateJsonMerged(repo,path,token,message,mutator,maxAttempts=4){
  let lastError=null;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const current=await getJsonFile(repo,path,token);
    const next=mutator(clone(current.json));
    try{
      await github(`/repos/${repo}/contents/${path}`,token,{
        method:'PUT',
        body:JSON.stringify({
          message,
          content:encodeUtf8Base64(JSON.stringify(next,null,2)+'\n'),
          sha:current.sha
        })
      });
      return next;
    }catch(e){
      lastError=e;
      if(e?.status!==409||attempt===maxAttempts)throw e;
    }
  }
  throw lastError||new Error('GitHub update conflict');
}

async function repoAccess(repo,token){
  const r=await github(`/repos/${repo}`,token);
  const p=r.permissions||{};
  return{can_write:!!(p.admin||p.maintain||p.push)};
}

function dateToReference(iso){
  const m=String(iso||'').match(/^\d{4}-(\d{2})-(\d{2})$/);
  return m?`${Number(m[1])}/${Number(m[2])}`:String(iso||'');
}

async function patchCheckpoint(repo,id,patch,token){
  const checkpointDoc=await updateJsonMerged(
    repo,
    'project/checkpoints.json',
    token,
    `Hub: update checkpoint ${id}`,
    doc=>{
      doc.checkpoints=Array.isArray(doc.checkpoints)?doc.checkpoints:[];
      const idx=doc.checkpoints.findIndex(x=>x.id===id);
      if(idx<0)throw new Error(`Checkpoint not found: ${id}`);
      const old=doc.checkpoints[idx];
      doc.checkpoints[idx]={
        ...old,
        ...patch,
        id:old.id
      };
      return doc;
    }
  );

  const updated=checkpointDoc.checkpoints.find(x=>x.id===id);

  const referenceDoc=await updateJsonMerged(
    repo,
    'project/reference_model.json',
    token,
    `Hub: sync ACL roadmap ${id}`,
    doc=>{
      doc.acl_levels=Array.isArray(doc.acl_levels)?doc.acl_levels:[];
      const idx=doc.acl_levels.findIndex(x=>x.checkpoint===id);
      const refPatch={
        checkpoint:id,
        date:dateToReference(updated.date),
        level:updated.acl||'',
        capability:updated.capability||'',
        review_checks:updated.review_checks||'',
        fsr_maturity_target:updated.fsrTarget||updated.fsr_target||''
      };
      if(idx>=0)doc.acl_levels[idx]={...doc.acl_levels[idx],...refPatch};
      else doc.acl_levels.push(refPatch);
      return doc;
    }
  );

  return{
    ok:true,
    checkpoint:updated,
    reference:referenceDoc.acl_levels.find(x=>x.checkpoint===id)||null
  };
}

async function loadReference(repo,token){
  const paths=[
    'project/reference_model.json',
    'project/item_functions.json',
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
  const[reference,itemFunctions,ctl,loc,navA,navB,perA,perB,stmA,stmB,interfaces,odd,trace]=await Promise.all(paths.map(p=>getJson(repo,p,token)));
  return{
    reference,
    item_functions:itemFunctions,
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

function validateReference(v){
  if(!v||!Array.isArray(v.acl_levels)||!Array.isArray(v.fsr_maturity_levels))throw new Error('reference_model requires acl_levels[] and fsr_maturity_levels[]');
  return v;
}

function groupMap(t){return new Map((t.groups||[]).map(g=>[String(g.group||'').toUpperCase(),g.requirements||[]]))}

async function saveTechnicalRequirements(repo,t,token){
  const m=groupMap(t),nav=m.get('NAV')||[],per=m.get('PER')||[],stm=m.get('STM')||[];
  const writes=[
    ['project/technical_requirements/ctl.json',{schema_version:'1.0',group:'CTL',requirements:m.get('CTL')||[]}],
    ['project/technical_requirements/loc.json',{schema_version:'1.0',group:'LOC',requirements:m.get('LOC')||[]}],
    ['project/technical_requirements/nav_a.json',{schema_version:'1.0',group:'NAV',requirements:nav.slice(0,4)}],
    ['project/technical_requirements/nav_b.json',{schema_version:'1.0',group:'NAV',requirements:nav.slice(4)}],
    ['project/technical_requirements/per.json',{schema_version:'1.0',group:'PER',requirements:per.slice(0,7)}],
    ['project/technical_requirements/per_b.json',{schema_version:'1.0',group:'PER',requirements:per.slice(7)}],
    ['project/technical_requirements/stm_a.json',{schema_version:'1.0',group:'STM',requirements:stm.slice(0,7)}],
    ['project/technical_requirements/stm_b.json',{schema_version:'1.0',group:'STM',requirements:stm.slice(7)}],
    ['project/technical_requirements/interfaces.json',{schema_version:'1.0',interfaces:t.interfaces||[]}],
    ['project/technical_requirements/odd_allocation.json',{schema_version:'1.0',odd_allocation:t.odd_allocation||[]}],
    ['project/technical_requirements/traceability.json',{schema_version:'1.0',fsr_traceability:t.fsr_traceability||[],open_gates:t.open_gates||[]}]
  ];
  for(const[path,payload]of writes)await putJson(repo,path,payload,token,'Hub: update Technical Requirements');
  return{ok:true};
}

export default{
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    const cpMatch=url.pathname.match(/^\/api\/project\/checkpoints\/([^/]+)$/);
    const isReference=url.pathname.startsWith('/api/project/reference');

    if(!cpMatch&&!isReference)return app.fetch(request,env,ctx);

    const C=cors(request.headers.get('Origin')||'',env.FRONTEND_URL);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:C});

    try{
      const token=await tokenFromRequest(request,env);
      if(!token)return json({error:'unauthorized'},401,C);
      const repo=env.PROJECT_REPO;

      if(cpMatch&&request.method==='PATCH'){
        const access=await repoAccess(repo,token);
        if(!access.can_write)return json({error:'forbidden',message:'PM / Write permission required'},403,C);
        const id=decodeURIComponent(cpMatch[1]);
        const patch=await request.json();
        return json(await patchCheckpoint(repo,id,patch,token),200,C);
      }

      if(url.pathname==='/api/project/reference'&&request.method==='GET'){
        return json(await loadReference(repo,token),200,C);
      }

      if(request.method==='PUT'){
        const access=await repoAccess(repo,token);
        if(!access.can_write)return json({error:'forbidden',message:'PM / Write permission required'},403,C);

        if(url.pathname==='/api/project/reference/reference-model'){
          const payload=validateReference(await request.json());
          await putJson(repo,'project/reference_model.json',payload,token,'Hub: update ACL / FSR maturity reference');
          return json({ok:true},200,C);
        }

        if(url.pathname==='/api/project/reference/item-functions'){
          const payload=await request.json();
          if(!Array.isArray(payload?.item_functions))return json({error:'item_functions[] required'},400,C);
          await putJson(repo,'project/item_functions.json',payload,token,'Hub: update Item Function baseline');
          return json({ok:true},200,C);
        }

        if(url.pathname==='/api/project/reference/technical-requirements'){
          return json(await saveTechnicalRequirements(repo,await request.json(),token),200,C);
        }
      }

      return json({error:'not found'},404,C);
    }catch(e){
      const status=e?.status===409?409:500;
      return json({error:e.message||String(e)},status,C);
    }
  }
};
