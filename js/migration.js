(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  let ran = false;

  function toast(msg){
    const el=document.getElementById('toast');
    if(!el)return;
    el.textContent=msg;
    el.classList.add('show');
    setTimeout(()=>el.classList.remove('show'),4200);
  }

  async function tryRestore(){
    if(ran) return;
    ran = true;
    try{
      const me = window.SMARTPORT_ACCESS || await API.me();
      if(!me?.can_write) return;

      for(let i=0;i<30;i++){
        if(Store?.state?.connected) break;
        await new Promise(r=>setTimeout(r,150));
      }

      const count = Store?.state?.subtasks?.length || 0;
      if(count !== 6) return;

      toast('偵測到精簡版 Subtask registry，正在恢復 v0.4.1 完整 baseline…');
      const result = await API.restoreV041Subtasks();
      if(result?.count > 6){
        toast(`v0.4.1 Subtask baseline 已恢復：${result.count} 個 Subtask`);
        setTimeout(()=>document.getElementById('btnReload')?.click(),700);
      }
    }catch(e){
      console.warn('v0.4.1 migration skipped:', e);
    }
  }

  if(document.readyState==='loading') document.addEventListener('DOMContentLoaded',()=>setTimeout(tryRestore,900));
  else setTimeout(tryRestore,900);
})();
