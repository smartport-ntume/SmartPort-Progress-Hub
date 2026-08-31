(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;

  function toast(msg){
    const el=document.getElementById('toast');
    if(!el)return;
    el.textContent=msg;
    el.classList.add('show');
    clearTimeout(toast.t);
    toast.t=setTimeout(()=>el.classList.remove('show'),5200);
  }

  async function currentAccess(){
    return window.SMARTPORT_ACCESS || await API.me();
  }

  async function refreshAfterRestore(){
    const snap=await API.loadSnapshot();
    window.SmartPortStore.replaceSnapshot(snap);
    document.getElementById('btnReload')?.click();
  }

  async function restoreNow(button){
    const me=await currentAccess();
    if(!me?.can_write){
      toast('只有 PM / Write 以上權限可以執行 baseline restore。');
      return;
    }

    if(button){button.disabled=true;button.textContent='恢復中...';}
    try{
      const before=Store?.state?.subtasks?.length || 0;
      const result=await API.restoreV041Subtasks();
      const count=Number(result?.count||0);
      if(result?.skipped){
        toast(`目前 registry 已有 ${count} 個 Subtask；未重複覆寫。`);
      }else{
        toast(`v0.4.1 baseline 恢復完成：${before} → ${count} 個 Subtask`);
      }
      await refreshAfterRestore();
    }catch(e){
      console.error('v0.4.1 restore failed',e);
      toast(`v0.4.1 restore 失敗：${e.message||e}`);
    }finally{
      if(button){button.disabled=false;button.textContent='恢復 v0.4.1 完整 Subtasks';}
    }
  }

  async function init(){
    const settings=document.querySelector('#settings .grid2 .panel:nth-child(2) > div[style]');
    if(!settings)return;

    let me;
    try{me=await currentAccess();}catch(_){return;}
    if(!me?.can_write)return;

    if(!document.getElementById('btnRestoreV041')){
      const wrap=document.createElement('div');
      wrap.className='field';
      wrap.style.marginTop='16px';
      wrap.innerHTML=`
        <div class="alert info">
          <b>v0.4.1 Baseline Recovery</b><br>
          從原始 SmartPort Progress Hub v0.4.1 baseline 恢復完整 WP Subtask registry。既有 GitHub Issue mapping 與已核准執行狀態會依 Subtask ID 保留。
        </div>
        <button id="btnRestoreV041" type="button" class="btn">恢復 v0.4.1 完整 Subtasks</button>
        <div id="restoreV041State" class="muted" style="margin-top:6px">目前載入：${Store?.state?.subtasks?.length||0} 個 Subtask</div>
      `;
      settings.appendChild(wrap);
      const btn=document.getElementById('btnRestoreV041');
      btn.addEventListener('click',()=>restoreNow(btn));
    }
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(init,1200));
  else setTimeout(init,1200);
})();
