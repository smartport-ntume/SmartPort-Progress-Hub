(() => {
  const API=window.SmartPortAPI;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  let data=null;

  async function request(path,options={}){return API.request(path,options)}
  function canWrite(){return !!window.SMARTPORT_ACCESS?.can_write}
  function toast(msg){const el=document.getElementById('toast');if(!el)return;el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),3600)}

  function install(){
    const nav=document.querySelector('.nav'),main=document.querySelector('main');if(!nav||!main||document.getElementById('item-functions'))return false;
    const refBtn=nav.querySelector('[data-view="reference"]'),trBtn=nav.querySelector('[data-view="tr"]');if(!refBtn||!trBtn)return false;
    const b=document.createElement('button');b.dataset.view='item-functions';b.textContent='Item Function';nav.insertBefore(b,refBtn);
    const sec=document.createElement('section');sec.id='item-functions';sec.className='view';sec.innerHTML=`<div class="panel"><div class="panel-title">Item Function Baseline <div class="toolbar"><span class="revision-badge">IF-01 ～ IF-16</span></div></div><div id="itemFunctionBody" style="padding:14px"><div class="muted">載入中...</div></div></div>`;
    main.insertBefore(sec,document.getElementById('reference')||document.getElementById('settings'));
    return true;
  }

  function render(){
    const root=document.getElementById('itemFunctionBody');if(!root||!data)return;
    const list=data.item_functions?.item_functions||[];
    const modules=[...new Set(list.map(x=>x.module))];
    root.innerHTML=`<div class="alert info"><b>Item Function</b><br>以 IF-01～IF-16 作為功能責任與介面邊界。此頁為 Requirements baseline；PM 可編輯後直接寫回 Private Project-Control。</div>${modules.map(m=>`<div class="panel reference-subpanel"><div class="panel-title">${esc(m)}</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>IF</th><th>Function</th><th>功能簡述</th><th></th></tr></thead><tbody>${list.filter(x=>x.module===m).map(x=>`<tr><td><b>${esc(x.id)}</b></td><td>${esc(x.name)}</td><td>${esc(x.description||'')}</td><td>${canWrite()?`<button type="button" class="btn smallbtn" data-edit-if="${esc(x.id)}">Edit</button>`:''}</td></tr>`).join('')}</tbody></table></div></div>`).join('')}`;
  }

  async function load(){try{data=await request('/api/project/reference');render()}catch(e){const root=document.getElementById('itemFunctionBody');if(root)root.innerHTML=`<div class="alert">${esc(e.message)}</div>`}}
  function edit(id){
    const item=data?.item_functions?.item_functions?.find(x=>x.id===id);if(!item)return;
    const drawer=document.getElementById('drawer'),backdrop=document.getElementById('drawerBackdrop'),body=document.getElementById('drawerBody');
    document.getElementById('drawerTitle').textContent=`編輯 ${item.id} · ${item.name}`;
    body.innerHTML=`<div class="field"><label>IF ID</label><input value="${esc(item.id)}" readonly></div><div class="field"><label>Module</label><input name="module" value="${esc(item.module)}"></div><div class="field"><label>Function Name</label><input name="name" value="${esc(item.name)}"></div><div class="field"><label>功能簡述</label><textarea name="description">${esc(item.description||'')}</textarea></div><div class="field"><button class="btn primary" type="submit">儲存到 GitHub</button> <button class="btn" type="button" data-close>取消</button></div>`;
    drawer.classList.add('open');backdrop.classList.add('open');
    body.onsubmit=async e=>{e.preventDefault();const fd=new FormData(body);item.module=String(fd.get('module')||'').trim();item.name=String(fd.get('name')||'').trim();item.description=String(fd.get('description')||'').trim();try{await request('/api/project/reference/item-functions',{method:'PUT',body:JSON.stringify(data.item_functions)});drawer.classList.remove('open');backdrop.classList.remove('open');render();toast(`${item.id} 已更新`)}catch(err){toast(err.message)}};
  }

  document.addEventListener('click',e=>{const b=e.target.closest('[data-edit-if]');if(b)edit(b.dataset.editIf)});
  const obs=new MutationObserver(()=>{if(install())load()});
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{if(install())load();obs.observe(document.body,{childList:true,subtree:true})});else{if(install())load();obs.observe(document.body,{childList:true,subtree:true})}
})();
