(() => {
  const cfg = window.SMARTPORT_CONFIG;
  let currentRole='UNAUTHENTICATED';

  function base() {
    const saved = localStorage.getItem('smartport.apiBase');
    return (saved || cfg.apiBase || '').replace(/\/$/, '');
  }

  function captureSessionFromHash() {
    const raw = window.location.hash || '';
    if (!raw.startsWith('#sp_session=')) return;
    const token = decodeURIComponent(raw.slice('#sp_session='.length));
    if (token) sessionStorage.setItem('smartport.session', token);
    history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function sessionToken() { return sessionStorage.getItem('smartport.session') || ''; }
  function clearSession() { sessionStorage.removeItem('smartport.session'); currentRole='UNAUTHENTICATED'; }

  async function request(path, options = {}) {
    const root = base();
    if (!root) throw new Error('尚未設定 Auth/API Base URL');
    const token = sessionToken();
    const res = await fetch(root + path, {
      credentials: 'include',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
        ...(options.headers || {})
      },
      ...options
    });

    if (!res.ok) {
      let detail = '', parsed = null;
      try { detail = await res.text(); parsed = detail ? JSON.parse(detail) : null; } catch (_) {}
      const err = new Error(parsed?.error || parsed?.message || detail || `API ${res.status}`);
      err.status = res.status;
      err.payload = parsed;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  function unauthenticated(extra={}) {
    return { login:'', role:'UNAUTHENTICATED', repository_permission:'none', can_write:false, can_approve:false, authenticated:false, ...extra };
  }

  captureSessionFromHash();

  window.SmartPortAPI = {
    getBase: base,
    getRole() { return currentRole; },
    setBase(url) { localStorage.setItem('smartport.apiBase', (url || '').trim().replace(/\/$/, '')); },
    login() { window.location.href = base() + cfg.endpoints.login; },
    logout() { clearSession(); window.location.href = base() + cfg.endpoints.logout; },
    clearSession,
    hasSession() { return !!sessionToken(); },
    async health() { return request(cfg.endpoints.health); },
    async me() {
      if (!sessionToken()) { currentRole='UNAUTHENTICATED'; return unauthenticated(); }
      try {
        const me=await request(cfg.endpoints.me);
        currentRole=me.role||'ENGINEER';
        return me;
      } catch (e) {
        if (e?.status === 401) {
          clearSession();
          return unauthenticated();
        }
        if (e?.status === 403 && e?.payload?.error === 'organization_membership_required') {
          clearSession();
          currentRole='DENIED';
          return unauthenticated({ role:'DENIED', denied_reason:'organization_membership_required', organization:e.payload.organization || 'smartport-ntume' });
        }
        throw e;
      }
    },
    async guestLogin(password) {
      const data = await request('/api/guest/login', { method:'POST', body:JSON.stringify({ password }) });
      if (data?.session) {
        sessionStorage.setItem('smartport.session', data.session);
        currentRole='GUEST';
      }
      return data;
    },
    async changeGuestPassword(password) {
      return request('/api/admin/guest-password', { method:'PUT', body:JSON.stringify({ password }) });
    },
    async loadSnapshot() {
      if (!sessionToken()) return { project:{name:'SmartPort SC'}, work_packages:[], subtasks:[], functional_safety_requirements:[], checkpoints:[] };
      return request(cfg.endpoints.snapshot);
    },
    async saveWorkPackages(payload) { return request(cfg.endpoints.workPackages, { method:'PUT', body:JSON.stringify(payload) }); },
    async saveFSR(payload) { return request(cfg.endpoints.fsr, { method:'PUT', body:JSON.stringify(payload) }); },
    async saveCheckpoints(payload) { return request(cfg.endpoints.checkpoints, { method:'PUT', body:JSON.stringify(payload) }); },
    async createSubtask(payload) { return request(cfg.endpoints.subtasks, { method:'POST', body:JSON.stringify(payload) }); },
    async updateSubtask(id, payload) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method:'PUT', body:JSON.stringify(payload) }); },
    async archiveSubtask(id) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method:'DELETE' }); },
    async listProposals() { return currentRole==='GUEST' ? {proposals:[]} : request(cfg.endpoints.proposals); },
    async createProposal(payload) { return request(cfg.endpoints.proposals, { method:'POST', body:JSON.stringify(payload) }); },
    async approveProposal(issueNumber) { return request(`${cfg.endpoints.proposals}/${encodeURIComponent(issueNumber)}/approve`, { method:'POST' }); },
    async rejectProposal(issueNumber, reason='') { return request(`${cfg.endpoints.proposals}/${encodeURIComponent(issueNumber)}/reject`, { method:'POST', body:JSON.stringify({ reason }) }); },
    async restoreV041Subtasks() { return request('/api/admin/restore-v041-subtasks', { method:'POST' }); }
  };
})();
