(() => {
  const params = new URLSearchParams(window.location.search);
  const runtime = window.SMARTPORT_RUNTIME_CONFIG || {};
  const supplied = params.get('apiBase') || '';
  const publicSnapshotEnabled = params.get('publicSnapshot') === '1';
  const requestedBackend = params.get('backend') || runtime.backendMode || 'supabase';
  const backendMode = requestedBackend === 'local' ? 'local' : 'supabase';
  const sameOriginLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
    window.location.hostname.endsWith('.ts.net');

  window.SMARTPORT_CONFIG = {
    version: '0.8.0',
    backendMode,
    projectRepository: 'smartport-ntume/SmartPort-Project-Control',
    apiBase: backendMode === 'local' ? (supplied || (sameOriginLocal ? window.location.origin : '')) : '',
    supabase: {
      url: String(runtime.supabaseUrl || '').replace(/\/$/, ''),
      anonKey: String(runtime.supabaseAnonKey || ''),
      guestEmail: String(runtime.guestEmail || ''),
      reportBucket: String(runtime.reportBucket || 'weekly-reports')
    },
    publicSnapshot: {
      enabled: backendMode === 'local' && publicSnapshotEnabled,
      url: 'data/public-snapshot.json'
    },
    endpoints: {
      health: '/api/health',
      me: '/api/me',
      login: '/auth/login',
      logout: '/auth/logout',
      snapshot: '/api/project/snapshot',
      workPackages: '/api/project/work-packages',
      subtasks: '/api/project/subtasks',
      fsr: '/api/safety/fsr',
      checkpoints: '/api/project/checkpoints',
      proposals: '/api/reports/proposals',
      reportJobs: '/api/reports/jobs'
    }
  };
})();
