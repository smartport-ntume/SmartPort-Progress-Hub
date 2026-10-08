(function (root) {
  'use strict';
  const clean = value => String(value ?? '').trim();
  const key = item => `${item.target_type}:${item.target_id}`;
  function feedback(item = {}) {
    return [...new Set([...(item.missing_items || []), ...(item.actions || [])].map(clean).filter(Boolean))];
  }
  function steps(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 200).flatMap(item => {
      if (!['WP', 'SUBTASK'].includes(item?.target_type) || !clean(item.target_id)) return [];
      const entries = (Array.isArray(item.steps) ? item.steps : []).slice(0, 50).flatMap(step => {
        const name = clean(step?.name).slice(0, 600);
        if (!name || /^[\s_＿.．…—-]+$/.test(name)) return [];
        const percent = step.completion_percent;
        return [{ name, completion_percent: typeof percent === 'number' && Number.isFinite(percent) && percent >= 0 && percent <= 100 ? percent : null,
          status: ['completed', 'in_progress', 'not_started'].includes(step.status) ? step.status : null }];
      });
      return entries.length ? [{ target_type: item.target_type, target_id: clean(item.target_id).slice(0, 128), steps: entries }] : [];
    });
  }
  // Read the member's plan verbatim. Stage percentages describe a future milestone,
  // never the actual progress of a task, and are not converted into proposals here.
  function extractSteps(text, context = {}) {
    const tasks = context.subtasks || [], packages = context.work_packages || context.workPackages || [];
    const targets = [...tasks.map(t => ({ ...t, type: 'SUBTASK' })), ...packages.map(t => ({ ...t, type: 'WP' }))];
    const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
    const result = [];
    let target = null;
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index].trim();
      const heading = targets.find(t => line.startsWith(t.id) && /^[\s　·｜|/]/.test(line.slice(t.id.length)));
      if (heading && !(heading.type === 'WP' && target?.type === 'SUBTASK' && target.parent_wp === heading.id)) target = heading;
      if (!target || !/^完成工項的步驟/.test(line)) continue;
      const entries = [];
      let buffer = '';
      function collect() {
        const match = buffer.match(/^\s*\d+[.．、)]\s*(?:步驟\s*[:：]\s*)?([\s\S]+)/);
        if (!match) return;
        const parts = match[1].split(/(?:本週)?狀態\s*[:：]?|[☐☑☒□■✓✔]\s*(?:已完成|進行中|未開始)/);
        const percent = parts[0].match(/[（(]\s*(\d+(?:\.\d+)?)\s*[%％]\s*[）)]/);
        const name = parts[0].replace(/[（(]\s*(?:\d+(?:\.\d+)?|[_＿\s]+)\s*[%％]\s*[）)]/g, '').trim();
        const checked = [...buffer.matchAll(/[☑☒■✓✔]\s*(已完成|進行中|未開始)/g)].map(m => m[1]);
        const plain = buffer.match(/狀態\s*[:：]\s*(已完成|進行中|未開始)(?:\s|$)/);
        const status = checked.length === 1 ? checked[0] : checked.length ? null : plain?.[1];
        entries.push({ name, completion_percent: percent ? Number(percent[1]) : null,
          status: ({ 已完成: 'completed', 進行中: 'in_progress', 未開始: 'not_started' })[status] || null });
      }
      for (let j = index + 1; j < lines.length; j++) {
        const next = lines[j].trim();
        if (/^(?:目前做到哪一步|上期(?:工作)?回饋|上期需要補充|建議下一步|本週(?:新增|準備|回覆)|成果證據|下一步|阻礙|預期成果|03\s*工項)/.test(next)) break;
        if (/^\d+[.．、)]\s*/.test(next)) { collect(); buffer = next; }
        else if (buffer && next) buffer += ' ' + next;
      }
      collect();
      result.push({ target_type: target.type, target_id: target.id, steps: entries });
    }
    return [...new Map(steps(result).map(item => [key(item), item])).values()];
  }
  function rubric(value) {
    if (value == null) return [];
    if (!Array.isArray(value) || value.length > 200) throw new Error('invalid_weekly_task_reviews');
    const seen = new Set();
    return value.map(item => {
      if (!['WP', 'SUBTASK'].includes(item?.target_type) || typeof item.target_id !== 'string' || !item.target_id.trim() || item.target_id.length > 128
        || typeof item.score !== 'number' || !Number.isFinite(item.score) || item.score < 0 || item.score > 100
        || typeof item.summary !== 'string' || item.summary.length > 600 || seen.has(key(item))) throw new Error('invalid_weekly_task_review');
      seen.add(key(item));
      const list = field => {
        if (!Array.isArray(item[field]) || item[field].length > 6 || item[field].some(s => typeof s !== 'string' || s.length > 300)) throw new Error('invalid_weekly_score_guidance');
        return item[field].map(clean).filter(Boolean);
      };
      const to80 = list('to_80'), to100 = list('to_100');
      if (item.score < 80 && !to80.length || item.score < 100 && !to100.length) throw new Error('weekly_score_guidance_missing');
      return { target_type: item.target_type, target_id: item.target_id, score: Math.round(item.score), summary: item.summary.trim(),
        to_80: item.score >= 80 ? [] : to80, to_100: item.score >= 100 ? [] : to100 };
    });
  }
  root.SmartPortWeeklyTasks = { feedback, steps, extractSteps, rubric, key };
})(typeof window === 'object' ? window : globalThis);
