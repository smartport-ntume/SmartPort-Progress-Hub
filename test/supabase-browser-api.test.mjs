import test from 'node:test';
import assert from 'node:assert/strict';

test('browser Supabase adapter derives UI permissions only from the protected profile', async t => {
  const previousWindow = globalThis.window;
  t.after(() => { globalThis.window = previousWindow; });
  const user = {
    id: 'user-1',
    email: 'vincent@example.com',
    user_metadata: { user_name: 'untrusted-metadata-login' }
  };
  const profile = {
    user_id: 'user-1', login: 'vincent', display_name: 'Vincent', avatar_url: '',
    role: 'PM', can_trigger_codex: true, active: true
  };
  const client = {
    auth: {
      async getSession() { return { data: { session: { user } }, error: null }; },
      onAuthStateChange() { return { data: { subscription: { unsubscribe() {} } } }; }
    },
    from(table) {
      assert.equal(table, 'profiles');
      const query = {
        select() { return query; },
        eq() { return query; },
        async maybeSingle() { return { data: profile, error: null }; }
      };
      return query;
    }
  };
  globalThis.window = {
    supabase: { createClient: () => client },
    location: { href: 'https://example.test/' }
  };

  await import('../js/supabase-api.js?test=permissions');
  const api = globalThis.window.createSmartPortSupabaseAPI({
    supabase: {
      url: 'https://example.supabase.co',
      anonKey: 'publishable-key-with-enough-length',
      guestEmail: 'guest@example.com'
    }
  });
  const access = await api.me();
  assert.equal(access.login, 'vincent');
  assert.equal(access.role, 'PM');
  assert.equal(access.can_write, true);
  assert.equal(access.can_approve, true);
  assert.equal(access.can_trigger_codex, true);
  assert.equal(access.repository_permission, 'write-via-local-agent');
});
