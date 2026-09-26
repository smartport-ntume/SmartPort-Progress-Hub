import { reviewTaskFeedback, assignTaskFeedback } from '../worker/src/weekly-feedback.js';

const REVIEWED = new Set(['APPROVED', 'CHANGES_REQUESTED']);

export function previousReviewHandoff(batch, submissions = []) {
  if (!batch) return { ready: true, review: null, blocked: [] };
  const current = new Map();
  for (const row of submissions) {
    if (row.is_current === false || row.review_status === 'SUPERSEDED') continue;
    const prior = current.get(row.member_id);
    if (!prior || Number(row.revision || 1) > Number(prior.revision || 1)) current.set(row.member_id, row);
  }
  const members = (batch.payload?.team_config?.members || []).filter(m => m.active !== false && m.weekly_report_required !== false);
  const blocked = [], feedback = [];
  for (const member of members) {
    const row = current.get(member.id);
    const reviewed = row?.status === 'completed' && REVIEWED.has(row.review_status)
      && (row.review_status !== 'CHANGES_REQUESTED' || String(row.pm_feedback || '').trim());
    if (!reviewed) {
      const reason = !row ? '尚未繳交' : row.review_status === 'REVIEW_FAILED' ? '審核未完成'
        : row.status === 'failed' ? '批改失敗' : ['queued','running'].includes(row.status) ? '等待批改完成' : '待 PM 審核';
      blocked.push({ member_id: member.id, member_name: member.name || member.id, reason });
      continue;
    }
    feedback.push({
      member_id: member.id, submission_id: row.id, revision: row.revision || 1,
      review_status: row.review_status, reviewed_at: row.reviewed_at || null,
      pm_feedback: String(row.pm_feedback || '').slice(0, 4000),
      task_feedback: assignTaskFeedback(row.pm_task_feedback ?? reviewTaskFeedback(row.analysis_result?.analysis?.review), batch.payload, member.id)
    });
  }
  return {
    ready: blocked.length === 0, blocked, batchId: batch.id, weekKey: batch.week_key,
    review: { batch_id: batch.id, week_key: batch.week_key, report_date: batch.report_date, members: feedback }
  };
}

export function pendingReviewError(gate) {
  const error = new Error(`下一期週報等待 ${gate.weekKey} 完成 PM 審核：${gate.blocked.map(m => `${m.member_name}（${m.reason}）`).join('、')}`);
  error.code = 'weekly_previous_review_pending';
  error.gate = gate;
  return error;
}
