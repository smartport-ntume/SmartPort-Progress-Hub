export const WEEKLY_PROPOSAL_STATUSES = ['In Progress', 'On Track', 'At Risk', 'Blocked', 'Delayed', 'Completed'];

// Both the local Codex runner and the API reviewer use the same mapping policy.
export const WEEKLY_PROPOSAL_RULES = [
  'A proposed update is a candidate for PM review, not a certification that acceptance tests passed.',
  'Group missing_items and actions into review.task_feedback using the exact SUBTASK or WP ID from project context. Use GENERAL with target_id empty only for feedback that cannot be assigned to one task. Do not duplicate task-specific feedback as GENERAL.',
  'For each scoped task with concrete reported work, an explicit task-completion percentage, a current blocker, or a changed status, create one proposal citing the report text in evidence.',
  'Do not suppress all proposals because current actual_progress is null, evidence links are missing, or acceptance is still pending.',
  'An explicit self-reported TASK COMPLETION percentage may be proposed in progress and recorded in reported_progress; identify it as self-reported and describe missing verification in verification_note. PM approval is still required.',
  'Do not convert readiness scores, confidence, interface readiness, or sub-step completion into overall task completion percentages.',
  'If no defensible task-completion percentage is available, set progress to null: this preserves the current actual_progress, including an unknown/null value. Still propose the concrete work record, blocker or status.',
  'Use status In Progress for explicitly ongoing work; use null when no status change is supported. Missing evidence alone does not prove Blocked or Delayed.',
  'Use blocker null to preserve the current blocker; an empty string clears it only when the report explicitly says it is resolved.',
  'Use reported_progress only for an explicit task-completion percentage, never a readiness score. Use null if absent.',
  'Separate concrete reported facts in summary/evidence from unverified claims, missing acceptance evidence and recommendations in verification_note.',
  'For example: a task self-reports 100% but lacks acceptance records -> propose the self-reported 100% with a verification note for PM, not zero proposals.',
  'For example: remote E-stop was tested but local E-stop is pending, with no task-completion percentage -> propose a work record with progress null, not 100% completion.',
  'Progress is an absolute percentage, not a weekly delta. Preserve a lower explicit self-report too: PM can correct the final percentage before approval.',
  'Prefer SUBTASK updates for identifiable tasks; use WP only for whole-package evidence. Stay within owner_teams. required_scope_subtask_ids is a coverage checklist, not an exclusion filter: include concrete current-week work or explicit completion claims for other owned tasks too, including already-completed tasks needing correction.',
  'Template prompts, unchecked boxes, blank fields, planned future work and reviewer recommendations alone are not reported accomplishments.',
  'Carried-forward PM feedback is a historical review, not new accomplishments; map only the member\'s concrete responses and current-week work, never the unchanged feedback itself.',
  'Do not invent evidence, blockers, tests, dates, completion percentages, or targets. Return no proposals only when the report contains no concrete in-scope updates.'
].join(' ');

function boundedText(value, field, max) {
  const text = String(value ?? '');
  if (text.length > max) throw new Error(`codex_output_${field}_too_long`);
  return text;
}

function percent(value, field) {
  if (value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 100) throw new Error(`invalid_${field}`);
  return value;
}

export function normalizeWeeklyProposal(value, index = 0) {
  const type = String(value?.target_type || '').toUpperCase();
  if (!['WP', 'SUBTASK'].includes(type)) throw new Error('invalid_target_type_at_' + index);
  const targetId = boundedText(value?.target_id, 'target_id', 128).trim();
  if (!targetId) throw new Error('missing_target_id_at_' + index);
  const progress = percent(value?.progress, 'progress_at_' + index);
  const reported = percent(value?.reported_progress ?? null, 'reported_progress_at_' + index);
  const status = value?.status === null ? null : String(value?.status || '');
  if (status !== null && !WEEKLY_PROPOSAL_STATUSES.includes(status)) throw new Error('invalid_status_at_' + index);
  const confidence = Number(value?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) throw new Error('invalid_confidence_at_' + index);
  const evidence = boundedText(value?.evidence, 'evidence', 12_000);
  const summary = boundedText(value?.summary, 'summary', 8_000);
  if (progress === null && (!evidence.trim() || !summary.trim())) throw new Error('work_record_requires_report_evidence_at_' + index);
  return {
    target_type: type, target_id: targetId, progress, reported_progress: reported, status,
    blocker: value?.blocker === null ? null : boundedText(value?.blocker, 'blocker', 4_000),
    evidence, summary, confidence,
    rationale: boundedText(value?.rationale, 'rationale', 8_000),
    verification_note: boundedText(value?.verification_note, 'verification_note', 4_000)
  };
}

