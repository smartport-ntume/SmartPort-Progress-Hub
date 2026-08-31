(() => {
  const API=window.SmartPortAPI;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const lines=v=>esc(v||'').replace(/\n/g,'<br>');
  let data=null;

  function installViews(){
    const nav=document.querySelector('.nav');
    const main=document.querySelector('main');
    if(!nav||!main||document.getElementById('reference'))return;
    const settingsBtn=nav.querySelector('[data-view="settings"]');
    const refBtn=document.createElement('button');refBtn.dataset.view='reference';refBtn.textContent='ACL / Maturity';
    const trBtn=document.createElement('button');trBtn.dataset.view='tr';trBtn.textContent='Technical Requirements';
    nav.insertBefore(refBtn,settingsBtn||null);nav.insertBefore(trBtn,settingsBtn||null);

    const ref=document.createElement('section');ref.id='reference';ref.className='view';ref.innerHTML=`
      <div class="panel"><div class="panel-title">ACL / FSR Maturity Reference <span class="revision-badge">Project-defined reference</span></div><div id="referenceBody" style="padding:14px"><div class="muted">載入中...</div></div></div>`;
    const tr=document.createElement('section');tr.id='tr';tr.className='view';tr.innerHTML=`
      <div class="panel"><div class="panel-title">Technical Requirements <div class="toolbar" id="trFilters"></div></div><div id="trBody" style="padding:14px"><div class="muted">載入中...</div></div></div>`;
    const settings=document.getElementById('settings');main.insertBefore(ref,settings||null);main.insertBefore(tr,settings||null);
  }

  async function load(){
    try{
      const token=sessionStorage.getItem('smartport.session')||'';
      const res=await fetch(API.getBase()+'/api/project/reference',{credentials:'include',headers:{...(token?{'Authorization':`Bearer ${token}`}:{})}});
      if(!res.ok)throw new Error(`API ${res.status}: ${await res.text()}`);
      data=await res.json();renderReference();renderTR('ALL');
    }catch(e){
      const msg=`Reference data 載入失敗：${esc(e.message||e)}`;
      const a=document.getElementById('referenceBody'),b=document.getElementById('trBody');if(a)a.innerHTML=`<div class="alert">${msg}</div>`;if(b)b.innerHTML=`<div class="alert">${msg}</div>`;
    }
  }

  function renderReference(){
    const root=document.getElementById('referenceBody');if(!root||!data)return;
    const r=data.reference||{},m=r.fsr_maturity_levels||[],acl=r.acl_levels||[];
    root.innerHTML=`
      <div class="grid2 reference-intro">
        <div class="alert info"><b>ACL｜Autonomous Capability Level</b><br>${esc(r.acl_note||'')}</div>
        <div class="alert info"><b>FSR Maturity｜M0～M5</b><br>${esc(r.maturity_note||'')}</div>
      </div>
      <div class="panel reference-subpanel"><div class="panel-title">FSR Maturity Model｜M0 → M5</div>
        <div class="maturity-grid">${m.map(x=>`<div class="maturity-card"><div class="maturity-code">${esc(x.level)}</div><div class="maturity-name">${esc(x.name)}</div><div class="maturity-def">${esc(x.definition)}</div><div class="muted"><b>Evidence：</b>${esc(x.evidence)}</div></div>`).join('')}</div>
      </div>
      <div class="panel reference-subpanel"><div class="panel-title">ACL Roadmap｜Checkpoint → Vehicle Capability</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>CP</th><th>ACL</th><th>車輛能力 / Capability</th><th>Review / Check</th><th>FSR Maturity Target</th></tr></thead><tbody>${acl.map(x=>`<tr><td><b>${esc(x.checkpoint)}</b><div class="muted">${esc(x.date)}</div></td><td><span class="acl-pill">${esc(x.level)}</span></td><td>${lines(x.capability)}</td><td>${lines(x.review_checks)}</td><td><b>${esc(x.fsr_maturity_target)}</b></td></tr>`).join('')}</tbody></table></div></div>`;
  }

  function allRequirements(){return (data?.technical_requirements?.groups||[]).flatMap(g=>(g.requirements||[]).map(x=>({...x,group:g.group})))}
  function renderTR(group){
    const root=document.getElementById('trBody'),filters=document.getElementById('trFilters');if(!root||!filters||!data)return;
    const t=data.technical_requirements||{},groups=t.groups||[],all=allRequirements(),rows=group==='ALL'?all:all.filter(x=>x.group===group);
    filters.innerHTML=['ALL',...groups.map(g=>g.group)].map(g=>`<button type="button" class="btn smallbtn ${g===group?'primary':''}" data-tr-group="${esc(g)}">${g==='ALL'?'All · '+all.length:g+' · '+all.filter(x=>x.group===g).length}</button>`).join('');
    root.innerHTML=`
      <div class="alert info"><b>Source：</b>${esc(t.source||'')}<br><b>Status：</b>${esc(t.status||'')}。此頁保留原始 Preliminary / TBD，不自動把 TBD 視為已核准。</div>
      <div class="tr-summary">${groups.map(g=>`<div class="tr-stat"><b>${esc(g.group)}</b><span>${(g.requirements||[]).length} TR</span></div>`).join('')}</div>
      <div class="panel reference-subpanel"><div class="panel-title">${group==='ALL'?'All Technical Requirements':esc(group)+' Technical Requirements'}</div><div style="overflow:auto;max-height:620px"><table class="reference-table tr-table"><thead><tr><th>TR ID</th><th>Technical Requirement</th><th>Source</th><th>Parameter</th><th>Verification</th><th>Status</th></tr></thead><tbody>${rows.map(x=>`<tr><td><b>${esc(x.id)}</b><div class="muted">${esc(x.group)}</div></td><td>${esc(x.requirement)}</td><td>${esc(x.source)}</td><td><code>${lines(x.parameter)}</code></td><td>${esc(x.verification)}</td><td><span class="revision-badge ${x.status==='TBD'?'tr-tbd':''}">${esc(x.status)}</span></td></tr>`).join('')}</tbody></table></div></div>
      ${renderInterfaces(t.interfaces||[])}${renderOdd(t.odd_allocation||[])}${renderTrace(t.fsr_traceability||[],t.open_gates||[])}`;
  }

  function renderInterfaces(v){return`<div class="panel reference-subpanel"><div class="panel-title">Cross-Subsystem Interface Technical Requirements</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>Interface</th><th>Producer → Consumer</th><th>Required Data</th><th>Technical Requirement</th><th>Verification</th></tr></thead><tbody>${v.map(x=>`<tr><td><b>${esc(x.interface)}</b></td><td>${esc(x.flow)}</td><td>${esc(x.required_data)}</td><td>${esc(x.technical_requirement)}</td><td>${esc(x.verification)}</td></tr>`).join('')}</tbody></table></div></div>`}
  function renderOdd(v){return`<div class="panel reference-subpanel"><div class="panel-title">ODD Parameter → Technical Requirement Allocation</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>Parameter Family</th><th>Owner</th><th>TR Use</th><th>Symbolic Parameters</th></tr></thead><tbody>${v.map(x=>`<tr><td><b>${esc(x.family)}</b></td><td>${esc(x.owner)}</td><td>${esc(x.tr_use)}</td><td><code>${esc(x.parameters)}</code></td></tr>`).join('')}</tbody></table></div></div>`}
  function renderTrace(trace,gates){return`<div class="grid2 reference-subpanel"><div class="panel"><div class="panel-title">FSR → TR Traceability</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>FSR Cluster</th><th>Primary</th><th>TR Examples</th><th>Evidence</th></tr></thead><tbody>${trace.map(x=>`<tr><td>${lines(x.cluster)}</td><td>${esc(x.primary_subsystem)}</td><td>${esc(x.tr_examples)}</td><td>${esc(x.evidence_to_close)}</td></tr>`).join('')}</tbody></table></div></div><div class="panel"><div class="panel-title">Open Gates / TBD</div><div style="overflow:auto"><table class="reference-table"><thead><tr><th>Open Item</th><th>Why it matters</th><th>Affected</th></tr></thead><tbody>${gates.map(x=>`<tr><td><b>${esc(x.item)}</b></td><td>${esc(x.why_it_matters)}</td><td>${esc(x.affected_subsystem)}</td></tr>`).join('')}</tbody></table></div></div></div>`}

  document.addEventListener('click',e=>{const b=e.target.closest('[data-tr-group]');if(b)renderTR(b.dataset.trGroup)});
  installViews();
  const style=document.createElement('style');style.textContent=`.reference-subpanel{margin-top:14px}.maturity-grid{display:grid;grid-template-columns:repeat(6,minmax(145px,1fr));gap:10px;padding:14px}.maturity-card{border:1px solid var(--line);border-radius:10px;padding:12px;background:#fff}.maturity-code{font-size:22px;font-weight:800;color:var(--navy)}.maturity-name{font-weight:700;margin:3px 0 8px}.maturity-def{font-size:13px;line-height:1.45;margin-bottom:9px}.reference-table td{line-height:1.45;min-width:110px}.reference-table td:nth-child(3){min-width:220px}.acl-pill{display:inline-block;padding:4px 8px;border-radius:999px;background:#eef4fb;color:#315f91;font-weight:700}.tr-summary{display:flex;gap:8px;flex-wrap:wrap;margin:10px 0}.tr-stat{border:1px solid var(--line);border-radius:9px;padding:8px 12px;background:#fff}.tr-stat span{display:block;font-size:11px;color:var(--muted);margin-top:2px}.tr-tbd{background:#fff1d8;color:#925f0d}.tr-table code,.reference-table code{font-size:11px;white-space:normal}@media(max-width:1200px){.maturity-grid{grid-template-columns:repeat(3,1fr)}}`;document.head.appendChild(style);
  load();
})();
