(() => {
  const API=window.SmartPortAPI;

  async function syncNow(btn,status){
    if(!window.SMARTPORT_ACCESS?.can_write)return;
    btn.disabled=true;btn.textContent='同步中...';
    status.textContent='正在從 Private Project-Control 產生公開白名單 snapshot...';
    try{
      const token=sessionStorage.getItem('smartport.session')||'';
      const res=await fetch(API.getBase()+'/api/public/sync',{
        method:'POST',
        credentials:'include',
        headers:{'Content-Type':'application/json',...(token?{'Authorization':`Bearer ${token}`}:{})}
      });
      const text=await res.text();
      let data={};try{data=text?JSON.parse(text):{}}catch(_){data={error:text}}
      if(!res.ok)throw new Error(data.error||`API ${res.status}`);
      status.textContent=`公開 Snapshot 已同步：${data.work_packages||0} WP / ${data.checkpoints||0} CP · ${data.generated_at||''}`;
    }catch(e){status.textContent=`同步失敗：${e.message||String(e)}`;}
    finally{btn.disabled=false;btn.textContent='同步 Public Snapshot';}
  }

  function install(){
    if(!window.SMARTPORT_ACCESS?.can_write)return;
    const settings=document.querySelector('#settings .grid2 .panel:nth-child(2) > div[style]');
    if(!settings||document.getElementById('btnPublicSnapshotSync'))return;
    const wrap=document.createElement('div');wrap.className='field';wrap.style.marginTop='16px';
    wrap.innerHTML=`<div class="alert info"><b>Public Snapshot</b><br>將 Private Project-Control 的最新 WP / CP 轉成公開白名單資料；不會公開 FSR、IF、TR、Evidence、PM Comment 或 GitHub Issue。</div><button id="btnPublicSnapshotSync" type="button" class="btn primary">同步 Public Snapshot</button><div id="publicSnapshotSyncState" class="muted" style="margin-top:8px">PM 修改正式時程或進度後，可按此同步外部公開頁。</div>`;
    settings.appendChild(wrap);
    const btn=document.getElementById('btnPublicSnapshotSync');
    const status=document.getElementById('publicSnapshotSyncState');
    btn.addEventListener('click',()=>syncNow(btn,status));
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(install,1200));
  else setTimeout(install,1200);
})();
