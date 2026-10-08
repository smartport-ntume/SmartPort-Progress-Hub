(() => {
  'use strict';

  function rawProgress(item) {
    const value = item?.actual_progress ?? item?.actualProgress ?? item?.progress;
    if (value === null || value === undefined || value === '') return null;
    const number = Number(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : null;
  }

  // All children contribute equally, including old records with stored weights.
  function weightOf() { return 1; }

  function forWorkPackage(workPackage, subtasks = []) {
    const children = (Array.isArray(subtasks) ? subtasks : [])
      .filter(item => item?.parent_wp === workPackage?.id);
    const parentProgress = rawProgress(workPackage);
    if (!children.length) {
      return {
        value: parentProgress,
        derived: false,
        children: 0,
        reported: parentProgress === null ? 0 : 1,
        totalWeight: 0,
        reportedWeight: 0,
        missingWeight: 0
      };
    }

    const rows = children.map(item => ({
      progress: rawProgress(item),
      weight: weightOf(item)
    }));
    const totalWeight = rows.reduce((sum, row) => sum + row.weight, 0);
    const reportedRows = rows.filter(row => row.progress !== null);
    const reportedWeight = reportedRows.reduce((sum, row) => sum + row.weight, 0);
    const value = reportedRows.length
      ? Math.round((reportedRows.reduce((sum, row) => sum + row.progress * row.weight, 0) / totalWeight) * 10) / 10
      : null;

    return {
      value,
      derived: true,
      children: rows.length,
      reported: reportedRows.length,
      totalWeight,
      reportedWeight,
      missingWeight: totalWeight - reportedWeight
    };
  }

  function forItem(item, workPackages = [], subtasks = []) {
    const parent = !item?.parent_wp && (Array.isArray(workPackages) ? workPackages : [])
      .find(candidate => candidate?.id === item?.id);
    return parent ? forWorkPackage(parent, subtasks) : {
      value: rawProgress(item),
      derived: false,
      children: 0,
      reported: rawProgress(item) === null ? 0 : 1,
      totalWeight: 0,
      reportedWeight: 0,
      missingWeight: 0
    };
  }

  function label(info) {
    if (!info?.derived) return '';
    if (info.value === null) return '子項目尚未填寫進度';
    return info.missingWeight > 0
      ? `子項目平均 · 已填 ${info.reported}/${info.children}`
      : '子項目平均';
  }

  window.SmartPortProgress = Object.freeze({
    rawProgress,
    weightOf,
    forWorkPackage,
    forItem,
    label
  });
})();