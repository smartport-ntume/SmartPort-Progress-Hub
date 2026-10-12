(() => {
  const API=window.SmartPortAPI;
  const Store=window.SmartPortStore;
  const S=Store.state;
  const active=new Set();
  const memory=new Map();
  const restored=new Set();

  function storageKey(id){
    return `smartport.checkpoint-save:${API.getBase?.()||''}:${window.SMARTPORT_ACCESS?.login||''}:${id}`;
  }
  function pending(id){
    const key=storageKey(id);
    try{
      const record=JSON.parse(sessionStorage.getItem(key)||'null');
      if(record?.id===id&&record.key&&record.patch)return record;
    }catch(_){}
    return memory.get(key)||null;
  }
  function remember(record,key=storageKey(record.id)){
    memory.set(key,record);
    try{sessionStorage.setItem(key,JSON.stringify(record));}catch(_){}
  }
  function forget(id,key=storageKey(id)){
    memory.delete(key);
    restored.delete(key);
    try{sessionStorage.removeItem(key);}catch(_){}
  }

  function statusElement(form){
    let status=form.querySelector('[data-cp-save-status]');
    if(!status){
      status=document.createElement('p');
      status.dataset.cpSaveStatus='';
      status.className='muted';
      status.setAttribute('role','status');
      status.setAttribute('aria-live','polite');
      form.querySelector('button[type="submit"]')?.parentElement?.append(status);
    }
    return status;
  }
  function render(form,record,busy=false,message=''){
    form.querySelectorAll('[name^="cp_"]').forEach(input=>{input.disabled=!!record;});
    const submit=form.querySelector('button[type="submit"]');
    if(submit){
      submit.disabled=busy;
      submit.textContent=record?.phase==='sync'?(busy?'同步畫面中…':'重試畫面同步'):
        busy?(record?.status==='running'?'寫入中…':'等待 Agent…'):record?'查看儲存狀態':'儲存到 GitHub';
    }
    const close=form.querySelector('[data-close]');
    if(close)close.textContent=record?'關閉':'取消';
    statusElement(form).textContent=message||(record?.phase==='sync'?
      `${record.id} 已寫入 GitHub，${busy?'正在確認 Dashboard 與 ACL 日期。':'畫面尚未同步，請按「重試畫面同步」。'}`:record?
      record.status==='running'?'Agent 已接到工作，正在寫入 CP 與同步畫面。':
      record.jobId?'已送出，等待 Agent 處理；關閉視窗不會取消儲存。':
      '正在確認儲存工作；請勿重複送出。':'');
  }

  document.addEventListener('smartport:checkpoint-editor-open',event=>{
    const id=event.detail?.id,form=document.getElementById('drawerBody');
    if(!id||!form)return;
    const record=pending(id);
    if(!record)return;
    restoreConfirmed(record);
    const fields={date:'date',acl:'acl',name:'name',capability:'capability',review:'review_checks',
      fsr:'fsrTarget',fsr_targets:'fsr_targets',criteria:'criteria'};
    for(const [field,key]of Object.entries(fields)){
      const input=form.querySelector(`[name="cp_${field}"]`);
      if(input)input.value=['criteria','fsr_targets'].includes(field)?JSON.stringify(record.patch[key]||[],null,2):record.patch[key]||'';
    }
    render(form,record,active.has(storageKey(id)));
  });

  function closeDrawer(){
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
  }

  async function patchCheckpoint(id,patch,options){
    return API.request(`/api/project/checkpoints/${encodeURIComponent(id)}`,{
      method:'PATCH',
      body:JSON.stringify(patch),
      ...options
    });
  }

  function sameValue(a,b){
    if(a===b)return true;
    if(!a||!b||typeof a!=='object'||typeof b!=='object')return false;
    if(Array.isArray(a)!==Array.isArray(b))return false;
    const keys=Object.keys(a);
    return keys.length===Object.keys(b).length&&keys.every(key=>Object.hasOwn(b,key)&&sameValue(a[key],b[key]));
  }
  const matches=(expected,actual)=>!!actual&&Object.entries(expected).every(([key,value])=>sameValue(actual[key],value));

  function confirmedResult(record,result){
    if(result?.checkpoint?.id!==record.id||!matches(record.patch,result.checkpoint)){
      throw Object.assign(new Error('儲存回傳的 CP 與送出的內容不符，尚未確認成功。請重新整理後檢查日期。'),{resultInvalid:true});
    }
    const cp=result.checkpoint,parts=String(cp.date).split('-');
    const reference={checkpoint:cp.id,date:parts.length===3?`${Number(parts[1])}/${Number(parts[2])}`:cp.date,
      level:cp.acl||'',capability:cp.capability||'',review_checks:cp.review_checks||'',
      fsr_maturity_target:cp.fsrTarget||cp.fsr_target||''};
    return {checkpoint:cp,reference};
  }

  function restoreConfirmed(record){
    const key=storageKey(record.id);
    if(record.phase!=='sync'||!record.result||restored.has(key))return;
    restored.add(key);
    Store.applyCheckpoint(record.result);
  }

  document.addEventListener('smartport:snapshot-replaced',()=>{
    for(const cp of S.checkpoints){const record=pending(cp.id);if(record)restoreConfirmed(record);}
  });

  async function readSynced(record){
    const revision=Store.getRevision();
    let timer;
    try{
      const [snapshot,reference]=await Promise.race([
        Promise.all([API.loadSnapshot(),API.loadReference?API.loadReference():API.request('/api/project/reference')]),
        new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('讀取同步結果逾時')),15_000);})
      ]);
      const cp=snapshot.checkpoints?.find(x=>x.id===record.id);
      const acl=reference.reference?.acl_levels?.find(x=>x.checkpoint===record.id);
      if(matches({id:record.id,...record.patch},cp)&&matches(record.result.reference,acl))return {snapshot,revision};
      return null;
    }finally{clearTimeout(timer);}
  }

  document.addEventListener('submit',async e=>{
    const form=e.target;
    if(!(form instanceof HTMLFormElement)||form.id!=='drawerBody')return;
    const idInput=form.querySelector('[name="cp_id"]');
    if(!idInput)return;

    // Capture the CP editor submit before the legacy whole-file save handler runs.
    e.preventDefault();
    e.stopImmediatePropagation();

    const id=String(idInput.value||'').trim();
    const activeKey=storageKey(id);
    if(active.has(activeKey))return;
    let record=pending(id);
    if(!record){
      const fd=new FormData(form);
      let criteria=[];
      try{
        criteria=JSON.parse(String(fd.get('cp_criteria')||'[]'));
        if(!Array.isArray(criteria))throw new Error('not array');
      }catch(_){
        alert('Readiness Criteria JSON 格式錯誤');
        return;
      }
      let fsrTargets=[];
      try{
        fsrTargets=JSON.parse(String(fd.get('cp_fsr_targets')||'[]'));
        if(!Array.isArray(fsrTargets))throw new Error('not array');
      }catch(_){
        alert('FSR Targets JSON 格式錯誤');
        return;
      }

      const patch={
        date:String(fd.get('cp_date')||''),
        acl:String(fd.get('cp_acl')||'').trim(),
        name:String(fd.get('cp_name')||'').trim(),
        capability:String(fd.get('cp_capability')||'').trim(),
        review_checks:String(fd.get('cp_review')||'').trim(),
        fsrTarget:String(fd.get('cp_fsr')||'').trim(),
        fsr_targets:fsrTargets,
        criteria
      };
      record={id,patch,key:`checkpoint:${crypto.randomUUID()}`,jobId:null,status:'queued'};
      // Preserve the key before enqueueing, including when its HTTP response is lost.
      if(API.getMode?.()==='supabase')remember(record);
    }

    active.add(activeKey);
    const isCurrent=()=>form.contains(idInput);
    const currentForm=()=>{
      if(storageKey(id)!==activeKey)return null;
      const current=document.getElementById('drawerBody');
      return current?.querySelector('[name="cp_id"]')?.value===id?current:null;
    };
    render(form,record,true);
    try{
      if(record.phase!=='sync'){
        const result=await patchCheckpoint(id,record.patch,{
          idempotencyKey:record.key,jobId:record.jobId,
          onUpdate(job){
            record={...record,jobId:job.id,status:job.status};
            remember(record,activeKey);
            const current=currentForm();
            if(current)render(current,record,true);
          }
        });
        record={...record,phase:'sync',result:confirmedResult(record,result)};
        remember(record,activeKey);
      }
      if(storageKey(id)!==activeKey)return;
      restoreConfirmed(record);
      if(currentForm())render(currentForm(),record,true);
      let synced=await readSynced(record);
      if(!synced&&API.syncCheckpoint){
        record.syncKey ||= `checkpoint-sync:${crypto.randomUUID()}`;
        remember(record,activeKey);
        await API.syncCheckpoint(id,{
          idempotencyKey:record.syncKey,jobId:record.syncJobId,
          onUpdate(job){record={...record,syncJobId:job.id};remember(record,activeKey);}
        });
        // A completed refresh can be retried with a new key if publishing failed.
        record.syncJobId=null;record.syncKey=null;
        remember(record,activeKey);
        synced=await readSynced(record);
      }
      if(!synced)throw new Error('Dashboard 或 ACL 仍回傳舊資料，請確認 Agent 正常後重試。');
      forget(id,activeKey);
      if(storageKey(id)!==activeKey)return;
      Store.replaceSnapshot(synced.snapshot,synced.revision);
      Store.confirmCheckpointSync(id);
      if(isCurrent()||currentForm())closeDrawer();
      const toast=document.getElementById('toast');
      if(toast){
        toast.textContent=`${id} 已儲存並同步 · ${record.result.checkpoint.date}`;
        toast.classList.add('show');
        setTimeout(()=>toast.classList.remove('show'),5000);
      }
    }catch(err){
      if(record.phase==='sync'){
        if(err?.queueRejected||err?.status===404||['failed','cancelled'].includes(err?.job?.status)){
          record.syncJobId=null;record.syncKey=null;
        }
        remember(record,activeKey);
        const current=currentForm();
        const message=`${id} 已寫入 GitHub，但畫面尚未同步。${err?.message||String(err)} 按「重試畫面同步」即可，不會再寫入 CP。`;
        if(current)render(current,record,false,message);
        else if(storageKey(id)===activeKey){
          const toast=document.getElementById('toast');
          if(toast){toast.textContent=message;toast.classList.add('show');}
        }
        return;
      }
      const terminal=err?.resultInvalid||err?.queueRejected||err?.status===404||['failed','cancelled'].includes(err?.job?.status)||API.getMode?.()!=='supabase';
      if(terminal)forget(id,activeKey);
      else{
        record={...record,jobId:err?.job?.id||record.jobId,status:err?.job?.status||record.status};
        remember(record,activeKey);
      }
      let message=err?.message||String(err);
      if(!terminal){
        message=record.status==='running'?
          'Agent 尚未回報完成。請按「查看儲存狀態」確認這筆工作，不會重複送出。':
          record.jobId?'尚未收到完成通知，上次狀態為等待 Agent。請確認本機 Agent 已啟動；若正在批改週報，需等前一筆完成。':
          '暫時無法確認是否已送出。請按「查看儲存狀態」，會沿用同一筆工作。';
      }
      const current=currentForm();
      if(current)render(current,terminal?null:record,false,message);
    }finally{
      active.delete(activeKey);
    }
  },true);
})();
