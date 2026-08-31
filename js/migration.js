(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  let restoring = false;

  function toast(msg){
    const el=document.getElementById('toast');
    if(!el)return;
    el.textContent=msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t=setTimeout(()=>el.classList.remove('show'),6200);
  }

  async function currentAccess(){
    return window.SMARTPORT_ACCESS || await API.me();
  }

  function setState(message,kind='info'){
    const el=document.getElementById('restoreV041State');
    if(!el)return;
    el.textContent=message;
    el.style.fontWeight='600';
    el.style.color=kind==='error'?'#b42318':kind==='ok'?'#176b36':'#667085';
  }

  async function refreshAfterRestore(){
    const snap=await API.loadSnapshot();
    window.SmartPortStore.replaceSnapshot(snap);
    setState(`目前載入：${snap?.subtasks?.length||0} 個 Subtask`,'ok');
    document.getElementById('btnReload')?.click();
  }

  async function restoreNow(button,automatic=false){
    if(restoring)return;
    const me=await currentAccess();
    if(!me?.can_write){
      setState('只有 PM / Write 以上權限可以執行 baseline restore。','error');
      return;
    }

    restoring=true;
    if(button){button.disabled=true;button.textContent='恢復中...';}
    const before=Store?.state?.subtasks?.length || 0;
    setState(`${automatic?'自動':''}恢復中：目前 ${before} 個 Subtask → 目標 97 個...`);
    try{
      const result=await API.restoreV041Subtasks();
      const count=Number(result?.count||0);
      if(result?.skipped){
        setState(`Worker 回報 registry 已有 ${count} 個 Subtask，未覆寫。`,count>=97?'ok':'error');
        toast(`registry 目前 ${count} 個 Subtask`);
      }else if(count===97){
        setState(`v0.4.1 baseline 恢復成功：${before} → 97 個 Subtask`,'ok');
        toast(`v0.4.1 baseline 恢復完成：${before} → 97 個 Subtask`);
      }else{
        setState(`Restore 已執行，但回傳 ${count} 個 Subtask；預期 97。`,'error');
        toast(`Restore 數量異常：${count} / 97`);
      }
      await refreshAfterRestore();
    }catch(e){
      console.error('v0.4.1 restore failed',e);
      const msg=e?.message||String(e);
      setState(`Restore 失敗：${msg}`,'error');
      toast(`v0.4.1 restore 失敗：${msg}`);
    }finally{
      restoring=false;
      if(button){button.disabled=false;button.textContent='強制恢復 v0.4.1 完整 Subtasks';}
    }
  }

  async function init(){
    const settings=document.querySelector('#settings .grid2 .panel:nth-child(2) > div[style]');
    if(!settings)return;

    let me;
    try{me=await currentAccess();}catch(e){return;}
    if(!me?.can_write)return;

    if(!document.getElementById('btnRestoreV041')){
      const wrap=document.createElement('div');
      wrap.className='field';
      wrap.style.marginTop='16px';
      wrap.innerHTML=`
        <div class="alert info">
          <b>v0.4.1 Baseline Recovery</b><br>
          正式目標為 <b>19 WP / 97 Subtasks</b>。此工具會恢復 v0.4.1 完整 Subtask registry，並依 ID 保留既有 GitHub Issue mapping 與已核准執行狀態。
        </div>
        <button id="btnRestoreV041" type="button" class="btn primary">強制恢復 v0.4.1 完整 Subtasks</button>
        <div id="restoreV041State" class="muted" style="margin-top:8px">目前載入：${Store?.state?.subtasks?.length||0} 個 Subtask</div>
      `;
      settings.appendChild(wrap);
      const btn=document.getElementById('btnRestoreV041');
      btn.addEventListener('click',()=>restoreNow(btn,false));
    }

    // PM sees only the pilot six records: repair automatically once per tab session.
    const count=Store?.state?.subtasks?.length || 0;
    if(count===6 && sessionStorage.getItem('smartport.v041AutoRestoreAttempted')!=='1'){
      sessionStorage.setItem('smartport.v041AutoRestoreAttempted','1');
      await restoreNow(document.getElementById('btnRestoreV041'),true);
    }else if(count>=97){
      setState(`完整 baseline 已載入：${count} 個 Subtask`,'ok');
    }else{
      setState(`目前載入：${count} 個 Subtask；完整 v0.4.1 baseline 應為 97 個。`,count===97?'ok':'error');
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,1400));
  else setTimeout(init,1400);
})();
