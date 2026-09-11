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
  const dateOnly = value => {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ''));
    if (!match) return null;
    const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
    return date.getUTCFullYear() === Number(match[1])
      && date.getUTCMonth() === Number(match[2]) - 1
      && date.getUTCDate() === Number(match[3]) ? date : null;
  };

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
    return { schema_version: '1.0', categories, members: [], category_owners: {} };
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

    const rawMembers = Array.isArray(source.members) ? source.members : [];
    const members = [];
    const memberIds = new Set();
    rawMembers.forEach(item => {
      const id = clean(item?.id, 100);
      if (!id || memberIds.has(id)) return;
      memberIds.add(id);
      members.push({
        id,
        name: clean(item?.name, 80),
        ...(typeof item?.discord_user_id === 'string' && /^[1-9][0-9]{16,19}$/.test(item.discord_user_id.trim())
          && BigInt(item.discord_user_id.trim()) <= 18446744073709551615n
          ? { discord_user_id: item.discord_user_id.trim() } : {}),
        weekly_report_required: item?.weekly_report_required !== false,
        active: item?.active !== false
      });
    });

    const categoryOwners = {};
    if (source.category_owners && typeof source.category_owners === 'object' && !Array.isArray(source.category_owners)) {
      Object.entries(source.category_owners).forEach(([categoryId, memberId]) => {
        const id = clean(memberId, 100);
        if (categoryIds.has(categoryId) && memberIds.has(id)) categoryOwners[categoryId] = id;
      });
    }

    // Read the first preview schema without making users re-enter responsibility data.
    rawMembers.forEach(item => {
      const categoryId = clean(item?.category_id, 32);
      const memberId = clean(item?.id, 100);
      if (categoryIds.has(categoryId) && memberIds.has(memberId) && !categoryOwners[categoryId]) {
        categoryOwners[categoryId] = memberId;
      }
    });
    if (source.assignments && typeof source.assignments === 'object' && !Array.isArray(source.assignments)) {
      const categoryBySubtask = new Map(subtasks.map(item => [String(item?.id || ''), clean(item?.owner_team, 32)]));
      Object.entries(source.assignments).forEach(([subtaskId, memberId]) => {
        const categoryId = categoryBySubtask.get(subtaskId);
        const id = clean(memberId, 100);
        if (categoryIds.has(categoryId) && memberIds.has(id) && !categoryOwners[categoryId]) {
          categoryOwners[categoryId] = id;
        }
      });
    }

    return {
      schema_version: '1.0', categories, members, category_owners: categoryOwners,
      ...(source.updated_at ? { updated_at: clean(source.updated_at, 40) } : {}),
      ...(source.updated_by ? { updated_by: clean(source.updated_by, 100) } : {})
    };
  }

  function category(config, id) {
    return config?.categories?.find(item => item.id === id) || null;
  }

  function member(config, id) {
    return config?.members?.find(item => item.id === id) || null;
  }

  function activeCategories(config) {
    return (config?.categories || []).filter(item => item.active !== false);
  }

  function responsibleMember(config, categoryId) {
    return member(config, config?.category_owners?.[categoryId]);
  }

  function memberCategories(config, memberId) {
    return (config?.categories || []).filter(item => config?.category_owners?.[item.id] === memberId);
  }

  function reportScope(config, subtasks, memberId, today = new Date(), checkpoints = []) {
    const localDate = new Date(today.getTime() - today.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
    const reportDate = dateOnly(localDate);
    const checkpointEntries = checkpoints.map(item => ({
      item, date: dateOnly(item?.date)
    })).filter(entry => entry.date && !Number.isNaN(+entry.date))
      .sort((left, right) => left.date - right.date
        || String(left.item?.id || '').localeCompare(String(right.item?.id || '')));
    const checkpointDateMap = new Map(checkpointEntries.map(entry => [String(entry.item?.id || ''), entry.date]));
    const nextCheckpoint = checkpointEntries.find(entry => entry.date > reportDate) || null;
    return (subtasks || []).filter(item => {
      if (config?.category_owners?.[item.owner_team] !== memberId) return false;
      const progress = Number(item.actual_progress ?? item.progress ?? 0);
      if (progress >= 100 || ['DONE', 'COMPLETED', 'APPROVED'].includes(String(item.status || '').toUpperCase())) return false;
      const end = dateOnly(item.end);
      const targetCheckpointDate = checkpointDateMap.get(String(item.target_cp || ''));
      const overdue = (end && end < reportDate)
        || (targetCheckpointDate && targetCheckpointDate < reportDate);
      if (overdue) return true;
      if (!nextCheckpoint) return false;
      return (end && end <= nextCheckpoint.date)
        || (targetCheckpointDate && targetCheckpointDate <= nextCheckpoint.date);
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
    member,
    responsibleMember,
    memberCategories,
    reportScope
  };
})();
