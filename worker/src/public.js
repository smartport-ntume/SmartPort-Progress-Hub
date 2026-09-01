import app from './reference.js';

const GH_API='https://api.github.com';

function json(data,status=200,headers={}){
  return new Response(JSON.stringify(data),{status,headers:{'Content-Type':'application/json; charset=utf-8',...headers}});
}
function cors(origin,frontendUrl){
  const allowed=new URL(frontendUrl).origin;
  return{
    'Access-Control-Allow-Origin':origin===allowed?origin:allowed,
    'Access-Control-Allow-Credentials':'true',
    'Access-Control-Allow-Headers':'Content-Type, Authorization',
    'Access-Control-Allow-Methods':'GET,POST,PUT,PATCH,DELETE,OPTIONS',
    'Vary':'Origin'
  };
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
function bytesToB64url(bytes){
  let s='';bytes.forEach(b=>{s+=String.fromCharCode(b)});
  return btoa(s).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/g,'');
}
function b64urlToBytes(s){
  s=String(s||'').replace(/-/g,'+').replace(/_/g,'/');
  while(s.length%4)s+='=';
  return Uint8Array.from(atob(s),c=>c.charCodeAt(0));
}
async function aesKey(secret,usages){
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(secret));
  return crypto.subtle.importKey('raw',digest,{name:'AES-GCM'},false,usages);
}
async function seal(value,secret){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await aesKey(secret,['encrypt']);
  const plain=new TextEncoder().encode(JSON.stringify(value));
  const encrypted=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plain));
  return `${bytesToB64url(iv)}.${bytesToB64url(encrypted)}`;
}
async function unseal(value,secret){
  try{
    const[ivPart,dataPart]=String(value||'').split('.');
    if(!ivPart||!dataPart)return null;
    const key=await aesKey(secret,['decrypt']);
    const decrypted=await crypto.subtle.decrypt({name:'AES-GCM',iv:b64urlToBytes(ivPart)},key,b64urlToBytes(dataPart));
    const data=JSON.parse(new TextDecoder().decode(decrypted));
    if(!data.exp||Date.now()>data.exp)return null;
    return data;
  }catch(_){return null;}
}
async function sessionFromRequest(req,env){
  if(!env.SESSION_SECRET)return null;
  const auth=req.headers.get('Authorization')||'';
  if(auth.startsWith('Bearer ')){
    const s=await unseal(auth.slice(7),env.SESSION_SECRET);
    if(s)return s;
  }
  const c=parseCookies(req);
  if(c.sp_session){
    const s=await unseal(c.sp_session,env.SESSION_SECRET);
    if(s)return s;
  }
  return null;
}
async function ghRaw(path,token,options={}){
  return fetch(GH_API+path,{
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
}
async function github(path,token,options={}){
  const res=await ghRaw(path,token,options);
  const text=await res.text();
  let body=null;try{body=text?JSON.parse(text):null}catch(_){body=text}
  if(!res.ok){
    const err=new Error(`GitHub ${res.status}: ${typeof body==='string'?body:JSON.stringify(body)}`);
    err.status=res.status;err.body=body;throw err;
  }
  return body;
}
function decodeUtf8Base64(v){return decodeURIComponent(escape(atob(v.replace(/\n/g,''))))}
function encodeUtf8Base64(v){return btoa(unescape(encodeURIComponent(v)))}
async function getJsonFile(repo,path,token){
  const f=await github(`/repos/${repo}/contents/${path}`,token);
  return{json:JSON.parse(decodeUtf8Base64(f.content)),sha:f.sha};
}
async function getJson(repo,path,token){return(await getJsonFile(repo,path,token)).json}
async function canWrite(repo,token){
  const r=await github(`/repos/${repo}`,token);const p=r.permissions||{};
  return!!(p.admin||p.maintain||p.push);
}
async function updateJsonMerged(repo,path,token,message,mutator,maxAttempts=4){
  let last;
  for(let attempt=1;attempt<=maxAttempts;attempt++){
    const current=await getJsonFile(repo,path,token);
    const next=mutator(JSON.parse(JSON.stringify(current.json)));
    const res=await ghRaw(`/repos/${repo}/contents/${path}`,token,{
      method:'PUT',
      body:JSON.stringify({message,content:encodeUtf8Base64(JSON.stringify(next,null,2)+'\n'),sha:current.sha})
    });
    if(res.ok)return next;
    const text=await res.text();
    last=new Error(`GitHub ${res.status}: ${text}`);last.status=res.status;
    if(res.status!==409||attempt===maxAttempts)throw last;
  }
  throw last||new Error('GitHub update conflict');
}

async function isOrgMember(token,org){
  const res=await ghRaw(`/user/memberships/orgs/${encodeURIComponent(org)}`,token);
  if(res.status===404)return false;
  if(!res.ok){const text=await res.text();throw new Error(`GitHub org check ${res.status}: ${text}`)}
  const body=await res.json();
  return body?.state==='active';
}
function constantEqual(a,b){
  if(a.length!==b.length)return false;
  let diff=0;for(let i=0;i<a.length;i++)diff|=a[i]^b[i];return diff===0;
}
async function passwordHash(password,salt,iterations){
  const baseKey=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveBits']);
  const bits=await crypto.subtle.deriveBits({name:'PBKDF2',hash:'SHA-256',salt,iterations},baseKey,256);
  return new Uint8Array(bits);
}
async function verifyGuestPassword(password,policy){
  if(!policy?.enabled||policy.password_algorithm!=='PBKDF2-SHA256')return false;
  const salt=b64urlToBytes(policy.salt);
  const expected=b64urlToBytes(policy.password_hash);
  const actual=await passwordHash(String(password||''),salt,Number(policy.iterations)||310000);
  return constantEqual(actual,expected);
}
async function loadAccessPolicy(env){
  if(!env.GUEST_REPO_TOKEN)throw Object.assign(new Error('GUEST_REPO_TOKEN is not configured'),{status:503});
  return getJson(env.PROJECT_REPO,'project/access_control.json',env.GUEST_REPO_TOKEN);
}
async function validateGuestSession(session,env){
  const policyDoc=await loadAccessPolicy(env);
  const policy=policyDoc.guest_access||{};
  const currentRevision=String(policy.revision||'');
  if(!policy.enabled||!currentRevision||String(session?.revision||'')!==currentRevision){
    throw Object.assign(new Error('guest_session_revoked'),{status:401});
  }
  return policy;
}
async function guestSnapshot(env){
  if(!env.GUEST_REPO_TOKEN)throw Object.assign(new Error('GUEST_REPO_TOKEN is not configured'),{status:503});
  const token=env.GUEST_REPO_TOKEN,repo=env.PROJECT_REPO;
  const[project,wp,subs,fsr,cp]=await Promise.all([
    getJson(repo,'project/project.json',token),
    getJson(repo,'project/work_packages.json',token),
    getJson(repo,'project/subtasks.json',token),
    getJson(repo,'safety/fsr.json',token),
    getJson(repo,'project/checkpoints.json',token)
  ]);
  return{
    project,
    work_packages:wp.work_packages||[],
    subtasks:subs.subtasks||[],
    functional_safety_requirements:fsr.functional_safety_requirements||[],
    checkpoints:cp.checkpoints||[]
  };
}
async function guestReference(env){
  if(!env.GUEST_REPO_TOKEN)throw Object.assign(new Error('GUEST_REPO_TOKEN is not configured'),{status:503});
  const token=env.GUEST_REPO_TOKEN,repo=env.PROJECT_REPO;
  const paths=[
    'project/reference_model.json','project/item_functions.json',
    'project/technical_requirements/ctl.json','project/technical_requirements/loc.json',
    'project/technical_requirements/nav_a.json','project/technical_requirements/nav_b.json',
    'project/technical_requirements/per.json','project/technical_requirements/per_b.json',
    'project/technical_requirements/stm_a.json','project/technical_requirements/stm_b.json',
    'project/technical_requirements/interfaces.json','project/technical_requirements/odd_allocation.json',
    'project/technical_requirements/traceability.json'
  ];
  const[reference,itemFunctions,ctl,loc,navA,navB,perA,perB,stmA,stmB,interfaces,odd,trace]=await Promise.all(paths.map(p=>getJson(repo,p,token)));
  return{
    reference,
    item_functions:itemFunctions,
    technical_requirements:{
      source:'Private SmartPort Project-Control baseline',
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

async function guestStatus(env,C){
  const status={
    guest_repo_token_configured:!!env.GUEST_REPO_TOKEN,
    session_secret_configured:!!env.SESSION_SECRET,
    project_repo:env.PROJECT_REPO||null,
    repo_readable:false,
    access_policy_readable:false,
    github_status:null
  };
  if(!env.GUEST_REPO_TOKEN)return json(status,200,C);
  try{
    const r=await ghRaw(`/repos/${env.PROJECT_REPO}`,env.GUEST_REPO_TOKEN);
    status.github_status=r.status;
    status.repo_readable=r.ok;
    if(r.ok){
      try{
        await getJson(env.PROJECT_REPO,'project/access_control.json',env.GUEST_REPO_TOKEN);
        status.access_policy_readable=true;
      }catch(_){}
    }
  }catch(_){status.github_status=0;}
  return json(status,200,C);
}

async function guestLogin(request,env,C){
  if(!env.SESSION_SECRET)return json({error:'SESSION_SECRET not configured'},503,C);
  const body=await request.json().catch(()=>({}));
  const policyDoc=await loadAccessPolicy(env);
  const policy=policyDoc.guest_access||{};
  const ok=await verifyGuestPassword(body.password,policy);
  if(!ok)return json({error:'invalid_password'},401,C);
  const revision=String(policy.revision||'');
  if(!revision)return json({error:'guest_policy_revision_missing'},503,C);
  const hours=Math.max(1,Math.min(24,Number(policy.session_hours)||8));
  const exp=Date.now()+hours*3600*1000;
  const session=await seal({guest:true,role:'GUEST',revision,exp},env.SESSION_SECRET);
  return json({ok:true,session,role:'GUEST',expires_at:new Date(exp).toISOString(),allowed_views:policy.allowed_views||[]},200,C);
}

async function changeGuestPassword(request,env,C,session){
  if(!session?.token)return json({error:'unauthorized'},401,C);
  const org=env.GITHUB_ORG||'smartport-ntume';
  if(!(await isOrgMember(session.token,org)))return json({error:'organization_membership_required',organization:org},403,C);
  if(!(await canWrite(env.PROJECT_REPO,session.token)))return json({error:'pm_permission_required'},403,C);
  const body=await request.json().catch(()=>({}));
  const password=String(body.password||'');
  if(password.length<12)return json({error:'password_too_short',minimum:12},400,C);
  const salt=crypto.getRandomValues(new Uint8Array(16));
  const iterations=310000;
  const hash=await passwordHash(password,salt,iterations);
  const revision=crypto.randomUUID();
  await updateJsonMerged(env.PROJECT_REPO,'project/access_control.json',session.token,'Hub: rotate guest access password',doc=>{
    doc.organization=org;
    doc.guest_access=doc.guest_access||{};
    doc.guest_access.enabled=true;
    doc.guest_access.password_algorithm='PBKDF2-SHA256';
    doc.guest_access.iterations=iterations;
    doc.guest_access.salt=bytesToB64url(salt);
    doc.guest_access.password_hash=bytesToB64url(hash);
    doc.guest_access.revision=revision;
    doc.guest_access.session_hours=Number(doc.guest_access.session_hours)||8;
    doc.guest_access.allowed_views=['dashboard','plan','fsr','cp','item-functions','reference','tr'];
    doc.guest_access.hidden_views=['reports','review','settings'];
    doc.guest_access.password_updated_at=new Date().toISOString();
    return doc;
  });
  return json({ok:true,revision},200,C);
}

export default{
  async fetch(request,env,ctx){
    const url=new URL(request.url);
    const C=cors(request.headers.get('Origin')||'',env.FRONTEND_URL);
    if(request.method==='OPTIONS')return new Response(null,{status:204,headers:C});

    try{
      if(url.pathname==='/api/guest/status'){
        if(request.method!=='GET')return json({error:'method_not_allowed'},405,C);
        return await guestStatus(env,C);
      }
      if(url.pathname==='/api/guest/login'){
        if(request.method!=='POST')return json({error:'method_not_allowed'},405,C);
        return await guestLogin(request,env,C);
      }

      const session=await sessionFromRequest(request,env);

      if(url.pathname==='/api/admin/guest-password'){
        if(request.method!=='PUT')return json({error:'method_not_allowed'},405,C);
        return await changeGuestPassword(request,env,C,session);
      }

      if(session?.guest){
        const policy=await validateGuestSession(session,env);
        if(url.pathname==='/api/me'&&request.method==='GET'){
          return json({
            login:'Guest Viewer',role:'GUEST',repository_permission:'guest-read',
            can_write:false,can_approve:false,guest:true,
            allowed_views:policy.allowed_views||[]
          },200,C);
        }
        if(url.pathname==='/api/project/snapshot'&&request.method==='GET')return json(await guestSnapshot(env),200,C);
        if(url.pathname==='/api/project/reference'&&request.method==='GET')return json(await guestReference(env),200,C);
        return json({error:'guest_read_only',message:'Guest access is read-only and Workflow is not available.'},403,C);
      }

      if(url.pathname.startsWith('/api/')&&url.pathname!=='/api/health'){
        if(!session?.token)return json({error:'authentication_required',login:`${url.origin}/auth/login`},401,C);
        const org=env.GITHUB_ORG||'smartport-ntume';
        if(!(await isOrgMember(session.token,org))){
          return json({error:'organization_membership_required',organization:org},403,C);
        }
      }

      return app.fetch(request,env,ctx);
    }catch(e){
      return json({error:e.message||String(e)},e?.status||500,C);
    }
  }
};
