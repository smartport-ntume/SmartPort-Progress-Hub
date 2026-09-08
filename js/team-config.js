(() => {
  const core = [
    { id: 'CTL', name: '控制', color: '#5277bb' },
    { id: 'LOC/NAV', name: '定位＋導航', color: '#6c9275' },
    { id: 'PER', name: '感知', color: '#8a6bb8' },
    { id: 'STM', name: '狀態機＋任務', color: '#c37b4a' }
  ];
  const known = { VERIFY: { name: '驗證', color: '#7b8794' } };
  const colors = ['#456990', '#5b8e7d', '#7d5ba6', '#b36a5e', '#6b7280'];
  const clone = value => JSON.parse(JSON.stringify(value));
  const clean = (value, length = 100) => String(value ?? '').trim().slice(0, length);

  function referenced(workPackages = [], subtasks = []) {
    return [...new Set([
      ...workPackages.map(item => clean(item?.owner, 32)),
      ...subtasks.map(item => clean(item?.owner_team, 32))
    ].filter(Boolean))];
  }

  function fallbackCategory(id, index) {
    return {
      id,
      name: known[id]?.name || id,
      color: known[id]?.color || colors[index % colors.length],
      active: true,
      order: index + 1
    };
  }

  function defaults(referencedIds = []) {
    const categories = core.map((item, index) => ({ ...item, active: true, order: index + 1 }));
    const ids = new Set(categories.map(item => item.id));
    referencedIds.forEach(id => {
      if (!ids.has(id)) {
        categories.push(fallbackCategory(id, categories.length));
        ids.add(id);
      }
    });
    return { schema_version: '1.0', categories, members: [], assignments: {} };
  }

  function normalize(value, workPackages = [], subtasks = []) {
    const referencedIds = referenced(workPackages, subtasks);
    const base = defaults(referencedIds);
    const source = value && typeof value === 'object' ? value : base;
    const rawCategories = Array.isArray(source.categories) && source.categories.length
      ? source.categories
      : base.categories;
    const categories = [];
    const categoryIds = new Set();
    rawCategories.forEach((item, index) => {
      const id = clean(item?.id, 32);
      if (!id || categoryIds.has(id)) return;
      const builtin = core.find(candidate => candidate.id === id) || known[id];
      categoryIds.add(id);
      categories.push({
        id,
        name: clean(item?.name, 80) || builtin?.name || id,
        color: /^#[0-9a-f]{6}$/i.test(String(item?.color || ''))
          ? String(item.color).toLowerCase()
          : builtin?.color || colors[index % colors.length],
        active: item?.active !== false,
        order: Number.isInteger(Number(item?.order)) ? Number(item.order) : index + 1
      });
    });
    referencedIds.forEach(id => {
      if (!categoryIds.has(id)) {
        categories.push(fallbackCategory(id, categories.length));
        categoryIds.add(id);
      }
    });
    categories.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
    categories.forEach((item, index) => { item.order = index + 1; });

    const members = [];
    const memberIds = new Set();
    (Array.isArray(source.members) ? source.members : []).forEach(item => {
      const id = clean(item?.id, 100);
      const categoryId = clean(item?.category_id, 32);
      if (!id || memberIds.has(id) || !categoryIds.has(categoryId)) return;
      memberIds.add(id);
      members.push({
        id,
        name: clean(item?.name, 80),
        category_id: categoryId,
        weekly_report_required: item?.weekly_report_required !== false,
        active: item?.active !== false
      });
    });

    const assignments = {};
    if (source.assignments && typeof source.assignments === 'object' && !Array.isArray(source.assignments)) {
      Object.entries(source.assignments).forEach(([subtaskId, memberId]) => {
        const id = clean(memberId, 100);
        if (id && memberIds.has(id)) assignments[clean(subtaskId, 200)] = id;
      });
    }
    return {
      schema_version: '1.0', categories, members, assignments,
      ...(source.updated_at ? { updated_at: clean(source.updated_at, 40) } : {}),
      ...(source.updated_by ? { updated_by: clean(source.updated_by, 100) } : {})
    };
  }

  function category(config, id) {
    return config?.categories?.find(item => item.id === id) || null;
  }

  function activeCategories(config) {
    return (config?.categories || []).filter(item => item.active !== false);
  }

  function reportScope(config, subtasks, memberId, today = new Date()) {
    const cutoff = new Date(today);
    cutoff.setMonth(cutoff.getMonth() + 1);
    cutoff.setHours(23, 59, 59, 999);
    return (subtasks || []).filter(item => {
      if (config?.assignments?.[item.id] !== memberId) return false;
      const progress = Number(item.actual_progress ?? item.progress ?? 0);
      if (progress >= 100 || ['Done', 'Completed'].includes(String(item.status || ''))) return false;
      const end = new Date(String(item.end || '') + 'T12:00:00');
      return !Number.isNaN(+end) && end <= cutoff;
    }).sort((a, b) => String(a.end || '').localeCompare(String(b.end || '')) || String(a.id).localeCompare(String(b.id)));
  }

  window.SmartPortTeam = {
    clone,
    defaults,
    normalize,
    referenced,
    category,
    activeCategories,
    categoryName(config, id) { return category(config, id)?.name || id || '—'; },
    categoryColor(config, id) { return category(config, id)?.color || '#667085'; },
    member(config, id) { return config?.members?.find(item => item.id === id) || null; },
    reportScope
  };
})();
