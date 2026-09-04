// Public deployment configuration. Secrets stay in the server-side .env.local.
window.SMARTPORT_RUNTIME_CONFIG = Object.freeze({
  backendMode: 'local',
  lockBackend: true,
  apiBase: 'same-origin',
  lockApiBase: true
});
