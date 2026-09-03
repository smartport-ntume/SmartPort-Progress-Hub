function message(error) {
  return String(error?.message || error || 'unknown_error').slice(0, 8000);
}

function returnedRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data?.id ? data : null;
}

export class SupabaseRealtimeAgent {
  constructor({ supabase, agentId, version = '', handleJob, logger = console }) {
    this.supabase = supabase;
    this.agentId = agentId;
    this.version = version;
    this.handleJob = handleJob;
    this.logger = logger;
    this.channel = null;
    this.pendingIds = new Set();
    this.chain = Promise.resolve();
    this.catchUpPromise = null;
    this.stopped = false;
    this.currentJobId = null;
  }

  async updateState(status, extra = {}) {
    const now = new Date().toISOString();
    const { error } = await this.supabase.from('agent_state').upsert({
      agent_id: this.agentId,
      status,
      version: this.version,
      current_job_id: extra.currentJobId ?? this.currentJobId,
      last_error: extra.lastError ?? null,
      connected_at: extra.connectedAt || undefined,
      last_seen_at: now,
      updated_at: now
    }, { onConflict: 'agent_id' });
    if (error) throw new Error('agent_state_update_failed: ' + error.message);
  }

  schedule(jobId) {
    if (this.stopped || !jobId || this.pendingIds.has(jobId)) return;
    this.pendingIds.add(jobId);
    this.chain = this.chain
      .then(() => this.process(jobId))
      .catch(error => this.logger.error('[gateway] queue error:', message(error)))
      .finally(() => this.pendingIds.delete(jobId));
  }

  async catchUp() {
    if (this.catchUpPromise) return this.catchUpPromise;
    this.catchUpPromise = (async () => {
      const { data, error } = await this.supabase
        .from('gateway_jobs')
        .select('id')
        .eq('status', 'queued')
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) throw new Error('gateway_catch_up_failed: ' + error.message);
      for (const row of data || []) this.schedule(row.id);
    })().finally(() => { this.catchUpPromise = null; });
    return this.catchUpPromise;
  }

  async process(jobId) {
    if (this.stopped) return;
    const claimed = await this.supabase.rpc('claim_gateway_job', {
      p_job_id: jobId,
      p_agent_id: this.agentId
    });
    if (claimed.error) throw new Error('gateway_job_claim_failed: ' + claimed.error.message);
    const job = returnedRow(claimed.data);
    if (!job) return;

    this.currentJobId = job.id;
    await this.updateState('busy', { currentJobId: job.id });
    this.logger.info(`[gateway] running ${job.kind} ${job.id} (${job.actor_login})`);

    try {
      const result = await this.handleJob(job);
      const completed = await this.supabase
        .from('gateway_jobs')
        .update({
          status: 'completed',
          result: result ?? { ok: true },
          error: null,
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id)
        .eq('status', 'running');
      if (completed.error) throw new Error('gateway_job_complete_failed: ' + completed.error.message);
      this.logger.info(`[gateway] completed ${job.kind} ${job.id}`);
    } catch (error) {
      const failure = message(error);
      const failed = await this.supabase
        .from('gateway_jobs')
        .update({
          status: 'failed',
          error: failure,
          finished_at: new Date().toISOString()
        })
        .eq('id', job.id)
        .eq('status', 'running');
      if (failed.error) this.logger.error('[gateway] failed to record job error:', failed.error.message);
      this.logger.error(`[gateway] failed ${job.kind} ${job.id}: ${failure}`);
    } finally {
      this.currentJobId = null;
      await this.updateState('online', { currentJobId: null }).catch(error => {
        this.logger.error('[gateway] agent state error:', message(error));
      });
    }
  }

  async start() {
    this.stopped = false;
    const connectedAt = new Date().toISOString();
    await this.updateState('online', { connectedAt, currentJobId: null });

    return new Promise((resolve, reject) => {
      let settled = false;
      const timeout = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('Supabase Realtime subscription timed out'));
        }
      }, 20_000);

      this.channel = this.supabase
        .channel(`smartport-agent-${this.agentId}`)
        .on('postgres_changes', {
          event: 'INSERT', schema: 'public', table: 'gateway_jobs'
        }, event => this.schedule(event.new?.id))
        .subscribe(status => {
          if (status === 'SUBSCRIBED') {
            if (!settled) {
              settled = true;
              clearTimeout(timeout);
              resolve();
            }
            this.updateState('online', { connectedAt, currentJobId: this.currentJobId })
              .catch(error => this.logger.error('[gateway] agent state error:', message(error)));
            // One catch-up after startup/reconnect closes event-delivery gaps. No timer polls the table.
            this.catchUp().catch(error => this.logger.error('[gateway] catch-up error:', message(error)));
          } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
            this.updateState('error', { lastError: `Realtime ${status}` })
              .catch(() => {});
          }
        });
    });
  }

  async stop() {
    this.stopped = true;
    if (this.channel) {
      await this.supabase.removeChannel(this.channel).catch(() => {});
      this.channel = null;
    }
    await this.updateState('offline', { currentJobId: this.currentJobId }).catch(() => {});
  }
}
