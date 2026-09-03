(() => {
  const API=window.SmartPortAPI;
  const S=window.SmartPortStore.state;

  function closeDrawer(){
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
  }

  async function patchCheckpoint(id,patch){
    return API.request(`/api/project/checkpoints/${encodeURIComponent(id)}`,{
      method:'PATCH',
      body:JSON.stringify(patch)
    });
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
    const fd=new FormData(form);
    let criteria=[];
    try{
      criteria=JSON.parse(String(fd.get('cp_criteria')||'[]'));
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

    const submit=form.querySelector('button[type="submit"]');
    const oldText=submit?.textContent||'';
    if(submit){submit.disabled=true;submit.textContent='儲存中...';}

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

    try{
      const result=await patchCheckpoint(id,patch);
      if(result?.checkpoint){
        const idx=S.checkpoints.findIndex(x=>x.id===id);
        if(idx>=0)S.checkpoints[idx]={...S.checkpoints[idx],...result.checkpoint};
      }
      closeDrawer();
      document.getElementById('btnReload')?.click();
    }catch(err){
      alert(err?.message||String(err));
    }finally{
      if(submit){submit.disabled=false;submit.textContent=oldText||'儲存到 GitHub';}
    }
  },true);
})();
