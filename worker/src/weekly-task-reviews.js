import '../../js/weekly-task-records.js';

export const normalizeTaskReviews = value => globalThis.SmartPortWeeklyTasks.rubric(value);
export const extractTaskSteps = (...args) => globalThis.SmartPortWeeklyTasks.extractSteps(...args);
export const normalizeTaskSteps = value => globalThis.SmartPortWeeklyTasks.steps(value);
export function requireTaskReviewCoverage(reviews, context) {
  const known = new Set((reviews || []).filter(item => item.target_type === 'SUBTASK').map(item => item.target_id));
  const missing = (context?.required_scope_subtask_ids || []).filter(id => !known.has(id));
  if (missing.length) throw new Error('weekly_task_reviews_missing: ' + missing.join(', '));
}
export const TASK_REVIEW_SCHEMA = {
  type: 'array', maxItems: 200, items: {
    type: 'object', additionalProperties: false,
    required: ['target_type', 'target_id', 'score', 'summary', 'to_80', 'to_100'],
    properties: {
      target_type: { type: 'string', enum: ['WP', 'SUBTASK'] }, target_id: { type: 'string', maxLength: 128 },
      score: { type: 'number', minimum: 0, maximum: 100 }, summary: { type: 'string', maxLength: 600 },
      to_80: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } },
      to_100: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 300 } }
    }
  }
};
export const TASK_REVIEW_RULES = `For each required_scope_subtask_id AND each other owned task actually reported, provide exactly one task_reviews entry. Score the quality of this week's REPORT, not the task's completion percentage. A task can be 10% complete and have a 100-point report. Give a short summary of what was done and what is still unclear. For score below 80, to_80 lists the specific missing facts to reach 80 (what changed, result, current status, next action/date). For score below 100, to_100 lists the additional specific evidence to reach 100 (a usable file/version/link or test result, compared with the project's actual expected evidence and checkpoint criteria). Do not demand completion of future work for a good report score. If already at a threshold, its list must be empty. Do not invent scores for work outside the member's scope. Use short, plain Traditional Chinese, ideally one action per sentence; name the actual missing file, result or date. Avoid long policy explanations or words such as 佐證、支撐、交付樣態、可追溯性. Combine all advice per task into task_feedback.missing_items; leave task_feedback.actions empty (legacy transport keys only, one unified feedback field). Do not repeat the same advice in overall_assessment or warnings. Overall assessment should be at most three short sentences. A step's (__%) is the member's cumulative task completion target WHEN THAT STEP IS FINISHED, not an actual progress report. Never use unselected status checkboxes, template prompts or carried-forward step names as evidence of work done this week.`;
