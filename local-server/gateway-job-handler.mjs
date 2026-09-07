function boundedActor(value) {
  const actor = String(value || '').trim();
  return /^[A-Za-z0-9][A-Za-z0-9_.@-]{0,99}$/.test(actor) ? actor : 'supabase-user';
}

function numericIssue(value) {
  const issue = Number(value);
  if (!Number.isInteger(issue) || issue < 1) throw new Error('invalid_issue_number');
  return issue;
}

export class GatewayJobHandler {
  constructor({ app, env, internalBearer, supabase, reportBucket = 'weekly-reports' }) {
    this.app = app;
    this.env = env;
    this.internalBearer = internalBearer;
    this.supabase = supabase;
    this.reportBucket = reportBucket;
  }

  async request(path, method = 'GET', payload = null, actor = 'supabase-user') {
    const request = new Request('http://local-agent' + path, {
      method,
      headers: {
        Authorization: `Bearer ${this.internalBearer}`,
        'Content-Type': 'application/json',
        'X-SmartPort-Actor': boundedActor(actor)
      },
      ...(['GET', 'HEAD'].includes(method) || payload == null
        ? {}
        : { body: JSON.stringify(payload) })
    });
    const response = await this.app.fetch(request, this.env, {});
    const text = response.status === 204 ? '' : await response.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; }
    catch (_) { body = text; }
    if (!response.ok) {
      const message = typeof body === 'string'
        ? body
        : body?.message || body?.error || `Internal API ${response.status}`;
      const error = new Error(message);
      error.status = response.status;
      error.payload = body;
      throw error;
    }
    return body ?? { ok: true };
  }

  async analyzeWeeklyReport(job) {
    const payload = job.payload || {};
    const storagePath = String(payload.storage_path || '');
    if (!storagePath || !storagePath.startsWith(job.actor_id + '/')) {
      throw new Error('invalid_weekly_report_storage_path');
    }
    const filename = String(payload.filename || storagePath.split('/').pop() || 'weekly-report.docx');
    const { data, error } = await this.supabase.storage.from(this.reportBucket).download(storagePath);
    if (error) throw new Error('weekly_report_download_failed: ' + error.message);
    const buffer = Buffer.from(await data.arrayBuffer());
    if (!buffer.length) throw new Error('report_file_empty');
    if (buffer.length > 10 * 1024 * 1024) throw new Error('report_file_too_large_10mb_max');

    const upload = await this.request('/api/reports/upload', 'POST', {
      report_date: payload.report_date,
      owner_team: payload.owner_team,
      filename,
      mime_type: data.type || 'application/octet-stream',
      size: buffer.length,
      data_base64: buffer.toString('base64')
    }, job.actor_login);

    let temporaryDeleteWarning = '';
    const removed = await this.supabase.storage.from(this.reportBucket).remove([storagePath]);
    if (removed.error) temporaryDeleteWarning = 'temporary_storage_delete_failed: ' + removed.error.message;

    const result = await this.request('/api/reports/analyze', 'POST', {
      report_date: payload.report_date,
      owner_team: payload.owner_team,
      report_path: upload.report.path
    }, job.actor_login);
    return {
      ...result,
      report: { ...(result.report || {}), ...upload.report, temporary: false },
      ...(temporaryDeleteWarning ? { gateway_warning: temporaryDeleteWarning } : {})
    };
  }

  async handle(job) {
    const payload = job.payload || {};
    switch (job.kind) {
      case 'write_work_packages':
        return this.request('/api/project/work-packages', 'PUT', payload, job.actor_login);
      case 'write_fsr':
        return this.request('/api/safety/fsr', 'PUT', payload, job.actor_login);
      case 'write_checkpoints':
        return this.request('/api/project/checkpoints', 'PUT', payload, job.actor_login);
      case 'create_subtask':
        return this.request('/api/project/subtasks', 'POST', payload, job.actor_login);
      case 'update_subtask':
        return this.request(
          `/api/project/subtasks/${encodeURIComponent(String(payload.id || ''))}`,
          'PUT', payload.item || {}, job.actor_login
        );
      case 'archive_subtask':
        return this.request(
          `/api/project/subtasks/${encodeURIComponent(String(payload.id || ''))}`,
          'DELETE', null, job.actor_login
        );
      case 'patch_checkpoint':
        return this.request(
          `/api/project/checkpoints/${encodeURIComponent(String(payload.id || ''))}`,
          'PATCH', payload.patch || {}, job.actor_login
        );
      case 'write_reference_model':
        return this.request('/api/project/reference/reference-model', 'PUT', payload, job.actor_login);
      case 'write_item_functions':
        return this.request('/api/project/reference/item-functions', 'PUT', payload, job.actor_login);
      case 'write_technical_requirements':
        return this.request('/api/project/reference/technical-requirements', 'PUT', payload, job.actor_login);
      case 'create_manual_proposal':
        return this.request('/api/reports/proposals', 'POST', payload, job.actor_login);
      case 'approve_proposal':
        return this.request(
          `/api/reports/proposals/${numericIssue(payload.issue_number)}/approve`,
          'POST', {}, job.actor_login
        );
      case 'reject_proposal':
        return this.request(
          `/api/reports/proposals/${numericIssue(payload.issue_number)}/reject`,
          'POST', { reason: String(payload.reason || '').slice(0, 4000) }, job.actor_login
        );
      case 'analyze_weekly_report':
        return this.analyzeWeeklyReport(job);
      case 'refresh_snapshots':
        return { ok: true, refresh_requested: true };
      default:
        throw new Error('unsupported_gateway_job_kind: ' + job.kind);
    }
  }

  async listProposals() {
    return this.request('/api/reports/proposals', 'GET', null, 'supabase-agent');
  }
}
