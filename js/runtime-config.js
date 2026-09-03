// Deployment values are public browser configuration, not secrets.
// Never put SUPABASE_SERVICE_ROLE_KEY, GitHub tokens, or Codex credentials here.
window.SMARTPORT_RUNTIME_CONFIG = Object.freeze({
  backendMode: 'supabase',
  supabaseUrl: 'https://omnevhesguhofipvfccf.supabase.co',
  supabaseAnonKey: 'sb_publishable_yGqV5RVgSBegesB2dazjLg_f1HqnrXQ',
  guestEmail: '',
  reportBucket: 'weekly-reports'
});
