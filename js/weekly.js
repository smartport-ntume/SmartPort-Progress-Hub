(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  const $ = s => document.querySelector(s);
  const esc = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const localIsoDate = (date=new Date()) => new Date(date.getTime()-date.getTimezoneOffset()*60000).toISOString().slice(0,10);

  let proposals = [];
  let me = null;
  let selectedFile = null;
  let selectedFileMemberId = '';
  let latestAnalysis = null;
  let canTriggerCodex = false;
  const ACTIVE_JOB_KEY='smartport.weeklyAnalysisJob';
  const ACTIVE_REPORT_KEY='smartport.weeklyAnalysisReport';

  function memberCategoryLabel(memberId){
    const categories=window.SmartPortTeam?.memberCategories(Store.state.teamConfig,memberId)||[];
    return categories.length?categories.map(item=>item.name).join('、'):'尚未負責分類';
  }

  function renderReportOptions(){
    const categories=window.SmartPortTeam?.activeCategories(Store.state.teamConfig)||[];
    const manual=$('#weeklyManualOwner');
    if(manual){
      const selected=manual.value;
      manual.innerHTML=categories.map(item=>`<option value="${esc(item.id)}">${esc(item.name)} (${esc(item.id)})</option>`).join('');
      if(categories.some(item=>item.id===selected))manual.value=selected;
    }
    const members=(Store.state.teamConfig?.members||[]).filter(item=>item.active!==false&&item.weekly_report_required!==false);
    const select=$('#weeklyMember');
    if(select){
      const selected=select.value;
      select.innerHTML=`<option value="">選擇成員</option>${members.map(item=>`<option value="${esc(item.id)}">${esc(item.name)} · ${esc(memberCategoryLabel(item.id))}</option>`).join('')}`;
      if(members.some(item=>item.id===selected))select.value=selected;
      else if(members.length===1)select.value=members[0].id;
    }
    renderReportScope();
  }

  function toast(msg){
    const el=$('#toast');
    if(!el) return;
    el.textContent=msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t=setTimeout(()=>el.classList.remove('show'),4200);
  }

  function installLayout(){
    const root=$('#reports');
    if(!root) return;
    root.innerHTML=`
      <div class="weekly-intake-grid">
        <div class="panel weekly-upload-panel">
          <div class="panel-title"><span>個人週報產生與回收</span><span class="revision-badge">Gantt → Word → Local Codex</span></div>
          <form id="weeklyReportUploadForm" class="weekly-upload-body">
            <div class="alert info"><b>先選人，系統會依其負責分類產生本週 Word。</b><br>內容只含逾期未完成，以及下一個 CP 檢核前應完成的 Subtask；填寫完成後再回到此處上傳。</div>
            <div class="weekly-meta-grid">
              <div class="field"><label>Report Date</label><input id="weeklyDate" name="report_date" type="date" required></div>
              <div class="field"><label>Report Member</label><select id="weeklyMember" name="member_id" required></select></div>
            </div>
            <div id="weeklyScopePreview" class="weekly-scope-preview muted">請選擇成員。</div>
            <div class="weekly-template-actions">
              <button id="weeklyDownloadBtn" class="btn primary" type="button" disabled>下載此人的 Word 週報</button>
              <span class="muted">Word 內會自動帶入工作 ID、計畫期間、目前進度與預期成果。</span>
            </div>
            <div class="weekly-step-divider"><span>填寫完成後上傳</span></div>
            <label id="weeklyDropZone" class="weekly-dropzone" for="weeklyReportFile">
              <input id="weeklyReportFile" type="file" accept=".doc,.docx,application/msword,application/vnd.openxmlformats-officedocument.wordprocessingml.document" hidden>
              <div class="weekly-drop-icon">DOC</div>
              <div><b>選擇或拖曳填好的 Word 週報</b><div class="muted">必須與上方成員一致 · 支援 .doc / .docx · 單檔上限 10 MB</div></div>
            </label>
            <div id="weeklySelectedFile" class="weekly-selected-file muted">尚未選擇檔案</div>
            <div class="weekly-upload-actions">
              <button id="weeklyAnalyzeBtn" class="btn primary" type="submit" disabled>上傳並批改</button>
              <span class="muted">Local Codex 會檢查完整度、證據與甘特圖一致性，再建立 Proposed Updates。</span>
            </div>
          </form>
        </div>

        <div class="panel weekly-ai-panel">
          <div class="panel-title"><span>AI Processing Result</span><span id="weeklyAiBadge" class="revision-badge">Waiting</span></div>
          <div id="weeklyAiResult" class="weekly-ai-result">
            <div class="weekly-empty-state"><b>尚未解析週報</b><span>上傳後會顯示 GitHub 儲存位置、AI 摘要與產生的 WP / Subtask Proposed Updates。</span></div>
          </div>
        </div>
      </div>

      <div class="panel weekly-status-panel">
        <div class="panel-title">Proposal Status</div>
        <div id="weeklyStatusSummary" style="padding:14px" class="muted">載入中...</div>
      </div>

      <details class="panel weekly-manual-panel">
        <summary>Manual Proposal · fallback</summary>
        <form id="weeklyProposalForm" style="padding:14px">
          <div class="weekly-manual-grid">
            <div class="field"><label>Report Date</label><input id="weeklyManualDate" name="report_date" type="date" required></div>
            <div class="field"><label>Owner Team</label><select id="weeklyManualOwner" name="owner_team" required></select></div>
            <div class="field"><label>Target Type</label><select id="weeklyTargetType" name="target_type" required><option value="WP">WP</option><option value="SUBTASK">Subtask</option></select></div>
            <div class="field"><label>Target</label><select id="weeklyTargetId" name="target_id" required></select></div>
            <div class="field"><label>Proposed Progress (%)</label><input name="progress" type="number" min="0" max="100" step="1" required></div>
            <div class="field"><label>Status</label><select name="status" required><option value="On Track">On Track</option><option value="At Risk">At Risk</option><option value="Blocked">Blocked</option><option value="Delayed">Delayed</option><option value="Completed">Completed</option></select></div>
          </div>
          <div class="field"><label>Blocker</label><textarea name="blocker" rows="2"></textarea></div>
          <div class="field"><label>Evidence / Link</label><textarea name="evidence" rows="2"></textarea></div>
          <div class="field"><label>Weekly Summary</label><textarea name="summary" rows="3" required></textarea></div>
          <button id="weeklySubmitBtn" class="btn" type="submit">送 PM Review</button>
        </form>
      </details>

      <div class="panel weekly-archive-panel">
        <div class="panel-title">Proposal Archive｜Submitted → PM Review → Approved / Rejected</div>
        <div style="overflow:auto;max-height:520px"><table id="proposalArchiveTable"><thead><tr><th>Date</th><th>Report Member</th><th>Team</th><th>Target</th><th>Progress</th><th>Status</th><th>Source</th><th>Review</th><th>GitHub</th></tr></thead><tbody><tr><td colspan="9" class="muted">載入中...</td></tr></tbody></table></div>
      </div>`;

    const style=document.createElement('style');
    style.id='weeklyAiLayoutStyle';
    style.textContent=`
      .weekly-intake-grid{display:grid;grid-template-columns:minmax(560px,1.12fr) minmax(420px,.88fr);gap:14px}.weekly-upload-body{padding:14px 16px}.weekly-meta-grid,.weekly-manual-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:0 12px}.weekly-scope-preview{border:1px solid #dfe4ec;border-radius:10px;background:#f8fafc;padding:11px 12px;margin:4px 0 10px}.weekly-scope-summary{display:flex;gap:7px;flex-wrap:wrap;align-items:center;margin-bottom:8px}.weekly-scope-chip{border-radius:999px;background:#eef1f5;padding:3px 7px;font-size:11px}.weekly-scope-chip.overdue{background:#fdecec;color:#9b1c1c}.weekly-scope-chip.active{background:#eaf2ff;color:#315f91}.weekly-scope-chip.upcoming{background:#fff3d9;color:#805800}.weekly-scope-list{display:grid;gap:5px;max-height:150px;overflow:auto}.weekly-scope-row{display:flex;justify-content:space-between;gap:12px;border-top:1px solid #e9edf2;padding-top:5px}.weekly-template-actions,.weekly-upload-actions{display:flex;align-items:center;gap:12px;margin:10px 0;flex-wrap:wrap}.weekly-step-divider{display:flex;align-items:center;gap:10px;color:#98a2b3;font-size:11px;margin:14px 0}.weekly-step-divider:before,.weekly-step-divider:after{content:"";height:1px;background:#e3e8ef;flex:1}.weekly-dropzone{min-height:130px;border:2px dashed #c7d1df;border-radius:12px;background:#f9fbfd;display:flex;align-items:center;justify-content:center;gap:16px;padding:20px;cursor:pointer;text-align:left;transition:.15s}.weekly-dropzone:hover,.weekly-dropzone.dragover{border-color:#5277bb;background:#f2f6fc}.weekly-drop-icon{width:54px;height:54px;border-radius:12px;background:#e9f0fa;color:#315d91;display:flex;align-items:center;justify-content:center;font-size:12px;font-weight:800}.weekly-selected-file{padding:10px 2px 2px}.weekly-ai-result{padding:16px;min-height:286px}.weekly-empty-state{min-height:235px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;color:#667085;gap:6px}.weekly-empty-state b{color:#344054}.weekly-ai-summary{background:#f8fafc;border:1px solid #e3e8ef;border-radius:10px;padding:11px 12px;line-height:1.55;margin-bottom:12px}.weekly-score-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin:10px 0}.weekly-score{border:1px solid #e2e7ee;border-radius:9px;padding:8px;text-align:center}.weekly-score b{display:block;font-size:20px;color:#1f3b63}.weekly-review-list{margin:8px 0 12px;padding-left:20px;font-size:12px;color:#475467}.weekly-ai-proposal{border:1px solid #e2e7ee;border-radius:10px;padding:10px 12px;margin:8px 0}.weekly-ai-proposal-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.weekly-ai-proposal-id{font-weight:700}.weekly-ai-proposal-meta{font-size:11px;color:#667085;margin-top:4px}.weekly-report-link{display:inline-flex;margin-bottom:10px}.weekly-status-panel,.weekly-manual-panel,.weekly-archive-panel{margin-top:14px}.weekly-manual-panel>summary{padding:12px 16px;cursor:pointer;font-weight:650;border-bottom:1px solid transparent}.weekly-manual-panel[open]>summary{border-bottom-color:#dfe4ec}.weekly-status-panel .cards{grid-template-columns:repeat(3,1fr);margin:0}.ai-confidence{font-size:10px;padding:2px 6px;border-radius:999px;background:#eef1f5;color:#667085}@media(max-width:1100px){.weekly-intake-grid{grid-template-columns:1fr}.weekly-meta-grid,.weekly-manual-grid{grid-template-columns:1fr}}
    `;
    document.head.appendChild(style);
  }

  function selectedReportModel(){
    return window.SmartPortWeeklyReport.build({
      teamConfig:Store.state.teamConfig,
      workPackages:Store.state.workPackages,
      subtasks:Store.state.subtasks,
      checkpoints:Store.state.checkpoints,
      memberId:$('#weeklyMember')?.value||'',
      reportDate:$('#weeklyDate')?.value||''
    });
  }

  function renderReportScope(){
    const root=$('#weeklyScopePreview'),download=$('#weeklyDownloadBtn');
    if(!root||!download)return;
    try{
      const model=selectedReportModel();
      const checkpoint=model.nextCheckpoint
        ? `<span class="weekly-scope-chip">${esc(model.nextCheckpoint.id)} 檢核 · ${esc(model.nextCheckpoint.dateDisplay)}</span>`
        : '<span class="weekly-scope-chip">尚無後續 CP，僅列逾期</span>';
      root.className='weekly-scope-preview';
      root.innerHTML=`<div class="weekly-scope-summary"><b>${esc(model.member.name)}</b>${checkpoint}<span class="weekly-scope-chip overdue">逾期 ${model.counts.overdue}</span><span class="weekly-scope-chip active">進行中 ${model.counts.active}</span><span class="weekly-scope-chip upcoming">尚未開始 ${model.counts.upcoming}</span><span class="muted">共 ${model.counts.total} 項</span></div>${model.tasks.length?`<div class="weekly-scope-list">${model.tasks.map(item=>`<div class="weekly-scope-row"><span><b>${esc(item.id)}</b> · ${esc(item.name)}</span><span class="muted">${esc(item.categoryName)} · ${esc(item.end||item.targetCp||'—')}</span></div>`).join('')}</div>`:'<div class="muted">本期沒有符合條件的未完成工作；仍可下載空白狀態週報。</div>'}`;
      download.disabled=false;
    }catch(error){
      root.className='weekly-scope-preview muted';
      root.textContent=error.message||String(error);
      download.disabled=true;
    }
  }

  function downloadBlob(blob,filename){
    const link=document.createElement('a');
    link.href=URL.createObjectURL(blob);
    link.download=filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(()=>URL.revokeObjectURL(link.href),2000);
  }

  async function downloadReportTemplate(){
    const button=$('#weeklyDownloadBtn');
    try{
      const model=selectedReportModel();
      button.disabled=true;button.textContent='產生 Word 中...';
      const blob=await window.SmartPortWeeklyDocx.create(model);
      downloadBlob(blob,model.filename);
      toast(`已產生 ${model.member.name} 的週報，共 ${model.counts.total} 項工作`);
    }catch(error){toast(error.message||String(error));}
    finally{button.disabled=false;button.textContent='下載此人的 Word 週報';}
  }

  function targetOptions(){
    const type=$('#weeklyTargetType')?.value || 'WP';
    const sel=$('#weeklyTargetId');
    if(!sel) return;
    const items=type==='WP' ? Store.state.workPackages : Store.state.subtasks;
    sel.innerHTML=items.map(x=>`<option value="${esc(x.id)}">${esc(x.id)} · ${esc(x.name||'')}</option>`).join('');
  }

  function reviewBadge(status){
    const colors={PENDING:'#fff3cd',APPROVED:'#e7f6ec',REJECTED:'#fdecec'};
    const fg={PENDING:'#7a5a00',APPROVED:'#176b36',REJECTED:'#9b1c1c'};
    return `<span style="display:inline-block;padding:3px 7px;border-radius:999px;background:${colors[status]||'#eef2f6'};color:${fg[status]||'#475467'};font-size:11px;font-weight:700">${esc(status)}</span>`;
  }

  function renderArchive(){
    const tb=$('#proposalArchiveTable tbody');
    if(!tb) return;
    if(!proposals.length){tb.innerHTML='<tr><td colspan="9" class="muted">尚無 Weekly Proposal。</td></tr>';return;}
    tb.innerHTML=proposals.map(p=>`<tr>
      <td>${esc(p.report_date||'')}</td>
      <td>${esc(p.report_member_name||p.author||p.submitted_by||'')}</td>
      <td>${esc(p.owner_team||'')}</td>
      <td><b>${esc(p.target_type||'')}</b> ${esc(p.target_id||'')}</td>
      <td>${esc(p.progress)}%</td>
      <td>${esc(p.status||'')}</td>
      <td>${p.ai_generated?`<span class="revision-badge">AI</span>`:'Manual'}${p.source_report_path?`<div class="muted" title="${esc(p.source_report_path)}">Weekly report</div>`:''}</td>
      <td>${reviewBadge(p.review_status)}</td>
      <td>${p.html_url?`<a href="${esc(p.html_url)}" target="_blank" rel="noopener">#${esc(p.issue_number)}</a>`:'—'}</td>
    </tr>`).join('');
  }

  function renderSummary(){
    const el=$('#weeklyStatusSummary');
    if(!el) return;
    const pending=proposals.filter(p=>p.review_status==='PENDING').length;
    const approved=proposals.filter(p=>p.review_status==='APPROVED').length;
    const rejected=proposals.filter(p=>p.review_status==='REJECTED').length;
    el.innerHTML=`<div class="cards" style="grid-template-columns:repeat(3,1fr);margin:0">
      <div class="card"><div class="k">Pending</div><div class="v">${pending}</div><div class="small">等待 PM Review</div></div>
      <div class="card"><div class="k">Approved</div><div class="v">${approved}</div><div class="small">已寫入 baseline</div></div>
      <div class="card"><div class="k">Rejected</div><div class="v">${rejected}</div><div class="small">未寫入 baseline</div></div>
    </div>`;
    const dash=$('#pendingCount'); if(dash) dash.textContent=String(pending);
    const rc=$('#reviewCount'); if(rc) rc.textContent=pending?`(${pending})`:'';
  }

  function renderReview(){
    const box=$('#reviewQueue');
    if(!box) return;
    if(!me?.can_approve){box.innerHTML='<span class="muted">PM permission required.</span>';return;}
    const pending=proposals.filter(p=>p.review_status==='PENDING');
    if(!pending.length){box.innerHTML='<span class="muted">目前沒有待核准的 Proposed Update。</span>';return;}
    box.innerHTML=pending.map(p=>`<div class="panel" style="margin-bottom:12px;box-shadow:none">
      <div class="panel-title"><span>#${esc(p.issue_number)} · ${esc(p.target_type)} ${esc(p.target_id)}</span><span>${p.ai_generated?'<span class="revision-badge">AI mapped</span> ':''}${reviewBadge('PENDING')}</span></div>
      <div style="padding:12px 14px">
        <div class="grid2"><div><b>${esc(p.progress)}%</b> · ${esc(p.status)}</div><div class="muted">${esc(p.report_date)} · ${esc(p.owner_team)} · ${esc(p.report_member_name||p.author||'')}</div></div>
        ${p.source_report_path?`<div class="field"><label>Source Report</label><div>${esc(p.source_report_path)}</div></div>`:''}
        <div class="field"><label>Summary</label><div>${esc(p.summary||'—')}</div></div>
        ${p.ai_rationale?`<div class="field"><label>AI Mapping Rationale</label><div>${esc(p.ai_rationale)}</div></div>`:''}
        <div class="field"><label>Blocker</label><div>${esc(p.blocker||'—')}</div></div>
        <div class="field"><label>Evidence</label><div>${esc(p.evidence||'—')}</div></div>
        <div class="toolbar" style="justify-content:flex-end">
          ${p.html_url?`<a class="btn" href="${esc(p.html_url)}" target="_blank" rel="noopener">GitHub Issue</a>`:''}
          <button class="btn danger" data-reject-proposal="${esc(p.issue_number)}">Reject</button>
          <button class="btn primary" data-approve-proposal="${esc(p.issue_number)}">Approve → Baseline</button>
        </div>
      </div>
    </div>`).join('');
  }

  function setAiState(label,kind=''){
    const b=$('#weeklyAiBadge');if(!b)return;b.textContent=label;b.dataset.kind=kind;
  }

  function renderAiResult(result){
    latestAnalysis=result;
    const el=$('#weeklyAiResult');if(!el)return;
    const analysis=result?.analysis||{};
    const review=analysis.review||{};
    const created=result?.proposals||[];
    const report=result?.report||{};
    const reviewList=(title,items)=>Array.isArray(items)&&items.length?`<div class="weekly-review-list"><b>${esc(title)}</b><ul>${items.map(item=>`<li>${esc(item)}</li>`).join('')}</ul></div>`:'';
    el.innerHTML=`
      ${report.html_url?`<a class="btn weekly-report-link" href="${esc(report.html_url)}" target="_blank" rel="noopener">開啟 GitHub 原始週報</a>`:''}
      <div class="weekly-ai-summary"><b>Codex 批改結論</b><br>${esc(review.overall_assessment||analysis.report_summary||'Codex 已完成週報檢查。')}</div>
      ${Number.isFinite(Number(review.completeness_score))?`<div class="weekly-score-grid"><div class="weekly-score"><b>${esc(review.completeness_score)}</b><span>完整度</span></div><div class="weekly-score"><b>${esc(review.evidence_score)}</b><span>證據品質</span></div><div class="weekly-score"><b>${esc(review.schedule_alignment_score)}</b><span>時程一致性</span></div></div>`:''}
      ${reviewList('做得好的地方',review.strengths)}
      ${reviewList('需要補充',review.missing_items)}
      ${reviewList('建議下一步',review.actions)}
      <div class="muted">${analysis.model?`${esc(analysis.model)} · `:''}產生 ${created.length} 筆 Proposed Update${analysis.warnings?.length?` · ${analysis.warnings.length} warning(s)`:''}</div>
      ${(created||[]).map(p=>`<div class="weekly-ai-proposal"><div class="weekly-ai-proposal-head"><span class="weekly-ai-proposal-id">${esc(p.target_type)} ${esc(p.target_id)} → ${esc(p.progress)}%</span><span class="ai-confidence">confidence ${Math.round(Number(p.ai_confidence||0)*100)}%</span></div><div class="weekly-ai-proposal-meta">${esc(p.status||'')} · ${esc(p.summary||'')}</div></div>`).join('')||'<div class="muted" style="margin-top:12px">週報沒有足夠資訊形成可審核的進度更新。</div>'}
      ${analysis.warnings?.length?`<div class="alert" style="margin-top:12px"><b>AI warnings</b><br>${analysis.warnings.map(esc).join('<br>')}</div>`:''}`;
  }

  async function reloadProposals(){
    try{
      const data=await API.listProposals();
      proposals=data.proposals||[];
      renderArchive();renderSummary();renderReview();
    }catch(e){toast(e.message)}
  }

  async function refreshSnapshotAfterApprove(){
    try{
      const snap=await API.loadSnapshot();
      Store.replaceSnapshot(snap);
      document.querySelector('#btnReload')?.click();
    }catch(_){ }
  }

  function fileToBase64(file){
    return file.arrayBuffer().then(buf=>{
      const bytes=new Uint8Array(buf);let binary='';const chunk=0x8000;
      for(let i=0;i<bytes.length;i+=chunk)binary+=String.fromCharCode(...bytes.subarray(i,i+chunk));
      return btoa(binary);
    });
  }

  const wait=ms=>new Promise(resolve=>setTimeout(resolve,ms));

  async function waitForAnalysisJob(initialJob,report){
    let job=initialJob;
    sessionStorage.setItem(ACTIVE_JOB_KEY,job.id);
    sessionStorage.setItem(ACTIVE_REPORT_KEY,JSON.stringify(report||{}));
    if(typeof API.waitForAnalysisJob==='function'){
      setAiState(job.status==='running'?'Local Codex running':'Queued');
      $('#weeklyAiResult').innerHTML='<div class="weekly-empty-state"><b>'+(
        job.status==='running'?'本機 Codex 分析中':'等待本機 Agent'
      )+'</b><span>Job '+esc(job.id)+' · 完成時會由 Realtime 事件通知，不會定時輪詢。</span></div>';
      job=await API.waitForAnalysisJob(job.id);
      if(job.status==='completed'){
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_REPORT_KEY);
        return job.result||{analysis:{report_summary:'本機分析已完成，請查看 Proposal Archive。'},proposals:[],report};
      }
      sessionStorage.removeItem(ACTIVE_JOB_KEY);
      sessionStorage.removeItem(ACTIVE_REPORT_KEY);
      throw new Error(job.error||'local_codex_job_failed');
    }
    for(let attempt=0;attempt<600;attempt++){
      if(job.status==='completed'){
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_REPORT_KEY);
        return job.result||{analysis:{report_summary:'本機分析已完成，請查看 Proposal Archive。'},proposals:[],report};
      }
      if(job.status==='failed'){
        sessionStorage.removeItem(ACTIVE_JOB_KEY);
        sessionStorage.removeItem(ACTIVE_REPORT_KEY);
        throw new Error(job.error||'local_codex_job_failed');
      }
      const queued=job.status==='queued';
      setAiState(queued?'Queued':'Local Codex running');
      $('#weeklyAiResult').innerHTML='<div class="weekly-empty-state"><b>'+
        (queued?'等待本機 Codex':'本機 Codex 分析中')+
        '</b><span>Job '+esc(job.id)+' · 可以繼續瀏覽其他頁面。</span></div>';
      await wait(2000);
      const data=await API.getAnalysisJob(job.id);
      job=data.job;
    }
    throw new Error('local_codex_job_timeout');
  }

  function bindDropzone(){
    const input=$('#weeklyReportFile'),zone=$('#weeklyDropZone'),label=$('#weeklySelectedFile'),btn=$('#weeklyAnalyzeBtn');
    if(!input||!zone)return;
    const choose=file=>{
      selectedFile=file||null;
      selectedFileMemberId=file?($('#weeklyMember')?.value||''):'';
      if(!file){label.textContent='尚未選擇檔案';btn.disabled=true;return;}
      if(!selectedFileMemberId){toast('請先選擇這份週報的成員');input.value='';return choose(null);}
      const ext=(file.name.split('.').pop()||'').toLowerCase();
      if(!['doc','docx'].includes(ext)){toast('請上傳 .doc 或 .docx');input.value='';return choose(null);}
      if(file.size>10*1024*1024){toast('週報檔案上限 10 MB');input.value='';return choose(null);}
      label.innerHTML=`<b>${esc(file.name)}</b> · ${(file.size/1024/1024).toFixed(2)} MB${ext==='doc'?'<br><span class="muted">Legacy .doc 會先保存；若 AI 端無法直接解析，系統會保留原檔並回報需轉為 .docx。</span>':''}`;
      btn.disabled=!canTriggerCodex;
    };
    input.addEventListener('change',()=>choose(input.files?.[0]));
    ['dragenter','dragover'].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();zone.classList.add('dragover')}));
    ['dragleave','drop'].forEach(type=>zone.addEventListener(type,e=>{e.preventDefault();zone.classList.remove('dragover')}));
    zone.addEventListener('drop',e=>{const f=e.dataTransfer?.files?.[0];if(f)choose(f)});
  }

  async function submitReport(e){
    e.preventDefault();if(!selectedFile||!canTriggerCodex)return;
    const btn=$('#weeklyAnalyzeBtn');
    let model;
    try{model=selectedReportModel();}catch(error){return toast(error.message||String(error));}
    if(selectedFileMemberId!==model.member.id)return toast('目前選擇的成員與這份上傳檔案不一致，請重新選擇檔案');
    const date=model.reportDate,team=model.ownerTeams[0];
    const gateway=API.getMode?.()==='supabase';
    btn.disabled=true;btn.textContent=gateway?'暫存 Supabase...':'上傳 GitHub...';setAiState('Uploading');
    try{
      const base64=await fileToBase64(selectedFile);
      const upload=await API.uploadWeeklyReport({
        report_date:date,
        owner_team:team,
        owner_teams:model.ownerTeams,
        member_id:model.member.id,
        member_name:model.member.name,
        filename:selectedFile.name,
        mime_type:selectedFile.type||'',
        size:selectedFile.size,
        data_base64:base64
      });
      setAiState('Queueing');btn.textContent='排入本機 Codex...';
      const analysis=await API.analyzeWeeklyReport({
        report_date:date,
        owner_team:team,
        owner_teams:model.ownerTeams,
        member_id:model.member.id,
        member_name:model.member.name,
        scope_subtask_ids:model.scopeSubtaskIds,
        report_path:upload.report.path
      });
      const result=analysis.job?await waitForAnalysisJob(analysis.job,upload.report):analysis;
      result.report={...(result.report||{}),...upload.report};
      renderAiResult(result);setAiState('Proposals ready');toast(`AI 已建立 ${result.proposals?.length||0} 筆 Proposed Update`);
      await reloadProposals();
    }catch(err){
      setAiState('Needs attention');
      const msg=err?.message||String(err);
      $('#weeklyAiResult').innerHTML=`<div class="alert"><b>週報處理未完成</b><br>${esc(msg)}</div>`;
      toast(msg);
    }finally{
      btn.disabled=!selectedFile||!canTriggerCodex;
      btn.textContent=canTriggerCodex?'上傳並批改':'PM 才可啟動本機 Codex';
    }
  }

  async function init(){
    if(!$('#reports')) return;
    installLayout();
    renderReportOptions();
    document.addEventListener('smartport:snapshot-replaced',renderReportOptions);
    document.addEventListener('smartport:team-config-saved',renderReportOptions);
    const today=localIsoDate();
    $('#weeklyDate').value=today;$('#weeklyManualDate').value=today;
    renderReportOptions();
    $('#weeklyDate').addEventListener('change',renderReportScope);
    $('#weeklyMember').addEventListener('change',()=>{
      renderReportScope();
      if(selectedFile&&selectedFileMemberId!==$('#weeklyMember').value){
        selectedFile=null;selectedFileMemberId='';
        $('#weeklyReportFile').value='';
        $('#weeklySelectedFile').textContent='成員已變更，請重新選擇其填好的週報';
        $('#weeklyAnalyzeBtn').disabled=true;
      }
    });
    $('#weeklyDownloadBtn').addEventListener('click',downloadReportTemplate);
    bindDropzone();$('#weeklyReportUploadForm').addEventListener('submit',submitReport);

    for(let i=0;i<30;i++){
      if(Store.state.workPackages?.length) break;
      await new Promise(r=>setTimeout(r,150));
    }
    targetOptions();$('#weeklyTargetType')?.addEventListener('change',targetOptions);

    try{me=await API.me();}catch(_){return;}
    canTriggerCodex=me?.can_trigger_codex!==false;
    const analyzeButton=$('#weeklyAnalyzeBtn');
    if(!canTriggerCodex){
      analyzeButton.disabled=true;
      analyzeButton.textContent='PM 才可啟動本機 Codex';
      setAiState('PM only');
    }
    await reloadProposals();
    const activeJobId=sessionStorage.getItem(ACTIVE_JOB_KEY);
    if(activeJobId){
      try{
        const report=JSON.parse(sessionStorage.getItem(ACTIVE_REPORT_KEY)||'{}');
        const data=await API.getAnalysisJob(activeJobId);
        const result=await waitForAnalysisJob(data.job,report);
        result.report={...(result.report||{}),...report};
        renderAiResult(result);setAiState('Proposals ready');await reloadProposals();
      }catch(error){
        setAiState('Needs attention');
        $('#weeklyAiResult').innerHTML='<div class="alert"><b>本機分析未完成</b><br>'+
          esc(error.message||String(error))+'</div>';
      }
    }

    $('#weeklyProposalForm')?.addEventListener('submit',async e=>{
      e.preventDefault();const btn=$('#weeklySubmitBtn');btn.disabled=true;btn.textContent='提交中...';
      try{
        const fd=new FormData(e.currentTarget),payload=Object.fromEntries(fd.entries());payload.progress=Number(payload.progress);
        await API.createProposal(payload);e.currentTarget.reset();$('#weeklyManualDate').value=today;targetOptions();toast('Manual Proposal 已送 PM Review');await reloadProposals();
      }catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='送 PM Review';}
    });

    document.addEventListener('click',async e=>{
      const approve=e.target.closest('[data-approve-proposal]');
      if(approve){const n=approve.dataset.approveProposal;if(!confirm(`Approve Proposal #${n} 並寫入正式 baseline？`))return;approve.disabled=true;try{await API.approveProposal(n);toast(`Proposal #${n} 已核准並寫入 baseline`);await refreshSnapshotAfterApprove();await reloadProposals();}catch(err){toast(err.message)}finally{approve.disabled=false;}return;}
      const reject=e.target.closest('[data-reject-proposal]');
      if(reject){const n=reject.dataset.rejectProposal,reason=prompt(`Reject Proposal #${n} 的原因：`,'');if(reason===null)return;reject.disabled=true;try{await API.rejectProposal(n,reason);toast(`Proposal #${n} 已 Reject`);await reloadProposals();}catch(err){toast(err.message)}finally{reject.disabled=false;}}
    });
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
