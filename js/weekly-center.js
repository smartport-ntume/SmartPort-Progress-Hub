(() => {
  const esc = value => String(value ?? '').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const hint=(title,text)=>window.SmartPortUI?.hint(title,text)||`<span title="${esc(text)}">${esc(title)}</span>`;
  const combined=item=>[...new Set([...(item.missing_items||[]),...(item.actions||[])])];
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
    root.innerHTML=`<div class="weekly-center-head"><h2>週報管理中心</h2><div class="weekly-center-actions"><button class="btn primary" data-action="publish">發布新一期週報</button><button class="btn" data-action="refresh">重新整理</button></div></div>
      <div class="weekly-center-top"><div class="weekly-center-tools"><label>週次<select data-field="batch" aria-label="週報週次"></select></label>
      <label>狀態<select data-field="filter"><option value="all">全部成員</option><option value="missing">尚未繳交</option><option value="pending">待 PM 審核</option><option value="failed">處理失敗</option><option value="returned">退回補件</option><option value="approved">已核准</option></select></label>
      <button class="btn" data-action="resend">更新回饋並補發</button><label>截止時間（台灣）<input type="datetime-local" data-field="deadline"></label><button class="btn" data-action="extend">展延截止</button>
      <button class="btn" data-action="older">更早週次</button></div><nav class="weekly-center-roster" data-field="roster" aria-label="選擇週報成員"></nav></div>
      <div data-field="publication"></div><div class="weekly-center-message" data-field="message" role="status" aria-live="polite"></div><div class="weekly-center-message" data-field="jobs" role="status" aria-live="polite"></div><div class="weekly-center-counts" data-field="counts"></div><p class="weekly-center-message" data-field="handoff" role="status"></p>
      <div class="weekly-center-grid"><section class="weekly-center-detail" data-field="detail">選擇成員查看週報。</section></div>`;
    parent.append(root,manual);
    const el=name=>root.querySelector(`[data-field="${name}"]`);
    let batches=[],batchId='',memberId='',detail=null,snapshot={},busy=false,sequence=0,loadSequence=0;
    const active=()=>batches.find(b=>b.id===batchId);
    const jobKey='smartport.weeklyCenterJobs';
    const pendingJobs=new Map(),watching=new Set();
    const publication=window.SmartPortWeeklyPublication?.mount(el('publication'),{API,onPublished:()=>load(false,false)});
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
        if(name==='publish'){b.disabled=busy||!publication;return;}
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
      el('handoff').innerHTML=hint(waiting.length ? `下期自動發布：等待 ${waiting.length} 人` : '下期自動發布已就緒', waiting.length
        ? `自動發布會等全員完成 PM 審閱。目前等待：${waiting.map(({member,row})=>`${member.name}（${model().status(row).label}）`).join('、')}。若需提前發送，請按「發布新一期週報」，未繳與待審者也會收到。`
        : '下期週報會帶入各人的 PM 意見。也可以主動發布新一期。');
      el('counts').innerHTML=`<span>應繳 ${people.length} 人</span><span>未繳 ${count('missing')}</span><span>待審 ${count('pending')}</span><span>失敗 ${count('failed')}</span><span>已核准 ${count('approved')}</span><span>截止 ${esc(stamp(batch.due_at))}</span>`;
      const visible=people.filter(p=>el('filter').value==='all'||model().status(p.row).key===el('filter').value);
      el('roster').innerHTML=visible.map(({member,row})=>`<button type="button" class="weekly-center-person" data-member="${esc(member.id)}" aria-pressed="${member.id===memberId}"><span><b>${esc(member.name)}</b><small>${row?`第 ${row.revision||1} 版${row.late?' · 逾期':''}`:'尚無上傳紀錄'}</small></span>${badge(row)}</button>`).join('')||'<p class="muted" style="padding:1rem">沒有符合條件的成員。</p>';
      controls();
    }
    function feedbackEditor(item={target_type:'GENERAL',target_id:'',missing_items:[],actions:[]},editable=true,showTarget=true){
      const title=model().targetTitle(item.target_type,item.target_id,detail.feedback_context,snapshot);
      return `<article class="weekly-center-feedback-editor" data-feedback-type="${esc(item.target_type)}" data-feedback-id="${esc(item.target_id)}">${showTarget?`<div class="weekly-center-feedback-target"><strong>${esc(title)}</strong></div>`:''}
        <label>${hint('工作回饋','這裡的回饋會以「上期工作回饋」帶入下一期 Word。每行一項，可直接修改。')}<textarea data-feedback-text rows="4" ${!editable?'readonly':''} placeholder="直接寫要補什麼、怎麼做或何時完成">${esc(combined(item).join('\n'))}</textarea></label>
        ${editable?'<button class="btn quiet smallbtn" data-action="remove-feedback">移除回饋</button>':''}</article>`;
    }
    function issuesSection(issues,canRetry){
      const states={none:'成員明確填寫「無」',not_filled:'此欄未填寫',not_found:'未找到此欄位，請查看原始 Word 確認'};
      const cards=issues?['cross_task_issues','decision_requests'].map((key,index)=>{
        const item=issues[key]||{},reported=item.status==='reported'&&item.reported_text;
        const metadata=[['相關工作',(item.related_ids||[]).join('、')],['需協助對象',item.requested_from],['期限',item.deadline],['建議選項',item.options]].filter(([,value])=>value);
        return `<article class="weekly-center-issue" data-issue="${key}"><h4>${index?'需要 PM 決策':'跨組依賴／共通風險'}</h4>
          ${reported?`${item.summary?`<p class="muted">AI 整理摘要</p><p>${esc(item.summary)}</p>`:`<p>${esc(item.reported_text)}</p>`}
          ${metadata.length?`<dl>${metadata.map(([label,value])=>`<dt>${label}</dt><dd>${esc(value)}</dd>`).join('')}</dl>`:''}
          <details><summary>查看成員填寫原文</summary><p>${esc(item.reported_text)}</p></details>`:`<p class="muted">${states[item.status]||'尚未擷取此欄位，請重新批改原始週報'}</p>`}</article>`;
      }).join(''):`<p class="muted">這份批改尚未擷取跨任務事項。${canRetry?'更新 Agent 後，可重新批改原始週報；不需重新上傳。':'請開啟原始 Word 週報查看本節內容。'}</p>`;
      return `<section class="weekly-center-issues" aria-label="跨任務問題與決策需求"><h3>${hint('跨任務問題與決策需求','保留成員原文。處理意見請填整體回饋，儲存後會帶入下期 Word。')}</h3>${cards}
        ${issues?.source_text?`<details class="weekly-center-issue-source"><summary>查看本節完整原文</summary><p>${esc(issues.source_text)}</p></details>`:''}</section>`;
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
          if(values.length>100||values.some(s=>s.length>2000))throw new Error('回饋最多 100 項，每項最多 2000 字。');
          return values;
        };
        const values=lines('[data-feedback-text]');
        return {target_type:editor.dataset.feedbackType,target_id:editor.dataset.feedbackId,missing_items:values.slice(0,50),actions:values.slice(50)};
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
      const canRetry=row.is_current!==false&&!['APPROVED','REVIEWING','REVIEW_FAILED'].includes(row.review_status)&&!['queued','running'].includes(row.status)&&me.can_trigger_codex;
      const resuming=row.is_current!==false&&row.review_status==='REVIEW_FAILED';
      const recovering=resuming&&assessmentIssue&&!(row.review_result?.decisions||[]).length;
      const decided=new Map((row.review_result?.decisions||[]).map(p=>[Number(p.issue_number),p.status]));
      const priorSelected=new Set(row.review_result?.request?.issue_numbers||[]);
      const link=safeLink(row.report_html_url);
      const memberName=active()?.members?.find(m=>m.id===row.member_id)?.name||row.member_name;
      const versions=(active()?.submissions||[]).filter(s=>s.member_id===row.member_id).sort((a,b)=>b.revision-a.revision);
      const list=(title,items)=>Array.isArray(items)&&items.length?`<div class="weekly-center-feedback"><b>${title}</b><ul>${items.map(i=>`<li>${esc(i)}</li>`).join('')}</ul></div>`:'';
      const groups=new Map();
      const groupFor=item=>{const key=`${item.target_type}:${item.target_id}`;if(!groups.has(key))groups.set(key,{...item,feedback:[],proposals:[]});return groups.get(key);};
      for(const item of model().taskFeedback(row,detail.feedback_context||snapshot))groupFor(item).feedback.push(item);
      for(const item of review.task_reviews||[])groupFor(item).rubric=item;
      for(const item of proposals)groupFor(item).proposals.push(item);
      const taskCards=[...groups.values()].map(group=>{
        const title=model().targetTitle(group.target_type,group.target_id,detail.feedback_context,snapshot);
        const feedback=group.feedback.length?group.feedback:[{target_type:group.target_type,target_id:group.target_id,missing_items:[],actions:[]}];
        const changes=group.proposals.map(p=>{
          const before=expected[p.issue_number],terminal=decided.get(Number(p.issue_number));
          return `<article class="weekly-center-change"><label class="proposal-choice"><input type="checkbox" data-proposal="${p.issue_number}" ${resuming&&(terminal==='APPROVED'||(priorSelected.has(Number(p.issue_number))&&before&&terminal!=='REJECTED'))?'checked':''} ${assessmentIssue||(!editable&&!resuming)||!before||(resuming&&terminal)?'disabled':''}><span>${terminal?terminal==='APPROVED'?'已核准':'未採用':p.progress==null?'採用工作紀錄':'採用這項更新'}</span></label>
            <p class="proposal-summary">${esc(p.summary||'')}</p><p class="proposal-reported">目前 <b>${esc(before?model().progressLabel(before.progress,'未填'):'找不到工作')}</b>${p.reported_progress!=null?`<span aria-hidden="true"> → </span>成員回報 <b>${esc(p.reported_progress)}%</b>`:p.progress!=null?`<span aria-hidden="true"> → </span>提案 <b>${esc(p.progress)}%</b>`:''}</p>${progressEditor(p,editable,row)}
            ${p.verification_note?`<p class="verification-note">${esc(p.verification_note)}</p>`:''}<details><summary>成果與批改依據</summary><p>${esc(p.evidence||'尚無附件或連結')}</p><p>${esc(p.ai_rationale||'')}</p></details></article>`;
        }).join('');
        const taskHint=group.proposals.map(p=>{const before=expected[p.issue_number];return `目前 ${before?model().progressLabel(before.progress,'未填'):'找不到工作'}，${before?.status||'未更新'}。提案 ${model().progressLabel(p.progress)}，${p.status??'保留目前狀態'}。`;}).join('\n')||'這項目前沒有進度更新提案。';
        return `<section class="weekly-task-review" data-task="${esc(group.target_id)}"><h4>${hint(title,taskHint+'\n核定進度留白會保留目前值。未勾選的項目不採用。')}</h4><div class="weekly-task-columns"><div class="weekly-task-assessment">${window.SmartPortUI?.rubric(group.rubric)||''}${feedback.map(item=>feedbackEditor(item,feedbackEditable,false)).join('')}</div><aside class="weekly-task-approval" aria-label="${esc(title)} 進度審核">${changes||'<p class="muted">這項目前沒有進度更新提案。</p>'}</aside></div></section>`;
      }).join('');
      el('detail').innerHTML=`<div class="weekly-report-heading"><div><div class="eyebrow">${esc(detail.week_key)} / REVIEW</div><h3>${esc(memberName)} <span>第 ${row.revision||1} 版</span></h3></div><div class="weekly-report-links">${badge(row)}${link?`<a class="btn" href="${esc(link)}" target="_blank" rel="noopener">開啟 Word ↗</a>`:''}</div></div>
        <p class="muted report-date">${esc(stamp(row.submitted_at))}${row.is_current===false?' · 歷史版本':''}${!link?' · 原始週報尚未歸檔':''}</p>
        ${row.error?`<p class="weekly-center-message error">${esc(row.error)}</p>`:''}${assessmentIssue?`<p class="weekly-center-message error">${esc(assessmentIssue)}</p>`:''}
        <div class="weekly-report-overview">${feedbackReady&&(review.overall_assessment||analysis.report_summary)?`<p class="weekly-center-feedback">${esc(review.overall_assessment||analysis.report_summary)}</p>`:''}
        ${Object.keys(review).length?`<div class="weekly-center-scores">${[['completeness_score','完整度'],['evidence_score','成果說明'],['schedule_alignment_score','時程']].map(([k,label])=>`<div><b>${esc(review[k]??'—')}</b><span>${label}</span></div>`).join('')}</div>`:''}</div>
        ${feedbackReady?`<div class="weekly-task-toolbar"><h3>${hint('逐項審閱','左側看批改與工作回饋，右側勾選更新及核定進度。核准前可修改百分比；原始自報值會保留。')}</h3><span class="muted">${proposals.length} 項進度更新</span>${(editable||resuming&&!assessmentIssue)&&proposals.length?'<button class="btn" data-action="select-all">全選可核准項目</button>':''}</div><div data-field="task-feedback">${taskCards}</div>${!review.task_reviews?.length?`<p class="legacy-review-note">${hint('關於這份舊批改','既有回饋與提案都保留。若要查看各工項的 80／100 分說明，請重新批改原始週報；已核准版本不會重新評分。')}</p>`:''}${feedbackEditable?'<button class="btn quiet" data-action="add-feedback">＋ 新增工作回饋</button>':''}`:''}
        ${!proposals.length?`<p class="muted">${assessmentIssue?'批改未完成，請重新批改原始週報。':feedbackReady?'沒有進度更新提案，可保留回饋後核准週報。':'正在等待批改結果。'}</p>`:''}
        ${feedbackReady?issuesSection(review.issues_and_decisions,canRetry):''}
        <label class="weekly-overall-feedback">${hint('整體回饋','回覆跨組問題與需要 PM 決定的事項，會帶入下期週報。退回補件時請填原因。')}<textarea class="weekly-center-notes" data-field="feedback" rows="3" maxlength="4000" ${!feedbackEditable?'readonly':''} placeholder="需要做什麼、誰協助、何時完成">${esc(['REVIEWING','REVIEW_FAILED'].includes(row.review_status)?row.review_result?.request?.feedback??row.pm_feedback??'':row.pm_feedback??row.review_result?.request?.feedback??'')}</textarea></label>
        ${feedbackReady&&analysis.warnings?.length?`<details class="weekly-review-warnings"><summary>批改備註（${analysis.warnings.length}）</summary>${list('',analysis.warnings)}</details>`:''}
        <div class="weekly-center-actions weekly-review-actions"><span data-field="selection-count" class="selection-count" aria-live="polite"></span>${feedbackEditable?'<button class="btn" data-action="save-feedback">儲存回饋</button>':''}${editable?`<button class="btn primary" data-action="approve">${proposals.length?'核准勾選項目並結案':'核准週報（不更新進度）'}</button><button class="btn danger" data-action="return">退回補件</button>`:''}${resuming&&(!assessmentIssue||recovering)?`<button class="btn primary" data-action="resume_review">${recovering?'解除失敗審核':'重試剩餘審核'}</button>`:''}${canRetry?'<button class="btn quiet" data-action="retry">重新批改原始週報</button>':''}</div>
        ${recovering?'<p class="muted">這次審核尚未寫入任何進度。解除後可重新批改原始週報。</p>':''}
        <details class="weekly-center-history"><summary>提交版本與批改紀錄</summary><div>${versions.map(v=>`<button class="btn" data-version="${v.id}" ${v.id===row.id?'disabled':''}>第 ${v.revision||1} 版 · ${model().status(v).label}</button>`).join('')}</div>${(detail.runs||[]).map(r=>`<p class="muted">${esc(stamp(r.created_at))} · ${esc(r.status)}${r.error?` · ${esc(r.error)}`:''}</p>`).join('')}</details>`;
      selectionCount();
      controls();
    }
    function selectionCount(){
      const target=el('selection-count');if(!target)return;
      target.textContent=`已勾選 ${el('detail').querySelectorAll('[data-proposal]:checked').length} 項`;
      el('detail').querySelectorAll('.weekly-center-change').forEach(card=>card.classList.toggle('selected',!!card.querySelector('[data-proposal]')?.checked));
    }
    root.addEventListener('change',event=>{if(event.target.matches('[data-proposal]'))selectionCount();});
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
      if(name==='publish'){publication?.open({batches});return;}
      if(name==='resend'){if(active())publication?.open({batch:active()});return;}
      if(name==='add-feedback'){el('task-feedback').insertAdjacentHTML('beforeend',feedbackEditor());return;}
      if(name==='select-all'){el('detail').querySelectorAll('[data-proposal]:not(:disabled)').forEach(b=>b.checked=true);selectionCount();return;}
      const batch=active();if(!batch)return;
      let id=batch.id,payload={};
      const target=['resend','extend'].includes(name)?batch.id:detail?.submission.id;
      if(pendingFor(target))return;
      if(name==='extend'){
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
          busy=true;controls();
          try{
            const saved=await API.saveWeeklyFeedback(id,payload);
            if(detail?.submission.id===id){
              // Keep the PM's live selections, progress overrides and newer typing.
              Object.assign(detail.submission,saved);
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
