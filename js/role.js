(() => {
  const API = window.SmartPortAPI;
  let access = { role: 'ENGINEER', can_write: false, repository_permission: 'read' };

  const isWriteControl = el => {
    if (!(el instanceof Element)) return false;
    if (el.matches('[data-action],[data-edit-wp],[data-edit-subtask],[data-edit-cp],[data-edit-fsr],[data-delete-wp],[data-delete-subtask],[data-delete-cp],[data-delete-fsr]')) return true;
    const text = (el.textContent || '').trim();
    return /^(編輯|Edit|刪除|Archive|新增|儲存到 GitHub|儲存)$/i.test(text) || /^＋新增/.test(text);
  };

  function applyReadOnly(root = document) {
    if (access.can_write) return;

    root.querySelectorAll?.('button').forEach(btn => {
      if (isWriteControl(btn)) btn.style.display = 'none';
    });

    document.querySelectorAll('.nav button').forEach(btn => {
      if (btn.dataset.view === 'plan' || btn.dataset.view === 'review') btn.style.display = 'none';
    });

    const active = document.querySelector('.view.active');
    if (active && (active.id === 'plan' || active.id === 'review')) {
      document.querySelector('.nav button[data-view="dashboard"]')?.click();
    }
  }

  function showRoleBadge(me) {
    const box = document.querySelector('.connection-box');
    if (!box) return;
    let badge = document.getElementById('roleBadge');
    if (!badge) {
      badge = document.createElement('span');
      badge.id = 'roleBadge';
      badge.style.cssText = 'display:inline-flex;align-items:center;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.14);font-size:11px;color:#fff;margin-left:4px;white-space:nowrap';
      box.insertBefore(badge, document.getElementById('btnReload'));
    }
    badge.textContent = `${me.role === 'PM' ? 'PM' : 'Engineer'} · ${me.repository_permission}`;
    badge.title = `GitHub: ${me.login}`;
  }

  async function initRole() {
    try {
      const me = await API.me();
      access = me;
      window.SMARTPORT_ACCESS = me;
      showRoleBadge(me);
      applyReadOnly(document);

      const observer = new MutationObserver(mutations => {
        if (access.can_write) return;
        for (const m of mutations) {
          m.addedNodes.forEach(node => {
            if (node.nodeType === 1) applyReadOnly(node);
          });
        }
      });
      observer.observe(document.body, { childList: true, subtree: true });
    } catch (_) {
      // Authentication/redirection is handled by api.js/app.js.
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initRole);
  else initRole();
})();
