function checked(result, operation) {
  if (result?.error) throw new Error(`${operation}: ${result.error.message || result.error}`);
  return result?.data;
}

export function selectedProposalNumbers(values, proposals) {
  if (!Array.isArray(values)) throw new Error('invalid_weekly_proposal_selection');
  const allowed = new Set(proposals.map(p => Number(p.issue_number)));
  const selected = [...new Set(values.map(Number))];
  if (selected.some(n => !Number.isSafeInteger(n) || !allowed.has(n))) {
    throw new Error('weekly_proposal_not_in_this_analysis');
  }
  return new Set(selected);
}

export function assertExpectedProgress(proposal, record, expected) {
  if (!record) throw new Error('weekly_proposal_target_missing');
  if (Number(record.last_update_proposal) === Number(proposal.issue_number)
    && Number(record.actual_progress) === Number(proposal.progress)
    && record.status === proposal.status && (record.blocker || '') === (proposal.blocker || '')
    && (record.actual_evidence || '') === (proposal.evidence || '')) return;
  const actual = Number(record.actual_progress ?? 0);
  if (!expected || !Number.isFinite(Number(expected.progress))
    || actual !== Number(expected.progress) || String(record.status || '') !== String(expected.status || '')) {
    throw new Error(`進度已變更：${proposal.target_id}。請重新整理後檢查差異，再重試審核。`);
  }
  if (Number(proposal.progress) < actual) throw new Error(`提案進度低於目前進度：${proposal.target_id}`);
}

export class WeeklyReviewService {
  constructor({ supabase, request, automation = null }) {
    this.supabase = supabase;
    this.request = request;
    this.automation = automation;
  }

  async submission(id) {
    const row = checked(await this.supabase.from('weekly_report_submissions')
      .select('*').eq('id', id).maybeSingle(), 'weekly_submission_lookup');
    if (!row) throw new Error('weekly_submission_not_found');
    return row;
  }

  async batch(id) {
    const row = checked(await this.supabase.from('weekly_report_batches')
      .select('*').eq('id', id).maybeSingle(), 'weekly_batch_lookup');
    if (!row) throw new Error('weekly_batch_not_found');
    return row;
  }

  async assertPm(job, codex = false) {
    const profile = checked(await this.supabase.from('profiles').select('role,active,can_trigger_codex')
      .eq('user_id', job.actor_id).maybeSingle(), 'weekly_actor_lookup');
    if (!profile?.active || profile.role !== 'PM' || (codex && !profile.can_trigger_codex)) {
      throw new Error('weekly_action_no_longer_authorized');
    }
  }

  async assertAnalysis({ submission_id: id, analysis_job_id: jobId }) {
    if (!id) return;
    const row = await this.submission(id);
    if (row.is_current === false || row.review_status === 'SUPERSEDED' || row.job_id !== jobId) {
      throw new Error('weekly_submission_superseded');
    }
    if (['APPROVED','REVIEWING','REVIEW_FAILED'].includes(row.review_status)) {
      throw new Error('weekly_report_review_in_progress');
    }
  }

  async recordArchive(submission, job, report) {
    if (!report?.path?.startsWith('weekly_reports/')) throw new Error('invalid_weekly_archive');
    checked(await this.supabase.from('weekly_report_submissions').update({
      report_path: report.path, report_html_url: report.html_url || null
    }).eq('id', submission.id).eq('job_id', job.id), 'weekly_archive_record');
  }

