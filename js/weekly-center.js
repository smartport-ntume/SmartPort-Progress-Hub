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
      <button class="btn" data-action="older">更早週次</button></div>
      <div class="weekly-center-message" data-field="message" role="status" aria-live="polite"></div><div class="weekly-center-message" data-field="jobs" role="status" aria-live="polite"></div><div class="weekly-center-counts" data-field="counts"></div><p class="weekly-center-message" data-field="handoff" role="status"></p>
      <div class="weekly-center-grid"><div class="weekly-center-roster" data-field="roster"></div><section class="weekly-center-detail" data-field="detail">選擇成員查看週報。</section></div>`;
    parent.append(root,manual);
    const el=name=>root.querySelector(`[data-field="${name}"]`);
    let batches=[],batchId='',memberId='',detail=null,snapshot={},busy=false,sequence=0,loadSequence=0;
    const active=()=>batches.find(b=>b.id===batchId);
    const jobKey='smartport.weeklyCenterJobs';
    const pendingJobs=new Map(),watching=new Set();
    const pendingFor=id=>[...pendingJobs.values()].some(job=>job.targetId===id);
    function saveJobs(){
      try{sessionStorage.setItem(jobKey,JSON.stringify([...pendingJobs.entries()]));}catch(_){/* The queue also remains in Supabase. */}
    }
    const message=(text,error=false)=>{el('message').textContent=text;el('message').classList.toggle('error',error);};
    function controls(){
      el('jobs').textContent=pendingJobs.size?`有 ${pendingJobs.size} 項操作等待完成，可繼續查看或處理其他成員。`:'';
      root.querySelectorAll('[data-action]').forEach(b=>{
        const name=b.dataset.action;
        if(['refresh','older'].includes(name)){b.disabled=busy;return;}
        const target=['resend','extend'].includes(name)?batchId:detail?.submission.id;
        b.disabled=busy||!active()||pendingFor(target);
      });
    }
    function renderRoster(){
      const batch=active();if(!batch){el('roster').innerHTML='';el('counts').textContent='尚無自動週報批次。';el('detail').textContent='每週週報建立後，會列在這裡。';controls();return;}
      const people=(batch.members||[]).map(m=>({member:m,row:model().latest(batch.submissions||[],m.id)}));
      const count=k=>people.filter(p=>model().status(p.row).key===k).length;
      const waiting=people.filter(({member,row})=>member.active!==false&&member.weekly_report_required!==false
        && !(row?.status==='completed'&&['APPROVED','CHANGES_REQUESTED'].includes(row.review_status)&&row.is_current!==false));
      el('handoff').textContent=waiting.length
        ? `下期週報等待本期全員完成 PM 審閱：${waiting.map(({member,row})=>`${member.name}（${model().status(row).label}）`).join('、')}。審閱完成後才會依排程發送並帶入個人回饋。`
        : '本期全員已完成 PM 審閱；下期週報發送時會帶入各人的 PM 意見。';
      el('counts').innerHTML=`<span>應繳 ${people.length} 人</span><span>未繳 ${count('missing')}</span><span>待審 ${count('pending')}</span><span>失敗 ${count('failed')}</span><span>已核准 ${count('approved')}</span><span>截止 ${esc(stamp(batch.due_at))}</span>`;
      const visible=people.filter(p=>el('filter').value==='all'||model().status(p.row).key===el('filter').value);
      el('roster').innerHTML=visible.map(({member,row})=>`<button type="button" class="weekly-center-person" data-member="${esc(member.id)}" aria-pressed="${member.id===memberId}"><span><b>${esc(member.name)}</b><small>${row?`第 ${row.revision||1} 版 · ${esc(stamp(row.submitted_at))}${row.late?' · 逾期':''}`:'尚無上傳紀錄'}</small></span>${badge(row)}</button>`).join('')||'<p class="muted" style="padding:1rem">沒有符合條件的成員。</p>';
      controls();
    }
    function feedbackEditor(item={target_type:'GENERAL',target_id:'',missing_items:[],actions:[]},editable=true){
      const targets=model().feedbackTargets(detail.feedback_context||snapshot,detail.submission.member_id);
      const target=targets.find(t=>t.type===item.target_type&&t.id===item.target_id);
      const title=item.target_type==='GENERAL'?'整份週報共通事項':[target?.parentWp,item.target_id,target?.name!==item.target_id?target?.name:''].filter(Boolean).join(' · ');
      return `<article class="weekly-center-feedback-editor" data-feedback-type="${esc(item.target_type)}" data-feedback-id="${esc(item.target_id)}"><div class="weekly-center-feedback-target"><span>自動對應工作</span><strong>${esc(title)}</strong></div>
        <label>需要補充<textarea data-feedback-missing rows="8" ${!editable?'readonly':''}>${esc((item.missing_items||[]).join('\n'))}</textarea></label>
        <label>建議下一步<textarea data-feedback-actions rows="8" ${!editable?'readonly':''}>${esc((item.actions||[]).join('\n'))}</textarea></label>
        ${editable?'<button class="btn" data-action="remove-feedback">移除此項回饋</button>':''}</article>`;
    }
    function progressEditor(p,editable,row){
      const overrides=row.review_result?.request?.progress_overrides||{};
      const value=Object.hasOwn(overrides,String(p.issue_number))?overrides[p.issue_number]:(p.progress??p.reported_progress);
      return `<label class="weekly-center-progress">PM 核定進度（%）<input type="number" min="0" max="100" step="any" data-progress="${p.issue_number}" aria-label="${esc(p.target_id)} PM 核定進度" value="${value==null?'':esc(value)}" ${!editable?'readonly':''} placeholder="留白保留目前進度"></label>`;
    }
    function readTaskFeedback(){
      const items=[...el('detail').querySelectorAll('.weekly-center-feedback-editor')].map(editor=>{
        const lines=selector=>{
          const values=editor.querySelector(selector).value.split('\n').map(s=>s.trim()).filter(Boolean);
          if(values.length>50||values.some(s=>s.length>2000))throw new Error('每欄最多 50 項，每項最多 2000 字。');
          return values;
        };
        return {target_type:editor.dataset.feedbackType,target_id:editor.dataset.feedbackId,missing_items:lines('[data-feedback-missing]'),actions:lines('[data-feedback-actions]')};
      });
      return window.SmartPortWeeklyFeedback.assign(items,detail.feedback_context||snapshot,detail.submission.member_id);
    }
    function renderDetail(){
      if(!detail)return;
      const row=detail.submission,analysis=row.analysis_result?.analysis||{},proposals=row.analysis_result?.proposals||[];
      const assessmentIssue=row.status==='completed'?model().assessmentIssue(analysis):'';
      const feedbackReady=row.status==='completed'&&!assessmentIssue;
      const review=feedbackReady?analysis.review||{}:{};
      const expected=model().expected(proposals,snapshot);
      const editable=row.is_current!==false&&feedbackReady&&row.review_status==='PENDING';
      const feedbackEditable=row.is_current!==false&&feedbackReady&&['PENDING','APPROVED','CHANGES_REQUESTED'].includes(row.review_status);
      const resuming=row.is_current!==false&&row.review_status==='REVIEW_FAILED';
      const recovering=resuming&&assessmentIssue&&!(row.review_result?.decisions||[]).length;
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
        ${assessmentIssue?`<p class="weekly-center-message error">${esc(assessmentIssue)}</p>`:''}
        ${feedbackReady&&(review.overall_assessment||analysis.report_summary)?`<p class="weekly-center-feedback">${esc(review.overall_assessment||analysis.report_summary)}</p>`:''}
        ${Object.keys(review).length?`<div class="weekly-center-scores">${[['completeness_score','完整度'],['evidence_score','證據品質'],['schedule_alignment_score','時程一致性']].map(([k,label])=>`<div><b>${esc(review[k]??'—')}</b>${label}</div>`).join('')}</div>`:''}
        ${feedbackReady?`<h3>工作回饋（可編輯，將帶入下期 Word）</h3><p class="muted">已依工作內容自動歸入 WP／子任務，不需手動指定。直接編輯回饋即可；共通事項放在 Word 前段。</p><div data-field="task-feedback">${model().taskFeedback(row,detail.feedback_context||snapshot).map(item=>feedbackEditor(item,feedbackEditable)).join('')}</div>${feedbackEditable?'<button class="btn" data-action="add-feedback">新增工作回饋</button>':''}`:''}${feedbackReady?list('批改注意事項',analysis.warnings):''}
        <h3>進度更新（${proposals.length} 項）</h3>
        ${(editable||resuming&&!assessmentIssue)&&proposals.length?'<button class="btn" data-action="select-all">全選可核准項目</button>':''}
        ${proposals.map(p=>{const before=expected[p.issue_number],terminal=decided.get(Number(p.issue_number));return `<article class="weekly-center-change"><label><input type="checkbox" data-proposal="${p.issue_number}" ${resuming&&(terminal==='APPROVED'||(priorSelected.has(Number(p.issue_number))&&before&&terminal!=='REJECTED'))?'checked':''} ${assessmentIssue||(!editable&&!resuming)||!before||(resuming&&terminal)?'disabled':''}><span><b>${esc(p.target_id)} · ${esc(p.target_type)}</b><br>${p.progress==null?'工作紀錄更新（百分比不變）<br>':''}進度 ${esc(before?model().progressLabel(before.progress,'未填'):'找不到工作')} → ${esc(model().progressLabel(p.progress))}<br><small>${esc(before?.status||'—')} → ${esc(p.status??'保留目前狀態')}${terminal?` · ${terminal==='APPROVED'?'已核准':'未採用'}`:''}</small></span></label><p>${esc(p.summary||'')}</p>${p.reported_progress!=null?`<p>成員自報完成度：${esc(p.reported_progress)}%（待 PM 確認）</p>`:''}${progressEditor(p,editable,row)}${p.verification_note?`<p class="weekly-center-feedback"><b>待確認事項：</b>${esc(p.verification_note)}</p>`:''}<details><summary>查看證據與批改依據</summary><p>${esc(p.evidence||'未提供證據')}</p><p>${esc(p.ai_rationale||'')}</p></details></article>`;}).join('')||`<p class="muted">${assessmentIssue?'批改未完成，尚未產生可勾選的進度更新。請重新批改原始週報。':feedbackReady?'批改已完成，但沒有可採用的進度更新。請查看上方缺漏與批改注意事項；可核准週報或退回補件，正式進度不會變更。':'批改完成後，有證據支持的進度更新才會顯示在這裡。'}</p>`}
        <label>PM 回饋（將帶入下期週報）<textarea class="weekly-center-notes" data-field="feedback" rows="8" maxlength="4000" ${!feedbackEditable?'readonly':''} placeholder="填寫下期需追蹤的事項；退回時請說明需要補充的內容">${esc(['REVIEWING','REVIEW_FAILED'].includes(row.review_status)?row.review_result?.request?.feedback??row.pm_feedback??'':row.pm_feedback??row.review_result?.request?.feedback??'')}</textarea></label>
        <div class="weekly-center-actions">${feedbackEditable?'<button class="btn" data-action="save-feedback">儲存回饋</button>':''}${editable?`<button class="btn primary" data-action="approve">${proposals.length?'核准勾選項目並結案':'核准週報（不更新進度）'}</button><button class="btn danger" data-action="return">退回補件</button>`:''}${resuming&&(!assessmentIssue||recovering)?`<button class="btn primary" data-action="resume_review">${recovering?'解除失敗審核':'重試剩餘審核'}</button>`:''}
        ${row.is_current!==false&&!['APPROVED','REVIEWING','REVIEW_FAILED'].includes(row.review_status)&&!['queued','running'].includes(row.status)&&me.can_trigger_codex?'<button class="btn" data-action="retry">重新批改原始週報</button>':''}</div>
        ${editable?'<p class="muted">核准前可修改每項核定進度（0～100%），留白表示保留目前進度。原始自報值會保留；未勾選項目記為未採用。</p>':''}
        ${recovering?'<p class="muted">這次審核尚未寫入任何進度。解除後可重新批改原始週報。</p>':''}
        <div class="weekly-center-history"><b>提交版本</b><div>${versions.map(v=>`<button class="btn" data-version="${v.id}" ${v.id===row.id?'disabled':''}>第 ${v.revision||1} 版 · ${model().status(v).label}</button>`).join('')}</div></div>
        ${detail.runs?.length?`<details class="weekly-center-history"><summary>批改執行紀錄（${detail.runs.length}）</summary>${detail.runs.map(r=>`<p class="muted">${esc(stamp(r.created_at))} · ${esc(r.status)}${r.error?` · ${esc(r.error)}`:''}</p>`).join('')}</details>`:''}`;
      controls();
    }
    async function openReport(id){
      const seq=++sequence;detail=null;el('detail').textContent='正在讀取週報…';
      try {
        const [report,current]=await Promise.all([API.getWeeklyReport(id),API.loadSnapshot()]);
        if(seq!==sequence)return;
        detail=report;snapshot=current;memberId=report.submission.member_id;
        const listed=active()?.submissions?.find(row=>row.id===report.submission.id);
        if(listed)Object.assign(listed,report.submission);
        renderRoster();renderDetail();
      }catch(error){if(seq===sequence)el('detail').textContent=error.message;}
    }
    async function load(older=false,refreshDetail=true){
      const seq=++loadSequence;
      const old=older&&batches.length?batches.at(-1).report_date:null;
      const data=await API.listWeeklyReports(old);
      if(seq!==loadSequence)return;
      // Preserve already inspected assessments while the same analysis is current.
      for(const batch of data.batches||[])for(const row of batch.submissions||[]){
        const previous=batches.find(b=>b.id===batch.id)?.submissions?.find(s=>s.id===row.id);
        if(previous&&previous.status===row.status&&(previous.analysis_job_key||previous.job_id)===(row.analysis_job_key||row.job_id))row.analysis_result=previous.analysis_result;
      }
      batches=older?[...batches,...data.batches.filter(b=>!batches.some(a=>a.id===b.id))]:data.batches||[];
      if(!active())batchId=batches[0]?.id||'';
      el('batch').innerHTML=batches.map(b=>`<option value="${b.id}">${esc(b.week_key)} · ${esc(b.report_date)}</option>`).join('');el('batch').value=batchId;
      el('deadline').value=model().taipeiInput(active()?.due_at);
      renderRoster();
      if(memberId&&refreshDetail){const row=model().latest(active()?.submissions||[],memberId);if(row)await openReport(row.id);else {detail=null;el('detail').textContent='這位成員尚未繳交。';}}
    }
    async function watch(jobId){
      if(watching.has(jobId))return;
      watching.add(jobId);
      const pending=pendingJobs.get(jobId)||{};
      try{await API.waitForAnalysisJob(jobId);message(`${pending.label||'操作'}已完成。`);}
      catch(error){
        let released=false;
        if(pending.action==='resume_review'){
          try{const report=await API.getWeeklyReport(pending.targetId);released=report.submission.status==='failed'&&report.submission.review_status==='PENDING'&&!report.submission.review_job_id;}catch(_){}
        }
        message(released?`${pending.label} 的失敗審核已解除，現在可以重新批改原始週報。`:`${pending.label||'操作'}：${error.message}`,!released);
      }
      finally{
        watching.delete(jobId);pendingJobs.delete(jobId);saveJobs();controls();
        // Completing another member's job must not erase the PM's current selection or notes.
        await load(false,!detail||detail.submission.id===pending.targetId).catch(e=>message(e.message,true));
        try{await onChange?.();}catch(error){message(error.message,true);}
      }
    }
    async function action(name){
      if(busy)return;
      if(name==='refresh'){await load();message('已更新。');return;}
      if(name==='older'){await load(true);return;}
      if(name==='add-feedback'){el('task-feedback').insertAdjacentHTML('beforeend',feedbackEditor());return;}
      if(name==='select-all'){el('detail').querySelectorAll('[data-proposal]:not(:disabled)').forEach(b=>b.checked=true);return;}
      const batch=active();if(!batch)return;
      let id=batch.id,payload={};
      const target=['resend','extend'].includes(name)?batch.id:detail?.submission.id;
      if(pendingFor(target))return;
      if(name==='resend'){if(!confirm(`補發 ${batch.week_key} 的全部 Word 附件與原繳交連結到 Discord？`))return;}
      else if(name==='extend'){
        const due=new Date(el('deadline').value+'+08:00');
        if(!Number.isFinite(+due)||+due<=Math.max(Date.now(),+new Date(batch.due_at)))throw new Error('請選擇比原截止時間及現在更晚的日期。');
        payload={due_at:due.toISOString()};if(!confirm(`截止時間展延至 ${stamp(due)}？截止後仍可直接補交並標記逾期。`))return;
      }else{
        if(!detail)return;const row=detail.submission;id=row.id;
        if(['approve','return','resume_review'].includes(name)){
          const issue=model().assessmentIssue(row.analysis_result?.analysis);
          const canRelease=name==='resume_review'&&row.review_status==='REVIEW_FAILED'&&!(row.review_result?.decisions||[]).length;
          if(issue&&!canRelease)throw new Error(issue);
        }
        const selected=[...el('detail').querySelectorAll('[data-proposal]:checked')].map(b=>Number(b.dataset.proposal));
        const feedback=el('feedback')?.value.trim()||'';
        payload={analysis_job_id:row.analysis_job_key||row.job_id,issue_numbers:selected,feedback,feedback_version:row.feedback_version||0,
          task_feedback:readTaskFeedback(),expected:model().expected(row.analysis_result?.proposals||[],snapshot)};
        if(name==='approve'){
          payload.progress_overrides={};
          for(const input of el('detail').querySelectorAll('[data-progress]')){
            if(!selected.includes(Number(input.dataset.progress)))continue;
            const text=input.value.trim(),value=text===''?null:Number(text);
            if(input.validity.badInput||value!==null&&(!Number.isFinite(value)||value<0||value>100))throw new Error('PM 核定進度必須介於 0～100%。');
            payload.progress_overrides[input.dataset.progress]=value;
          }
        }
        if(name==='save-feedback'){
          if(!API.saveWeeklyFeedback)throw new Error('請更新網站並執行新版 SQL。');
          const savedDraft=JSON.stringify(payload.task_feedback);
          busy=true;controls();
          try{
            const saved=await API.saveWeeklyFeedback(id,payload);
            if(detail?.submission.id===id){
              const unchanged=JSON.stringify(readTaskFeedback())===savedDraft;
              Object.assign(detail.submission,saved);
              if(unchanged)el('task-feedback').innerHTML=model().taskFeedback(detail.submission,detail.feedback_context||snapshot).map(item=>feedbackEditor(item)).join('');
            }
            message('回饋已儲存；尚未發出的下期 Word 將帶入更新後的內容。');
          }finally{busy=false;controls();}
          return;
        }
        if(name==='return'&&!feedback)throw new Error('請先填寫退回補件的原因。');
        const prompts={approve:`核准 ${row.member_name} 第 ${row.revision} 版，採用 ${selected.length} 項進度更新並結案？`,return:'退回這份週報，讓成員依回饋補交？',retry:'以原始 Word 重新批改？原有未核准提案將標記為已取代。',resume_review:'依目前勾選項目重試剩餘審核？已完成的核准會保留。'};
        if(name==='resume_review'&&model().assessmentIssue(row.analysis_result?.analysis))prompts.resume_review='解除尚未寫入進度的失敗審核，讓這份週報可以重新批改？';
        if(!prompts[name]||!confirm(prompts[name]))return;
      }
      const label=['resend','extend'].includes(name)?batch.week_key:(batch.members||[]).find(m=>m.id===detail?.submission.member_id)?.name||'週報';
      busy=true;controls();
      try{
        const queued=await API.weeklyReportAction(name,id,payload);
        pendingJobs.set(queued.job.id,{targetId:id,label,action:name});saveJobs();
        message(`${label} 已排入佇列；本機 Agent 上線後會處理。可繼續處理其他成員。`);
        // Release the page immediately after enqueueing; only this target stays locked.
        busy=false;controls();
        void watch(queued.job.id);
        await load(false,detail?.submission.id===id);
      }finally{busy=false;controls();}
    }
    root.addEventListener('click',event=>{
      const person=event.target.closest('[data-member]'),version=event.target.closest('[data-version]'),button=event.target.closest('[data-action]');
      if(person){memberId=person.dataset.member;renderRoster();const row=model().latest(active()?.submissions||[],memberId);if(row)openReport(row.id);else{++sequence;detail=null;el('detail').textContent='這位成員尚未繳交。';}}
      else if(version)openReport(version.dataset.version);
      else if(button?.dataset.action==='remove-feedback')button.closest('.weekly-center-feedback-editor').remove();
      else if(button)action(button.dataset.action).catch(e=>message(e.message,true));
    });
    el('batch').addEventListener('change',()=>{++sequence;batchId=el('batch').value;memberId='';detail=null;el('detail').textContent='選擇成員查看週報。';el('deadline').value=model().taipeiInput(active()?.due_at);renderRoster();});
    el('filter').addEventListener('change',renderRoster);
    try{
      try{
        const saved=JSON.parse(sessionStorage.getItem(jobKey)||'[]');
        if(Array.isArray(saved))for(const item of saved)if(Array.isArray(item)&&typeof item[0]==='string'&&item[1]&&typeof item[1]==='object')pendingJobs.set(item[0],item[1]);
        const legacy=sessionStorage.getItem('smartport.weeklyCenterJob');
        if(legacy)pendingJobs.set(legacy,{label:'週報'});
        sessionStorage.removeItem('smartport.weeklyCenterJob');saveJobs();
      }catch(_){/* A malformed/blocked session cache must not disable the PM center. */}
      await load();for(const jobId of pendingJobs.keys())void watch(jobId);
    }
    catch(error){message(`週報管理尚未就緒：${error.message}`,true);}
  }
  window.SmartPortWeeklyCenter={mount};
})();
