(() => {
  const API=window.SmartPortAPI;
  const S=window.SmartPortStore.state;

  function tokenHeaders(){
    const token=sessionStorage.getItem('smartport.session')||'';
    return token?{'Authorization':`Bearer ${token}`} : {};
  }

  function closeDrawer(){
    document.getElementById('drawer')?.classList.remove('open');
    document.getElementById('drawerBackdrop')?.classList.remove('open');
  }

  async function patchCheckpoint(id,patch){
    const res=await fetch(`${API.getBase()}/api/project/checkpoints/${encodeURIComponent(id)}`,{
      method:'PATCH',
      credentials:'include',
      headers:{'Content-Type':'application/json',...tokenHeaders()},
      body:JSON.stringify(patch)
    });
    const text=await res.text();
    let body=null;
    try{body=text?JSON.parse(text):null}catch(_){body=text}
    if(!res.ok){
      const detail=typeof body==='string'?body:(body?.error||JSON.stringify(body));
      throw new Error(`API ${res.status}: ${detail}`);
    }
    return body;
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
