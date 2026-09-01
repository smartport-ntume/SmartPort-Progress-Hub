(() => {
  const API = window.SmartPortAPI;
  let access = { role: 'UNAUTHENTICATED', can_write: false, repository_permission: 'none' };

  function ensureReadonlyStyle(){
    if(document.getElementById('smartportReadonlyStyle'))return;
    const style=document.createElement('style');
    style.id='smartportReadonlyStyle';
    style.textContent=`
      body.sp-readonly [data-action],
      body.sp-readonly [data-edit-wp],
      body.sp-readonly [data-edit-subtask],
      body.sp-readonly [data-edit-cp],
      body.sp-readonly [data-edit-fsr],
      body.sp-readonly [data-delete-wp],
      body.sp-readonly [data-delete-subtask],
      body.sp-readonly [data-delete-cp],
      body.sp-readonly [data-delete-fsr],
      body.sp-readonly .sp-write-hidden{display:none!important}
    `;
    document.head.appendChild(style);
  }

  const isLegacyWriteControl = el => {
    if (!(el instanceof Element) || !el.matches('button')) return false;
    if (el.matches('[data-plan-family],[data-view],#btnReload,#drawerClose')) return false;
    if (el.matches('[data-action],[data-edit-wp],[data-edit-subtask],[data-edit-cp],[data-edit-fsr],[data-delete-wp],[data-delete-subtask],[data-delete-cp],[data-delete-fsr]')) return false;
    const text = (el.textContent || '').trim();
    return /^(編輯|Edit|刪除|Archive|新增|儲存到 GitHub|儲存)$/i.test(text) || /^＋新增/.test(text);
  };

  function markLegacyWriteControls(root=document){
    if(access.can_write)return;
    const nodes=[];
    if(root instanceof Element && root.matches('button'))nodes.push(root);
    if(root.querySelectorAll)nodes.push(...root.querySelectorAll('button'));
    nodes.forEach(btn=>{if(isLegacyWriteControl(btn))btn.classList.add('sp-write-hidden');});
  }

  function hideViewButton(id){
    document.querySelector(`.nav button[data-view="${id}"]`)?.style.setProperty('display','none','important');
  }

  function hideGroup(id){
    document.querySelector(`[data-nav-group="${id}"]`)?.style.setProperty('display','none','important');
  }

  function hideGuestWorkflowIndicators(){
    const pending=document.getElementById('pendingCount')?.closest('.card');
    if(pending)pending.style.setProperty('display','none','important');
    document.querySelectorAll('#dashboard .pending-dot').forEach(dot=>{
      const host=dot.closest('.muted')||dot.parentElement;
      host?.style.setProperty('display','none','important');
    });
  }

  function applyNavigationVisibility() {
    if (access.can_write) return;

    if (access.role === 'GUEST') {
      hideViewButton('reports');
      hideViewButton('review');
      hideViewButton('settings');
      hideGroup('workflow');
      document.querySelector('.nav-system')?.style.setProperty('display','none','important');
      hideGuestWorkflowIndicators();
      const active=document.querySelector('.view.active');
      if(active&&['reports','review','settings'].includes(active.id)){
        document.querySelector('.nav button[data-view="dashboard"]')?.click();
      }
      return;
    }

    if (access.role === 'ENGINEER') {
      hideViewButton('review');
      hideViewButton('settings');
      document.querySelector('.nav-system')?.style.setProperty('display','none','important');
      const active=document.querySelector('.view.active');
      if(active&&['review','settings'].includes(active.id)){
        document.querySelector('.nav button[data-view="dashboard"]')?.click();
      }
    }
  }

  function applyAccessClass(){
    ensureReadonlyStyle();
    document.body.classList.toggle('sp-readonly',!access.can_write);
    document.body.classList.toggle('sp-guest',access.role==='GUEST');
    document.body.classList.toggle('sp-engineer',access.role==='ENGINEER');
    markLegacyWriteControls(document);
    applyNavigationVisibility();
  }

  function showRoleBadge(me) {
    const box = document.querySelector('.connection-box');
    if (!box || ['UNAUTHENTICATED','DENIED'].includes(me.role)) return;
    let badge = document.getElementById('roleBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'roleBadge';
      badge.style.cssText = 'display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.14);font-size:11px;color:#fff;margin-left:4px;white-space:nowrap';
      box.insertBefore(badge, document.getElementById('btnReload'));
    }
    if(me.role==='GUEST'){
      badge.textContent='Guest · Read Only';
      badge.title='Password-authenticated guest viewer';
    }else{
      badge.textContent = `${me.role === 'PM' ? 'PM' : 'Engineer'} · ${me.repository_permission}`;
      badge.title = `GitHub: ${me.login}`;
    }
  }

  function setConnectionLabel(me){
    const text=document.getElementById('connText');
    const dot=document.getElementById('connDot');
    if(!text||!dot)return;
    if(me.role==='GUEST'){
      text.textContent='Guest Project View · Read Only';
      dot.className='conn-dot online';
    }
  }

  function loadPmPasswordManager(){
    if(!access.can_write||document.querySelector('script[data-guest-password-manager]'))return;
    const s=document.createElement('script');
    s.src=`js/guest-password-settings.js?v=${window.SMARTPORT_BUILD||Date.now()}`;
    s.dataset.guestPasswordManager='1';
    document.body.appendChild(s);
  }

  async function initRole() {
    try {
      const me = await API.me();
      access = me;
      window.SMARTPORT_ACCESS = me;
      showRoleBadge(me);
      setConnectionLabel(me);
      applyAccessClass();
      loadPmPasswordManager();
      document.dispatchEvent(new CustomEvent('smartport:access-changed', { detail: me }));

      const observer = new MutationObserver(mutations => {
        if(access.can_write)return;
        for(const m of mutations){
          for(const node of m.addedNodes){
            if(node.nodeType===1)markLegacyWriteControls(node);
          }
        }
        applyNavigationVisibility();
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (_) {}
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRole);
  else initRole();
})();
