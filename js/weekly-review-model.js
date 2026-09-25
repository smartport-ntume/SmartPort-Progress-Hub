(() => {
  const WEEKLY_SCORE_FIELDS = ['completeness_score', 'evidence_score', 'schedule_alignment_score'];

  const INPUT_RESOURCE = '(?:weekly-report\\.txt|project-context\\.json|proposal\\.schema\\.json|(?:weekly\\s+)?report(?:\\s+(?:text|contents?))?|project\\s+(?:context|data)|proposal\\s+schema|input(?:\\s+(?:files?|data|text))?s?)';
  const INPUT_ACCESS_FAILURE = new RegExp(
    `(?:unable|cannot|can't|could not|couldn't|failed|not able)\\s+(?:to\\s+)?(?:read|access|inspect|open|load|retrieve)\\s+(?:(?:the|full|complete|supplied|uploaded|required|original)\\s+)*${INPUT_RESOURCE}\\b`
    + `|${INPUT_RESOURCE}.{0,180}?(?:could not|cannot|can't|couldn't|was not|were not|not)\\s+(?:be\\s+)?(?:read|accessed|inspected|opened|loaded|available)\\b`
    + `|${INPUT_RESOURCE}\\s+(?:(?:is|are|was|were)\\s+)?(?:unavailable|inaccessible)\\b`
    + `|without\\s+(?:reading|accessing|inspecting)\\s+(?:the\\s+)?${INPUT_RESOURCE}\\b`, 'i');

  // Accept valid historical reviews without the new status field, but recognize the
  // old file-access refusal that was incorrectly normalized to three zero scores.
  // Keep in sync with js/weekly-review-model.js; regression tests exercise both.
  function weeklyAssessmentIssue(analysis, { requireStatus = false } = {}) {
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
  function status(row) {
    if (!row) return { key: 'missing', label: '尚未繳交' };
    if (row.review_status === 'APPROVED') return { key: 'approved', label: '已核准' };
    if (row.is_current === false || row.review_status === 'SUPERSEDED') return { key: 'superseded', label: '已被新版取代' };
    if (row.review_status === 'REVIEW_FAILED') return { key: 'failed', label: '審核未完成' };
    if (row.review_status === 'REVIEWING') return { key: 'reviewing', label: 'PM 審核處理中' };
    if (row.review_status === 'CHANGES_REQUESTED') return { key: 'returned', label: '退回補件' };
    const analysis = row.analysis_result?.analysis || (row.review || row.summary ? { review: row.review, report_summary: row.summary } : null);
    if (row.status === 'completed' && analysis && weeklyAssessmentIssue(analysis)) return { key: 'failed', label: '批改未完成' };
    return ({
      queued: { key: 'queued', label: '已上傳・等待批改' },
      running: { key: 'running', label: '批改中' },
      completed: { key: 'pending', label: '待 PM 審核' },
      failed: { key: 'failed', label: '批改失敗' },
      cancelled: { key: 'cancelled', label: '已取消' }
    })[row.status] || { key: 'missing', label: '尚未繳交' };
  }
  function latest(rows, memberId) {
    return rows.filter(r => r.member_id === memberId).sort((a,b) =>
      Number(b.is_current !== false) - Number(a.is_current !== false)
      || Number(b.revision || 1) - Number(a.revision || 1))[0] || null;
  }
  function expected(proposals, snapshot) {
    return Object.fromEntries(proposals.map(p => {
      const rows = p.target_type === 'WP' ? snapshot.work_packages || [] : snapshot.subtasks || [];
      const record = rows.find(r => r.id === p.target_id);
      const before = record ? { progress: p.schema_version === '1.1' && record.actual_progress == null ? null : Number(record.actual_progress ?? 0), status: String(record.status || '') } : null;
      if (before && p.schema_version === '1.1') before.record_version = weeklyRecordVersion(record);
      return [p.issue_number, before];
    }));
  }
  // Same change token as worker/src/weekly-proposal.js; keeps large evidence out of review requests.
  function weeklyRecordVersion(record) {
    const text = JSON.stringify(['blocker','actual_evidence','last_update_summary','self_progress','last_update_proposal','last_update'].map(key => record[key] ?? null));
    let hash = 14695981039346656037n;
    for (let i = 0; i < text.length; i++) hash = BigInt.asUintN(64, (hash ^ BigInt(text.charCodeAt(i))) * 1099511628211n);
    return `${text.length}:${hash.toString(16)}`;
  }
  function taipeiInput(value) {
    const date = new Date(value);
    return Number.isFinite(+date) ? new Date(+date + 8*3600000).toISOString().slice(0,16) : '';
  }
  function progressLabel(value, empty = '保留目前進度') { return value == null ? empty : `${value}%`; }
  function feedbackTargets(context, memberId) {
    const owners=context.team_config?.category_owners;
    const tasks=(context.subtasks||[]).filter(task=>!owners||owners[task.owner_team]===memberId);
    const parents=new Set(tasks.map(task=>task.parent_wp));
    return [
      ...(context.work_packages||[]).filter(wp=>!owners||owners[wp.owner]===memberId||parents.has(wp.id)).map(wp=>({type:'WP',id:wp.id,name:wp.name||wp.id})),
      ...tasks.map(task=>({type:'SUBTASK',id:task.id,name:task.name||task.id}))
    ];
  }
  function taskFeedback(row) {
    const review=row.analysis_result?.analysis?.review||row.review||{};
    const frozen=['REVIEWING','REVIEW_FAILED'].includes(row.review_status)?row.review_result?.request?.task_feedback:null;
    const saved=frozen??row.pm_task_feedback??row.task_feedback??review.task_feedback;
    if(Array.isArray(saved))return saved;
    const missing=Array.isArray(review.missing_items)?review.missing_items:[],actions=Array.isArray(review.actions)?review.actions:[];
    return missing.length||actions.length?[{target_type:'GENERAL',target_id:'',missing_items:missing,actions}]:[];
  }
  window.SmartPortWeeklyReview = { status, latest, expected, taipeiInput, progressLabel, feedbackTargets, taskFeedback, assessmentIssue: weeklyAssessmentIssue };
})();
