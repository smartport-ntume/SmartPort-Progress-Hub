(() => {
  const API=window.SmartPortAPI;

  function install(){
    if(!window.SMARTPORT_ACCESS?.can_write)return;
    const settings=document.querySelector('#settings .grid2 .panel:nth-child(2) > div[style]');
    if(!settings||document.getElementById('guestPasswordManager'))return;

    const wrap=document.createElement('div');
    wrap.id='guestPasswordManager';
    wrap.className='field';
    wrap.style.marginTop='18px';
    wrap.innerHTML=`
      <div class="alert info">
        <b>Guest Access Password</b><br>
        Organization 外部訪客可用共用密碼進入唯讀模式。密碼不會寫入前端或 README；Private Repo 只保存 salted PBKDF2 hash。
      </div>
      <div class="split">
        <div class="field"><label>New Guest Password</label><input id="guestPasswordNew" type="password" autocomplete="new-password" placeholder="至少 12 個字元"></div>
        <div class="field"><label>Confirm Password</label><input id="guestPasswordConfirm" type="password" autocomplete="new-password"></div>
      </div>
      <button id="btnChangeGuestPassword" type="button" class="btn primary">更新 Guest Password</button>
      <div id="guestPasswordState" class="muted" style="margin-top:8px">只有 PM 可修改。更新後，既有 Guest session 仍會在原到期時間前有效。</div>`;
    settings.appendChild(wrap);

    const btn=document.getElementById('btnChangeGuestPassword');
    const state=document.getElementById('guestPasswordState');
    btn.onclick=async()=>{
      const a=document.getElementById('guestPasswordNew').value;
      const b=document.getElementById('guestPasswordConfirm').value;
      if(a.length<12){state.textContent='密碼至少需要 12 個字元。';return;}
      if(a!==b){state.textContent='兩次輸入的密碼不一致。';return;}
      if(!confirm('確定更新 Guest Access Password？'))return;
      btn.disabled=true;btn.textContent='更新中...';
      try{
        await API.changeGuestPassword(a);
        document.getElementById('guestPasswordNew').value='';
        document.getElementById('guestPasswordConfirm').value='';
        state.textContent=`Guest Password 已更新 · ${new Date().toLocaleString('zh-TW')}`;
      }catch(e){state.textContent=`更新失敗：${e.message||String(e)}`;}
      finally{btn.disabled=false;btn.textContent='更新 Guest Password';}
    };
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>setTimeout(install,1000));
  else setTimeout(install,1000);
})();
