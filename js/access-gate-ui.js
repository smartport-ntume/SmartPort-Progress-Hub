(() => {
  const API=window.SmartPortAPI;

  function esc(v=''){
    return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function createGate(){
    let gate=document.getElementById('smartportAccessGate');
    if(gate)return gate;
    gate=document.createElement('div');
    gate.id='smartportAccessGate';
    gate.innerHTML=`
      <div class="sp-gate-card">
        <div class="sp-gate-brand">SmartPort Progress Hub</div>
        <h2>Project Access</h2>
        <p class="sp-gate-copy">請使用訪客密碼，或以 SmartPort Organization 成員的 GitHub 帳號登入。</p>
        <div id="spGateMessage" class="sp-gate-message" hidden></div>
        <form id="spGuestLoginForm" class="sp-gate-section">
          <label for="spGuestPassword">訪客密碼</label>
          <div class="sp-gate-password-row">
            <input id="spGuestPassword" type="password" autocomplete="current-password" required placeholder="Guest password">
            <button id="spGuestSubmit" type="submit" class="sp-gate-primary">進入唯讀模式</button>
          </div>
          <label class="sp-gate-show-password"><input id="spShowGuestPassword" type="checkbox"> 顯示密碼</label>
          <div class="sp-gate-hint">Guest 可唯讀查看 Dashboard、Project 與 Requirements；Workflow 與管理設定不開放。</div>
        </form>
        <div class="sp-gate-divider"><span>或</span></div>
        <button id="spGithubLogin" type="button" class="sp-gate-github">GitHub Organization Login</button>
        <div class="sp-gate-hint">GitHub 登入後會驗證 <b>smartport-ntume</b> Organization membership，再依 Engineer / PM 權限進入。</div>
      </div>`;
    document.body.appendChild(gate);

    const style=document.createElement('style');
    style.id='smartportAccessGateStyle';
    style.textContent=`
      #smartportAccessGate{position:fixed;inset:0;z-index:10000;background:linear-gradient(135deg,#17365d 0%,#274b78 55%,#1f416c 100%);display:flex;align-items:center;justify-content:center;padding:24px}
      .sp-gate-card{width:min(620px,100%);background:#fff;border-radius:16px;padding:28px 30px;box-shadow:0 24px 70px rgba(0,0,0,.28);color:#172033}
      .sp-gate-brand{font-size:13px;font-weight:800;color:#5277bb;letter-spacing:.02em;margin-bottom:6px}
      .sp-gate-card h2{font-size:26px;margin:0 0 8px}.sp-gate-copy{margin:0 0 22px;color:#667085;line-height:1.6}
      .sp-gate-section>label:first-child{display:block;font-size:12px;font-weight:700;color:#475467;margin-bottom:7px}
      .sp-gate-password-row{display:grid;grid-template-columns:1fr auto;gap:9px}.sp-gate-password-row input{height:42px;border:1px solid #cfd7e3;border-radius:8px;padding:0 12px;font-size:14px;min-width:0}
      .sp-gate-show-password{display:inline-flex!important;align-items:center;gap:7px;margin-top:8px;margin-bottom:0!important;font-size:12px!important;font-weight:500!important;color:#667085!important;cursor:pointer;user-select:none}.sp-gate-show-password input{margin:0}
      .sp-gate-primary,.sp-gate-github{height:42px;border:0;border-radius:8px;font-weight:700;cursor:pointer;padding:0 16px}.sp-gate-primary{background:#244675;color:#fff}.sp-gate-primary:disabled{opacity:.6;cursor:wait}
      .sp-gate-github{width:100%;background:#24292f;color:#fff;font-size:14px}.sp-gate-divider{display:flex;align-items:center;gap:12px;color:#98a2b3;font-size:12px;margin:20px 0}.sp-gate-divider:before,.sp-gate-divider:after{content:"";height:1px;background:#e3e8ef;flex:1}
      .sp-gate-hint{font-size:11.5px;color:#7a8597;line-height:1.55;margin-top:7px}.sp-gate-message{padding:10px 12px;border-radius:8px;margin-bottom:16px;font-size:12px;line-height:1.5;background:#fff4e5;color:#8a4b08;border:1px solid #f4d39e}
      @media(max-width:620px){.sp-gate-card{padding:22px}.sp-gate-password-row{grid-template-columns:1fr}.sp-gate-primary{width:100%}}
    `;
    document.head.appendChild(style);
    return gate;
  }

  function showMessage(html){
    const msg=document.getElementById('spGateMessage');
    if(!msg)return;
    msg.hidden=false;
    msg.innerHTML=html;
  }

  function showGate(me){
    const gate=createGate();
    gate.style.display='flex';
    const msg=document.getElementById('spGateMessage');
    if(me?.role==='DENIED'){
      showMessage(`目前登入的 GitHub 帳號不是 <b>${esc(me.organization||'smartport-ntume')}</b> 的有效成員。你可以改用訪客密碼，或使用正確的 Organization GitHub 帳號登入。`);
    }else{
      msg.hidden=true;
      msg.textContent='';
    }
  }

  function hideGate(){
    const gate=document.getElementById('smartportAccessGate');
    if(gate)gate.style.display='none';
  }

  function repoAccessHelp(status){
    if(Number(status)===404){
      return 'Guest Access Token 已設定，但 GitHub 看不到 <b>smartport-ntume/SmartPort-Project-Control</b>。請確認 Fine-grained token 的 <b>Resource owner = smartport-ntume</b>、Repository access 已勾選 <b>SmartPort-Project-Control</b>，以及 Organization approval 狀態不是 Pending。';
    }
    if(Number(status)===403){
      return 'Guest Access Token 已設定，但 GitHub 拒絕存取 Private Repo（403）。請確認 token 的 <b>Contents = Read-only</b>，並確認 Organization 已核准這顆 Fine-grained token。';
    }
    return `Guest Access Token 已設定，但目前無法讀取 Private Repo。GitHub 狀態：<b>${esc(String(status??'unknown'))}</b>。`;
  }

  async function checkGuestServer(){
    try{
      const s=await API.guestStatus();
      if(!s.session_secret_configured){
        showMessage('Guest Access 尚未完成伺服器設定：<b>SESSION_SECRET</b> 未設定。');
        return false;
      }
      if(!s.guest_repo_token_configured){
        showMessage('Guest Access 尚未完成伺服器設定：Cloudflare Worker 目前沒有讀到 <b>GUEST_REPO_TOKEN</b>。請確認 Secret 是加在 <b>smartport-progress-hub-api</b> 的 Production Worker。');
        return false;
      }
      if(!s.repo_readable){
        showMessage(repoAccessHelp(s.github_status));
        return false;
      }
      if(!s.access_policy_readable){
        showMessage('Guest Access Token 可讀 repository，但無法讀取 <b>project/access_control.json</b>。請檢查 Contents: Read-only 權限。');
        return false;
      }
      return true;
    }catch(_){
      return true;
    }
  }

  async function init(){
    const me=await API.me().catch(()=>({role:'UNAUTHENTICATED'}));
    if(me?.role!=='UNAUTHENTICATED'&&me?.role!=='DENIED'){
      hideGate();
      return;
    }

    showGate(me);
    await checkGuestServer();
    const form=document.getElementById('spGuestLoginForm');
    const input=document.getElementById('spGuestPassword');
    const submit=document.getElementById('spGuestSubmit');
    const message=document.getElementById('spGateMessage');
    const showPassword=document.getElementById('spShowGuestPassword');

    showPassword.onchange=()=>{
      input.type=showPassword.checked?'text':'password';
      input.focus();
    };

    form.onsubmit=async e=>{
      e.preventDefault();
      submit.disabled=true;
      submit.textContent='驗證中...';
      try{
        await API.guestLogin(input.value);
        window.location.reload();
      }catch(err){
        message.hidden=false;
        if(err?.status===401)message.textContent='訪客密碼不正確，或目前 Guest session 已失效。';
        else if([403,404,503].includes(Number(err?.status))){
          const ok=await checkGuestServer();
          if(ok){
            if(err?.payload?.error==='guest_repo_token_no_access')showMessage(repoAccessHelp(404));
            else if(err?.payload?.error==='guest_repo_token_forbidden')showMessage(repoAccessHelp(403));
            else message.textContent=`Guest Access 無法登入：${err?.message||String(err)}`;
          }
        }else message.textContent=`無法登入：${err?.message||String(err)}`;
      }finally{
        submit.disabled=false;
        submit.textContent='進入唯讀模式';
      }
    };

    document.getElementById('spGithubLogin').onclick=()=>API.login();
    setTimeout(()=>input?.focus(),80);
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
