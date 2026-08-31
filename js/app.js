(() => {
  const S = window.SmartPortStore.state;
  const API = window.SmartPortAPI;
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const esc = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const arr = v => Array.isArray(v) ? v : [];
  const csv = v => arr(v).join(', ');
  const parseCsv = v => String(v||'').split(',').map(x=>x.trim()).filter(Boolean);
  const clone = v => JSON.parse(JSON.stringify(v));
  const d = s => new Date(s+'T12:00:00');
  const clamp=(x,a,b)=>Math.max(a,Math.min(b,x));
  let selectedItem=null;

  const teamNames={CTL:'控制','LOC/NAV':'定位＋導航',PER:'感知',STM:'狀態機＋任務',VERIFY:'Verification'};
  const teamColor={CTL:'#5277bb','LOC/NAV':'#6c9275',PER:'#8a6bb8',STM:'#c37b4a',VERIFY:'#7b8794'};
  const statusOptions=['Not Updated','Planned','In Progress','On Track','At Risk','Blocked','Delayed','Done','Completed'];

  function toast(msg){const el=$('#toast');if(!el)return;el.textContent=msg;el.classList.add('show');clearTimeout(toast.t);toast.t=setTimeout(()=>el.classList.remove('show'),3400)}
  function setConnection(ok,text){S.connected=!!ok;$('#connDot').className='conn-dot '+(ok?'online':'offline');$('#connText').textContent=text||(ok?'GitHub Project Store 已連線':'GitHub Project Store 未連線')}
  function switchView(name){$$('.nav button').forEach(b=>b.classList.toggle('active',b.dataset.view===name));$$('.view').forEach(v=>v.classList.toggle('active',v.id===name))}
  function projectBounds(){const dates=[...S.workPackages.flatMap(t=>[d(t.start),d(t.end)]),...S.checkpoints.map(c=>d(c.date))].filter(x=>!Number.isNaN(+x));if(!dates.length){const now=new Date();return{start:now,end:new Date(+now+86400000)}}return{start:new Date(Math.min(...dates)),end:new Date(Math.max(...dates))}}
  function pos(dt){const b=projectBounds();return clamp((dt-b.start)/(b.end-b.start),0,1)*100}
  function currentCPs(){const cps=[...S.checkpoints].sort((a,b)=>d(a.date)-d(b.date));if(!cps.length)return{prev:null,next:null};const now=new Date();let prev=cps[0],next=cps[cps.length-1];for(const cp of cps){if(d(cp.date)<=now)prev=cp;if(d(cp.date)>=now){next=cp;break}}return{prev,next}}
  function progressOf(t){return t?.actual_progress ?? t?.actualProgress ?? t?.progress ?? null}
  function weightOf(t){return t?.weight ?? 1}
  function statusOf(t){return t?.status || 'Not Updated'}
  function lastWeekOf(t){return t?.last_week ?? t?.lastWeek ?? ''}
  function thisWeekOf(t){return t?.this_week ?? t?.thisWeek ?? t?.last_update_summary ?? ''}
  function blockerOf(t){if(t?.blocker!=null)return String(t.blocker);if(Array.isArray(t?.blockers))return t.blockers.join('\n');return''}
  function pmCommentOf(t){if(t?.pm_comment!=null)return String(t.pm_comment);if(t?.pmComment!=null)return String(t.pmComment);if(Array.isArray(t?.pm_comments))return t.pm_comments.join('\n');if(Array.isArray(t?.pmComments))return t.pmComments.join('\n');return''}
  function actualEvidenceOf(t){const v=t?.actual_evidence ?? t?.evidence_note ?? t?.evidenceNote ?? '';return Array.isArray(v)?v.join('\n'):String(v||'')}
  function lastUpdateOf(t){return t?.last_update || ''}
  function canWrite(){return !!window.SMARTPORT_ACCESS?.can_write}
  function planned(t){const now=new Date(),s=d(t.start),e=d(t.end);if(now<=s)return 0;if(now>=e)return 100;return Math.round(100*(now-s)/(e-s))}
  function riskOf(t){const p=progressOf(t);if(p==null)return'NOT_UPDATED';const gap=planned(t)-p,days=(d(t.end)-new Date())/86400000;if(new Date()>d(t.end)&&p<100)return'DELAYED';if(String(statusOf(t)).toLowerCase()==='blocked'||String(statusOf(t)).toLowerCase()==='at risk')return'AT_RISK';if(gap>=25||(days<14&&p<70))return'AT_RISK';return'ON_TRACK'}

  function renderSummary(){
    const {prev,next}=currentCPs(),today=new Date();
    $('#todayCard').textContent=today.toLocaleDateString('zh-TW',{year:'numeric',month:'2-digit',day:'2-digit'});
    $('#currentAcl').textContent=prev?.acl||'—';
    $('#currentCpSub').textContent=prev?`${prev.id} · ${prev.name}`:'';
    $('#nextCp').textContent=next?.id||'—';
    $('#nextCpDate').textContent=next?`${next.date} · ${next.name}`:'';
    const updated=S.workPackages.filter(t=>progressOf(t)!=null).length;
    const risks=S.workPackages.map(riskOf);
    const health=risks.includes('DELAYED')?'RED':risks.includes('AT_RISK')?'AMBER':updated?'GREEN':'NO DATA';
    $('#scheduleHealth').textContent=health;
    $('#scheduleSub').textContent=updated?`${risks.filter(x=>x==='AT_RISK').length} at risk · ${risks.filter(x=>x==='DELAYED').length} delayed`:'等待第一輪 Approved Update';
    if(!$('#pendingCount').dataset.weeklyManaged)$('#pendingCount').textContent='0';
  }

  function makeCpLines(tl,today){S.checkpoints.forEach(cp=>{const x=document.createElement('div');x.className='cp-vline';x.style.left=pos(d(cp.date))+'%';tl.appendChild(x)});const b=projectBounds();if(today>=b.start&&today<=b.end){const x=document.createElement('div');x.className='today-line';x.style.left=pos(today)+'%';tl.appendChild(x)}}
  function buildGanttRows(){const rows=[];S.workPackages.forEach(w=>{rows.push({...w,_kind:'wp'});if($('#showSubs')?.checked){S.subtasks.filter(s=>s.parent_wp===w.id).forEach(s=>rows.push({...s,owner:s.owner_team,_kind:'sub'}))}});return rows}

  function renderGantt(){
    const root=$('#gantt');root.innerHTML='';if(!S.workPackages.length){root.innerHTML='<div class="muted" style="padding:14px">尚未載入 Gantt。</div>';return}
    const head=document.createElement('div');head.className='g-row g-head';
    head.innerHTML='<div class="g-cell">Owner</div><div class="g-cell">Work Package / Subtask</div><div class="g-cell" style="padding:0"><div class="cp-lane"></div><div class="month-lane"></div></div>';
    root.appendChild(head);
    const cpLane=head.querySelector('.cp-lane'),monthLane=head.querySelector('.month-lane'),b=projectBounds(),today=new Date();
    S.checkpoints.forEach(cp=>{const m=document.createElement('div');m.className='cp-marker';m.style.left=pos(d(cp.date))+'%';m.innerHTML=`${esc(cp.id)}<br>${esc(cp.acl||'')}`;m.onclick=()=>openCpDetail(cp.id);cpLane.appendChild(m)});
    let s=new Date(b.start);while(s<b.end){let e=new Date(s.getFullYear(),s.getMonth()+1,1);if(e<=s)e=new Date(s.getFullYear(),s.getMonth()+1,1);if(e>b.end)e=b.end;const el=document.createElement('div');el.className='month';el.style.left=pos(s)+'%';el.style.width=(pos(e)-pos(s))+'%';el.textContent=s.toLocaleString('en',{month:'short'});monthLane.appendChild(el);s=e}
    if(today>=b.start&&today<=b.end){const tag=document.createElement('div');tag.className='today-tag';tag.style.left=pos(today)+'%';tag.textContent='TODAY '+today.toLocaleDateString('zh-TW',{month:'2-digit',day:'2-digit'});cpLane.appendChild(tag)}
    buildGanttRows().forEach(t=>{const row=document.createElement('div');row.className='g-row'+(t._kind==='sub'?' sub-row-gantt':'');const owner=t.owner||'',r=riskOf(t),p=progressOf(t);row.innerHTML=`<div class="g-cell"><span class="owner-pill">${esc(teamNames[owner]||owner||'—')}</span></div><div class="g-cell"><b>${esc(t.id)}</b> ${esc(t.name||'')}<div><span class="risk-pill risk-${r}">${esc(r.replace('_',' '))}</span> <span class="muted">${p==null?'—':p+'%'}</span></div></div><div class="g-cell timeline"></div>`;const tl=row.querySelector('.timeline');makeCpLines(tl,today);const bar=document.createElement('div');bar.className='bar';bar.style.left=pos(d(t.start))+'%';bar.style.width=Math.max(.5,pos(d(t.end))-pos(d(t.start)))+'%';bar.style.background=teamColor[owner]||'#667085';bar.title=`${t.id} · ${t.name}\n${t.start} → ${t.end}`;bar.onclick=()=>t._kind==='wp'?openWpDetail(t.id):openSubtaskDetail(t.id);bar.innerHTML=`<div class="fill" style="width:${p||0}%"></div><div class="bar-label">${esc(t.id)} · ${esc(t.name||'')}</div>`;tl.appendChild(bar);root.appendChild(row)})
  }

  function tags(v){return arr(v).map(x=>`<span class="tag">${esc(x)}</span>`).join('')||'<span class="muted">—</span>'}
  function renderPlan(){
    const tb=$('#planTable tbody');tb.innerHTML='';
    S.workPackages.forEach(w=>{
      const p=progressOf(w),st=statusOf(w);
      tb.insertAdjacentHTML('beforeend',`<tr class="plan-row clickable" data-open-wp="${esc(w.id)}"><td><b>${esc(w.id)}</b> ${esc(w.name)}<div class="muted">${esc(w.group||'')}</div></td><td>${esc(w.owner)}</td><td>${esc(w.start)}</td><td>${esc(w.end)}</td><td>${esc(weightOf(w))}</td><td>${p==null?'—':p+'%'}<div class="muted">${esc(st)}</div></td><td>${tags(w.ifs)}<br>${tags(w.fsrs)}</td><td><div class="row-actions"><button class="btn smallbtn" data-edit-wp="${esc(w.id)}">Edit</button></div></td></tr>`);
      S.subtasks.filter(s=>s.parent_wp===w.id).forEach(s=>{const sp=progressOf(s);tb.insertAdjacentHTML('beforeend',`<tr class="plan-row subtask-plan-row clickable" data-open-sub="${esc(s.id)}"><td style="padding-left:28px">↳ <b>${esc(s.id)}</b> ${esc(s.name)}<div class="muted">Parent: ${esc(s.parent_wp||'')}</div></td><td>${esc(s.owner_team||'')}</td><td>${esc(s.start||'')}</td><td>${esc(s.end||'')}</td><td>${esc(weightOf(s))}</td><td>${sp==null?'—':sp+'%'}<div class="muted">${esc(statusOf(s))}</div></td><td>${tags(s.ifs)}<br>${tags(s.fsrs)}</td><td><div class="row-actions"><button class="btn smallbtn" data-edit-subtask="${esc(s.id)}">Edit</button></div></td></tr>`)})
    });
    $('#cpEditTable tbody').innerHTML=S.checkpoints.map(cp=>`<tr class="clickable" data-cp-card="${esc(cp.id)}"><td><b>${esc(cp.id)}</b></td><td>${esc(cp.date)}</td><td>${esc(cp.acl||'')}</td><td>${esc(cp.name||'')}</td><td>${esc(cp.fsrTarget||cp.fsr_target||'')}</td><td><button class="btn smallbtn" data-edit-cp="${esc(cp.id)}">Edit</button></td></tr>`).join('')
  }

  function renderFsr(){$('#fsrTable tbody').innerHTML=S.fsrs.map(f=>`<tr><td><b>${esc(f.id)}</b></td><td>${esc(f.requirement||'')}</td><td>${esc(f.primary||'')}</td><td>${tags(f.support)}</td><td>${tags(f.linked_work_packages)}</td><td>${esc(f.maturity||'')}</td><td>${esc(f.target_2026_12_31||'')}</td><td><button class="btn smallbtn" data-edit-fsr="${esc(f.id)}">Edit</button></td></tr>`).join('')}
  function readiness(cp){if(!cp.criteria?.length)return{score:0,vals:[]};const vals=cp.criteria.map(([id,req])=>{const t=S.workPackages.find(x=>x.id===id),act=t&&progressOf(t)!=null?progressOf(t):0;return{id,req,act,ok:act>=req}});return{score:Math.round(vals.reduce((a,x)=>a+Math.min(1,x.req?x.act/x.req:1),0)/vals.length*100),vals}}
  function renderCp(){const b=projectBounds(),now=new Date(),tl=$('#cpTimeline');tl.innerHTML='<div class="cp-track"></div>';if(now>=b.start&&now<=b.end){const nl=document.createElement('div');nl.className='cp-now';nl.style.left=pos(now)+'%';nl.innerHTML='<span>TODAY</span>';tl.appendChild(nl)}const{prev,next}=currentCPs();S.checkpoints.forEach(cp=>{const el=document.createElement('div');let cls=d(cp.date)<now?'past':cp.id===next?.id?'next':'';if(cp.id===prev?.id&&d(cp.date)<=now)cls+=' current';el.className='cp-point '+cls;el.style.left=pos(d(cp.date))+'%';el.innerHTML=`<div class="dot"></div><div class="lab"><b>${esc(cp.id)}</b><br>${esc(cp.acl||'')}</div>`;el.onclick=()=>openCpDetail(cp.id);tl.appendChild(el)});$('#cpGrid').innerHTML=S.checkpoints.map(cp=>{const r=readiness(cp);let cls=d(cp.date)<now?'past':cp.id===next?.id?'next':'';if(cp.id===prev?.id&&d(cp.date)<=now)cls+=' current';return`<div class="cp-card ${cls}" data-cp-card="${esc(cp.id)}"><h3>${esc(cp.id)} · ${esc(cp.date)}</h3><div class="acl">${esc(cp.acl||'')}</div><p>${esc(cp.capability||'')}</p><div class="progress"><div style="width:${r.score}%"></div></div><div><b>${r.score}% readiness</b></div><p><b>FSR：</b>${esc(cp.fsrTarget||cp.fsr_target||'—')}</p>${r.vals.map(x=>`<div class="muted">${x.ok?'✓':'△'} ${esc(x.id)}: ${x.act}% / ${x.req}%</div>`).join('')}</div>`}).join('')}

  function openDrawer(title,html){selectedItem=title;$('#drawerTitle').textContent=title;$('#drawerBody').innerHTML=html;$('#drawer').classList.add('open');$('#drawerBackdrop').classList.add('open')}
  function closeDrawer(){$('#drawer').classList.remove('open');$('#drawerBackdrop').classList.remove('open');$('#drawerBody').onsubmit=null}
  function readField(label,value){return`<div class="field"><label>${esc(label)}</label><div class="detail-value">${String(value??'').trim()?esc(value):'<span class="muted">—</span>'}</div></div>`}
  function execEditor(t,kind){
    const p=progressOf(t),st=statusOf(t),w=lastWeekOf(t),tw=thisWeekOf(t),bl=blockerOf(t),pm=pmCommentOf(t),ev=actualEvidenceOf(t),lu=lastUpdateOf(t);
    if(!canWrite())return`${readField('Actual Progress',p==null?'Not Updated':p+'%')}${readField('Status',st)}${readField('上週完成',w)}${readField('本週完成',tw)}${readField('Blocker',bl)}${readField('PM Comment',pm)}${readField('Evidence / Link',ev)}${readField('Last Update',lu)}`;
    return`<div class="execution-editor"><div class="section-title">Execution Status</div><div class="split"><div class="field"><label>Actual Progress (%)</label><input name="exec_progress" type="number" min="0" max="100" value="${p==null?'':esc(p)}"></div><div class="field"><label>Status</label><select name="exec_status">${statusOptions.map(x=>`<option ${st===x?'selected':''}>${esc(x)}</option>`).join('')}</select></div></div><div class="field"><label>上週完成</label><textarea name="exec_last_week">${esc(w)}</textarea></div><div class="field"><label>本週完成</label><textarea name="exec_this_week">${esc(tw)}</textarea></div><div class="field"><label>Blocker</label><textarea name="exec_blocker">${esc(bl)}</textarea></div><div class="field"><label>PM Comment</label><textarea name="exec_pm_comment">${esc(pm)}</textarea></div><div class="field"><label>Evidence / Link</label><textarea name="exec_evidence">${esc(ev)}</textarea></div><div class="field"><label>Last Update</label><input name="exec_last_update" type="date" value="${esc(lu)}"></div><button type="button" class="btn primary" data-save-exec="${kind}" data-id="${esc(t.id)}">儲存進度到 GitHub</button></div>`
  }

  function openWpDetail(id){
    const t=S.workPackages.find(x=>x.id===id);if(!t)return;const subs=S.subtasks.filter(s=>s.parent_wp===id);
    openDrawer(`${t.id} · ${t.name}`,`<div><span class="owner-pill">${esc(teamNames[t.owner]||t.owner)}</span> <span class="risk-pill risk-${riskOf(t)}">${esc(riskOf(t))}</span></div><div class="split">${readField('Schedule',`${t.start} → ${t.end}`)}${readField('Weight',weightOf(t))}</div>${readField('Group',t.group||'')}${readField('IF',csv(t.ifs))}${readField('FSR',csv(t.fsrs))}${readField('工作內容',t.description||'')}<div class="field"><label>Expected Evidence</label><div>${arr(t.evidence).map(x=>`• ${esc(x)}`).join('<br>')||'<span class="muted">—</span>'}</div></div>${execEditor(t,'wp')}<div class="field"><label>Subtasks</label>${subs.length?subs.map(s=>`<button type="button" class="btn smallbtn" data-open-sub="${esc(s.id)}">${esc(s.id)} · ${esc(s.name)}</button>`).join(' '):'<span class="muted">—</span>'}</div><div class="field"><button type="button" class="btn" data-edit-wp="${esc(t.id)}">編輯規劃欄位</button></div>`)
  }

  function openSubtaskDetail(id){
    const t=S.subtasks.find(x=>x.id===id);if(!t)return;
    openDrawer(`${t.id} · ${t.name}`,`<div><span class="owner-pill">${esc(teamNames[t.owner_team]||t.owner_team||'')}</span> <span class="risk-pill risk-${riskOf(t)}">${esc(riskOf(t))}</span></div><div class="split">${readField('Parent WP',t.parent_wp||'')}${readField('Weight',weightOf(t))}</div><div class="split">${readField('Schedule',`${t.start||''} → ${t.end||''}`)}${readField('Target CP',t.target_cp||'')}</div>${readField('IF',csv(t.ifs))}${readField('FSR',csv(t.fsrs))}${readField('工作內容',t.description||'')}${arr(t.expected_evidence).length?`<div class="field"><label>Expected Evidence</label><div>${arr(t.expected_evidence).map(x=>`• ${esc(x)}`).join('<br>')}</div></div>`:''}${readField('GitHub Issue',t.github_issue?'#'+t.github_issue:'')}${execEditor(t,'subtask')}<div class="field"><button type="button" class="btn" data-edit-subtask="${esc(t.id)}">編輯規劃欄位</button></div>`)
  }

  function openCpDetail(id){const cp=S.checkpoints.find(x=>x.id===id);if(!cp)return;const r=readiness(cp);openDrawer(`${cp.id} · ${cp.name}`,`<div class="field"><label>ACL / Date</label><div>${esc(cp.acl||'')} · ${esc(cp.date)}</div></div><div class="field"><label>Vehicle Capability / Gate</label><div>${esc(cp.capability||'')}</div></div><div class="field"><label>FSR Target</label><div>${esc(cp.fsrTarget||cp.fsr_target||'—')}</div></div><div class="field"><label>Readiness</label><div class="progress"><div style="width:${r.score}%"></div></div><div>${r.score}%</div></div><div class="field"><label>Criteria</label>${r.vals.map(x=>`${x.ok?'✓':'△'} ${esc(x.id)}: ${x.act}% / ${x.req}%`).join('<br>')||'—'}</div><button type="button" class="btn primary" data-edit-cp="${esc(cp.id)}">編輯 CP</button>`)}

  function field(name,label,value='',type='text',readonly=false){return`<div class="field"><label>${esc(label)}</label><input name="${esc(name)}" type="${type}" value="${esc(value)}" ${readonly?'readonly':''}></div>`}
  function area(name,label,value=''){return`<div class="field"><label>${esc(label)}</label><textarea name="${esc(name)}">${esc(value)}</textarea></div>`}
  function selectField(name,label,value,options){return`<div class="field"><label>${esc(label)}</label><select name="${esc(name)}">${options.map(x=>`<option value="${esc(x)}" ${String(value)===String(x)?'selected':''}>${esc(x)}</option>`).join('')}</select></div>`}
  function formButtons(extra=''){return`<div class="field"><button type="submit" class="btn primary">儲存到 GitHub</button> ${extra} <button type="button" class="btn" data-close>取消</button></div>`}
  function bindForm(title,html,onSubmit){openDrawer(title,html);const f=$('#drawerBody');f.onsubmit=async e=>{e.preventDefault();await onSubmit(new FormData(f))}}

  function editWp(id=''){
    const old=id?S.workPackages.find(x=>x.id===id):{id:'',name:'',owner:'CTL',group:'',start:'',end:'',weight:1,ifs:[],fsrs:[],keywords:[],description:'',evidence:[],actual_progress:null,status:'Not Updated'};
    if(!old)return;
    bindForm(id?`編輯 ${id}`:'新增 Work Package',`${field('id','WP ID',old.id,'text',!!id)}${field('name','Name',old.name)}${selectField('owner','Owner',old.owner,Object.keys(teamNames))}${field('group','Group',old.group||'')}<div class="split">${field('start','Start',old.start,'date')}${field('end','End',old.end,'date')}</div>${field('weight','Weight',weightOf(old),'number')}${field('ifs','IF（逗號分隔）',csv(old.ifs))}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs))}${field('keywords','Keywords（逗號分隔）',csv(old.keywords))}${area('description','工作內容',old.description||'')}${area('evidence','Expected Evidence（每行一項）',arr(old.evidence).join('\n'))}${formButtons(id?`<button type="button" class="btn danger" data-delete-wp="${esc(id)}">刪除 WP</button>`:'')}`,async fd=>{
      const item={...clone(old),id:String(fd.get('id')).trim(),name:String(fd.get('name')).trim(),owner:String(fd.get('owner')).trim(),group:String(fd.get('group')).trim(),start:String(fd.get('start')||''),end:String(fd.get('end')||''),weight:Number(fd.get('weight')||1),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs')),keywords:parseCsv(fd.get('keywords')),description:String(fd.get('description')||'').trim(),evidence:String(fd.get('evidence')||'').split('\n').map(x=>x.trim()).filter(Boolean)};
      if(!item.id)return toast('WP ID 必填');const next=clone(S.workPackages),i=next.findIndex(x=>x.id===id);if(i>=0)next[i]=item;else{if(next.some(x=>x.id===item.id))return toast('WP ID 已存在');next.push(item)}try{await API.saveWorkPackages({schema_version:'1.0',status:'GitHub-backed planning baseline',work_packages:next});S.workPackages=next;closeDrawer();renderAll();toast('WP 已寫回 GitHub')}catch(e){toast(e.message)}
    })
  }

  function editSubtask(id=''){
    const old=id?S.subtasks.find(x=>x.id===id):{id:'',parent_wp:'',name:'',owner_team:'CTL',start:'',end:'',weight:1,target_cp:'',ifs:[],fsrs:[],keywords:[],description:'',expected_evidence:[],actual_progress:null,status:'Not Updated'};
    if(!old)return;
    bindForm(id?`編輯 ${id}`:'新增 Subtask',`${field('id','Subtask ID',old.id,'text',!!id)}${field('parent_wp','Parent WP',old.parent_wp)}${field('name','Name',old.name)}${selectField('owner_team','Owner Team',old.owner_team||'CTL',Object.keys(teamNames))}<div class="split">${field('start','Start',old.start||'','date')}${field('end','End',old.end||'','date')}</div><div class="split">${field('weight','Weight',weightOf(old),'number')}${field('target_cp','Target CP',old.target_cp||'')}</div>${field('ifs','IF（逗號分隔）',csv(old.ifs))}${field('fsrs','FSR（逗號分隔）',csv(old.fsrs))}${field('keywords','Keywords（逗號分隔）',csv(old.keywords))}${area('description','工作內容',old.description||'')}${area('expected_evidence','Expected Evidence（每行一項）',arr(old.expected_evidence).join('\n'))}${formButtons(id?`<button type="button" class="btn danger" data-delete-subtask="${esc(id)}">Archive</button>`:'')}`,async fd=>{
      const item={...clone(old),id:String(fd.get('id')).trim(),parent_wp:String(fd.get('parent_wp')).trim(),name:String(fd.get('name')).trim(),owner_team:String(fd.get('owner_team')).trim(),start:String(fd.get('start')||''),end:String(fd.get('end')||''),weight:Number(fd.get('weight')||1),target_cp:String(fd.get('target_cp')||'').trim(),ifs:parseCsv(fd.get('ifs')),fsrs:parseCsv(fd.get('fsrs')),keywords:parseCsv(fd.get('keywords')),description:String(fd.get('description')||'').trim(),expected_evidence:String(fd.get('expected_evidence')||'').split('\n').map(x=>x.trim()).filter(Boolean)};
      if(!item.id||!item.parent_wp)return toast('Subtask ID / Parent WP 必填');try{let saved;if(id){saved=await API.updateSubtask(id,item);const i=S.subtasks.findIndex(x=>x.id===id);S.subtasks[i]={...S.subtasks[i],...saved}}else{if(S.subtasks.some(x=>x.id===item.id))return toast('Subtask ID 已存在');saved=await API.createSubtask(item);S.subtasks.push(saved)}closeDrawer();renderAll();toast(id?'Subtask 已更新':'Subtask 已建立 GitHub Issue')}catch(e){toast(e.message)}
    })
  }

  async function saveExecution(kind,id){
    const root=$('#drawerBody'),raw=root.querySelector('[name="exec_progress"]')?.value??'',progress=raw===''?null:clamp(Number(raw),0,100);const patch={actual_progress:progress,status:root.querySelector('[name="exec_status"]')?.value||'Not Updated',last_week:root.querySelector('[name="exec_last_week"]')?.value||'',this_week:root.querySelector('[name="exec_this_week"]')?.value||'',blocker:root.querySelector('[name="exec_blocker"]')?.value||'',pm_comment:root.querySelector('[name="exec_pm_comment"]')?.value||'',actual_evidence:root.querySelector('[name="exec_evidence"]')?.value||'',last_update:root.querySelector('[name="exec_last_update"]')?.value||new Date().toISOString().slice(0,10),last_update_by:window.SMARTPORT_ACCESS?.login||''};if(progress===100&&patch.status==='Not Updated')patch.status='Done';
    try{
      if(kind==='wp'){const next=clone(S.workPackages),i=next.findIndex(x=>x.id===id);if(i<0)return;next[i]={...next[i],...patch};await API.saveWorkPackages({schema_version:'1.0',status:'GitHub-backed planning baseline',work_packages:next});S.workPackages=next;renderAll();openWpDetail(id)}
      else{const saved=await API.updateSubtask(id,patch),i=S.subtasks.findIndex(x=>x.id===id);if(i>=0)S.subtasks[i]={...S.subtasks[i],...saved};renderAll();openSubtaskDetail(id)}
      toast('進度已寫回 GitHub')
    }catch(e){toast(e.message)}
  }

  function editCp(id=''){const old=id?S.checkpoints.find(x=>x.id===id):{id:'',date:'',acl:'',name:'',capability:'',fsrTarget:'',criteria:[]};bindForm(id?`編輯 ${id}`:'新增 Checkpoint',`${field('id','CP ID',old.id,'text',!!id)}${field('date','Date',old.date,'date')}${field('acl','ACL',old.acl||'')}${field('name','Name',old.name||'')}${area('capability','Vehicle Capability / Gate',old.capability||'')}${field('fsrTarget','FSR Target',old.fsrTarget||old.fsr_target||'')}${area('criteria','Readiness Criteria JSON',JSON.stringify(old.criteria||[],null,2))}${formButtons(id?`<button type="button" class="btn danger" data-delete-cp="${esc(id)}">刪除 CP</button>`:'')}`,async fd=>{let criteria=[];try{criteria=JSON.parse(String(fd.get('criteria')||'[]'))}catch(e){toast('Criteria JSON 格式錯誤');return}const item={...clone(old),id:String(fd.get('id')).trim(),date:String(fd.get('date')||''),acl:String(fd.get('acl')).trim(),name:String(fd.get('name')).trim(),capability:String(fd.get('capability')||'').trim(),fsrTarget:String(fd.get('fsrTarget')||'').trim(),criteria};const next=clone(S.checkpoints),i=next.findIndex(x=>x.id===id);if(i>=0)next[i]=item;else next.push(item);next.sort((a,b)=>d(a.date)-d(b.date));try{await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});S.checkpoints=next;closeDrawer();renderAll();toast('CP 已寫回 GitHub')}catch(e){toast(e.message)}})}

  function editFsr(id=''){const old=id?S.fsrs.find(x=>x.id===id):{id:'',parent_sg:'',requirement:'',primary:'',support:[],linked_work_packages:[],maturity:'M0',target_2026_12_31:'M5',allocation_status:''};bindForm(id?`編輯 ${id}`:'新增 FSR',`${field('id','FSR ID',old.id,'text',!!id)}${field('parent_sg','Parent SG',old.parent_sg||'')}${area('requirement','Requirement',old.requirement||'')}${field('primary','Primary',old.primary||'')}${field('support','Support / IF（逗號分隔）',csv(old.support))}${field('linked_work_packages','Linked WP（逗號分隔）',csv(old.linked_work_packages))}${field('maturity','Current Maturity',old.maturity||'M0')}${field('target_2026_12_31','12/31 Target',old.target_2026_12_31||'')}${area('allocation_status','Allocation Status',old.allocation_status||'')}${formButtons(id?`<button type="button" class="btn danger" data-delete-fsr="${esc(id)}">刪除 FSR</button>`:'')}`,async fd=>{const item={...clone(old),id:String(fd.get('id')).trim(),parent_sg:String(fd.get('parent_sg')).trim(),requirement:String(fd.get('requirement')).trim(),primary:String(fd.get('primary')).trim(),support:parseCsv(fd.get('support')),linked_work_packages:parseCsv(fd.get('linked_work_packages')),maturity:String(fd.get('maturity')).trim(),target_2026_12_31:String(fd.get('target_2026_12_31')).trim(),allocation_status:String(fd.get('allocation_status')||'').trim()};const next=clone(S.fsrs),i=next.findIndex(x=>x.id===id);if(i>=0)next[i]=item;else next.push(item);try{await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next});S.fsrs=next;closeDrawer();renderAll();toast('FSR 已寫回 GitHub')}catch(e){toast(e.message)}})}

  async function deleteWp(id){const refs=S.subtasks.filter(s=>s.parent_wp===id);if(refs.length){toast(`不能刪除 ${id}：仍有 ${refs.length} 個 Subtask`);return}if(!confirm(`刪除 ${id}？`))return;const next=S.workPackages.filter(x=>x.id!==id);try{await API.saveWorkPackages({schema_version:'1.0',work_packages:next});S.workPackages=next;closeDrawer();renderAll();toast('WP 已刪除')}catch(e){toast(e.message)}}
  async function deleteSubtask(id){if(!confirm(`Archive ${id}？`))return;try{await API.archiveSubtask(id);S.subtasks=S.subtasks.filter(x=>x.id!==id);closeDrawer();renderAll();toast('Subtask 已 Archive')}catch(e){toast(e.message)}}
  async function deleteCp(id){if(!confirm(`刪除 ${id}？`))return;const next=S.checkpoints.filter(x=>x.id!==id);try{await API.saveCheckpoints({schema_version:'1.0',checkpoints:next});S.checkpoints=next;closeDrawer();renderAll();toast('CP 已刪除')}catch(e){toast(e.message)}}
  async function deleteFsr(id){const linked=[...S.workPackages.filter(w=>arr(w.fsrs).includes(id)),...S.subtasks.filter(s=>arr(s.fsrs).includes(id))];if(linked.length){toast(`不能刪除 ${id}：仍有 ${linked.length} 個 WP/Subtask 參照`);return}if(!confirm(`刪除 ${id}？`))return;const next=S.fsrs.filter(x=>x.id!==id);try{await API.saveFSR({schema_version:'1.0',functional_safety_requirements:next});S.fsrs=next;closeDrawer();renderAll();toast('FSR 已刪除')}catch(e){toast(e.message)}}

  function exportSnapshot(){const blob=new Blob([JSON.stringify({project:S.project,work_packages:S.workPackages,subtasks:S.subtasks,functional_safety_requirements:S.fsrs,checkpoints:S.checkpoints},null,2)],{type:'application/json'});const a=document.createElement('a');a.href=URL.createObjectURL(blob);a.download=`SmartPort_Project_Snapshot_${new Date().toISOString().slice(0,10)}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(a.href),500)}
  function renderAll(){renderSummary();renderGantt();renderPlan();renderFsr();renderCp()}
  async function load(){try{const me=await API.me();window.SMARTPORT_ACCESS={...(window.SMARTPORT_ACCESS||{}),...me};setConnection(true,`GitHub Project Store 已連線 · ${me.login}`);$('#githubUser').value=me.login;const snap=await API.loadSnapshot();window.SmartPortStore.replaceSnapshot(snap);renderAll()}catch(e){setConnection(false,'連線失敗');toast(e.message)}}

  document.addEventListener('click',e=>{
    const nav=e.target.closest('.nav button[data-view]');if(nav){switchView(nav.dataset.view);return}
    if(e.target.closest('[data-close]')||e.target.closest('#drawerClose')||e.target.id==='drawerBackdrop'){closeDrawer();return}
    let el=e.target.closest('[data-action="add-wp"]');if(el){editWp();return}el=e.target.closest('[data-action="add-subtask"]');if(el){editSubtask();return}el=e.target.closest('[data-action="add-cp"]');if(el){editCp();return}el=e.target.closest('[data-action="add-fsr"]');if(el){editFsr();return}
    el=e.target.closest('[data-edit-wp]');if(el){editWp(el.dataset.editWp);return}el=e.target.closest('[data-edit-subtask]');if(el){editSubtask(el.dataset.editSubtask);return}el=e.target.closest('[data-edit-cp]');if(el){editCp(el.dataset.editCp);return}el=e.target.closest('[data-edit-fsr]');if(el){editFsr(el.dataset.editFsr);return}
    el=e.target.closest('[data-save-exec]');if(el){saveExecution(el.dataset.saveExec,el.dataset.id);return}
    el=e.target.closest('[data-delete-wp]');if(el){deleteWp(el.dataset.deleteWp);return}el=e.target.closest('[data-delete-subtask]');if(el){deleteSubtask(el.dataset.deleteSubtask);return}el=e.target.closest('[data-delete-cp]');if(el){deleteCp(el.dataset.deleteCp);return}el=e.target.closest('[data-delete-fsr]');if(el){deleteFsr(el.dataset.deleteFsr);return}
    el=e.target.closest('[data-open-sub]');if(el){openSubtaskDetail(el.dataset.openSub);return}el=e.target.closest('[data-open-wp]');if(el){openWpDetail(el.dataset.openWp);return}el=e.target.closest('[data-cp-card]');if(el){openCpDetail(el.dataset.cpCard);return}
  });
  $('#showSubs').addEventListener('change',renderGantt);
  $('#btnReload').onclick=load;
  $('#apiBase').value=API.getBase();
  $('#btnSaveSettings').onclick=()=>{API.setBase($('#apiBase').value);toast('API URL 已儲存')};
  $('#btnLogin').onclick=()=>API.login();
  $('#btnLogout').onclick=()=>API.logout();
  $('#btnExportSnapshot').onclick=exportSnapshot;
  load();
})();
