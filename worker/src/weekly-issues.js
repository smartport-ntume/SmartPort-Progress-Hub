const MAX_SOURCE = 30_000;
const CATEGORIES = ['cross_task_issues', 'decision_requests'];
const STATES = ['reported', 'none', 'not_filled', 'not_found'];
const quotedText = { type: 'string', maxLength: MAX_SOURCE };
const categorySchema = {
  type: 'object', additionalProperties: false,
  required: ['status', 'reported_text', 'summary', 'related_ids', 'requested_from', 'deadline', 'options'],
  properties: {
    status: { type: 'string', enum: STATES },
    reported_text: quotedText,
    summary: { type: 'string', maxLength: 4000 },
    related_ids: { type: 'array', maxItems: 30, items: { type: 'string', maxLength: 128 } },
    requested_from: quotedText, deadline: quotedText, options: quotedText
  }
};

export const WEEKLY_ISSUES_SCHEMA = {
  type: 'object', additionalProperties: false,
  required: ['source_text', ...CATEGORIES],
  properties: { source_text: quotedText, cross_task_issues: categorySchema, decision_requests: categorySchema }
};

export const WEEKLY_ISSUES_RULES = [
  'Independently extract the report section 跨任務問題與決策需求 / ISSUES AND DECISIONS into review.issues_and_decisions; do not bury it in the overall assessment or task feedback.',
  'source_text must be the verbatim section text. Extract 跨組依賴／共通風險 as cross_task_issues and 需要 PM 決策 as decision_requests.',
  'reported_text must preserve the member’s exact words, excluding only unchanged template prompts. Never treat template prompts, prior PM feedback or blank lines as a reported issue.',
  'Use status reported for substantive answers, none only for an explicit answer of no issues, not_filled for a blank/template-only field, and not_found when that field cannot be located. Do not equate a missing field with none.',
  'If issues_and_decisions_source is supplied, preserve its source_text, reported_text and status exactly; they were extracted directly from the Word file.',
  'Summarize the member’s request in Traditional Chinese without inventing decisions or recommendations. related_ids must occur in the report; requested_from, deadline and options must be exact excerpts from reported_text, or empty strings when unstated.',
  'These reported issues are requests for PM review, not PM decisions and not permission to change progress.'
].join(' ');

function text(value, maximum = MAX_SOURCE) {
  if (value == null) return '';
  if (typeof value !== 'string' || value.length > maximum) throw new Error('weekly_issues_invalid_text');
  return value.trim();
}

function empty(status = 'not_found') {
  return { status, reported_text: '', summary: '', related_ids: [], requested_from: '', deadline: '', options: '' };
}

function answer(value) {
  const reported = text(value);
  if (!reported) return empty('not_filled');
  const explicitNone = /^(?:(?:本週|本期|目前|暫時)\s*)?(?:無|沒有|暫無)(?:\s*(?:跨組依賴|共通風險|跨任務問題|問題|風險|決策需求|需(?:要)?\s*PM\s*決策(?:事項)?))?[。.!！]?$/iu.test(reported);
  return { ...empty(explicitNone ? 'none' : 'reported'), reported_text: reported };
}

const prompts = new Set([
  '請整合列出跨任務問題；如無請填「無」。',
  '請寫成可直接決策的問題，並附建議選項與期限；如無請填「無」。'
]);

// Mammoth renders Word table labels and cell contents as separate paragraphs.
// Keep the entire section as well, so changed labels never silently lose content.
export function extractWeeklyIssues(reportText) {
  const report = String(reportText || '').replace(/\r\n?/g, '\n');
  // The current section follows the task pages; a previous PM comment may quote
  // an older section with the same heading earlier in the report.
  const heading = [...report.matchAll(/^(?:5[\s.、．]*)?跨任務問題與決策需求(?:\s+ISSUES AND DECISIONS)?[ \t]*$/gim)].at(-1);
  if (!heading) return { source_text: '', cross_task_issues: empty(), decision_requests: empty() };
  const rest = report.slice(heading.index + heading[0].length);
  const end = /\n(?:6\s*\n\s*)?(?:6[\s.、．]*)?PM\s*審閱(?:\s+PM\s+REVIEW)?[ \t]*(?:\n|$)/i.exec(rest);
  const section = text(end ? rest.slice(0, end.index) : rest);
  const labels = [...section.matchAll(/^(跨組依賴[／/]共通風險|需要\s*PM\s*決策)[ \t]*[:：]?[ \t]*$/gm)];
  const result = { source_text: section, cross_task_issues: empty(), decision_requests: empty() };
  labels.forEach((match, index) => {
    const key = /^跨組/.test(match[1]) ? 'cross_task_issues' : 'decision_requests';
    const content = section.slice(match.index + match[0].length, labels[index + 1]?.index ?? section.length)
      .split('\n').filter(line => !prompts.has(line.trim())).join('\n').trim();
    result[key] = answer([result[key].reported_text, content].filter(Boolean).join('\n\n'));
  });
  return result;
}

const compact = value => value.replace(/\s+/g, '');
function quoted(value, source) {
  const quote = text(value);
  return quote && compact(source).includes(compact(quote)) ? quote : '';
}
function quotedId(value, source) {
  const id = text(value, 128);
  const escaped = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return id && new RegExp(`(^|[^A-Za-z0-9_.-])${escaped}(?![A-Za-z0-9_.-])`).test(source) ? id : '';
}

export function normalizeWeeklyIssues(value, source = null) {
  if (!value && !source) return null; // Historical analyses have no extracted section.
  if (value && (typeof value !== 'object' || Array.isArray(value))) throw new Error('weekly_issues_invalid_object');
  const result = { source_text: text(source?.source_text ?? value?.source_text) };
  for (const key of CATEGORIES) {
    const ai = value?.[key] || {};
    const original = source?.[key] || ai;
    const reported = text(original.reported_text);
    const status = STATES.includes(original.status) ? original.status : 'not_found';
    // The extracted answer wins over an AI omission or an incorrect "none".
    const item = reported ? answer(reported) : empty(status === 'none' || status === 'reported' ? 'not_filled' : status);
    if (item.status === 'reported') {
      item.summary = !source || (ai.status === item.status && compact(text(ai.reported_text)) === compact(reported))
        ? text(ai.summary, 4000) : '';
      item.related_ids = [...new Set((Array.isArray(ai.related_ids) ? ai.related_ids : []).map(id => quotedId(id, reported)).filter(Boolean))].slice(0, 30);
      for (const field of ['requested_from', 'deadline', 'options']) item[field] = quoted(ai[field], reported);
    }
    result[key] = item;
  }
  return result;
}
