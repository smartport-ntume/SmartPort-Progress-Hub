(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  const $ = s => document.querySelector(s);
  const esc = (v='') => String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));

  let proposals = [];
  let me = null;

  function toast(msg){
    const el=$('#toast');
    if(!el) return;
    el.textContent=msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t=setTimeout(()=>el.classList.remove('show'),3600);
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
    if(!proposals.length){tb.innerHTML='<tr><td colspan="8" class="muted">尚無 Weekly Proposal。</td></tr>';return;}
    tb.innerHTML=proposals.map(p=>`<tr>
      <td>${esc(p.report_date||'')}</td>
      <td>${esc(p.author||p.submitted_by||'')}</td>
      <td>${esc(p.owner_team||'')}</td>
      <td><b>${esc(p.target_type||'')}</b> ${esc(p.target_id||'')}</td>
      <td>${esc(p.progress)}%</td>
      <td>${esc(p.status||'')}</td>
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
      <div class="panel-title"><span>#${esc(p.issue_number)} · ${esc(p.target_type)} ${esc(p.target_id)}</span><span>${reviewBadge('PENDING')}</span></div>
      <div style="padding:12px 14px">
        <div class="grid2">
          <div><b>${esc(p.progress)}%</b> · ${esc(p.status)}</div>
          <div class="muted">${esc(p.report_date)} · ${esc(p.owner_team)} · ${esc(p.author||'')}</div>
        </div>
        <div class="field" style="margin-top:10px"><label>Summary</label><div>${esc(p.summary||'—')}</div></div>
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

  async function init(){
    if(!$('#weeklyProposalForm')) return;
    $('#weeklyDate').value=new Date().toISOString().slice(0,10);
    $('#weeklyTargetType').addEventListener('change',targetOptions);

    for(let i=0;i<30;i++){
      if(Store.state.workPackages?.length) break;
      await new Promise(r=>setTimeout(r,150));
    }
    targetOptions();

    try{me=await API.me();}catch(_){return;}
    await reloadProposals();

    $('#weeklyProposalForm').addEventListener('submit',async e=>{
      e.preventDefault();
      const btn=$('#weeklySubmitBtn');
      btn.disabled=true;btn.textContent='提交中...';
      try{
        const fd=new FormData(e.currentTarget);
        const payload=Object.fromEntries(fd.entries());
        payload.progress=Number(payload.progress);
        await API.createProposal(payload);
        e.currentTarget.reset();
        $('#weeklyDate').value=new Date().toISOString().slice(0,10);
        targetOptions();
        toast('Weekly Proposal 已送 PM Review');
        await reloadProposals();
      }catch(err){toast(err.message)}finally{btn.disabled=false;btn.textContent='送 PM Review';}
    });

    document.addEventListener('click',async e=>{
      const approve=e.target.closest('[data-approve-proposal]');
      if(approve){
        const n=approve.dataset.approveProposal;
        if(!confirm(`Approve Proposal #${n} 並寫入正式 baseline？`)) return;
        approve.disabled=true;
        try{
          await API.approveProposal(n);
          toast(`Proposal #${n} 已核准並寫入 baseline`);
          await reloadProposals();
          await refreshSnapshotAfterApprove();
        }catch(err){toast(err.message)}finally{approve.disabled=false;}
        return;
      }
      const reject=e.target.closest('[data-reject-proposal]');
      if(reject){
        const n=reject.dataset.rejectProposal;
        const reason=prompt(`Reject Proposal #${n} 的原因：`,'');
        if(reason===null) return;
        reject.disabled=true;
        try{
          await API.rejectProposal(n,reason);
          toast(`Proposal #${n} 已 Reject`);
          await reloadProposals();
        }catch(err){toast(err.message)}finally{reject.disabled=false;}
      }
    });
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',init);
  else init();
})();
