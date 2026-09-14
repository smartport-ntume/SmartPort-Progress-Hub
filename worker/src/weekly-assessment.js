export const WEEKLY_SCORE_FIELDS = ['completeness_score', 'evidence_score', 'schedule_alignment_score'];

// Accept valid historical reviews without the new status field, but recognize the
// old file-access refusal that was incorrectly normalized to three zero scores.
export function weeklyAssessmentIssue(analysis, { requireStatus = false } = {}) {
  const retry = '批改未完成，請更新本機 Agent 後重新批改原始週報。';
  if (!analysis || typeof analysis !== 'object') return retry;
  if (analysis.assessment_status === 'input_unavailable') return 'Codex 未取得完整週報或專案資料；' + retry;
  if ((requireStatus || analysis.assessment_status != null) && analysis.assessment_status !== 'completed') return retry;
  const review = analysis.review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return retry;
  const text = `${analysis.report_summary || ''}\n${review.overall_assessment || ''}`;
  const inputRefusal = /weekly-report\.txt|project-context\.json|proposal\.schema\.json/i.test(text)
    && /unable|cannot|could not|couldn't|unavailable|without reading|not (?:read|access)|無法|未讀取|讀不到/i.test(text)
    && WEEKLY_SCORE_FIELDS.every(key => review[key] == null || review[key] === 0);
  if (inputRefusal) return 'Codex 未取得完整週報或專案資料；' + retry;
  if (WEEKLY_SCORE_FIELDS.some(key => typeof review[key] !== 'number'
    || !Number.isFinite(review[key]) || review[key] < 0 || review[key] > 100)) return '批改缺少有效分數；' + retry;
  return '';
}
