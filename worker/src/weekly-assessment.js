export const WEEKLY_SCORE_FIELDS = ['completeness_score', 'evidence_score', 'schedule_alignment_score'];

const INPUT_RESOURCE = '(?:weekly-report\\.txt|project-context\\.json|proposal\\.schema\\.json|(?:weekly\\s+)?report(?:\\s+(?:text|contents?))?|project\\s+(?:context|data)|proposal\\s+schema|input(?:\\s+(?:files?|data|text))?s?)';
const INPUT_ACCESS_FAILURE = new RegExp(
  `(?:unable|cannot|can't|could not|couldn't|failed|not able)\\s+(?:to\\s+)?(?:read|access|inspect|open|load|retrieve)\\s+(?:(?:the|full|complete|supplied|uploaded|required|original)\\s+)*${INPUT_RESOURCE}\\b`
  + `|${INPUT_RESOURCE}.{0,180}?(?:could not|cannot|can't|couldn't|was not|were not|not)\\s+(?:be\\s+)?(?:read|accessed|inspected|opened|loaded|available)\\b`
  + `|${INPUT_RESOURCE}\\s+(?:(?:is|are|was|were)\\s+)?(?:unavailable|inaccessible)\\b`
  + `|without\\s+(?:reading|accessing|inspecting)\\s+(?:the\\s+)?${INPUT_RESOURCE}\\b`, 'i');

// Accept valid historical reviews without the new status field, but recognize the
// old file-access refusal that was incorrectly normalized to three zero scores.
// Keep in sync with js/weekly-review-model.js; regression tests exercise both.
export function weeklyAssessmentIssue(analysis, { requireStatus = false } = {}) {
  const retry = '批改未完成，請更新本機 Agent 後重新批改原始週報。';
  if (!analysis || typeof analysis !== 'object') return retry;
  if (analysis.assessment_status === 'input_unavailable') return 'Codex 未取得完整週報或專案資料；' + retry;
  if ((requireStatus || analysis.assessment_status != null) && analysis.assessment_status !== 'completed') return retry;
  const review = analysis.review;
  if (!review || typeof review !== 'object' || Array.isArray(review)) return retry;
  const statements = [analysis.report_summary, review.overall_assessment,
    ...(Array.isArray(review.missing_items) ? review.missing_items : []),
    ...(Array.isArray(review.actions) ? review.actions : []),
    ...(Array.isArray(analysis.warnings) ? analysis.warnings : [])];
  const inputRefusal = WEEKLY_SCORE_FIELDS.every(key => review[key] == null || review[key] === 0)
    && statements.some(value => {
      if (typeof value !== 'string') return false;
      const text = value.replace(/[’‘]/g, "'");
      return INPUT_ACCESS_FAILURE.test(text)
        || /(?:not assessed|unable to assess|cannot assess|could not assess).*without (?:file |input )?access/i.test(text)
        || /(?:無法|未能|不能|尚未|未)(?:讀取|存取|開啟|取得|讀到|檢視).{0,20}(?:週報|專案(?:資料|脈絡|內容)|輸入資料|weekly-report\.txt|project-context\.json|proposal\.schema\.json)/i.test(text)
        || /(?:週報|專案資料|輸入資料).{0,20}(?:無法讀取|無法存取|無法開啟|讀不到|未讀取)/.test(text);
    });
  if (inputRefusal) return 'Codex 未取得完整週報或專案資料；' + retry;
  if (WEEKLY_SCORE_FIELDS.some(key => typeof review[key] !== 'number'
    || !Number.isFinite(review[key]) || review[key] < 0 || review[key] > 100)) return '批改缺少有效分數；' + retry;
  return '';
}
