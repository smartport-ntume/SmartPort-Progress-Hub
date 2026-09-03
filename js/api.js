(() => {
  const cfg = window.SMARTPORT_CONFIG;
  let currentRole='UNAUTHENTICATED';
  const LEGACY_CLOUDFLARE_BASE='https://smartport-progress-hub-api.zf20000302.workers.dev';

  function normalizeBase(value) {
    const raw=String(value||'').trim().replace(/\/$/,'');
    if(!raw)return '';
    const parsed=new URL(raw,window.location.href);
    const loopback=['localhost','127.0.0.1'].includes(parsed.hostname);
    if(parsed.protocol!=='https:'&&!(parsed.protocol==='http:'&&loopback)){
      throw new Error('本機後端請使用 Tailscale HTTPS；只有 localhost 可以使用 HTTP');
    }
    return parsed.origin+parsed.pathname.replace(/\/$/,'');
  }

  try{
    const supplied=new URLSearchParams(window.location.search).get('apiBase');
    if(supplied)localStorage.setItem('smartport.apiBase',normalizeBase(supplied));
  }catch(_){}

  function base() {
    const saved = localStorage.getItem('smartport.apiBase');
    if(saved?.replace(/\/$/,'')===LEGACY_CLOUDFLARE_BASE){
      localStorage.removeItem('smartport.apiBase');
      return (cfg.apiBase||'').replace(/\/$/,'');
    }
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
      const err = new Error(parsed?.message || parsed?.error || detail || `API ${res.status}`);
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

  function publicSnapshotViewer() {
    return {
      login:'Public Snapshot',role:'GUEST',repository_permission:'public-snapshot',
      can_write:false,can_approve:false,can_trigger_codex:false,authenticated:false,
      guest:true,public_snapshot:true,allowed_views:['dashboard','plan','fsr','cp']
    };
  }

  async function loadPublicSnapshot() {
    const res=await fetch(cfg.publicSnapshot.url,{cache:'no-store'});
    if(!res.ok)throw new Error(`Public snapshot ${res.status}`);
    const snapshot=await res.json();
    if(snapshot?.kind!=='smartport_public_snapshot')throw new Error('Public snapshot format is invalid');
    return snapshot;
  }

  captureSessionFromHash();

  window.SmartPortAPI = {
    getBase: base,
    getRole() { return currentRole; },
    setBase(url) {
      const normalized=normalizeBase(url);
      if(normalized)localStorage.setItem('smartport.apiBase',normalized);
      else localStorage.removeItem('smartport.apiBase');
      return normalized;
    },
    login() {
      const returnTo=window.location.href.split('#')[0];
      window.location.href=base()+cfg.endpoints.login+'?return_to='+encodeURIComponent(returnTo);
    },
    logout() {
      const returnTo=window.location.href.split('#')[0];
      clearSession();
      window.location.href=base()+cfg.endpoints.logout+'?return_to='+encodeURIComponent(returnTo);
    },
    clearSession,
    hasSession() { return !!sessionToken(); },
    async health() { return request(cfg.endpoints.health); },
    async guestStatus() { return request('/api/guest/status'); },
    async me() {
      if(cfg.publicSnapshot.enabled){currentRole='GUEST';return publicSnapshotViewer();}
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
    async uploadWeeklyReport(payload) {
      return request('/api/reports/upload', { method:'POST', body:JSON.stringify(payload) });
    },
    async analyzeWeeklyReport(payload) {
      return request('/api/reports/analyze', { method:'POST', body:JSON.stringify(payload) });
    },
    async getAnalysisJob(id) {
      return request(`${cfg.endpoints.reportJobs}/${encodeURIComponent(id)}`);
    },
    async publishPublicSnapshot() {
      return request('/api/admin/public-snapshot', { method:'POST' });
    },
    async loadSnapshot() {
      if(cfg.publicSnapshot.enabled)return loadPublicSnapshot();
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
    async rejectProposal(issueNumber, reason='') { return request(`${cfg.endpoints.proposals}/${encodeURIComponent(issueNumber)}/reject`, { method:'POST', body:JSON.stringify({ reason }) }); }
  };
})();
