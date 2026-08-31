(() => {
  const S=window.SmartPortStore.state;
  const API=window.SmartPortAPI;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
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

  function familyOfRow(row){
    const wp=row.dataset.openWp;
    if(wp)return familyOfWp(wp);
    const sub=row.dataset.openSub;
    if(sub){
      const s=S.subtasks.find(x=>x.id===sub);
      return familyOfWp(s?.parent_wp||'');
    }
    return'';
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
    renderFilterButtons();
  }

  function renderFilterButtons(){
    const wrap=document.getElementById('planFamilyFilters');if(!wrap)return;
    wrap.innerHTML=groups.map(g=>`<button type="button" class="btn smallbtn ${filter===g.id?'primary':''}" data-plan-family="${g.id}" aria-pressed="${filter===g.id?'true':'false'}">${g.label} · ${countFor(g.id)}</button>`).join('');
  }

  function tagRows(){
    document.querySelectorAll('#planTable tbody tr.plan-row').forEach(row=>{
      row.dataset.planFamily=familyOfRow(row);
    });
  }

  function applyFilter(){
    const table=document.getElementById('planTable');
    if(!table)return;
    table.dataset.familyFilter=filter;
    tagRows();
    renderFilterButtons();
  }

  function ensurePlanHeader(){
    const tr=document.querySelector('#planTable thead tr');if(!tr)return;
    if(!tr.querySelector('[data-col="description"]')){
      const th=document.createElement('th');
      th.dataset.col='description';
      th.textContent='工作內容';
      tr.insertBefore(th,tr.children[6]||null);
    }
  }

  function enhancePlanRows(){
    document.querySelectorAll('#planTable tbody tr.plan-row').forEach(row=>{
      row.dataset.planFamily=familyOfRow(row);
      if(row.querySelector('.plan-desc-cell'))return;
      let item=null;
      if(row.dataset.openWp)item=S.workPackages.find(x=>x.id===row.dataset.openWp);
      else if(row.dataset.openSub)item=S.subtasks.find(x=>x.id===row.dataset.openSub);
      const td=document.createElement('td');
      td.className='plan-desc-cell';
      td.innerHTML=item?.description?`<div class="plan-description">${esc(item.description)}</div>`:'<span class="muted">—</span>';
      row.insertBefore(td,row.children[6]||null);
    });
  }

  function aclFor(cp){return refMap.get(cp.id)||null;}

  function ensureCpHeader(){
    const tr=document.querySelector('#cpEditTable thead tr');if(!tr)return;
    if(!tr.querySelector('[data-col="capability"]')){
      const cap=document.createElement('th');
      cap.dataset.col='capability';
      cap.textContent='車輛能力 / Capability';
      const review=document.createElement('th');
      review.dataset.col='review';
      review.textContent='Review / Check';
      tr.insertBefore(cap,tr.children[4]||null);
      tr.insertBefore(review,tr.children[5]||null);
    }
  }

  function roadmapHtml(value){
    const text=String(value||'—');
    return esc(text).replace(/\n/g,'<br>');
  }

  function enhanceCpRows(){
    document.querySelectorAll('#cpEditTable tbody tr[data-cp-card]').forEach(row=>{
      const cp=S.checkpoints.find(x=>x.id===row.dataset.cpCard);if(!cp)return;
      const ref=aclFor(cp);
      const fullCapability=ref?.capability || cp.capability || '—';
      const fullReview=ref?.review_checks || cp.review_checks || '—';

      let cap=row.querySelector('.cp-capability-cell');
      let review=row.querySelector('.cp-review-cell');
      if(!cap){
        cap=document.createElement('td');
        cap.className='cp-capability-cell';
        row.insertBefore(cap,row.children[4]||null);
      }
      if(!review){
        review=document.createElement('td');
        review.className='cp-review-cell';
        row.insertBefore(review,row.children[5]||null);
      }
      cap.innerHTML=`<div class="cp-roadmap-text">${roadmapHtml(fullCapability)}</div>`;
      review.innerHTML=`<div class="cp-roadmap-text">${roadmapHtml(fullReview)}</div>`;
    });
  }

  function enhance(){
    scheduled=false;
    installFilters();
    ensurePlanHeader();
    enhancePlanRows();
    applyFilter();
    ensureCpHeader();
    enhanceCpRows();
  }

  function schedule(){
    if(scheduled)return;
    scheduled=true;
    setTimeout(enhance,30);
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

  // Capture-phase listener keeps filters reliable even when the table is re-rendered.
  document.addEventListener('click',e=>{
    const b=e.target.closest?.('[data-plan-family]');
    if(!b)return;
    e.preventDefault();
    e.stopPropagation();
    filter=String(b.dataset.planFamily||'ALL').toUpperCase();
    applyFilter();
  },true);

  const style=document.createElement('style');
  style.textContent=`
    #plan .panel-title{gap:12px;flex-wrap:wrap}
    .plan-family-filters{display:flex;gap:6px;flex-wrap:wrap;margin-left:auto}
    .plan-family-filters+.toolbar{margin-left:0}
    .plan-family-filters button{cursor:pointer;position:relative;z-index:3}
    .plan-desc-cell{min-width:300px;max-width:480px}
    .plan-description{font-size:12px;line-height:1.5;color:#475467;white-space:normal}

    #planTable[data-family-filter="C"] tbody tr.plan-row:not([data-plan-family="C"]),
    #planTable[data-family-filter="L"] tbody tr.plan-row:not([data-plan-family="L"]),
    #planTable[data-family-filter="P"] tbody tr.plan-row:not([data-plan-family="P"]),
    #planTable[data-family-filter="S"] tbody tr.plan-row:not([data-plan-family="S"]),
    #planTable[data-family-filter="V"] tbody tr.plan-row:not([data-plan-family="V"]){display:none!important}

    #cpEditTable{min-width:2050px}
    .cp-capability-cell,.cp-review-cell{min-width:520px;max-width:640px;vertical-align:top}
    .cp-roadmap-text{font-size:12px;line-height:1.65;color:#344054;white-space:normal}
    .cp-roadmap-text br{content:"";display:block;margin-bottom:4px}
  `;
  document.head.appendChild(style);

  const obs=new MutationObserver(schedule);
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{
      schedule();
      loadReference();
      obs.observe(document.getElementById('plan')||document.body,{childList:true,subtree:true});
    });
  }else{
    schedule();
    loadReference();
    obs.observe(document.getElementById('plan')||document.body,{childList:true,subtree:true});
  }
})();
