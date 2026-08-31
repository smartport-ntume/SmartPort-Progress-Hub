(() => {
  const S=window.SmartPortStore.state;
  const API=window.SmartPortAPI;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=v=>Array.isArray(v)?v:[];
  let filter='ALL';
  let refMap=new Map();
  let referenceData=null;
  let scheduled=false;
  let lastOwnRender=0;

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
  function visibleWps(){return S.workPackages.filter(w=>filter==='ALL'||familyOfWp(w.id)===filter);}
  function visibleCount(){const ids=new Set(visibleWps().map(w=>w.id));return ids.size+S.subtasks.filter(s=>ids.has(s.parent_wp)).length;}
  function countFor(g){
    if(g==='ALL')return S.workPackages.length+S.subtasks.length;
    const ids=new Set(S.workPackages.filter(w=>familyOfWp(w.id)===g).map(w=>w.id));
    return ids.size+S.subtasks.filter(s=>ids.has(s.parent_wp)).length;
  }

  function installFilters(){
    const title=document.querySelector('#plan .panel:first-child .panel-title');if(!title)return;
    let wrap=document.getElementById('planFamilyFilters');
    if(!wrap){
      wrap=document.createElement('div');wrap.id='planFamilyFilters';wrap.className='plan-family-filters';
      const toolbar=title.querySelector('.toolbar');title.insertBefore(wrap,toolbar||null);
    }
    wrap.innerHTML=groups.map(g=>`<button type="button" class="btn smallbtn ${filter===g.id?'primary':''}" data-plan-family="${g.id}" aria-pressed="${filter===g.id?'true':'false'}">${g.label} · ${countFor(g.id)}</button>`).join('');

    let state=document.getElementById('planFilterState');
    if(!state){state=document.createElement('div');state.id='planFilterState';state.className='plan-filter-state';title.parentElement?.insertBefore(state,title.nextSibling);}
    state.innerHTML=`目前顯示：<b>${filter==='ALL'?'All':'WP-'+filter}</b> · ${visibleCount()} items`;
  }

  function ensurePlanHeader(){
    const tr=document.querySelector('#planTable thead tr');if(!tr)return;
    tr.innerHTML='<th>WP / Subtask</th><th>Owner</th><th>Start</th><th>End</th><th>Weight</th><th>Actual</th><th>工作內容</th><th>IF / FSR</th><th></th>';
  }

  function wpRow(w){
    const p=progressOf(w);
    return `<tr class="plan-row clickable" data-open-wp="${esc(w.id)}"><td><b>${esc(w.id)}</b> ${esc(w.name||'')}<div class="muted">${esc(w.group||'')}</div></td><td>${esc(w.owner||'')}</td><td>${esc(w.start||'')}</td><td>${esc(w.end||'')}</td><td>${esc(weightOf(w))}</td><td>${p==null?'—':p+'%'}<div class="muted">${esc(statusOf(w))}</div></td><td class="plan-desc-cell">${w.description?`<div class="plan-description">${esc(w.description)}</div>`:'<span class="muted">—</span>'}</td><td>${tags(w.ifs)}<br>${tags(w.fsrs)}</td><td><button class="btn smallbtn" data-edit-wp="${esc(w.id)}">Edit</button></td></tr>`;
  }
  function subRow(s){
    const p=progressOf(s);
    return `<tr class="plan-row subtask-plan-row clickable" data-open-sub="${esc(s.id)}"><td style="padding-left:28px">↳ <b>${esc(s.id)}</b> ${esc(s.name||'')}<div class="muted">Parent: ${esc(s.parent_wp||'')}</div></td><td>${esc(s.owner_team||'')}</td><td>${esc(s.start||'')}</td><td>${esc(s.end||'')}</td><td>${esc(weightOf(s))}</td><td>${p==null?'—':p+'%'}<div class="muted">${esc(statusOf(s))}</div></td><td class="plan-desc-cell">${s.description?`<div class="plan-description">${esc(s.description)}</div>`:'<span class="muted">—</span>'}</td><td>${tags(s.ifs)}<br>${tags(s.fsrs)}</td><td><button class="btn smallbtn" data-edit-subtask="${esc(s.id)}">Edit</button></td></tr>`;
  }

  function renderPlanRows(){
    const tbody=document.querySelector('#planTable tbody');if(!tbody)return;
    const wpList=visibleWps();let html='';
    for(const w of wpList){html+=wpRow(w);for(const s of S.subtasks.filter(x=>x.parent_wp===w.id))html+=subRow(s);}
    if(!html)html='<tr><td colspan="9" class="muted" style="padding:16px">此分類目前沒有 WP / Subtask。</td></tr>';
    lastOwnRender=performance.now();
    tbody.replaceChildren();
    tbody.insertAdjacentHTML('afterbegin',html);
    const scroller=tbody.closest('div[style*="overflow"]');if(scroller)scroller.scrollTop=0;
    installFilters();
  }

  function aclFor(cp){return refMap.get(cp.id)||null;}
  function ensureCpHeader(){
    const tr=document.querySelector('#cpEditTable thead tr');if(!tr)return;
    tr.innerHTML='<th>CP</th><th>Date</th><th>ACL</th><th>Name</th><th>車輛能力 / Capability</th><th>Review / Check</th><th>FSR Target</th><th></th>';
  }
  function roadmapHtml(value){return esc(String(value||'—')).replace(/\n/g,'<br>');}
  function enhanceCpRows(){
    document.querySelectorAll('#cpEditTable tbody tr[data-cp-card]').forEach(row=>{
      const cp=S.checkpoints.find(x=>x.id===row.dataset.cpCard);if(!cp)return;
      const ref=aclFor(cp);const capability=ref?.capability||cp.capability||'—';const review=ref?.review_checks||cp.review_checks||'—';const fsr=cp.fsrTarget||cp.fsr_target||'';
      row.innerHTML=`<td><b>${esc(cp.id)}</b></td><td>${esc(cp.date||'')}</td><td>${esc(cp.acl||'')}</td><td>${esc(cp.name||'')}</td><td class="cp-capability-cell"><div class="cp-roadmap-text">${roadmapHtml(capability)}</div></td><td class="cp-review-cell"><div class="cp-roadmap-text">${roadmapHtml(review)}</div></td><td class="cp-fsr-cell">${esc(fsr)}</td><td><button class="btn smallbtn" data-edit-cp="${esc(cp.id)}">Edit</button></td>`;
    });
  }

  function closeDrawer(){
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
  }
  function refDate(iso){
    const m=String(iso||'').match(/^\d{4}-(\d{2})-(\d{2})$/);
    return m?`${Number(m[1])}/${Number(m[2])}`:String(iso||'');
  }
  async function saveReferenceModel(payload){
    const token=sessionStorage.getItem('smartport.session')||'';
    const res=await fetch(API.getBase()+'/api/project/reference/reference-model',{
      method:'PUT',credentials:'include',headers:{'Content-Type':'application/json',...(token?{'Authorization':`Bearer ${token}`}:{})},body:JSON.stringify(payload)
    });
    if(!res.ok)throw new Error(`Reference API ${res.status}: ${await res.text()}`);
  }
  function openCpEditor(id){
    if(!window.SMARTPORT_ACCESS?.can_write)return;
    const cp=S.checkpoints.find(x=>x.id===id);if(!cp)return;
    const ref=aclFor(cp);
    const capability=ref?.capability||cp.capability||'';
    const review=ref?.review_checks||cp.review_checks||'';
    const title=document.getElementById('drawerTitle');
    const body=document.getElementById('drawerBody');
    const drawer=document.getElementById('drawer');
    const backdrop=document.getElementById('drawerBackdrop');
    if(!title||!body||!drawer||!backdrop)return;

    title.textContent=`編輯 ${cp.id}`;
    body.innerHTML=`
      <div class="field"><label>CP ID</label><input name="cp_id" value="${esc(cp.id)}" readonly></div>
      <div class="field"><label>Date</label><input name="cp_date" type="date" value="${esc(cp.date||'')}"></div>
      <div class="field"><label>ACL</label><input name="cp_acl" value="${esc(cp.acl||'')}"></div>
      <div class="field"><label>Name</label><input name="cp_name" value="${esc(cp.name||'')}"></div>
      <div class="field"><label>Vehicle Capability / Gate</label><textarea name="cp_capability" rows="8">${esc(capability)}</textarea></div>
      <div class="field"><label>Review / Check</label><textarea name="cp_review" rows="8">${esc(review)}</textarea></div>
      <div class="field"><label>FSR Target</label><input name="cp_fsr" value="${esc(cp.fsrTarget||cp.fsr_target||ref?.fsr_maturity_target||'')}"></div>
      <div class="field"><label>Readiness Criteria JSON</label><textarea name="cp_criteria" rows="8">${esc(JSON.stringify(cp.criteria||[],null,2))}</textarea></div>
      <div class="field"><button type="submit" class="btn primary">儲存到 GitHub</button> <button type="button" class="btn" data-close>取消</button></div>`;
    drawer.classList.add('open');backdrop.classList.add('open');

    body.onsubmit=async e=>{
      e.preventDefault();
      const fd=new FormData(body);
      let criteria=[];
      try{criteria=JSON.parse(String(fd.get('cp_criteria')||'[]'));}catch(_){alert('Readiness Criteria JSON 格式錯誤');return;}
      const next=S.checkpoints.map(x=>x.id===id?{
        ...x,
        date:String(fd.get('cp_date')||''),
        acl:String(fd.get('cp_acl')||'').trim(),
        name:String(fd.get('cp_name')||'').trim(),
        capability:String(fd.get('cp_capability')||'').trim(),
        review_checks:String(fd.get('cp_review')||'').trim(),
        fsrTarget:String(fd.get('cp_fsr')||'').trim(),
        criteria
      }:x);
      try{
        await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});
        S.checkpoints=next;
        if(referenceData){
          referenceData={...referenceData,acl_levels:(referenceData.acl_levels||[]).map(x=>x.checkpoint===id?{
            ...x,
            date:refDate(String(fd.get('cp_date')||'')),
            level:String(fd.get('cp_acl')||'').trim(),
            capability:String(fd.get('cp_capability')||'').trim(),
            review_checks:String(fd.get('cp_review')||'').trim(),
            fsr_maturity_target:String(fd.get('cp_fsr')||'').trim()
          }:x)};
          await saveReferenceModel(referenceData);
          refMap=new Map((referenceData.acl_levels||[]).map(x=>[x.checkpoint,x]));
        }
        closeDrawer();
        ensureCpHeader();enhanceCpRows();
        document.getElementById('btnReload')?.click();
      }catch(err){alert(err.message||String(err));}
    };
  }

  function enhance(){scheduled=false;installFilters();ensurePlanHeader();renderPlanRows();ensureCpHeader();enhanceCpRows();}
  function schedule(){if(scheduled)return;scheduled=true;setTimeout(enhance,40);}

  async function loadReference(){
    try{const token=sessionStorage.getItem('smartport.session')||'';const res=await fetch(API.getBase()+'/api/project/reference',{credentials:'include',headers:{...(token?{'Authorization':`Bearer ${token}`}:{})}});if(!res.ok)return;const data=await res.json();referenceData=data?.reference||null;refMap=new Map((referenceData?.acl_levels||[]).map(x=>[x.checkpoint,x]));schedule();}catch(_){}
  }

  document.addEventListener('click',e=>{
    const family=e.target.closest?.('[data-plan-family]');
    if(family){e.preventDefault();e.stopImmediatePropagation();filter=String(family.dataset.planFamily||'ALL').toUpperCase();renderPlanRows();return;}
    const cpEdit=e.target.closest?.('[data-edit-cp]');
    if(cpEdit){e.preventDefault();e.stopImmediatePropagation();openCpEditor(cpEdit.dataset.editCp);return;}
  },true);

  const style=document.createElement('style');style.textContent=`
    #plan .panel-title{gap:8px;flex-wrap:wrap}.plan-family-filters{display:flex;gap:5px;flex-wrap:wrap;margin-left:auto}.plan-family-filters+.toolbar{margin-left:0}.plan-family-filters button{cursor:pointer;position:relative;z-index:3}.plan-filter-state{padding:4px 12px 8px;color:#667085;font-size:11px;border-bottom:1px solid var(--line)}
    #planTable{min-width:1360px}#planTable th,#planTable td{padding-left:8px;padding-right:8px}.plan-desc-cell{min-width:260px;max-width:410px}.plan-description{font-size:12px;line-height:1.45;color:#475467;white-space:normal}
    #cpEditTable{width:100%;min-width:1180px;table-layout:fixed}#cpEditTable th,#cpEditTable td{padding:6px 6px;vertical-align:top}#cpEditTable th:nth-child(1),#cpEditTable td:nth-child(1){width:3.5%}#cpEditTable th:nth-child(2),#cpEditTable td:nth-child(2){width:6.5%}#cpEditTable th:nth-child(3),#cpEditTable td:nth-child(3){width:6%}#cpEditTable th:nth-child(4),#cpEditTable td:nth-child(4){width:13%}#cpEditTable th:nth-child(5),#cpEditTable td:nth-child(5){width:30%}#cpEditTable th:nth-child(6),#cpEditTable td:nth-child(6){width:30%}#cpEditTable th:nth-child(7),#cpEditTable td:nth-child(7){width:7%}#cpEditTable th:nth-child(8),#cpEditTable td:nth-child(8){width:4%}.cp-roadmap-text{font-size:11.5px;line-height:1.45;color:#344054;white-space:normal}.cp-roadmap-text br{content:"";display:block;margin-bottom:2px}.cp-fsr-cell{font-size:11.5px;word-break:break-word}
    #drawerBody textarea[name="cp_capability"],#drawerBody textarea[name="cp_review"]{min-height:150px;line-height:1.5}
  `;document.head.appendChild(style);

  const plan=document.getElementById('plan')||document.body;
  const obs=new MutationObserver(mutations=>{
    if(performance.now()-lastOwnRender<180)return;
    const tableChanged=mutations.some(m=>m.target?.closest?.('#planTable tbody,#cpEditTable tbody')||[...m.addedNodes].some(n=>n.nodeType===1&&(n.matches?.('#planTable tbody tr,#cpEditTable tbody tr')||n.querySelector?.('#planTable tbody tr,#cpEditTable tbody tr'))));
    if(tableChanged)schedule();
  });
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{schedule();loadReference();obs.observe(plan,{childList:true,subtree:true})});else{schedule();loadReference();obs.observe(plan,{childList:true,subtree:true})}
})();
