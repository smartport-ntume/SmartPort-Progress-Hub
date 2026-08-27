(() => {
  const S = window.SmartPortStore.state;
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  function toast(msg){ const el=$('#toast'); el.textContent=msg; el.classList.add('show'); clearTimeout(toast.t); toast.t=setTimeout(()=>el.classList.remove('show'),3200); }
  function esc(v=''){ return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
  function arr(v){ return Array.isArray(v)?v:[]; }
  function csv(v){ return arr(v).join(', '); }
  function parseCsv(v){ return String(v||'').split(',').map(x=>x.trim()).filter(Boolean); }
  function fmtDate(v){ return v||'—'; }

  function setConnection(ok,text){
    S.connected=!!ok;
    $('#connDot').className='dot '+(ok?'online':'offline');
    $('#connText').textContent=text || (ok?'GitHub Project Store 已連線':'GitHub Project Store 未連線');
  }

  function switchView(name){
    $$('.tab').forEach(b=>b.classList.toggle('active',b.dataset.view===name));
    $$('.view').forEach(v=>v.classList.toggle('active',v.id===`view-${name}`));
  }

  async function load(){
    const base=API.getBase();
    $('#apiBase').value=base;
    if(!base){ setConnection(false,'尚未設定 Auth/API'); renderAll(); return; }
    try{
      const snap=await API.loadSnapshot();
      Store.replaceSnapshot(snap);
      setConnection(true,'GitHub Project Store 已連線');
      renderAll();
    }catch(e){ setConnection(false,'連線失敗'); renderAll(); toast(e.message); }
  }

  function renderAll(){ renderDashboard(); renderWp(); renderGantt(); renderSubtasks(); renderFsr(); renderCp(); }

  function renderDashboard(){
    $('#metricProject').textContent=S.project.name||'SmartPort SC';
    $('#metricWp').textContent=S.workPackages.length;
    $('#metricSubtasks').textContent=S.subtasks.length;
    $('#metricFsr').textContent=S.fsrs.length;
    const today=new Date().toISOString().slice(0,10);
    const next=[...S.checkpoints].filter(x=>x.date>=today).sort((a,b)=>a.date.localeCompare(b.date))[0];
    $('#metricCp').textContent=next?`${next.id} · ${next.date}`:'—';
    $('#dashboardWp').innerHTML=S.workPackages.length?`<table class="data-table"><thead><tr><th>WP</th><th>Owner</th><th>Schedule</th><th>FSR</th></tr></thead><tbody>${S.workPackages.slice(0,8).map(w=>`<tr><td><strong>${esc(w.id)}</strong> ${esc(w.name)}</td><td>${esc(w.owner)}</td><td>${fmtDate(w.start)} → ${fmtDate(w.end)}</td><td>${arr(w.fsrs).map(x=>`<span class="pill">${esc(x)}</span>`).join('')}</td></tr>`).join('')}</tbody></table>`:'<div class="empty">等待 Project Store 資料。</div>';
    const counts={}; S.fsrs.forEach(f=>counts[f.maturity||'—']=(counts[f.maturity||'—']||0)+1);
    $('#dashboardFsr').innerHTML=S.fsrs.length?Object.entries(counts).sort().map(([k,v])=>`<div style="margin:9px 0"><strong>${esc(k)}</strong> <span class="pill">${v}</span></div>`).join(''):'<div class="empty">等待 Project Store 資料。</div>';
    $('#dashboardCp').innerHTML=S.checkpoints.length?S.checkpoints.slice(0,5).map(c=>`<div style="padding:9px 0;border-bottom:1px solid #e8edf2"><strong>${esc(c.id)} · ${esc(c.acl||'')}</strong>　${esc(c.name)}<div style="font-size:12px;color:#6b7785">${fmtDate(c.date)}</div></div>`).join(''):'<div class="empty">等待 Project Store 資料。</div>';
  }

  function renderWp(){
    $('#wpTable').innerHTML=S.workPackages.length?`<table class="data-table"><thead><tr><th>ID / Name</th><th>Owner</th><th>Group</th><th>Schedule</th><th>IF / FSR</th><th></th></tr></thead><tbody>${S.workPackages.map(w=>`<tr><td><strong>${esc(w.id)}</strong><br>${esc(w.name)}</td><td>${esc(w.owner)}</td><td>${esc(w.group)}</td><td>${fmtDate(w.start)}<br>→ ${fmtDate(w.end)}</td><td>${arr(w.ifs).map(x=>`<span class="pill">${esc(x)}</span>`).join('')}<br>${arr(w.fsrs).map(x=>`<span class="pill">${esc(x)}</span>`).join('')}</td><td><div class="row-actions"><button class="btn" data-edit-wp="${esc(w.id)}">編輯</button><button class="btn danger" data-delete-wp="${esc(w.id)}">刪除</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="empty">尚未載入 Work Package。</div>';
  }

  function renderGantt(){
    if(!S.workPackages.length){ $('#gantt').innerHTML='<div class="empty">尚未載入 Gantt。</div>'; return; }
    const months=['08','09','10','11','12'];
    $('#gantt').innerHTML=`<div class="gantt-wrap"><table class="gantt-table"><thead><tr><th>WP</th>${months.map(m=>`<th>2026-${m}</th>`).join('')}</tr></thead><tbody>${S.workPackages.map(w=>`<tr><td>${esc(w.id)} ${esc(w.name)}</td>${months.map(m=>{const active=(w.start||'').slice(5,7)<=m && (w.end||'').slice(5,7)>=m;return `<td class="gantt-cell">${active?'<div class="gantt-bar"></div>':''}</td>`}).join('')}</tr>`).join('')}</tbody></table></div>`;
  }

  function renderSubtasks(){
    $('#subtaskTable').innerHTML=S.subtasks.length?`<table class="data-table"><thead><tr><th>ID</th><th>Parent WP</th><th>Name</th><th>Owner</th><th>Target CP</th><th>Issue</th><th></th></tr></thead><tbody>${S.subtasks.map(t=>`<tr><td><strong>${esc(t.id)}</strong></td><td>${esc(t.parent_wp)}</td><td>${esc(t.name)}</td><td>${esc(t.owner_team||'')}</td><td>${esc(t.target_cp||'')}</td><td>${t.github_issue?`#${esc(t.github_issue)}`:'—'}</td><td><div class="row-actions"><button class="btn" data-edit-subtask="${esc(t.id)}">編輯</button><button class="btn danger" data-delete-subtask="${esc(t.id)}">Archive</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="empty">尚未載入 Subtasks。</div>';
  }

  function renderFsr(){
    $('#fsrTable').innerHTML=S.fsrs.length?`<table class="data-table"><thead><tr><th>ID</th><th>SG</th><th>Requirement</th><th>Primary</th><th>Maturity</th><th>WP</th><th></th></tr></thead><tbody>${S.fsrs.map(f=>`<tr><td><strong>${esc(f.id)}</strong></td><td>${esc(f.parent_sg||'')}</td><td>${esc(f.requirement)}</td><td>${esc(f.primary||'')}</td><td>${esc(f.maturity||'')}</td><td>${arr(f.linked_work_packages).map(x=>`<span class="pill">${esc(x)}</span>`).join('')}</td><td><div class="row-actions"><button class="btn" data-edit-fsr="${esc(f.id)}">編輯</button><button class="btn danger" data-delete-fsr="${esc(f.id)}">刪除</button></div></td></tr>`).join('')}</tbody></table>`:'<div class="empty">尚未載入 FSR。</div>';
  }

  function renderCp(){
    $('#cpGrid').innerHTML=S.checkpoints.length?S.checkpoints.map(c=>`<article class="cp-card"><h3>${esc(c.id)} · ${esc(c.name)}</h3><div class="cp-meta">${esc(c.acl||'')} · ${fmtDate(c.date)}</div><div>${esc(c.capability||'')}</div><div class="criteria"><strong>FSR target</strong><br>${esc(c.fsrTarget||c.fsr_target||'—')}</div><div class="row-actions" style="margin-top:12px"><button class="btn" data-edit-cp="${esc(c.id)}">編輯</button><button class="btn danger" data-delete-cp="${esc(c.id)}">刪除</button></div></article>`).join(''):'<div class="empty">尚未載入 Checkpoint。</div>';
  }

  function openDrawer(title,html,onSubmit){
    $('#drawerTitle').textContent=title; const f=$('#editorForm'); f.innerHTML=html; f.onsubmit=async e=>{e.preventDefault(); await onSubmit(new FormData(f));}; $('#drawer').classList.add('open'); $('#drawerBackdrop').classList.add('open'); $('#drawer').setAttribute('aria-hidden','false');
  }
  function closeDrawer(){ $('#drawer').classList.remove('open'); $('#drawerBackdrop').classList.remove('open'); $('#drawer').setAttribute('aria-hidden','true'); }
  function field(name,label,value='',type='text'){ return `<label>${esc(label)}<input name="${esc(name)}" type="${type}" value="${esc(value)}" required /></label>`; }
  function area(name,label,value=''){ return `<label>${esc(label)}<textarea name="${esc(name)}" rows="4">${esc(value)}</textarea></label>`; }
  function buttons(deleteLabel=''){ return `<div class="actions"><button type="button" class="btn" data-close>取消</button><button type="submit" class="btn primary">儲存到 GitHub</button></div>`; }

  function editWp(id){
    const old=S.workPackages.find(x=>x.id===id)||{id:'',name:'',owner:'',group:'',start:'',end:'',ifs:[],fsrs:[],description:'',evidence:[]};
    openDrawer(id?'編輯 Work Package':'新增 Work Package',`${field('id','WP ID',old.id)}${field('name','Name',old.name)}${field('owner','Owner',old.owner)}${field('group','Group',old.group)}<div class="form-grid">${field('start','Start',old.start,'date')}${field('end','End',old.end,'date')}</div>${field('ifs','IF（逗號分隔）',csv(old.ifs))}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs))}${area('description','Description',old.description)}${area('evidence','Evidence（每行一項）',arr(old.evidence).join('\n'))}${buttons()}`,async fd=>{
      const item={id:fd.get('id').trim(),name:fd.get('name').trim(),owner:fd.get('owner').trim(),group:fd.get('group').trim(),start:fd.get('start'),end:fd.get('end'),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs')),description:fd.get('description').trim(),evidence:String(fd.get('evidence')||'').split('\n').map(x=>x.trim()).filter(Boolean)};
      const next=[...S.workPackages]; const i=next.findIndex(x=>x.id===old.id); if(i>=0) next[i]=item; else next.push(item);
      try{ await API.saveWorkPackages({schema_version:'1.0',work_packages:next}); S.workPackages=next; closeDrawer(); renderAll(); toast('WP 已寫回 GitHub'); }catch(e){toast(e.message)}
    });
  }

  function editCp(id){
    const old=S.checkpoints.find(x=>x.id===id)||{id:'',date:'',acl:'',name:'',capability:'',fsrTarget:'',criteria:[]};
    openDrawer(id?'編輯 Checkpoint':'新增 Checkpoint',`${field('id','CP ID',old.id)}${field('acl','ACL',old.acl||'')}${field('name','Name',old.name)}${field('date','Date',old.date,'date')}${area('capability','Capability',old.capability||'')}${field('fsrTarget','FSR Target',old.fsrTarget||old.fsr_target||'')}${area('criteria','Criteria JSON',JSON.stringify(old.criteria||[],null,2))}${buttons()}`,async fd=>{
      let criteria=[]; try{criteria=JSON.parse(fd.get('criteria')||'[]')}catch(_){return toast('Criteria JSON 格式錯誤')}
      const item={id:fd.get('id').trim(),date:fd.get('date'),acl:fd.get('acl').trim(),name:fd.get('name').trim(),capability:fd.get('capability').trim(),fsrTarget:fd.get('fsrTarget').trim(),criteria};
      const next=[...S.checkpoints]; const i=next.findIndex(x=>x.id===old.id); if(i>=0) next[i]=item; else next.push(item);
      try{ await API.saveCheckpoints({schema_version:'1.0',checkpoints:next}); S.checkpoints=next; closeDrawer(); renderAll(); toast('CP 已寫回 GitHub'); }catch(e){toast(e.message)}
    });
  }

  function editFsr(id){
    const old=S.fsrs.find(x=>x.id===id)||{id:'',parent_sg:'',requirement:'',primary:'',support:[],linked_work_packages:[],maturity:'M0',target_2026_12_31:'M5',allocation_status:'Preliminary'};
    openDrawer(id?'編輯 FSR':'新增 FSR',`${field('id','FSR ID',old.id)}${field('parent_sg','Parent SG',old.parent_sg||'')}${area('requirement','Requirement',old.requirement||'')}${field('primary','Primary',old.primary||'')}${field('support','Support（逗號分隔）',csv(old.support))}${field('linked_work_packages','Linked WP（逗號分隔）',csv(old.linked_work_packages))}${field('maturity','Maturity',old.maturity||'M0')}${field('target','Target',old.target_2026_12_31||'')}${field('allocation','Allocation Status',old.allocation_status||'')}${buttons()}`,async fd=>{
      const item={id:fd.get('id').trim(),parent_sg:fd.get('parent_sg').trim(),requirement:fd.get('requirement').trim(),primary:fd.get('primary').trim(),support:parseCsv(fd.get('support')),linked_work_packages:parseCsv(fd.get('linked_work_packages')),maturity:fd.get('maturity').trim(),target_2026_12_31:fd.get('target').trim(),allocation_status:fd.get('allocation').trim()};
      const next=[...S.fsrs]; const i=next.findIndex(x=>x.id===old.id); if(i>=0) next[i]=item; else next.push(item);
      try{ await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next}); S.fsrs=next; closeDrawer(); renderAll(); toast('FSR 已寫回 GitHub'); }catch(e){toast(e.message)}
    });
  }

  function editSubtask(id){
    const old=S.subtasks.find(x=>x.id===id)||{id:'',parent_wp:'',name:'',owner_team:'',start:'',end:'',target_cp:'',ifs:[],fsrs:[]};
    openDrawer(id?'編輯 Subtask':'新增 Subtask',`${field('id','Subtask ID',old.id)}${field('parent_wp','Parent WP',old.parent_wp)}${field('name','Name',old.name)}${field('owner_team','Owner Team',old.owner_team||'')}<div class="form-grid">${field('start','Start',old.start,'date')}${field('end','End',old.end,'date')}</div>${field('target_cp','Target CP',old.target_cp||'')}${field('ifs','IF（逗號分隔）',csv(old.ifs))}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs))}${buttons()}`,async fd=>{
      const item={id:fd.get('id').trim(),parent_wp:fd.get('parent_wp').trim(),name:fd.get('name').trim(),owner_team:fd.get('owner_team').trim(),start:fd.get('start'),end:fd.get('end'),target_cp:fd.get('target_cp').trim(),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs'))};
      try{ const saved=id?await API.updateSubtask(id,item):await API.createSubtask(item); Store.upsert('subtasks',saved.subtask||saved); closeDrawer(); renderAll(); toast(id?'Subtask 已更新':'Subtask Issue 已建立'); }catch(e){toast(e.message)}
    });
  }

  async function deleteWp(id){
    const refs={subtasks:S.subtasks.filter(x=>x.parent_wp===id),fsrs:S.fsrs.filter(x=>arr(x.linked_work_packages).includes(id)),cps:S.checkpoints.filter(x=>arr(x.criteria).some(c=>Array.isArray(c)&&c[0]===id))};
    if(refs.subtasks.length||refs.fsrs.length||refs.cps.length){ return alert(`${id} 仍被引用：\nSubtasks ${refs.subtasks.length}\nFSR ${refs.fsrs.length}\nCP ${refs.cps.length}\n\n請先解除關聯或改用 Archive。`); }
    if(!confirm(`確定刪除 ${id}？GitHub commit history 仍會保留舊版本。`))return;
    const next=S.workPackages.filter(x=>x.id!==id); try{await API.saveWorkPackages({schema_version:'1.0',work_packages:next});S.workPackages=next;renderAll();toast('WP 已刪除並留下 Git history')}catch(e){toast(e.message)}
  }
  async function deleteCp(id){ if(!confirm(`確定刪除 ${id}？`))return; const next=S.checkpoints.filter(x=>x.id!==id);try{await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});S.checkpoints=next;renderAll();toast('CP 已刪除')}catch(e){toast(e.message)} }
  async function deleteFsr(id){ const refs=S.workPackages.filter(x=>arr(x.fsrs).includes(id)); if(refs.length)return alert(`${id} 仍被 ${refs.map(x=>x.id).join(', ')} 引用，請先解除關聯。`); if(!confirm(`確定刪除 ${id}？`))return;const next=S.fsrs.filter(x=>x.id!==id);try{await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next});S.fsrs=next;renderAll();toast('FSR 已刪除')}catch(e){toast(e.message)} }
  async function archiveSubtask(id){ if(!confirm(`Archive ${id}？對應 GitHub Issue 將以 not_planned 關閉。`))return;try{await API.archiveSubtask(id);S.subtasks=S.subtasks.filter(x=>x.id!==id);renderAll();toast('Subtask 已 Archive')}catch(e){toast(e.message)} }

  document.addEventListener('click',e=>{
    const b=e.target.closest('button'); if(!b)return;
    if(b.classList.contains('tab'))switchView(b.dataset.view);
    if(b.dataset.action==='add-wp')editWp(); if(b.dataset.action==='add-cp')editCp(); if(b.dataset.action==='add-fsr')editFsr(); if(b.dataset.action==='add-subtask')editSubtask();
    if(b.dataset.editWp)editWp(b.dataset.editWp); if(b.dataset.editCp)editCp(b.dataset.editCp); if(b.dataset.editFsr)editFsr(b.dataset.editFsr); if(b.dataset.editSubtask)editSubtask(b.dataset.editSubtask);
    if(b.dataset.deleteWp)deleteWp(b.dataset.deleteWp); if(b.dataset.deleteCp)deleteCp(b.dataset.deleteCp); if(b.dataset.deleteFsr)deleteFsr(b.dataset.deleteFsr); if(b.dataset.deleteSubtask)archiveSubtask(b.dataset.deleteSubtask);
    if(b.dataset.close!==undefined)closeDrawer();
  });
  $('#drawerClose').onclick=closeDrawer; $('#drawerBackdrop').onclick=closeDrawer; $('#btnReload').onclick=load;
  $('#btnSaveSettings').onclick=()=>{API.setBase($('#apiBase').value);localStorage.setItem('smartport.projectRepo',$('#projectRepo').value.trim());toast('設定已儲存');load();};
  $('#btnTestConnection').onclick=async()=>{try{await API.health();setConnection(true,'Auth/API 可用');toast('連線成功')}catch(e){setConnection(false,'Auth/API 無法連線');toast(e.message)}};
  load();
})();
