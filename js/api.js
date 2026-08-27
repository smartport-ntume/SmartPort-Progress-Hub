(() => {
  const cfg = window.SMARTPORT_CONFIG;

  function base() {
    const saved = localStorage.getItem('smartport.apiBase');
    return (saved || cfg.apiBase || '').replace(/\/$/, '');
  }

  async function request(path, options = {}) {
    const root = base();
    if (!root) throw new Error('尚未設定 Auth/API Base URL');
    const res = await fetch(root + path, {
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    if (!res.ok) {
      let detail = '';
      try { detail = await res.text(); } catch (_) {}
      throw new Error(`API ${res.status}${detail ? ': ' + detail : ''}`);
    }
    if (res.status === 204) return null;
    return res.json();
  }

  window.SmartPortAPI = {
    getBase: base,
    setBase(url) { localStorage.setItem('smartport.apiBase', (url || '').trim().replace(/\/$/, '')); },
    async health() { return request(cfg.endpoints.health); },
    async loadSnapshot() { return request(cfg.endpoints.snapshot); },
    async saveWorkPackages(payload) { return request(cfg.endpoints.workPackages, { method: 'PUT', body: JSON.stringify(payload) }); },
    async saveFSR(payload) { return request(cfg.endpoints.fsr, { method: 'PUT', body: JSON.stringify(payload) }); },
    async saveCheckpoints(payload) { return request(cfg.endpoints.checkpoints, { method: 'PUT', body: JSON.stringify(payload) }); },
    async createSubtask(payload) { return request(cfg.endpoints.subtasks, { method: 'POST', body: JSON.stringify(payload) }); },
    async updateSubtask(id, payload) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method: 'PUT', body: JSON.stringify(payload) }); },
    async archiveSubtask(id) { return request(`${cfg.endpoints.subtasks}/${encodeURIComponent(id)}`, { method: 'DELETE' }); }
  };
})();