  async supersedeObsolete(submission, job) {
    const versions = checked(await this.supabase.from('weekly_report_submissions')
      .select('id,report_path,analysis_result').eq('batch_id', submission.batch_id).eq('member_id', submission.member_id),
    'weekly_versions_lookup') || [];
    const paths = new Set(versions.map(s => s.report_path).filter(Boolean));
    const ids = new Set(versions.map(s => s.id));
    const all = (await this.request('/api/reports/proposals')).proposals || [];
    const candidates = new Map(all.map(p => [Number(p.issue_number), p]));
    // Historical report IDs remain reachable after they leave the latest 100 GitHub Issues.
    for (const version of versions) for (const saved of version.analysis_result?.proposals || []) {
      if (candidates.has(Number(saved.issue_number))) continue;
      const preview = await this.request(`/api/reports/proposals/${Number(saved.issue_number)}/preview`);
      if (preview.proposal) candidates.set(Number(saved.issue_number), preview.proposal);
    }
    for (const proposal of candidates.values()) {
      if (proposal.review_status !== 'PENDING') continue;
      if (!ids.has(proposal.source_submission_id) && !paths.has(proposal.source_report_path)) continue;
      if (proposal.source_submission_id === submission.id && proposal.source_analysis_job_id === job.id) continue;
      await this.request(`/api/reports/proposals/${proposal.issue_number}/supersede`, 'POST', {}, job.actor_login);
    }
  }

  async guardProposal(proposal, reviewJobId, action, record, expected) {
    if (!proposal.source_report_path) return;
    const row = checked(await this.supabase.from('weekly_report_submissions').select('*')
      .eq('report_path', proposal.source_report_path).maybeSingle(), 'weekly_proposal_source_lookup');
    if (!row) {
      if (proposal.source_submission_id) throw new Error('weekly_proposal_source_missing');
      return; // Existing manual/direct-upload proposals keep their original PM workflow.
    }
    if (action === 'supersede') {
      const obsolete = row.is_current === false || (['queued','running'].includes(row.status)
        && proposal.source_analysis_job_id !== row.job_id);
      if (!obsolete) throw new Error('weekly_proposal_is_current');
      return;
    }
    if (row.is_current === false || row.review_status === 'SUPERSEDED') throw new Error('weekly_submission_superseded');
    if ((proposal.source_submission_id && proposal.source_submission_id !== row.id)
      || (proposal.source_analysis_job_id && proposal.source_analysis_job_id !== (row.analysis_job_key || row.job_id))) {
      throw new Error('weekly_proposal_analysis_superseded');
    }
    if (!reviewJobId || reviewJobId !== row.review_job_id) throw new Error('請由週報管理中心審核這份週報');
    const job = checked(await this.supabase.from('gateway_jobs').select('*')
      .eq('id', reviewJobId).maybeSingle(), 'weekly_review_job_lookup');
    if (!job || job.kind !== 'review_weekly_submission' || job.status !== 'running'
      || job.payload.submission_id !== row.id
      || job.payload.analysis_job_id !== (row.analysis_job_key || row.job_id)) {
      throw new Error('weekly_review_version_changed');
    }
    await this.assertPm(job);
    const allowed = selectedProposalNumbers(job.payload.issue_numbers, row.analysis_result?.proposals || []);
    if (action === 'approve' && (job.payload.decision !== 'approve' || !allowed.has(Number(proposal.issue_number)))) {
      throw new Error('weekly_proposal_not_selected');
    }
    if (action === 'approve') assertExpectedProgress(proposal, record, expected);
  }

