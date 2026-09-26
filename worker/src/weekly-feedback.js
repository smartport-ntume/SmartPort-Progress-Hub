import '../../js/weekly-feedback-routing.js';

export const assignTaskFeedback = (...args) => globalThis.SmartPortWeeklyFeedback.assign(...args);

// Keep the original AI review intact; PM edits are stored separately on the submission.
export function normalizeTaskFeedback(value) {
  if (!Array.isArray(value) || value.length > 200) throw new Error('invalid_weekly_task_feedback');
  return value.map(item => {
    const type = item?.target_type, id = item?.target_id;
    if (!['WP', 'SUBTASK', 'GENERAL'].includes(type) || typeof id !== 'string' || id.length > 128
      || (type === 'GENERAL' ? id !== '' : !id.trim())) throw new Error('invalid_weekly_feedback_target');
    const lines = key => {
      if (!Array.isArray(item[key]) || item[key].length > 50
        || item[key].some(text => typeof text !== 'string' || text.length > 2000)) throw new Error('invalid_weekly_feedback_text');
      return item[key].map(text => text.trim()).filter(Boolean);
    };
    return { target_type: type, target_id: id, missing_items: lines('missing_items'), actions: lines('actions') };
  });
}

export function reviewTaskFeedback(review = {}) {
  review ||= {};
  if (Array.isArray(review.task_feedback)) return normalizeTaskFeedback(review.task_feedback);
  const missing = Array.isArray(review.missing_items) ? review.missing_items : [];
  const actions = Array.isArray(review.actions) ? review.actions : [];
  return missing.length || actions.length
    ? normalizeTaskFeedback([{ target_type: 'GENERAL', target_id: '', missing_items: missing, actions }]) : [];
}

export const TASK_FEEDBACK_SCHEMA = {
  type: 'array', maxItems: 200, items: {
    type: 'object', additionalProperties: false,
    required: ['target_type', 'target_id', 'missing_items', 'actions'],
    properties: {
      target_type: { type: 'string', enum: ['WP', 'SUBTASK', 'GENERAL'] },
      target_id: { type: 'string', maxLength: 128 },
      missing_items: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 2000 } },
      actions: { type: 'array', maxItems: 50, items: { type: 'string', maxLength: 2000 } }
    }
  }
};
