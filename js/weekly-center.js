(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const model = () => window.SmartPortWeeklyReview;
  const stamp = value => value ? new Intl.DateTimeFormat('zh-TW',{timeZone:'Asia/Taipei',dateStyle:'short',timeStyle:'short'}).format(new Date(value)) : '—';
  const badge = row => { const s=model().status(row);return `<span class="weekly-status" data-status="${s.key}">${s.label}</span>`; };
  const safeLink = value => {try {const u=new URL(value);return u.protocol==='https:' && u.hostname==='github.com' ? u.href : '';}catch{return '';}};

  async function mount(parent, { API, me, onChange }) {
    if (!me.can_approve || !API.listWeeklyReports || parent.querySelector('.weekly-center')) return;
    const manual=document.createElement('details');manual.className='weekly-manual-intake';
    const summary=document.createElement('summary');summary.textContent='手動產生／上傳週報與提案紀錄';manual.append(summary);
    while(parent.firstChild)manual.append(parent.firstChild);
    const root=document.createElement('section');root.className='weekly-center';
    root.innerHTML=`<div class="weekly-center-head"><h2>週報管理中心</h2><button class="btn" data-action="refresh">重新整理</button></div>
      <div class="weekly-center-tools"><label>週次<select data-field="batch" aria-label="週報週次"></select></label>
      <label>狀態<select data-field="filter"><option value="all">全部成員</option><option value="missing">尚未繳交</option><option value="pending">待 PM 審核</option><option value="failed">處理失敗</option><option value="returned">退回補件</option><option value="approved">已核准</option></select></label>
      <button class="btn" data-action="resend">補發 Discord</button><label>截止時間（台灣）<input type="datetime-local" data-field="deadline"></label><button class="btn" data-action="extend">展延截止</button>
      <button class="btn" data-action="older">更早週次</button><button class="btn" data-action="copy-link" disabled>複製個人繳交連結</button></div>
      <div class="weekly-center-message" data-field="message" role="status" aria-live="polite"></div><div class="weekly-center-counts" data-field="counts"></div>
      <div class="weekly-center-grid"><div class="weekly-center-roster" data-field="roster"></div><section class="weekly-center-detail" data-field="detail">選擇成員查看週報。</section></div>`;
    parent.append(root,manual);
    const el=name=>root.querySelector(`[data-field="${name}"]`);
    let batches=[],batchId='',memberId='',detail=null,snapshot={},busy=false,sequence=0;
    const active=()=>batches.find(b=>b.id===batchId);
    const jobKey='smartport.weeklyCenterJob';
    const message=(text,error=false)=>{el('message').textContent=text;el('message').classList.toggle('error',error);};
    function controls(){root.querySelectorAll('[data-action]').forEach(b=>{b.disabled=busy||(!active()&&!['refresh','older'].includes(b.dataset.action))||(b.dataset.action==='copy-link'&&!memberId);});}
    function renderRoster(){
      const batch=active();if(!batch){el('roster').innerHTML='';el('counts').textContent='尚無自動週報批次。';el('detail').textContent='每週週報建立後，會列在這裡。';controls();return;}
      const people=(batch.members||[]).map(m=>({member:m,row:model().latest(batch.submissions||[],m.id)}));
      const count=k=>people.filter(p=>model().status(p.row).key===k).length;
      el('counts').innerHTML=`<span>應繳 ${people.length} 人</span><span>未繳 ${count('missing')}</span><span>待審 ${count('pending')}</span><span>失敗 ${count('failed')}</span><span>已核准 ${count('approved')}</span><span>截止 ${esc(stamp(batch.due_at))}</span>`;
      const visible=people.filter(p=>el('filter').value==='all'||model().status(p.row).key===el('filter').value);
      el('roster').innerHTML=visible.map(({member,row})=>`<button type="button" class="weekly-center-person" data-member="${esc(member.id)}" aria-pressed="${member.id===memberId}"><span><b>${esc(member.name)}</b><small>${row?`第 ${row.revision||1} 版 · ${esc(stamp(row.submitted_at))}${row.late?' · 逾期':''}`:'尚無上傳紀錄'}</small></span>${badge(row)}</button>`).join('')||'<p class="muted" style="padding:1rem">沒有符合條件的成員。</p>';
      controls();
    }
    function renderDetail(){
      if(!detail)return;
      const row=detail.submission,analysis=row.analysis_result?.analysis||{},review=analysis.review||{},proposals=row.analysis_result?.proposals||[];
      const expected=model().expected(proposals,snapshot);
      const editable=row.is_current!==false&&row.status==='completed'&&row.review_status==='PENDING';
      const resuming=row.is_current!==false&&row.review_status==='REVIEW_FAILED';
      const decided=new Map((row.review_result?.decisions||[]).map(p=>[Number(p.issue_number),p.status]));
      const priorSelected=new Set(row.review_result?.request?.issue_numbers||[]);
      const link=safeLink(row.report_html_url);
      const memberName=active()?.members?.find(m=>m.id===row.member_id)?.name||row.member_name;
      const versions=(active()?.submissions||[]).filter(s=>s.member_id===row.member_id).sort((a,b)=>b.revision-a.revision);
      const list=(title,items)=>Array.isArray(items)&&items.length?`<div class="weekly-center-feedback"><b>${title}</b><ul>${items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul></div>`:'';
      el('detail').innerHTML=`<div class="weekly-center-head"><h3>${esc(memberName)} · 第 ${row.revision||1} 版</h3>${badge(row)}</div>
        <p class="muted">${esc(detail.week_key)} · ${esc(stamp(row.submitted_at))}${row.is_current===false?' · 歷史版本':''}</p>
        ${link?`<a href="${esc(link)}" target="_blank" rel="noopener">開啟原始 Word 週報</a>`:'<p class="muted">原始週報尚未完成歸檔。</p>'}
        ${row.error?`<p class="weekly-center-message error">${esc(row.error)}</p>`:''}
        ${review.overall_assessment||analysis.report_summary?`<p class="weekly-center-feedback">${esc(review.overall_assessment||analysis.report_summary)}</p>`:''}
        ${Object.keys(review).length?`<div class="weekly-center-scores">${[['completeness_score','完整度'],['evidence_score','證據品質'],['schedule_alignment_score','時程一致性']].map(([k,label])=>`<div><b>${esc(review[k]??'—')}</b>${label}</div>`).join('')}</div>`:''}
        ${list('需要補充',review.missing_items)}${list('建議下一步',review.actions)}
        <h3>進度更新（${proposals.length} 項）</h3>
        ${editable||resuming?'<button class="btn" data-action="select-all">全選可核准項目</button>':''}
        ${proposals.map(p=>{const before=expected[p.issue_number],terminal=decided.get(Number(p.issue_number));return `<article class="weekly-center-change"><label><input type="checkbox" data-proposal="${p.issue_number}" ${resuming&&(terminal==='APPROVED'||(priorSelected.has(Number(p.issue_number))&&before&&terminal!=='REJECTED'))?'checked':''} ${(!editable&&!resuming)||!before||(resuming&&terminal)?'disabled':''}><span><b>${esc(p.target_id)} · ${esc(p.target_type)}</b><br>進度 ${esc(before?.progress??'找不到工作')}% → ${esc(p.progress)}%<br><small>${esc(before?.status||'—')} → ${esc(p.status)}${terminal?` · ${terminal==='APPROVED'?'已核准':'未採用'}`:''}</small></span></label><p>${esc(p.summary||'')}</p><details><summary>查看證據與批改依據</summary><p>${esc(p.evidence||'未提供證據')}</p><p>${esc(p.ai_rationale||'')}</p></details></article>`;}).join('')||'<p class="muted">這份週報沒有進度更新提案，仍可核准報告或退回補件。</p>'}
        <label>PM 回饋<textarea class="weekly-center-notes" data-field="feedback" maxlength="4000" ${!editable?'readonly':''} placeholder="退回時請說明需要補充的內容">${esc(row.pm_feedback||row.review_result?.request?.feedback||'')}</textarea></label>
        <div class="weekly-center-actions">${editable?'<button class="btn primary" data-action="approve">核准勾選項目並結案</button><button class="btn danger" data-action="return">退回補件</button>':''}${resuming?'<button class="btn primary" data-action="resume_review">重試剩餘審核</button>':''}
        ${row.is_current!==false&&!['APPROVED','REVIEWING','REVIEW_FAILED'].includes(row.review_status)&&!['queued','running'].includes(row.status)&&me.can_trigger_codex?'<button class="btn" data-action="retry">重新批改原始週報</button>':''}</div>
        ${editable?'<p class="muted">核准後，勾選項目寫入正式進度；未勾選項目記為未採用。退回補件不寫入進度。</p>':''}
        <div class="weekly-center-history"><b>提交版本</b><div>${versions.map(v=>`<button class="btn" data-version="${v.id}" ${v.id===row.id?'disabled':''}>第 ${v.revision||1} 版 · ${model().status(v).label}</button>`).join('')}</div></div>
        ${detail.runs?.length?`<details class="weekly-center-history"><summary>批改執行紀錄（${detail.runs.length}）</summary>${detail.runs.map(r=>`<p class="muted">${esc(stamp(r.created_at))} · ${esc(r.status)}${r.error?` · ${esc(r.error)}`:''}</p>`).join('')}</details>`:''}`;
      controls();
    }
    async function openReport(id){
      const seq=++sequence;detail=null;el('detail').textContent='正在讀取週報…';
      try {
        const [report,current]=await Promise.all([API.getWeeklyReport(id),API.loadSnapshot()]);
        if(seq!==sequence)return;
        detail=report;snapshot=current;memberId=report.submission.member_id;renderRoster();renderDetail();
      }catch(error){if(seq===sequence)el('detail').textContent=error.message;}
    }
    async function load(older=false){
      const old=older&&batches.length?batches.at(-1).report_date:null;
      const data=await API.listWeeklyReports(old);
      batches=older?[...batches,...data.batches.filter(b=>!batches.some(a=>a.id===b.id))]:data.batches||[];
      if(!active())batchId=batches[0]?.id||'';
      el('batch').innerHTML=batches.map(b=>`<option value="${b.id}">${esc(b.week_key)} · ${esc(b.report_date)}</option>`).join('');el('batch').value=batchId;
      el('deadline').value=model().taipeiInput(active()?.due_at);
      renderRoster();
      if(memberId){const row=model().latest(active()?.submissions||[],memberId);if(row)await openReport(row.id);else {detail=null;el('detail').textContent='這位成員尚未繳交。';}}
    }
    async function watch(jobId){
      busy=true;controls();message('操作已排入佇列；本機 Agent 上線後會處理。');
      try{await API.waitForAnalysisJob(jobId);message('已完成。');}
      catch(error){message(error.message,true);}
      finally{sessionStorage.removeItem(jobKey);busy=false;await load().catch(e=>message(e.message,true));await onChange?.();controls();}
    }
    async function action(name){
      if(busy)return;
      if(name==='refresh'){await load();message('已更新。');return;}
      if(name==='older'){await load(true);return;}
      if(name==='select-all'){el('detail').querySelectorAll('[data-proposal]:not(:disabled)').forEach(b=>b.checked=true);return;}
      const batch=active();if(!batch)return;
      if(name==='copy-link'){
        const member=batch.members?.find(m=>m.id===memberId);if(!member||!batch.token)return;
        const url=model().portalLink(new URL('weekly-submit.html',window.location.href).href,batch.token,member.id);
        try{await navigator.clipboard.writeText(url);message(`已複製 ${member.name} 的繳交連結，開啟時會預選姓名。`);}
        catch{window.prompt(`${member.name} 的繳交連結（會預選姓名）`,url);}
        return;
      }
      let id=batch.id,payload={};
      if(name==='resend'){if(!confirm(`補發 ${batch.week_key} 的全部 Word 附件與原繳交連結到 Discord？`))return;}
      else if(name==='extend'){
        const due=new Date(el('deadline').value+'+08:00');
        if(!Number.isFinite(+due)||+due<=Math.max(Date.now(),+new Date(batch.due_at)))throw new Error('請選擇比原截止時間及現在更晚的日期。');
        payload={due_at:due.toISOString()};if(!confirm(`截止時間展延至 ${stamp(due)}，補交期至少延至七天後？`))return;
      }else{
        if(!detail)return;const row=detail.submission;id=row.id;
        const selected=[...el('detail').querySelectorAll('[data-proposal]:checked')].map(b=>Number(b.dataset.proposal));
        const feedback=el('feedback')?.value.trim()||'';
        payload={analysis_job_id:row.analysis_job_key||row.job_id,issue_numbers:selected,feedback,expected:model().expected(row.analysis_result?.proposals||[],snapshot)};
        if(name==='return'&&!feedback)throw new Error('請先填寫退回補件的原因。');
        const prompts={approve:`核准 ${row.member_name} 第 ${row.revision} 版，採用 ${selected.length} 項進度更新並結案？`,return:'退回這份週報，讓成員依回饋補交？',retry:'以原始 Word 重新批改？原有未核准提案將標記為已取代。',resume_review:'依目前勾選項目重試剩餘審核？已完成的核准會保留。'};
        if(!prompts[name]||!confirm(prompts[name]))return;
      }
      busy=true;controls();
      try{const queued=await API.weeklyReportAction(name,id,payload);sessionStorage.setItem(jobKey,queued.job.id);await watch(queued.job.id);}
      catch(error){busy=false;controls();throw error;}
    }
    root.addEventListener('click',event=>{
      const person=event.target.closest('[data-member]'),version=event.target.closest('[data-version]'),button=event.target.closest('[data-action]');
      if(person){memberId=person.dataset.member;renderRoster();const row=model().latest(active()?.submissions||[],memberId);if(row)openReport(row.id);else{++sequence;detail=null;el('detail').textContent='這位成員尚未繳交。';}}
      else if(version)openReport(version.dataset.version);
      else if(button)action(button.dataset.action).catch(e=>message(e.message,true));
    });
    el('batch').addEventListener('change',()=>{++sequence;batchId=el('batch').value;memberId='';detail=null;el('detail').textContent='選擇成員查看週報。';el('deadline').value=model().taipeiInput(active()?.due_at);renderRoster();});
    el('filter').addEventListener('change',renderRoster);
    try{await load();const pending=sessionStorage.getItem(jobKey);if(pending)watch(pending);}
    catch(error){message(`週報管理尚未就緒：${error.message}`,true);}
  }
  window.SmartPortWeeklyCenter={mount};
})();