export function withPmProgress(proposal, overrides = {}, record = {}) {
  if (!Object.hasOwn(overrides, String(proposal.issue_number))) return proposal;
  const progress = percent(overrides[proposal.issue_number], 'pm_progress');
  return { ...proposal, original_progress: proposal.progress, pm_progress: progress, progress,
    status: progress === null && proposal.status === 'Completed' ? null
      : progress !== null && progress < 100 && (proposal.status === 'Completed' || proposal.status == null && record.status === 'Completed')
        ? 'In Progress' : proposal.status };
}

export function validateProgressOverrides(overrides, proposals) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides)) throw new Error('invalid_pm_progress_overrides');
  const ids = new Set(proposals.map(p => String(p.issue_number)));
  for (const [id, value] of Object.entries(overrides)) {
    if (!ids.has(id)) throw new Error('weekly_proposal_not_in_this_analysis');
    percent(value, 'pm_progress');
  }
  return overrides;
}

export function proposalSummary(p) {
  return [p.summary || '', p.verification_note ? `待確認：${p.verification_note}` : ''].filter(Boolean).join('\n');
}

// Compact change token, not an authorization credential. Mirrored in the browser review model.
export function weeklyRecordVersion(record) {
  const text = JSON.stringify(['blocker','actual_evidence','last_update_summary','self_progress','last_update_proposal','last_update'].map(key => record[key] ?? null));
  let hash = 14695981039346656037n;
  for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 1099511628211n);
  return `${text.length}:${hash.toString(16)}`;
}

export function proposalEvidence(p) {
  if (p.schema_version !== '1.1') return p.evidence || '';
  const attribution = p.report_member_name || p.submitted_by || '成員';
  return `週報記錄（${p.report_date}，${attribution}）：\n${p.evidence || ''}`
    + (p.verification_note ? `\n待確認：${p.verification_note}` : '');
}

export function applyWeeklyProposal(record, p) {
  record.last_update_proposal = p.issue_number;
  if (p.progress != null) record.actual_progress = percent(p.progress, 'proposal_progress');
  if (p.reported_progress != null) record.self_progress = percent(p.reported_progress, 'reported_progress');
  if (p.status != null) record.status = p.status;
  if (p.blocker !== null) record.blocker = p.blocker || '';
  const evidence = proposalEvidence(p);
  if (p.schema_version === '1.1') {
    const previous = Array.isArray(record.actual_evidence) ? record.actual_evidence.join('\n') : String(record.actual_evidence || '');
    // Append reported facts, retaining previous evidence and avoiding duplicates on retry.
    record.actual_evidence = previous.includes(evidence) ? previous : [previous, evidence].filter(Boolean).join('\n\n');
  } else record.actual_evidence = evidence;
  record.last_update = p.report_date;
  record.last_update_summary = proposalSummary(p);
  record.last_update_by = p.submitted_by || '';
  return record;
}

export function proposalAlreadyApplied(record, p) {
  return Number(record.last_update_proposal) === Number(p.issue_number)
    && (p.progress == null || record.actual_progress != null && Number(record.actual_progress) === Number(p.progress))
    && (p.status == null || record.status === p.status)
    && (p.blocker === null || (record.blocker || '') === (p.blocker || ''))
    && (p.reported_progress == null || record.self_progress === p.reported_progress)
    && (p.schema_version === '1.1'
      ? String(record.actual_evidence || '').includes(proposalEvidence(p)) && record.last_update_summary === proposalSummary(p)
      : (record.actual_evidence || '') === (p.evidence || ''));
}
