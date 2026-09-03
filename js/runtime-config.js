// Deployment values are public browser configuration, not secrets.
// Never put SUPABASE_SERVICE_ROLE_KEY, GitHub tokens, or Codex credentials here.
window.SMARTPORT_RUNTIME_CONFIG = Object.freeze({
  backendMode: 'supabase',
  supabaseUrl: '',
  supabaseAnonKey: '',
  guestEmail: '',
  reportBucket: 'weekly-reports'
});
