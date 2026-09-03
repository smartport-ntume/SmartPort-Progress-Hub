(() => {
  function createSmartPortSupabaseAPI(cfg) {
    const settings = cfg.supabase || {};
    const library = window.supabase;
    let currentRole = 'UNAUTHENTICATED';
    let profileCache = null;

    const configured = () => !!(
      library?.createClient &&
      /^https:\/\//i.test(settings.url || '') &&
      String(settings.anonKey || '').length > 20
    );

    const client = configured()
      ? library.createClient(settings.url, settings.anonKey, {
          auth: {
            storageKey: 'smartport.supabase.auth',
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          },
          realtime: { params: { eventsPerSecond: 5 } }
        })
      : null;

    function errorFrom(value, fallback = 'Supabase request failed') {
      const error = new Error(value?.message || value?.error_description || fallback);
      if (value?.status) error.status = Number(value.status);
      error.payload = value || null;
      return error;
    }

    function requireClient() {
      if (!client) {
        throw new Error('Supabase 尚未設定。請先填寫 js/runtime-config.js 的 Project URL、anon key 與 Guest email。');
      }
      return client;
    }

    function unauthenticated(extra = {}) {
      return {
        login: '', role: 'UNAUTHENTICATED', repository_permission: 'none',
        can_write: false, can_approve: false, can_trigger_codex: false,
        authenticated: false, ...extra
      };
    }

    function accessFrom(profile, user) {
      const role = profile?.active === false ? 'DENIED' : (profile?.role || 'DENIED');
      const login = profile?.login || user?.user_metadata?.user_name || user?.email || '';
      return {
        login,
        display_name: profile?.display_name || user?.user_metadata?.full_name || '',
        avatar_url: profile?.avatar_url || user?.user_metadata?.avatar_url || '',
        role,
        repository_permission: role === 'PM' ? 'write-via-local-agent' :
          role === 'ENGINEER' ? 'proposal-via-local-agent' :
          role === 'GUEST' ? 'supabase-snapshot-read' : 'none',
        can_write: role === 'PM',
        can_approve: role === 'PM',
        can_trigger_codex: !!profile?.can_trigger_codex && role === 'PM',
        authenticated: true,
        guest: role === 'GUEST',
        allowed_views: role === 'GUEST'
          ? ['dashboard', 'plan', 'fsr', 'cp', 'item-functions', 'reference', 'tr']
          : undefined
      };
    }

    async function getProfile(force = false) {
      const db = requireClient();
      if (profileCache && !force) return profileCache;
      const { data: authData, error: authError } = await db.auth.getSession();
      if (authError) throw errorFrom(authError);
      const user = authData?.session?.user;
      if (!user) return null;
      const { data, error } = await db
        .from('profiles')
        .select('user_id,login,display_name,avatar_url,role,can_trigger_codex,active')
        .eq('user_id', user.id)
        .maybeSingle();
      if (error) throw errorFrom(error);
      profileCache = { profile: data, user };
      return profileCache;
    }

    async function me(force = false) {
      const found = await getProfile(force);
      if (!found) {
        currentRole = 'UNAUTHENTICATED';
        return unauthenticated();
      }
      const access = accessFrom(found.profile, found.user);
      currentRole = access.role;
      return access;
    }

    async function snapshotRow(table) {
      const db = requireClient();
      if (currentRole === 'UNAUTHENTICATED') await me();
      const audience = currentRole === 'GUEST' ? 'GUEST' : 'MEMBER';
      const { data, error } = await db
        .from(table)
        .select('payload,source_commit,updated_at')
        .eq('audience', audience)
        .maybeSingle();
      if (error) throw errorFrom(error);
      if (!data?.payload) {
        throw new Error('本機 Agent 尚未發布專案快照；請先在本機執行 npm run agent。');
      }
      return {
        ...data.payload,
        source_commit: data.payload.source_commit || data.source_commit || '',
        gateway_updated_at: data.updated_at
      };
    }

    function normalizeJob(row) {
      if (!row) return null;
      return {
        id: row.id,
        type: row.kind,
        status: row.status,
        submitted_by: row.actor_login,
        result: row.result || null,
        error: row.error || null,
        created_at: row.created_at,
        started_at: row.started_at,
        completed_at: row.finished_at,
        agent_id: row.agent_id || null
      };
    }

    async function jobRow(id) {
      const { data, error } = await requireClient()
        .from('gateway_jobs')
        .select('*')
        .eq('id', id)
        .maybeSingle();
      if (error) throw errorFrom(error);
      if (!data) throw Object.assign(new Error('gateway_job_not_found'), { status: 404 });
      return data;
    }

    function settleJob(row) {
      if (row?.status === 'completed') return { done: true, value: row };
      if (row?.status === 'failed' || row?.status === 'cancelled') {
        const error = new Error(row.error || `gateway_job_${row.status}`);
        error.job = normalizeJob(row);
        return { done: true, error };
      }
      return { done: false };
    }

    async function waitForJob(id, timeoutMs = 20 * 60 * 1000) {
      const db = requireClient();
      const initial = await jobRow(id);
      const immediate = settleJob(initial);
      if (immediate.done) {
        if (immediate.error) throw immediate.error;
        return initial;
      }

      return new Promise((resolve, reject) => {
        let finished = false;
        const channelName = `smartport-job-${id}-${crypto.randomUUID()}`;
        const channel = db.channel(channelName);
        const timer = setTimeout(() => finish(new Error('local_agent_job_timeout')), timeoutMs);

        function finish(error, row) {
          if (finished) return;
          finished = true;
          clearTimeout(timer);
          db.removeChannel(channel).catch(() => {});
          if (error) reject(error);
          else resolve(row);
        }

        function inspect(row) {
          const state = settleJob(row);
          if (!state.done) return;
          finish(state.error || null, state.value || row);
        }

        channel
          .on('postgres_changes', {
            event: 'UPDATE', schema: 'public', table: 'gateway_jobs', filter: `id=eq.${id}`
          }, event => inspect(event.new))
          .subscribe(async status => {
            if (status !== 'SUBSCRIBED' && status !== 'TIMED_OUT' && status !== 'CHANNEL_ERROR') return;
            try {
              // One race-closing/catch-up read per subscription state; this is not polling.
              inspect(await jobRow(id));
            } catch (error) {
              if (status !== 'SUBSCRIBED') finish(error);
            }
          });
      });
    }

    async function enqueue(kind, payload, idempotencyKey = '') {
      const key = idempotencyKey || `${kind}:${crypto.randomUUID()}`;
      const { data, error } = await requireClient().rpc('enqueue_gateway_job', {
        p_kind: kind,
        p_payload: payload || {},
        p_idempotency_key: key
      });
      if (error) throw errorFrom(error);
      const row = Array.isArray(data) ? data[0] : data;
      if (!row?.id) throw new Error('Supabase did not return the queued job');
      return row;
    }

    async function enqueueAndWait(kind, payload) {
      const queued = await enqueue(kind, payload);
      const completed = await waitForJob(queued.id);
      return completed.result;
    }

    function decodeBase64(value) {
      const raw = atob(String(value || '').replace(/^data:[^,]+,/, '').replace(/\s/g, ''));
      const bytes = new Uint8Array(raw.length);
      for (let i = 0; i < raw.length; i += 1) bytes[i] = raw.charCodeAt(i);
      return bytes;
    }

    async function uploadWeeklyReport(payload) {
      const db = requireClient();
      const access = await me();
      if (!access.can_trigger_codex) throw Object.assign(new Error('只有被授權的 PM 可以啟動本機 Codex'), { status: 403 });
      const { data: authData } = await db.auth.getSession();
      const userId = authData?.session?.user?.id;
      if (!userId) throw new Error('authentication_required');
      const filename = String(payload?.filename || 'weekly-report.docx')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^-+|-+$/g, '') || 'weekly-report.docx';
      const bytes = decodeBase64(payload?.data_base64);
      if (!bytes.length) throw new Error('report_file_empty');
      if (bytes.length > 10 * 1024 * 1024) throw new Error('report_file_too_large_10mb_max');
      const storagePath = `${userId}/${crypto.randomUUID()}/${filename}`;
      const contentType = payload?.mime_type || 'application/octet-stream';
      const { error } = await db.storage
        .from(settings.reportBucket || 'weekly-reports')
        .upload(storagePath, new Blob([bytes], { type: contentType }), {
          contentType,
          cacheControl: '0',
          upsert: false
        });
      if (error) throw errorFrom(error);
      return {
        ok: true,
        report: {
          path: storagePath,
          storage_path: storagePath,
          filename,
          mime_type: contentType,
          size: bytes.length,
          temporary: true
        }
      };
    }

    async function analyzeWeeklyReport(payload) {
      const storagePath = String(payload?.report_path || payload?.storage_path || '');
      try {
        const uploadId = storagePath.split('/')[1] || crypto.randomUUID();
        const row = await enqueue('analyze_weekly_report', {
          storage_path: storagePath,
          filename: storagePath.split('/').pop() || 'weekly-report.docx',
          report_date: payload?.report_date || '',
          owner_team: payload?.owner_team || ''
        }, `weekly:${uploadId}`);
        return { job: normalizeJob(row) };
      } catch (error) {
        if (storagePath) {
          requireClient().storage.from(settings.reportBucket || 'weekly-reports').remove([storagePath]).catch(() => {});
        }
        throw error;
      }
    }

    async function requestPath(path, options = {}) {
      const method = String(options.method || 'GET').toUpperCase();
      const body = typeof options.body === 'string' ? JSON.parse(options.body || '{}') : (options.body || {});
      if (path === '/api/project/reference' && method === 'GET') return snapshotRow('reference_snapshots');
      if (path === '/api/project/reference/reference-model' && method === 'PUT') {
        return enqueueAndWait('write_reference_model', body);
      }
      if (path === '/api/project/reference/item-functions' && method === 'PUT') {
        return enqueueAndWait('write_item_functions', body);
      }
      if (path === '/api/project/reference/technical-requirements' && method === 'PUT') {
        return enqueueAndWait('write_technical_requirements', body);
      }
      const checkpoint = path.match(/^\/api\/project\/checkpoints\/([^/]+)$/);
      if (checkpoint && method === 'PATCH') {
        return enqueueAndWait('patch_checkpoint', {
          id: decodeURIComponent(checkpoint[1]),
          patch: body
        });
      }
      throw Object.assign(new Error(`Unsupported Supabase API path: ${method} ${path}`), { status: 404 });
    }

    if (client) {
      client.auth.onAuthStateChange(() => {
        profileCache = null;
      });
    }

    return {
      getMode: () => 'supabase',
      isConfigured: configured,
      getBase: () => settings.url || '',
      getRole: () => currentRole,
      supportsGuestPasswordChange: false,
      setBase() { throw new Error('Supabase 位址由部署設定管理，不能在瀏覽器內修改。'); },
      hasSession() { return currentRole !== 'UNAUTHENTICATED'; },
      clearSession() {
        profileCache = null;
        currentRole = 'UNAUTHENTICATED';
        if (client) client.auth.signOut().catch(() => {});
      },
      async login() {
        const db = requireClient();
        const redirectTo = window.location.href.split('#')[0].split('?code=')[0];
        const { error } = await db.auth.signInWithOAuth({
          provider: 'github',
          options: { redirectTo }
        });
        if (error) throw errorFrom(error);
      },
      async logout() {
        const db = requireClient();
        await db.auth.signOut({ scope: 'local' });
        profileCache = null;
        currentRole = 'UNAUTHENTICATED';
        window.location.replace(window.location.pathname);
      },
      async guestStatus() {
        return {
          configured: configured(),
          guest_email_configured: !!settings.guestEmail,
          mode: 'supabase'
        };
      },
      me,
      async guestLogin(password) {
        const db = requireClient();
        if (!settings.guestEmail) throw new Error('尚未設定 Supabase Guest email');
        const { error } = await db.auth.signInWithPassword({
          email: settings.guestEmail,
          password: String(password || '')
        });
        if (error) throw errorFrom(error);
        profileCache = null;
        const access = await me(true);
        if (access.role !== 'GUEST') {
          await db.auth.signOut({ scope: 'local' });
          throw Object.assign(new Error('此帳號未設定為 GUEST'), { status: 403 });
        }
        return { ok: true, role: 'GUEST' };
      },
      async changeGuestPassword() {
        throw new Error('Supabase Guest 密碼請由 Auth 管理員在 Dashboard 變更；不會把管理權限放到公開前端。');
      },
      async health() {
        const { data, error } = await requireClient()
          .from('agent_state')
          .select('*')
          .order('last_seen_at', { ascending: false })
          .limit(1)
          .maybeSingle();
        if (error) throw errorFrom(error);
        return { ok: true, mode: 'supabase', agent: data || null };
      },
      loadSnapshot: () => snapshotRow('project_snapshots'),
      loadReference: () => snapshotRow('reference_snapshots'),
      request: requestPath,
      uploadWeeklyReport,
      analyzeWeeklyReport,
      async getAnalysisJob(id) { return { job: normalizeJob(await jobRow(id)) }; },
      async waitForAnalysisJob(id) { return normalizeJob(await waitForJob(id)); },
      async publishPublicSnapshot() { return enqueueAndWait('refresh_snapshots', {}); },
      async saveWorkPackages(payload) { return enqueueAndWait('write_work_packages', payload); },
      async saveFSR(payload) { return enqueueAndWait('write_fsr', payload); },
      async saveCheckpoints(payload) { return enqueueAndWait('write_checkpoints', payload); },
      async createSubtask(payload) { return enqueueAndWait('create_subtask', payload); },
      async updateSubtask(id, payload) { return enqueueAndWait('update_subtask', { id, item: payload }); },
      async archiveSubtask(id) { return enqueueAndWait('archive_subtask', { id }); },
      async listProposals() {
        if (currentRole === 'GUEST') return { proposals: [] };
        const { data, error } = await requireClient()
          .from('proposal_snapshots')
          .select('payload')
          .eq('id', 'all')
          .maybeSingle();
        if (error) throw errorFrom(error);
        return data?.payload || { proposals: [] };
      },
      async createProposal(payload) { return enqueueAndWait('create_manual_proposal', payload); },
      async approveProposal(issueNumber) {
        return enqueueAndWait('approve_proposal', { issue_number: Number(issueNumber) });
      },
      async rejectProposal(issueNumber, reason = '') {
        return enqueueAndWait('reject_proposal', { issue_number: Number(issueNumber), reason });
      }
    };
  }

  window.createSmartPortSupabaseAPI = createSmartPortSupabaseAPI;
})();
