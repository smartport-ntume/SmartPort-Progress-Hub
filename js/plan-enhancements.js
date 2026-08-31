(() => {
  const S=window.SmartPortStore.state;
  const API=window.SmartPortAPI;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=v=>Array.isArray(v)?v:[];
  let filter='ALL';
  let refMap=new Map();
  let scheduled=false;

  const groups=[
    {id:'ALL',label:'All'},
    {id:'C',label:'WP-C'},
    {id:'L',label:'WP-L'},
    {id:'P',label:'WP-P'},
    {id:'S',label:'WP-S'},
    {id:'V',label:'WP-V'}
  ];

  function familyOfWp(id=''){
    const m=String(id).match(/^WP-([CLPSV])/i);
    return m?m[1].toUpperCase():'';
  }

  function progressOf(t){return t?.actual_progress ?? t?.actualProgress ?? t?.progress ?? null;}
  function statusOf(t){return t?.status || 'Not Updated';}
  function weightOf(t){return t?.weight ?? 1;}
  function tags(v){return arr(v).map(x=>`<span class="tag">${esc(x)}</span>`).join('')||'<span class="muted">—</span>';}

  function visibleWps(){
    return S.workPackages.filter(w=>filter==='ALL'||familyOfWp(w.id)===filter);
  }

  function countFor(g){
    if(g==='ALL')return S.workPackages.length+S.subtasks.length;
    const wpIds=new Set(S.workPackages.filter(w=>familyOfWp(w.id)===g).map(w=>w.id));
    return wpIds.size+S.subtasks.filter(s=>wpIds.has(s.parent_wp)).length;
  }

  function installFilters(){
    const title=document.querySelector('#plan .panel:first-child .panel-title');
    if(!title)return;
    let wrap=document.getElementById('planFamilyFilters');
    if(!wrap){
      wrap=document.createElement('div');
      wrap.id='planFamilyFilters';
      wrap.className='plan-family-filters';
      const toolbar=title.querySelector('.toolbar');
      title.insertBefore(wrap,toolbar||null);
    }
    wrap.innerHTML=groups.map(g=>`<button type="button" class="btn smallbtn ${filter===g.id?'primary':''}" data-plan-family="${g.id}" aria-pressed="${filter===g.id?'true':'false'}">${g.label} · ${countFor(g.id)}</button>`).join('');
  }

  function ensurePlanHeader(){
    const tr=document.querySelector('#planTable thead tr');
    if(!tr)return;
    tr.innerHTML='<th>WP / Subtask</th><th>Owner</th><th>Start</th><th>End</th><th>Weight</th><th>Actual</th><th>工作內容</th><th>IF / FSR</th><th></th>';
  }

  function wpRow(w){
    const p=progressOf(w);
    return `<tr class="plan-row clickable" data-open-wp="${esc(w.id)}" data-plan-family="${familyOfWp(w.id)}">
      <td><b>${esc(w.id)}</b> ${esc(w.name||'')}<div class="muted">${esc(w.group||'')}</div></td>
      <td>${esc(w.owner||'')}</td><td>${esc(w.start||'')}</td><td>${esc(w.end||'')}</td><td>${esc(weightOf(w))}</td>
      <td>${p==null?'—':p+'%'}<div class="muted">${esc(statusOf(w))}</div></td>
      <td class="plan-desc-cell">${w.description?`<div class="plan-description">${esc(w.description)}</div>`:'<span class="muted">—</span>'}</td>
      <td>${tags(w.ifs)}<br>${tags(w.fsrs)}</td>
      <td><div class="row-actions"><button class="btn smallbtn" data-edit-wp="${esc(w.id)}">Edit</button></div></td>
    </tr>`;
  }

  function subRow(s){
    const p=progressOf(s);
    return `<tr class="plan-row subtask-plan-row clickable" data-open-sub="${esc(s.id)}" data-plan-family="${familyOfWp(s.parent_wp)}">
      <td style="padding-left:28px">↳ <b>${esc(s.id)}</b> ${esc(s.name||'')}<div class="muted">Parent: ${esc(s.parent_wp||'')}</div></td>
      <td>${esc(s.owner_team||'')}</td><td>${esc(s.start||'')}</td><td>${esc(s.end||'')}</td><td>${esc(weightOf(s))}</td>
      <td>${p==null?'—':p+'%'}<div class="muted">${esc(statusOf(s))}</div></td>
      <td class="plan-desc-cell">${s.description?`<div class="plan-description">${esc(s.description)}</div>`:'<span class="muted">—</span>'}</td>
      <td>${tags(s.ifs)}<br>${tags(s.fsrs)}</td>
      <td><div class="row-actions"><button class="btn smallbtn" data-edit-subtask="${esc(s.id)}">Edit</button></div></td>
    </tr>`;
  }

  function renderPlanRows(){
    const tbody=document.querySelector('#planTable tbody');
    if(!tbody)return;
    let html='';
    for(const w of visibleWps()){
      html+=wpRow(w);
      for(const s of S.subtasks.filter(x=>x.parent_wp===w.id))html+=subRow(s);
    }
    if(!html)html='<tr><td colspan="9" class="muted" style="padding:18px">此分類目前沒有 WP / Subtask。</td></tr>';
    if(tbody.innerHTML!==html)tbody.innerHTML=html;
  }

  function aclFor(cp){return refMap.get(cp.id)||null;}

  function ensureCpHeader(){
    const tr=document.querySelector('#cpEditTable thead tr');
    if(!tr)return;
    tr.innerHTML='<th>CP</th><th>Date</th><th>ACL</th><th>Name</th><th>車輛能力 / Capability</th><th>Review / Check</th><th>FSR Target</th><th></th>';
  }

  function roadmapHtml(value){return esc(String(value||'—')).replace(/\n/g,'<br>');}

  function enhanceCpRows(){
    document.querySelectorAll('#cpEditTable tbody tr[data-cp-card]').forEach(row=>{
      const cp=S.checkpoints.find(x=>x.id===row.dataset.cpCard);
      if(!cp)return;
      const ref=aclFor(cp);
      const capability=ref?.capability || cp.capability || '—';
      const review=ref?.review_checks || cp.review_checks || '—';
      const fsr=cp.fsrTarget||cp.fsr_target||'';
      row.innerHTML=`
        <td><b>${esc(cp.id)}</b></td>
        <td>${esc(cp.date||'')}</td>
        <td>${esc(cp.acl||'')}</td>
        <td>${esc(cp.name||'')}</td>
        <td class="cp-capability-cell"><div class="cp-roadmap-text">${roadmapHtml(capability)}</div></td>
        <td class="cp-review-cell"><div class="cp-roadmap-text">${roadmapHtml(review)}</div></td>
        <td class="cp-fsr-cell">${esc(fsr)}</td>
        <td><button class="btn smallbtn" data-edit-cp="${esc(cp.id)}">Edit</button></td>`;
    });
  }

  function enhance(){
    scheduled=false;
    installFilters();
    ensurePlanHeader();
    renderPlanRows();
    ensureCpHeader();
    enhanceCpRows();
  }

  function schedule(){
    if(scheduled)return;
    scheduled=true;
    setTimeout(enhance,35);
  }

  async function loadReference(){
    try{
      const token=sessionStorage.getItem('smartport.session')||'';
      const res=await fetch(API.getBase()+'/api/project/reference',{credentials:'include',headers:{...(token?{'Authorization':`Bearer ${token}`}:{})}});
      if(!res.ok)return;
      const data=await res.json();
      refMap=new Map((data?.reference?.acl_levels||[]).map(x=>[x.checkpoint,x]));
      schedule();
    }catch(_){}
  }

  document.addEventListener('click',e=>{
    const b=e.target.closest?.('[data-plan-family]');
    if(!b)return;
    e.preventDefault();
    e.stopPropagation();
    filter=String(b.dataset.planFamily||'ALL').toUpperCase();
    installFilters();
    renderPlanRows();
  },true);

  const style=document.createElement('style');
  style.textContent=`
    #plan .panel-title{gap:10px;flex-wrap:wrap}
    .plan-family-filters{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
    .plan-family-filters+.toolbar{margin-left:0}
    .plan-family-filters button{cursor:pointer;position:relative;z-index:3}
    #planTable{min-width:1420px}
    #planTable th,#planTable td{padding-left:10px;padding-right:10px}
    .plan-desc-cell{min-width:280px;max-width:430px}
    .plan-description{font-size:12px;line-height:1.5;color:#475467;white-space:normal}

    #cpEditTable{min-width:1500px;width:100%;table-layout:auto}
    #cpEditTable th,#cpEditTable td{padding:8px 9px;vertical-align:top}
    #cpEditTable th:nth-child(1),#cpEditTable td:nth-child(1){width:54px;min-width:54px}
    #cpEditTable th:nth-child(2),#cpEditTable td:nth-child(2){width:105px;min-width:105px}
    #cpEditTable th:nth-child(3),#cpEditTable td:nth-child(3){width:90px;min-width:90px}
    #cpEditTable th:nth-child(4),#cpEditTable td:nth-child(4){width:180px;min-width:180px}
    .cp-capability-cell,.cp-review-cell{min-width:360px;max-width:500px}
    .cp-fsr-cell{min-width:120px;max-width:170px}
    .cp-roadmap-text{font-size:12px;line-height:1.55;color:#344054;white-space:normal}
    .cp-roadmap-text br{content:"";display:block;margin-bottom:3px}
  `;
  document.head.appendChild(style);

  const plan=document.getElementById('plan')||document.body;
  const obs=new MutationObserver(mutations=>{
    // app.js may repaint the tables after a GitHub save/reload; restore the selected family view.
    if(mutations.some(m=>[...m.addedNodes].some(n=>n.nodeType===1)))schedule();
  });

  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{
      schedule();loadReference();obs.observe(plan,{childList:true,subtree:true});
    });
  }else{
    schedule();loadReference();obs.observe(plan,{childList:true,subtree:true});
  }
})();
