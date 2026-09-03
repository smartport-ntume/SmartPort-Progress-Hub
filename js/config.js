(() => {
  const params = new URLSearchParams(window.location.search);
  const supplied = params.get('apiBase') || '';
  const publicSnapshotEnabled = params.get('publicSnapshot') === '1';
  const sameOriginLocal = ['localhost', '127.0.0.1'].includes(window.location.hostname) ||
    window.location.hostname.endsWith('.ts.net');

  window.SMARTPORT_CONFIG = {
    version: '0.7.0',
    backendMode: 'local',
    projectRepository: 'smartport-ntume/SmartPort-Project-Control',
    apiBase: supplied || (sameOriginLocal ? window.location.origin : ''),
    publicSnapshot: {
      enabled: publicSnapshotEnabled,
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
