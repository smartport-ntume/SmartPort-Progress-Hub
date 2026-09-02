(() => {
  const S=window.SmartPortStore.state;
  const esc=(v='')=>String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr=v=>Array.isArray(v)?v:[];
  const progressOf=t=>t?.actual_progress ?? t?.actualProgress ?? t?.progress ?? null;
  const maturityRank=v=>{const m=String(v||'').match(/^M([0-5])/);return m?Number(m[1]):-1;};
  const cpById=id=>S.checkpoints.find(x=>x.id===id);
  const fsrById=id=>S.fsrs.find(x=>x.id===id);
  const wpById=id=>S.workPackages.find(x=>x.id===id);
  const subById=id=>S.subtasks.find(x=>x.id===id);

  function openDrawer(titleText,html){
    const title=document.getElementById('drawerTitle'),body=document.getElementById('drawerBody');
    const drawer=document.getElementById('drawer'),backdrop=document.getElementById('drawerBackdrop');
    if(!title||!body||!drawer||!backdrop)return;
    title.textContent=titleText;body.innerHTML=html;body.onsubmit=null;
    drawer.classList.add('open');backdrop.classList.add('open');
  }
  function chip(kind,id,label=id){return `<button type="button" class="trace-chip trace-${kind}" data-trace-${kind}="${esc(id)}">${esc(label)}</button>`;}
  function field(label,html){return `<div class="field"><label>${esc(label)}</label><div class="trace-field">${html||'<span class="muted">—</span>'}</div></div>`;}
  function criteriaOf(cp){
    return arr(cp?.criteria).map(([id,req])=>{const wp=wpById(id),act=wp&&progressOf(wp)!=null?Number(progressOf(wp)):0;return{id,req:Number(req)||0,act,ok:act>=(Number(req)||0)};});
  }
  function explicitFsrTargets(cp){return arr(cp?.fsr_targets).filter(x=>x?.fsr_id);}
  function scopeTargets(cp){return arr(cp?.fsr_targets).filter(x=>x?.scope);}
  function relatedWpsForFsr(id){
    const fsr=fsrById(id);const set=new Set(arr(fsr?.linked_work_packages));
    S.workPackages.forEach(w=>{if(arr(w.fsrs).includes(id))set.add(w.id)});
    return [...set].map(wpById).filter(Boolean);
  }
  function relatedSubsForFsr(id){return S.subtasks.filter(s=>arr(s.fsrs).includes(id));}
  function cpTargetsForFsr(id){return S.checkpoints.filter(cp=>explicitFsrTargets(cp).some(t=>t.fsr_id===id));}
  function wpTargetCps(id){return S.checkpoints.filter(cp=>arr(cp.criteria).some(c=>c?.[0]===id));}
  function dateConflict(sub){const cp=cpById(sub?.target_cp);return !!(cp&&sub?.end&&sub.end>cp.date);}

  function openCpTrace(id){
    const cp=cpById(id);if(!cp)return;
    const criteria=criteriaOf(cp),subs=S.subtasks.filter(s=>s.target_cp===id),conflicts=subs.filter(dateConflict);
    const fsrTargets=explicitFsrTargets(cp),scopes=scopeTargets(cp);
    const wpHtml=criteria.length?criteria.map(x=>`<div class="trace-row"><div>${chip('wp',x.id)} <span class="trace-name">${esc(wpById(x.id)?.name||'')}</span></div><div class="trace-status ${x.ok?'ok':'warn'}">${x.ok?'✓':'△'} ${x.act}% / ${x.req}%</div></div>`).join(''):'<span class="muted">—</span>';
    const subHtml=subs.length?subs.map(s=>`<div class="trace-row"><div>${chip('subtask',s.id)} <span class="trace-name">${esc(s.name||'')}</span></div><div>${dateConflict(s)?'<span class="trace-status bad">⚠ date conflict</span>':`<span class="muted">${esc(s.end||'')}</span>`}</div></div>`).join(''):'<span class="muted">No direct Subtask target.</span>';
    const fsrHtml=[...fsrTargets.map(t=>{const f=fsrById(t.fsr_id),cur=f?.maturity||'M0',min=t.minimum_maturity||t.target_maturity,ok=maturityRank(cur)>=maturityRank(min);return `<div class="trace-row"><div>${chip('fsr',t.fsr_id)} <span class="trace-name">${esc(f?.requirement||'')}</span></div><div class="trace-status ${ok?'ok':'warn'}">${ok?'✓':'△'} ${esc(cur)} → ${esc(t.target_maturity||'')}</div></div>`;}),...scopes.map(t=>`<div class="trace-row"><div><span class="trace-chip trace-scope">${esc(t.scope)}</span></div><div>${esc(t.minimum_maturity||'')} → ${esc(t.target_maturity||'')}</div></div>`)].join('')||'<span class="muted">—</span>';
    openDrawer(`${cp.id} · ${cp.name||''}`,`
      ${field('ACL / Date',`${esc(cp.acl||'—')} · ${esc(cp.date||'—')}`)}
      ${field('Vehicle Capability / Gate',`<div class="trace-pre">${esc(cp.capability||'—')}</div>`)}
      ${field('Review / Check',`<div class="trace-pre">${esc(cp.review_checks||'—')}</div>`)}
      ${field('WP Readiness',wpHtml)}
      ${field(`Target Subtasks · ${subs.length}`,subHtml)}
      ${field('FSR Maturity Targets',fsrHtml)}
      ${conflicts.length?`<div class="alert danger"><b>Schedule / Target CP conflict</b><br>${conflicts.map(s=>`${esc(s.id)} end ${esc(s.end)} > ${esc(cp.date)}`).join('<br>')}</div>`:''}
      ${window.SMARTPORT_ACCESS?.can_write?`<div class="field"><button type="button" class="btn primary" data-edit-cp="${esc(cp.id)}">編輯 CP</button></div>`:''}`);
  }

  function openFsrTrace(id){
    const f=fsrById(id);if(!f)return;
    const wps=relatedWpsForFsr(id),subs=relatedSubsForFsr(id),cps=cpTargetsForFsr(id);
    const wpHtml=wps.map(w=>`${chip('wp',w.id)} `).join(' ')||'<span class="muted">—</span>';
    const subHtml=subs.map(s=>`<div class="trace-row"><div>${chip('subtask',s.id)} <span class="trace-name">${esc(s.name||'')}</span></div><div>${s.target_cp?chip('cp',s.target_cp):'<span class="muted">No CP</span>'}</div></div>`).join('')||'<span class="muted">—</span>';
    const cpHtml=cps.map(cp=>{const t=explicitFsrTargets(cp).find(x=>x.fsr_id===id);return `<div class="trace-row"><div>${chip('cp',cp.id,`${cp.id} · ${cp.date}`)}</div><div>${esc(t?.minimum_maturity||'')} → <b>${esc(t?.target_maturity||'')}</b></div></div>`}).join('')||'<span class="muted">No explicit CP maturity target.</span>';
    openDrawer(`${f.id} · FSR Traceability`,`
      ${field('Requirement',esc(f.requirement||'—'))}
      ${field('Safety Goal',esc(f.parent_sg||'—'))}
      ${field('Primary / Support',`${esc(f.primary||'—')}<br><span class="muted">${esc(arr(f.support).join(', '))}</span>`)}
      ${field('Current / Final Target',`${esc(f.maturity||'M0')} → ${esc(f.target_2026_12_31||'—')}`)}
      ${field('Related WP',wpHtml)}
      ${field(`Related Subtasks · ${subs.length}`,subHtml)}
      ${field('CP Maturity Roadmap',cpHtml)}
      ${field('Allocation Status',esc(f.allocation_status||'—'))}`);
  }

  function openWpTrace(id){
    const w=wpById(id);if(!w)return;
    const subs=S.subtasks.filter(s=>s.parent_wp===id),cps=wpTargetCps(id);
    openDrawer(`${w.id} · ${w.name||''}`,`
      ${field('Owner / Schedule',`${esc(w.owner||'—')} · ${esc(w.start||'')} → ${esc(w.end||'')}`)}
      ${field('Description',esc(w.description||'—'))}
      ${field('Checkpoint Gates',cps.map(cp=>{const c=arr(cp.criteria).find(x=>x?.[0]===id);return chip('cp',cp.id,`${cp.id} · ${c?.[1]??0}%`)}).join(' ')||'<span class="muted">—</span>')}
      ${field('FSR',arr(w.fsrs).map(id=>chip('fsr',id)).join(' ')||'<span class="muted">—</span>')}
      ${field(`Subtasks · ${subs.length}`,subs.map(s=>`<div class="trace-row"><div>${chip('subtask',s.id)} <span class="trace-name">${esc(s.name||'')}</span></div><div>${s.target_cp?chip('cp',s.target_cp):''}</div></div>`).join(''))}`);
  }

  function openSubTrace(id){
    const s=subById(id);if(!s)return;const cp=cpById(s.target_cp);
    openDrawer(`${s.id} · ${s.name||''}`,`
      ${field('Parent WP',chip('wp',s.parent_wp))}
      ${field('Schedule',`${esc(s.start||'')} → ${esc(s.end||'')}`)}
      ${field('Target CP',s.target_cp?chip('cp',s.target_cp,`${s.target_cp} · ${cp?.date||''}`):'<span class="muted">—</span>')}
      ${field('FSR',arr(s.fsrs).map(id=>chip('fsr',id)).join(' ')||'<span class="muted">—</span>')}
      ${field('Description',esc(s.description||'—'))}
      ${dateConflict(s)?`<div class="alert danger"><b>Schedule / Target CP conflict</b><br>Subtask end ${esc(s.end)} is later than ${esc(s.target_cp)} (${esc(cp?.date||'')}).</div>`:''}`);
  }

  function cpIdFromElement(el){
    if(!el)return'';if(el.dataset?.cpCard)return el.dataset.cpCard;if(el.dataset?.cpId)return el.dataset.cpId;
    const m=String(el.textContent||'').match(/\bCP\d+\b/i);return m?m[0].toUpperCase():'';
  }

  function renderHealth(){
    if(!S.subtasks.length||!S.checkpoints.length)return;
    const mapped=S.subtasks.filter(s=>s.target_cp&&cpById(s.target_cp)).length;
    const conflicts=S.subtasks.filter(dateConflict);
    const structured=S.checkpoints.filter(cp=>arr(cp.fsr_targets).length).length;
    const linkedFsr=S.fsrs.filter(f=>relatedWpsForFsr(f.id).length||relatedSubsForFsr(f.id).length).length;
    let panel=document.getElementById('traceabilityHealthPanel');
    if(!panel){
      panel=document.createElement('div');panel.id='traceabilityHealthPanel';panel.className='panel trace-health-panel';
      const ganttPanel=document.querySelector('#dashboard .panel');ganttPanel?.parentElement?.insertBefore(panel,ganttPanel);
    }
    panel.innerHTML=`<div class="panel-title">Traceability Health <span class="revision-badge">FSR → WP → Subtask → CP</span></div><div class="trace-health-grid">
      <div><span>Subtask CP Mapping</span><b>${mapped}/${S.subtasks.length}</b></div>
      <div><span>CP Structured FSR</span><b>${structured}/${S.checkpoints.length}</b></div>
      <div><span>FSR Work Coverage</span><b>${linkedFsr}/${S.fsrs.length}</b></div>
      <div><span>Schedule Conflicts</span><b class="${conflicts.length?'bad-text':'ok-text'}">${conflicts.length}</b></div>
    </div>${conflicts.length?`<div class="trace-health-warning">⚠ ${conflicts.map(s=>`${esc(s.id)} → ${esc(s.target_cp)}`).join(' · ')}</div>`:''}`;
  }

  document.addEventListener('click',e=>{
    let el=e.target.closest?.('[data-trace-cp]');if(el){e.preventDefault();e.stopImmediatePropagation();openCpTrace(el.dataset.traceCp);return;}
    el=e.target.closest?.('[data-trace-fsr]');if(el){e.preventDefault();e.stopImmediatePropagation();openFsrTrace(el.dataset.traceFsr);return;}
    el=e.target.closest?.('[data-trace-wp]');if(el){e.preventDefault();e.stopImmediatePropagation();openWpTrace(el.dataset.traceWp);return;}
    el=e.target.closest?.('[data-trace-subtask]');if(el){e.preventDefault();e.stopImmediatePropagation();openSubTrace(el.dataset.traceSubtask);return;}
    if(e.target.closest?.('[data-edit-cp],button,a,input,select,textarea'))return;
    const cpEl=e.target.closest?.('.cp-marker,.cp-point,[data-cp-card]');if(cpEl){const id=cpIdFromElement(cpEl);if(id){e.preventDefault();e.stopImmediatePropagation();openCpTrace(id);return;}}
    const fsrRow=e.target.closest?.('#fsrTable tbody tr');if(fsrRow){const id=fsrRow.querySelector('td:first-child b')?.textContent?.trim();if(id){e.preventDefault();e.stopImmediatePropagation();openFsrTrace(id);}}
  },true);

  const style=document.createElement('style');style.textContent=`
    .trace-chip{border:1px solid #c7d7eb;background:#eef4fb;color:#315d91;border-radius:999px;padding:2px 7px;font-size:11px;font-weight:700;cursor:pointer;white-space:nowrap}.trace-chip:hover{background:#dfeafb}.trace-fsr{background:#f4f0fb;border-color:#d9cdef;color:#65518c}.trace-wp{background:#eef6f0;border-color:#c9ddcf;color:#42664d}.trace-subtask{background:#f7f7f8;border-color:#dddfe3;color:#475467}.trace-scope{cursor:default;background:#f2f4f7;border-color:#d0d5dd;color:#475467}.trace-field{font-size:12.5px;line-height:1.55;color:#344054}.trace-pre{white-space:pre-line}.trace-row{display:flex;justify-content:space-between;gap:14px;align-items:flex-start;padding:5px 0;border-bottom:1px solid #eef0f3}.trace-row:last-child{border-bottom:0}.trace-row>div:first-child{min-width:0}.trace-name{margin-left:5px}.trace-status{white-space:nowrap;font-size:11px;font-weight:700}.trace-status.ok,.ok-text{color:#176b36}.trace-status.warn{color:#9a6700}.trace-status.bad,.bad-text{color:#b42318}.trace-health-panel{margin-bottom:14px}.trace-health-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e5e7eb}.trace-health-grid>div{background:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}.trace-health-grid span{font-size:11px;color:#667085}.trace-health-grid b{font-size:18px}.trace-health-warning{padding:8px 14px;font-size:11px;color:#b42318;background:#fff4f2;border-top:1px solid #fecdca}@media(max-width:850px){.trace-health-grid{grid-template-columns:1fr 1fr}}
  `;document.head.appendChild(style);

  const obs=new MutationObserver(()=>renderHealth());
  const start=()=>{renderHealth();const main=document.querySelector('main');if(main)obs.observe(main,{childList:true,subtree:true});setTimeout(renderHealth,800);setTimeout(renderHealth,2200)};
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();

  window.SmartPortTraceability={openCp:openCpTrace,openFsr:openFsrTrace,openWp:openWpTrace,openSubtask:openSubTrace,renderHealth};
})();
