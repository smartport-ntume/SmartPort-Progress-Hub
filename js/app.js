(() => {
  const S = window.SmartPortStore.state;
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  const esc = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr = v => Array.isArray(v) ? v : [];
  const csv = v => arr(v).join(', ');
  const parseCsv = v => String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
  const today = () => new Date().toISOString().slice(0,10);
  const toast = msg => { const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),3600); };

  function setConnection(ok,text){
    S.connected=!!ok;
    $('#connDot').className='dot '+(ok?'online':'offline');
    $('#connText').textContent=text || (ok?'GitHub Project Store 已連線':'GitHub Project Store 未連線');
  }

  function switchView(name){
    $$('.legacy-nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
    $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  }

  function getCurrentAndNextCp(){
    const cps=[...S.checkpoints].sort((a,b)=>a.date.localeCompare(b.date));
    const t=today();
    const current=[...cps].filter(c=>c.date<=t).pop() || cps[0];
    const next=cps.find(c=>c.date>t) || cps[cps.length-1];
    return {current,next};
  }

  function renderDashboard(){
    const t=today();
    const {current,next}=getCurrentAndNextCp();
    $('#todayCard').textContent=t;
    $('#currentAcl').textContent=current ? current.acl : '—';
    $('#currentCpSub').textContent=current ? `${current.id} · ${current.name}` : '';
    $('#nextCp').textContent=next ? next.id : '—';
    $('#nextCpDate').textContent=next ? `${next.date} · ${next.name}` : '';

    const overdue=S.workPackages.filter(w=>w.end<t).length;
    $('#scheduleHealth').textContent=overdue ? '需注意' : '正常';
    $('#scheduleSub').textContent=overdue ? `${overdue} 個 WP 已過 End Date` : `${S.workPackages.length} WP baseline loaded`;
    $('#pendingCount').textContent='0';

    $('#projectSnapshot').innerHTML=`<div class="snapshot-grid">
      <div class="snapshot-item"><span class="muted">Project</span><b>${esc(S.project.name||'SmartPort SC')}</b></div>
      <div class="snapshot-item"><span class="muted">WP</span><b>${S.workPackages.length}</b></div>
      <div class="snapshot-item"><span class="muted">Subtasks</span><b>${S.subtasks.length}</b></div>
      <div class="snapshot-item"><span class="muted">FSR</span><b>${S.fsrs.length}</b></div>
    </div>`;

    const counts={}; S.fsrs.forEach(f=>counts[f.maturity||'—']=(counts[f.maturity||'—']||0)+1);
    const max=Math.max(1,...Object.values(counts));
    $('#fsrSummary').innerHTML=Object.keys(counts).length ? Object.entries(counts).sort().map(([k,v])=>`<div class="maturity-row"><span class="maturity-key">${esc(k)}</span><div class="maturity-bar"><span style="width:${(v/max)*100}%"></span></div><span class="maturity-count">${v}</span></div>`).join('') : '<div class="muted">尚無 FSR。</div>';
    renderGantt();
  }

  function datePct(date,min,max){
    const d=new Date(date+'T00:00:00').getTime();
    return ((d-min)/(max-min))*100;
  }

  function renderGantt(){
    const box=$('#gantt');
    if(!S.workPackages.length){ box.innerHTML='<div class="empty">尚未載入 Gantt。</div>'; return; }
    const rows=[];
    S.workPackages.forEach(w=>{
      rows.push({id:w.id,name:w.name,start:w.start,end:w.end,sub:false});
      if($('#showSubs')?.checked){
        S.subtasks.filter(s=>s.parent_wp===w.id).forEach(s=>rows.push({id:s.id,name:s.name,start:s.start,end:s.end,sub:true}));
      }
    });
    const min=new Date('2026-08-01T00:00:00').getTime();
    const max=new Date('2027-01-01T00:00:00').getTime();
    const tp=Math.max(0,Math.min(100,datePct(today(),min,max)));
    const months=['Aug','Sep','Oct','Nov','Dec'];
    box.innerHTML=`<div class="gantt-head"><div class="gantt-label"><b>WP / Subtask</b></div><div class="gantt-track"><div class="gantt-axis">${months.map(m=>`<span>${m}</span>`).join('')}</div><div class="gantt-today" style="left:${tp}%"></div></div></div>`+
      rows.map(r=>{
        const l=Math.max(0,Math.min(100,datePct(r.start,min,max)));
        const rr=Math.max(0,Math.min(100,datePct(r.end,min,max)));
        const w=Math.max(0.8,rr-l);
        return `<div class="gantt-row ${r.sub?'sub':''}"><div class="gantt-label">${r.sub?'<span class="sub-prefix">↳</span>':''}<b>${esc(r.id)}</b> ${esc(r.name)}</div><div class="gantt-track"><div class="gantt-today" style="left:${tp}%"></div><div class="gantt-bar" style="left:${l}%;width:${w}%" title="${esc(r.start)} → ${esc(r.end)}"></div></div></div>`;
      }).join('');
  }

  function tags(items){ return arr(items).map(x=>`<span class="pill">${esc(x)}</span>`).join(''); }

  function renderPlan(){
    const tbody=$('#planTable tbody');
    tbody.innerHTML='';
    S.workPackages.forEach(w=>{
      tbody.insertAdjacentHTML('beforeend',`<tr class="wp-row"><td><b>${esc(w.id)}</b> ${esc(w.name)}</td><td>${esc(w.owner)}</td><td>${esc(w.start)}</td><td>${esc(w.end)}</td><td>—</td><td>${tags(w.ifs)}<br>${tags(w.fsrs)}</td><td>JSON</td><td><div class="row-actions"><button class="btn small" data-edit-wp="${esc(w.id)}">編輯</button><button class="btn danger small" data-delete-wp="${esc(w.id)}">刪除</button></div></td></tr>`);
      S.subtasks.filter(s=>s.parent_wp===w.id).forEach(s=>tbody.insertAdjacentHTML('beforeend',`<tr class="sub-row"><td><span class="sub-prefix">↳</span><b>${esc(s.id)}</b> ${esc(s.name)}</td><td>${esc(s.owner_team||'')}</td><td>${esc(s.start||'')}</td><td>${esc(s.end||'')}</td><td>—</td><td>${tags(s.ifs)}<br>${tags(s.fsrs)}</td><td>${s.github_issue?`Issue #${esc(s.github_issue)}`:'—'}</td><td><div class="row-actions"><button class="btn small" data-edit-subtask="${esc(s.id)}">編輯</button><button class="btn danger small" data-delete-subtask="${esc(s.id)}">Archive</button></div></td></tr>`));
    });

    $('#cpEditTable tbody').innerHTML=S.checkpoints.map(c=>`<tr><td><b>${esc(c.id)}</b></td><td>${esc(c.date)}</td><td>${esc(c.acl||'')}</td><td>${esc(c.name)}</td><td>${esc(c.fsrTarget||c.fsr_target||'')}</td><td><div class="row-actions"><button class="btn small" data-edit-cp="${esc(c.id)}">編輯</button><button class="btn danger small" data-delete-cp="${esc(c.id)}">刪除</button></div></td></tr>`).join('');
  }

  function renderFsr(){
    $('#fsrTable tbody').innerHTML=S.fsrs.map(f=>`<tr><td><b>${esc(f.id)}</b><div class="muted">${esc(f.parent_sg||'')}</div></td><td>${esc(f.requirement||'')}</td><td>${esc(f.primary||'')}</td><td>${tags(f.support)}</td><td>${tags(f.linked_work_packages)}</td><td><span class="pill">${esc(f.maturity||'')}</span></td><td>${esc(f.target_2026_12_31||'')}</td><td><div class="row-actions"><button class="btn small" data-edit-fsr="${esc(f.id)}">編輯</button><button class="btn danger small" data-delete-fsr="${esc(f.id)}">刪除</button></div></td></tr>`).join('');
  }

  function renderCp(){
    const t=today();
    $('#cpTimeline').innerHTML=S.checkpoints.map(c=>`<div class="cp-node ${c.date<t?'past':(c.date===t?'current':'')}"><span class="cp-dot"></span><b>${esc(c.id)}</b><div>${esc(c.acl||'')}</div><div class="muted">${esc(c.date)}</div></div>`).join('');
    $('#cpGrid').innerHTML=S.checkpoints.map(c=>`<article class="cp-card"><h3>${esc(c.id)} · ${esc(c.name)}</h3><div class="cp-meta">${esc(c.acl||'')} · ${esc(c.date)}</div><div>${esc(c.capability||'')}</div><div class="criteria"><b>FSR Target</b><br>${esc(c.fsrTarget||c.fsr_target||'—')}</div><div class="criteria"><b>Criteria</b><br>${arr(c.criteria).map(x=>`${esc(x[0])} ≥ ${esc(x[1])}%`).join('<br>')||'—'}</div><div class="row-actions top-gap"><button class="btn small" data-edit-cp="${esc(c.id)}">編輯</button></div></article>`).join('');
  }

  function renderAll(){ renderDashboard(); renderPlan(); renderFsr(); renderCp(); }

  function field(name,label,value='',type='text',required=true){ return `<div class="field"><label>${esc(label)}</label><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${required?'required':''}></div>`; }
  function area(name,label,value=''){ return `<div class="field"><label>${esc(label)}</label><textarea name="${esc(name)}" rows="4">${esc(value)}</textarea></div>`; }
  function actionButtons(){ return `<div class="actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">儲存到 GitHub</button></div>`; }

  function openDrawer(title,html,onSubmit){
    $('#drawerTitle').textContent=title;
    const form=$('#editorForm'); form.innerHTML=html;
    form.onsubmit=async e=>{e.preventDefault(); await onSubmit(new FormData(form));};
    $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false');
  }
  function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); }

  function editWp(id){
    const old=S.workPackages.find(x=>x.id===id)||{id:'',name:'',owner:'',group:'',start:'',end:'',ifs:[],fsrs:[],description:'',evidence:[]};
    openDrawer(id?'編輯 Work Package':'新增 Work Package',`${field('id','WP ID',old.id)}${field('name','Name',old.name)}${field('owner','Owner',old.owner)}${field('group','Group',old.group)}<div class="form-grid">${field('start','Start',old.start,'date')}${field('end','End',old.end,'date')}</div>${field('ifs','IF（逗號分隔）',csv(old.ifs), 'text', false)}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs),'text',false)}${area('description','Description',old.description||'')}${area('evidence','Evidence（每行一項）',arr(old.evidence).join('\n'))}${actionButtons()}`,async fd=>{
      const item={id:fd.get('id').trim(),name:fd.get('name').trim(),owner:fd.get('owner').trim(),group:fd.get('group').trim(),start:fd.get('start'),end:fd.get('end'),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs')),description:String(fd.get('description')||'').trim(),evidence:String(fd.get('evidence')||'').split('\n').map(x=>x.trim()).filter(Boolean)};
      const next=[...S.workPackages]; const i=next.findIndex(x=>x.id===old.id); if(i>=0)next[i]=item;else next.push(item);
      try{await API.saveWorkPackages({schema_version:'1.0',work_packages:next});S.workPackages=next;closeDrawer();renderAll();toast('WP 已寫回 GitHub');}catch(e){toast(e.message)}
    });
  }

  function editSubtask(id){
    const old=S.subtasks.find(x=>x.id===id)||{id:'',parent_wp:'',name:'',owner_team:'',start:'',end:'',target_cp:'',ifs:[],fsrs:[]};
    openDrawer(id?'編輯 Subtask':'新增 Subtask',`${field('id','Subtask ID',old.id)}${field('parent_wp','Parent WP',old.parent_wp)}${field('name','Name',old.name)}${field('owner_team','Owner Team',old.owner_team||'')}<div class="form-grid">${field('start','Start',old.start||'','date')}${field('end','End',old.end||'','date')}</div>${field('target_cp','Target CP',old.target_cp||'','text',false)}${field('ifs','IF（逗號分隔）',csv(old.ifs),'text',false)}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs),'text',false)}${actionButtons()}`,async fd=>{
      const item={id:fd.get('id').trim(),parent_wp:fd.get('parent_wp').trim(),name:fd.get('name').trim(),owner_team:fd.get('owner_team').trim(),start:fd.get('start'),end:fd.get('end'),target_cp:String(fd.get('target_cp')||'').trim(),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs'))};
      try{let saved;if(id){saved=await API.updateSubtask(id,item);const i=S.subtasks.findIndex(x=>x.id===id);S.subtasks[i]={...S.subtasks[i],...saved};}else{saved=await API.createSubtask(item);S.subtasks.push(saved);}closeDrawer();renderAll();toast(id?'Subtask 已更新':'Subtask 已建立 GitHub Issue');}catch(e){toast(e.message)}
    });
  }

  function editCp(id){
    const old=S.checkpoints.find(x=>x.id===id)||{id:'',date:'',acl:'',name:'',capability:'',fsrTarget:'',criteria:[]};
    openDrawer(id?'編輯 Checkpoint':'新增 Checkpoint',`${field('id','CP ID',old.id)}${field('date','Date',old.date,'date')}${field('acl','ACL',old.acl||'')}${field('name','Name',old.name)}${area('capability','Capability',old.capability||'')}${field('fsrTarget','FSR Target',old.fsrTarget||old.fsr_target||'','text',false)}${area('criteria','Criteria JSON',JSON.stringify(old.criteria||[],null,2))}${actionButtons()}`,async fd=>{
      let criteria=[];try{criteria=JSON.parse(fd.get('criteria')||'[]')}catch(_){return toast('Criteria JSON 格式錯誤')}
      const item={id:fd.get('id').trim(),date:fd.get('date'),acl:fd.get('acl').trim(),name:fd.get('name').trim(),capability:String(fd.get('capability')||'').trim(),fsrTarget:String(fd.get('fsrTarget')||'').trim(),criteria};
      const next=[...S.checkpoints];const i=next.findIndex(x=>x.id===old.id);if(i>=0)next[i]=item;else next.push(item);
      try{await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});S.checkpoints=next;closeDrawer();renderAll();toast('CP 已寫回 GitHub');}catch(e){toast(e.message)}
    });
  }

  function editFsr(id){
    const old=S.fsrs.find(x=>x.id===id)||{id:'',parent_sg:'',requirement:'',primary:'',support:[],linked_work_packages:[],maturity:'M0',target_2026_12_31:'M5',allocation_status:''};
    openDrawer(id?'編輯 FSR':'新增 FSR',`${field('id','FSR ID',old.id)}${field('parent_sg','Parent SG',old.parent_sg||'')}${area('requirement','Requirement',old.requirement||'')}${field('primary','Primary',old.primary||'')}${field('support','Support / IF（逗號分隔）',csv(old.support),'text',false)}${field('linked_work_packages','Linked WP（逗號分隔）',csv(old.linked_work_packages),'text',false)}${field('maturity','Current Maturity',old.maturity||'M0')}${field('target','12/31 Target',old.target_2026_12_31||'')}${area('allocation','Allocation Status',old.allocation_status||'')}${actionButtons()}`,async fd=>{
      const item={id:fd.get('id').trim(),parent_sg:fd.get('parent_sg').trim(),requirement:String(fd.get('requirement')||'').trim(),primary:fd.get('primary').trim(),support:parseCsv(fd.get('support')),linked_work_packages:parseCsv(fd.get('linked_work_packages')),maturity:fd.get('maturity').trim(),target_2026_12_31:fd.get('target').trim(),allocation_status:String(fd.get('allocation')||'').trim()};
      const next=[...S.fsrs];const i=next.findIndex(x=>x.id===old.id);if(i>=0)next[i]=item;else next.push(item);
      try{await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next});S.fsrs=next;closeDrawer();renderAll();toast('FSR 已寫回 GitHub');}catch(e){toast(e.message)}
    });
  }

  async function load(){
    $('#apiBase').value=API.getBase();
    try{
      const snap=await API.loadSnapshot();Store.replaceSnapshot(snap);setConnection(true);renderAll();
      try{const me=await API.me();$('#githubUser').value=me.login||'—';}catch(_){}
    }catch(e){setConnection(false,'連線失敗');toast(e.message);renderAll();}
  }

  document.addEventListener('click',async e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.dataset.view) return switchView(b.dataset.view);
    if(b.id==='btnReload') return load();
    if(b.id==='drawerClose'||b.dataset.close!==undefined) return closeDrawer();
    if(b.dataset.action==='add-wp') return editWp();
    if(b.dataset.action==='add-subtask') return editSubtask();
    if(b.dataset.action==='add-cp') return editCp();
    if(b.dataset.action==='add-fsr') return editFsr();
    if(b.dataset.editWp) return editWp(b.dataset.editWp);
    if(b.dataset.editSubtask) return editSubtask(b.dataset.editSubtask);
    if(b.dataset.editCp) return editCp(b.dataset.editCp);
    if(b.dataset.editFsr) return editFsr(b.dataset.editFsr);
    if(b.dataset.deleteWp){const id=b.dataset.deleteWp;const refs=S.subtasks.filter(s=>s.parent_wp===id);if(refs.length)return toast(`不能直接刪除 ${id}：仍有 ${refs.length} 個 Subtask。請先 Archive/移轉。`);if(!confirm(`確定刪除 ${id}？`))return;const next=S.workPackages.filter(x=>x.id!==id);try{await API.saveWorkPackages({schema_version:'1.0',work_packages:next});S.workPackages=next;renderAll();toast('WP 已刪除並寫回 GitHub');}catch(err){toast(err.message)}return;}
    if(b.dataset.deleteSubtask){if(!confirm(`Archive ${b.dataset.deleteSubtask} 並關閉對應 GitHub Issue？`))return;try{await API.archiveSubtask(b.dataset.deleteSubtask);S.subtasks=S.subtasks.filter(x=>x.id!==b.dataset.deleteSubtask);renderAll();toast('Subtask 已 Archive');}catch(err){toast(err.message)}return;}
    if(b.dataset.deleteCp){if(!confirm(`確定刪除 ${b.dataset.deleteCp}？`))return;const next=S.checkpoints.filter(x=>x.id!==b.dataset.deleteCp);try{await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});S.checkpoints=next;renderAll();toast('CP 已刪除');}catch(err){toast(err.message)}return;}
    if(b.dataset.deleteFsr){const id=b.dataset.deleteFsr;const linked=S.workPackages.filter(w=>arr(w.fsrs).includes(id));if(linked.length)return toast(`不能直接刪除 ${id}：仍被 ${linked.map(x=>x.id).join(', ')} 引用。`);if(!confirm(`確定刪除 ${id}？`))return;const next=S.fsrs.filter(x=>x.id!==id);try{await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next});S.fsrs=next;renderAll();toast('FSR 已刪除');}catch(err){toast(err.message)}return;}
    if(b.id==='btnSaveSettings'){API.setBase($('#apiBase').value);toast('API URL 已儲存');return;}
    if(b.id==='btnLogin') return API.login();
    if(b.id==='btnLogout') return API.logout();
    if(b.id==='btnExportSnapshot'){
      const data={project:S.project,work_packages:S.workPackages,subtasks:S.subtasks,functional_safety_requirements:S.fsrs,checkpoints:S.checkpoints};
      const blob=new Blob([JSON.stringify(data,null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`SmartPort_snapshot_${today()}.json`;a.click();URL.revokeObjectURL(a.href);return;
    }
  });

  $('#drawerBackdrop').addEventListener('click',closeDrawer);
  $('#showSubs').addEventListener('change',renderGantt);
  load();
})();