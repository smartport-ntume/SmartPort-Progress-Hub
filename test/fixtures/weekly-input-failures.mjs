export function zeroAnalysis(overrides = {}) {
  return {
    report_summary: '僅有空白範本，沒有成果或佐證。',
    review: {
      overall_assessment: '已檢查週報，尚未填寫實際工作內容。',
      completeness_score: 0, evidence_score: 0, schedule_alignment_score: 0,
      strengths: [], missing_items: ['請填寫完成工作與證據。'], actions: ['補交已填妥的週報。']
    },
    warnings: [], proposals: [], ...overrides
  };
}

// Transcribed failure wording from the two reported screenshots. These are
// legacy results: no assessment_status, and filenames appear only in feedback.
export const screenshotFailures = [
  zeroAnalysis({
    report_summary: 'Not assessed. The report, project context, and proposal schema could not be read; required scope and checkpoint gates remain unverified.',
    review: {
      ...zeroAnalysis().review,
      overall_assessment: 'Not assessed. The report, project context, and proposal schema could not be read; required scope and checkpoint gates remain unverified.',
      missing_items: ['Unable to inspect weekly-report.txt for substantive evidence.',
        'Unable to inspect project-context.json for owner_teams, required_scope_subtask_ids, current progress, next_checkpoint capability, and review_checks.']
    }
  }),
  zeroAnalysis({
    report_summary: 'Unable to assess the report, required scope, or checkpoint gates without file access. No evidence-supported progress updates can be proposed.',
    review: {
      ...zeroAnalysis().review,
      overall_assessment: 'Unable to assess the report, required scope, or checkpoint gates without file access. No evidence-supported progress updates can be proposed.',
      missing_items: ['Could not inspect weekly-report.txt.',
        'Could not inspect project-context.json to check every required_scope_subtask_id, owner_teams, next_checkpoint capability, and review_checks.']
    }
  })
];