  async review(job) {
    await this.assertPm(job);
    const payload = job.payload;
    const row = await this.submission(payload.submission_id);
    if (row.is_current === false || row.status !== 'completed' || row.review_job_id !== job.id
      || payload.analysis_job_id !== (row.analysis_job_key || row.job_id)) {
      throw new Error('weekly_review_version_changed');
    }
    const analysisProposals = row.analysis_result?.proposals || [];
    const selected = selectedProposalNumbers(payload.issue_numbers, analysisProposals);
    if (!['approve','return'].includes(payload.decision)) throw new Error('invalid_weekly_review_decision');
    if (payload.decision === 'return' && !String(payload.feedback || '').trim()) throw new Error('return_reason_required');
    const previews = new Map();
    for (const p of analysisProposals) {
      previews.set(Number(p.issue_number), await this.request(`/api/reports/proposals/${Number(p.issue_number)}/preview`));
    }
    const reports = analysisProposals.map(p => previews.get(Number(p.issue_number))?.proposal);
    if (reports.some(p => !p || p.source_report_path !== row.report_path || p.review_status === 'SUPERSEDED')) {
      throw new Error('weekly_proposal_set_changed');
    }
    for (const proposal of reports) {
      const desired = payload.decision === 'approve' && selected.has(Number(proposal.issue_number)) ? 'APPROVED' : 'REJECTED';
      if (proposal.review_status !== 'PENDING' && proposal.review_status !== desired) {
        throw new Error('weekly_proposal_decision_conflict');
      }
    }
    // Check every selected change before the first baseline write. A later interrupted write
    // remains a failed review reservation; Resume skips decisions already recorded in GitHub.
    for (const proposal of reports) {
      if (payload.decision !== 'approve' || !selected.has(Number(proposal.issue_number)) || proposal.review_status === 'APPROVED') continue;
      if (proposal.review_status !== 'PENDING') throw new Error('weekly_proposal_already_rejected');
      const preview = previews.get(Number(proposal.issue_number));
      assertExpectedProgress(proposal, preview.record, payload.expected?.[proposal.issue_number]);
    }
    const decisions = [];
    for (const proposal of reports) {
      const approve = payload.decision === 'approve' && selected.has(Number(proposal.issue_number));
      const terminal = approve ? 'APPROVED' : 'REJECTED';
      if (proposal.review_status === 'PENDING') {
        await this.request(`/api/reports/proposals/${proposal.issue_number}/${approve ? 'approve' : 'reject'}`, 'POST', {
          weekly_review_job_id: job.id,
          expected_current: payload.expected?.[proposal.issue_number],
          reason: String(payload.feedback || 'PM 完成整份審核；此項未列入核准更新。').slice(0,4000)
        }, job.actor_login);
      } else if (proposal.review_status !== terminal) {
        throw new Error('weekly_proposal_decision_conflict');
      }
      decisions.push({ issue_number: proposal.issue_number, status: terminal });
      checked(await this.supabase.from('weekly_report_submissions').update({
        review_result: { request: payload, decisions: [...decisions], job_id: job.id }
      }).eq('id', row.id).eq('review_job_id', job.id), 'weekly_review_checkpoint');
    }
    const review = {
      review_status: payload.decision === 'approve' ? 'APPROVED' : 'CHANGES_REQUESTED',
      pm_feedback: String(payload.feedback || '').slice(0,4000),
      reviewed_at: new Date().toISOString(), reviewed_by: job.actor_id,
      review_result: { request: payload, decisions, job_id: job.id }, error: null
    };
    checked(await this.supabase.from('weekly_report_submissions').update(review)
      .eq('id', row.id).eq('review_job_id', job.id).eq('is_current', true), 'weekly_review_save');
    return { ok: true, submission_id: row.id, ...review };
  }

  async manageBatch(job) {
    await this.assertPm(job);
    const batch = await this.batch(job.payload.batch_id);
    if (job.payload.action === 'extend') {
      const due = new Date(job.payload.due_at);
      if (!Number.isFinite(+due)) throw new Error('invalid_weekly_deadline');
      // Same job can safely resume after a successful update with a lost acknowledgment.
      if (+due < +new Date(batch.due_at)) throw new Error('extension_must_be_later');
      checked(await this.supabase.from('weekly_report_batches').update({
        due_at: due.toISOString(), accept_until: new Date(Math.max(+new Date(batch.accept_until), +due + 7*86400000)).toISOString(),
        status: 'OPEN'
      }).eq('id', batch.id), 'weekly_deadline_update');
      return { ok: true, due_at: due.toISOString() };
    }
    if (job.payload.action === 'resend') {
      if (!this.automation) throw new Error('weekly_discord_automation_not_configured');
      return this.automation.resendBatch(batch.id, job.id);
    }
    throw new Error('unsupported_weekly_batch_action');
  }
}
