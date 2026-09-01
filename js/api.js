(() => {
  const cfg = window.SMARTPORT_CONFIG;
  let publicMode = false;

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

  function sessionToken() {
    return sessionStorage.getItem('smartport.session') || '';
  }

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

    if (res.status === 401) {
      const err = new Error('unauthorized');
      err.status = 401;
      throw err;
    }

    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      const err = new Error(`API ${res.status}${detail ? ': ' + detail : ''}`);
      err.status = res.status;
      throw err;
    }
    if (res.status === 204) return null;
    return res.json();
  }

  async function publicSnapshot() {
    const url = new URL('data/public_snapshot.json', window.location.href);
    url.searchParams.set('v', window.SMARTPORT_BUILD || Date.now());
    const res = await fetch(url.toString(), { cache: 'no-store' });
    if (!res.ok) throw new Error(`Public snapshot ${res.status}`);
    return res.json();
  }

  captureSessionFromHash();

  window.SmartPortAPI = {
    getBase: base,
    setBase(url) { localStorage.setItem('smartport.apiBase', (url || '').trim().replace(/\/$/, '')); },
    login() { window.location.href = base() + cfg.endpoints.login; },
    logout() { sessionStorage.removeItem('smartport.session'); window.location.href = base() + cfg.endpoints.logout; },
    hasSession() { return !!sessionToken(); },
    isPublicMode() { return publicMode; },
    async health() { return request(cfg.endpoints.health); },
    async me() {
      try {
        const me = await request(cfg.endpoints.me);
        publicMode = false;
        return me;
      } catch (e) {
        if (e?.status !== 401) throw e;
        sessionStorage.removeItem('smartport.session');
        publicMode = true;
        return {
          login: 'Public View',
          role: 'PUBLIC',
          repository_permission: 'public-read',
          can_write: false,
          can_approve: false,
          public: true
        };
      }
    },
    async loadSnapshot() {
      if (publicMode) return publicSnapshot();
      try {
        return await request(cfg.endpoints.snapshot);
      } catch (e) {
        if (e?.status !== 401) throw e;
        publicMode = true;
        return publicSnapshot();
      }
    },
    async saveWorkPackages(payload) { return request(cfg.endpoints.workPackages, { method: 'PUT', body: JSON.stringify(payload) }); },
    async saveFSR(payload) { return request(cfg.endpoints.fsr, { method: 'PUT', body: JSON.stringify(payload) }); },
    async saveCheckpoints(payload) { return request(cfg.endpoints.checkpoints, { method: 'PUT', body: JSON.stringify(payload) }); },
    async createSubtask(payload) { return request(cfg.endpoints.subtasks, { method: 'POST', body: JSON.stringify(payload) }); },
    async updateSubtask(id, payload) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }); },
    async archiveSubtask(id) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method: 'DELETE' }); },
    async listProposals() { return request(cfg.endpoints.proposals); },
    async createProposal(payload) { return request(cfg.endpoints.proposals, { method: 'POST', body: JSON.stringify(payload) }); },
    async approveProposal(issueNumber) { return request(`${cfg.endpoints.proposals}/${encodeURIComponent(issueNumber)}/approve`, { method: 'POST' }); },
    async rejectProposal(issueNumber, reason='') { return request(`${cfg.endpoints.proposals}/${encodeURIComponent(issueNumber)}/reject`, { method: 'POST', body: JSON.stringify({ reason }) }); },
    async restoreV041Subtasks() { return request('/api/admin/restore-v041-subtasks', { method: 'POST' }); }
  };
})();
