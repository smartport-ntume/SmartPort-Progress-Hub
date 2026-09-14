(() => {
  const WEEKLY_SCORE_FIELDS = ['completeness_score', 'evidence_score', 'schedule_alignment_score'];

  // Accept valid historical reviews without the new status field, but recognize the
  // old file-access refusal that was incorrectly normalized to three zero scores.
  function weeklyAssessmentIssue(analysis, { requireStatus = false } = {}) {
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
      return [p.issue_number, record ? { progress: Number(record.actual_progress ?? 0), status: String(record.status || '') } : null];
    }));
  }
  function taipeiInput(value) {
    const date = new Date(value);
    return Number.isFinite(+date) ? new Date(+date + 8*3600000).toISOString().slice(0,16) : '';
  }
  window.SmartPortWeeklyReview = { status, latest, expected, taipeiInput, assessmentIssue: weeklyAssessmentIssue };
})();
