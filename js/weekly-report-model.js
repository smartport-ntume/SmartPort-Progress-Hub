(() => {
  const clean = (value, maximum = 200) => String(value ?? '').trim().slice(0, maximum);

  function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    if (Number.isNaN(+date)
      || date.getUTCFullYear() !== Number(match[1])
      || date.getUTCMonth() !== Number(match[2]) - 1
      || date.getUTCDate() !== Number(match[3])) return null;
    return date;
  }

  function isoDate(date) {
    return date.toISOString().slice(0, 10);
  }

  function addDays(date, days) {
    const next = new Date(date);
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  function displayDate(value) {
    const date = value instanceof Date ? value : parseDate(value);
    if (!date) return clean(value, 20) || '—';
    return `${date.getUTCFullYear()}/${String(date.getUTCMonth() + 1).padStart(2, '0')}/${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function isoWeek(date) {
    const cursor = new Date(date);
    cursor.setUTCHours(0, 0, 0, 0);
    cursor.setUTCDate(cursor.getUTCDate() + 4 - (cursor.getUTCDay() || 7));
    const yearStart = new Date(Date.UTC(cursor.getUTCFullYear(), 0, 1));
    const week = Math.ceil((((cursor - yearStart) / 86400000) + 1) / 7);
    return `${cursor.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
  }

  function progressOf(item) {
    const value = item?.actual_progress ?? item?.actualProgress ?? item?.progress;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
  }

  function isCompleted(item) {
    const progress = progressOf(item);
    const status = clean(item?.status, 40).toUpperCase();
    return progress >= 100 || ['DONE', 'COMPLETED', 'APPROVED'].includes(status);
  }

  function expectedEvidence(item) {
    const value = item?.expected_evidence ?? item?.evidence ?? [];
    if (Array.isArray(value)) return value.map(entry => clean(entry, 500)).filter(Boolean);
    const text = clean(value, 2000);
    return text ? [text] : [];
  }

  function build(options = {}) {
    const config = options.teamConfig || {};
    const memberId = clean(options.memberId, 100);
    const member = (config.members || []).find(item => item.id === memberId && item.active !== false);
    if (!member) throw new Error('請選擇有效的週報成員');
    const reportDate = parseDate(options.reportDate);
    if (!reportDate) throw new Error('請選擇正確的報告日期');

    const categories = (config.categories || []).filter(item =>
      item.active !== false && config.category_owners?.[item.id] === memberId
    );
    if (!categories.length) throw new Error(`${member.name || '此成員'} 尚未負責任何工作分類`);
    const categoryMap = new Map(categories.map(item => [item.id, item]));
    const workPackageMap = new Map((options.workPackages || []).map(item => [String(item.id || ''), item]));
    const cutoff = addDays(reportDate, 30);

    const tasks = (options.subtasks || []).filter(item => {
      if (!categoryMap.has(item?.owner_team) || isCompleted(item)) return false;
      const end = parseDate(item?.end);
      return end && end <= cutoff;
    }).map(item => {
      const end = parseDate(item.end);
      const start = parseDate(item.start);
      let scope = 'UPCOMING';
      if (end < reportDate) scope = 'OVERDUE';
      else if (!start || start <= reportDate) scope = 'ACTIVE';
      const wp = workPackageMap.get(String(item.parent_wp || '')) || {};
      return {
        id: clean(item.id, 128),
        name: clean(item.name, 300),
        parentWp: clean(item.parent_wp, 128),
        parentWpName: clean(wp.name, 300),
        ownerTeam: clean(item.owner_team, 32),
        categoryName: clean(categoryMap.get(item.owner_team)?.name, 80) || clean(item.owner_team, 32),
        start: clean(item.start, 20),
        end: clean(item.end, 20),
        targetCp: clean(item.target_cp, 80),
        currentProgress: progressOf(item),
        currentStatus: clean(item.status, 80) || 'Not Updated',
        description: clean(item.description, 4000),
        expectedEvidence: expectedEvidence(item),
        scope
      };
    }).sort((left, right) => {
      const rank = { OVERDUE: 0, ACTIVE: 1, UPCOMING: 2 };
      return rank[left.scope] - rank[right.scope]
        || left.end.localeCompare(right.end)
        || left.id.localeCompare(right.id);
    });

    const periodStart = addDays(reportDate, -6);
    const filenameMember = clean(member.name, 60).replace(/[\\/:*?"<>|\s]+/g, '_') || 'member';
    return {
      schemaVersion: '1.0',
      member: { id: member.id, name: clean(member.name, 80) || '未命名成員' },
      categories: categories.map(item => ({ id: item.id, name: item.name, color: item.color })),
      ownerTeams: categories.map(item => item.id),
      reportDate: isoDate(reportDate),
      reportDateDisplay: displayDate(reportDate),
      periodStart: isoDate(periodStart),
      periodEnd: isoDate(reportDate),
      periodDisplay: `${displayDate(periodStart)} ～ ${displayDate(reportDate)}`,
      weekId: isoWeek(reportDate),
      cutoffDate: isoDate(cutoff),
      tasks,
      currentTasks: tasks.filter(item => item.scope !== 'UPCOMING'),
      upcomingTasks: tasks.filter(item => item.scope === 'UPCOMING'),
      counts: {
        total: tasks.length,
        overdue: tasks.filter(item => item.scope === 'OVERDUE').length,
        active: tasks.filter(item => item.scope === 'ACTIVE').length,
        upcoming: tasks.filter(item => item.scope === 'UPCOMING').length
      },
      scopeSubtaskIds: tasks.map(item => item.id),
      filename: `SmartPort_Weekly_${isoDate(reportDate)}_${filenameMember}.docx`
    };
  }

  window.SmartPortWeeklyReport = {
    addDays,
    build,
    displayDate,
    isCompleted,
    parseDate,
    progressOf
  };
})();
