(() => {
  const API = window.SmartPortAPI;
  const Store = window.SmartPortStore;
  const Team = window.SmartPortTeam;
  const $ = selector => document.querySelector(selector);
  const esc = (value = '') => String(value).replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[char]));
  let baseline = null;
  let draft = null;
  let dirty = false;

  function toast(message) {
    const element = $('#toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => element.classList.remove('show'), 4200);
  }

  function setDirty(value = true) {
    dirty = value;
    const status = $('#teamSaveStatus');
    if (status) {
      status.textContent = dirty
        ? '有尚未儲存的變更；正式資料尚未寫入 Private Git。'
        : (baseline?.updated_at ? `已儲存：${baseline.updated_at.slice(0, 16).replace('T', ' ')}` : '尚無變更');
      status.classList.toggle('team-dirty', dirty);
    }
  }

  function categoryOptions(selected = '', includeInactive = true) {
    return (draft?.categories || [])
      .filter(item => includeInactive || item.active !== false)
      .map(item => `<option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)} (${esc(item.id)})${item.active === false ? ' · 停用' : ''}</option>`)
      .join('');
  }

  function renderCategories() {
    const root = $('#teamCategoryList');
    if (!root || !draft) return;
    const referenced = new Set(Team.referenced(Store.state.workPackages, Store.state.subtasks));
    root.innerHTML = draft.categories.map((item, index) => `
      <div class="team-category-row" data-category-index="${index}">
        <input class="team-color-input" type="color" value="${esc(item.color)}" data-category-field="color" aria-label="${esc(item.name)} 顏色">
        <input class="team-code-input" value="${esc(item.id)}" data-category-field="id" readonly aria-label="分類代碼">
        <input value="${esc(item.name)}" data-category-field="name" aria-label="分類名稱">
        <label class="team-check"><input type="checkbox" data-category-field="active" ${item.active !== false ? 'checked' : ''}>啟用</label>
        <button type="button" class="btn smallbtn danger" data-remove-category="${index}" ${referenced.has(item.id) ? 'disabled title="仍被甘特圖引用"' : ''}>刪除</button>
      </div>`).join('');
  }

  function renderMembers() {
    const root = $('#teamMemberList');
    if (!root || !draft) return;
    if (!draft.members.length) {
      root.innerHTML = '<div class="team-empty">尚未建立成員。先按「＋成員」，只要姓名與負責分類即可。</div>';
      return;
    }
    root.innerHTML = draft.members.map((item, index) => `
      <div class="team-member-row" data-member-index="${index}">
        <input value="${esc(item.name)}" data-member-field="name" placeholder="姓名" aria-label="成員姓名">
        <select data-member-field="category_id" aria-label="負責分類">${categoryOptions(item.category_id)}</select>
        <label class="team-check"><input type="checkbox" data-member-field="weekly_report_required" ${item.weekly_report_required !== false ? 'checked' : ''}>需交週報</label>
        <label class="team-check"><input type="checkbox" data-member-field="active" ${item.active !== false ? 'checked' : ''}>在組</label>
        <button type="button" class="btn smallbtn danger" data-remove-member="${index}">刪除</button>
      </div>`).join('');
  }

  function memberOptions(categoryId, selected = '') {
    const members = (draft?.members || []).filter(item => item.category_id === categoryId && item.active !== false);
    const selectedMember = draft?.members?.find(item => item.id === selected);
    if (selectedMember && !members.some(item => item.id === selectedMember.id)) members.push(selectedMember);
    return `<option value="">— 尚未指派 —</option>${members.map(item => `
      <option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name)}${item.active === false ? '（已停用）' : ''}</option>`).join('')}`;
  }

  function incomplete(item) {
    const progress = Number(item.actual_progress ?? item.progress ?? 0);
    return progress < 100 && !['Done', 'Completed'].includes(String(item.status || ''));
  }

  function inReportWindow(item) {
    if (!incomplete(item)) return false;
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() + 1);
    cutoff.setHours(23, 59, 59, 999);
    const end = new Date(String(item.end || '') + 'T12:00:00');
    return !Number.isNaN(+end) && end <= cutoff;
  }

  function filteredSubtasks() {
    const category = $('#teamAssignmentCategory')?.value || '';
    const status = $('#teamAssignmentStatus')?.value || '';
    const query = ($('#teamAssignmentSearch')?.value || '').trim().toLowerCase();
    return [...Store.state.subtasks]
      .filter(item => !category || item.owner_team === category)
      .filter(item => {
        const assigned = !!draft?.assignments?.[item.id];
        return status === 'unassigned' ? !assigned : status === 'assigned' ? assigned : true;
      })
      .filter(item => !query || `${item.id} ${item.name || ''} ${item.parent_wp || ''}`.toLowerCase().includes(query))
      .sort((a, b) => String(a.parent_wp || '').localeCompare(String(b.parent_wp || '')) || String(a.id).localeCompare(String(b.id)));
  }

  function renderAssignmentFilters() {
    const select = $('#teamAssignmentCategory');
    if (!select || !draft) return;
    const selected = select.value;
    select.innerHTML = `<option value="">全部分類</option>${categoryOptions(selected)}`;
    select.value = selected;
  }

  function renderAssignments() {
    const root = $('#teamAssignmentRows');
    if (!root || !draft) return;
    const items = filteredSubtasks();
    const wpNames = new Map(Store.state.workPackages.map(item => [item.id, item.name || '']));
    root.innerHTML = items.length ? items.map(item => {
      const memberId = draft.assignments[item.id] || '';
      const category = draft.categories.find(candidate => candidate.id === item.owner_team);
      const scope = !memberId ? '<span class="team-state unassigned">未指派</span>'
        : inReportWindow(item) ? '<span class="team-state due">本期需報告</span>'
          : incomplete(item) ? '<span class="team-state later">後續項目</span>'
            : '<span class="team-state done">已完成</span>';
      return `<tr>
        <td><b>${esc(item.parent_wp || '—')}</b><div class="muted">${esc(wpNames.get(item.parent_wp) || '')}</div></td>
        <td><b>${esc(item.id)}</b><div>${esc(item.name || '')}</div><div class="muted">${esc(item.end || '未設定期限')} · ${esc(item.status || 'Not Updated')}</div></td>
        <td><span class="team-color-dot" style="--team-dot:${esc(category?.color || '#667085')}"></span>${esc(category?.name || item.owner_team || '—')}</td>
        <td><select class="team-owner-select" data-assignment-id="${esc(item.id)}" data-assignment-category="${esc(item.owner_team || '')}">${memberOptions(item.owner_team, memberId)}</select></td>
        <td>${scope}</td>
      </tr>`;
    }).join('') : '<tr><td colspan="5" class="team-empty">沒有符合篩選條件的 Subtask。</td></tr>';

    const unassigned = Store.state.subtasks.filter(item => !draft.assignments[item.id]).length;
    const badge = $('#teamUnassignedBadge');
    if (badge) {
      badge.textContent = unassigned ? `${unassigned} 個 Subtask 未指派` : '所有 Subtask 已指派';
      badge.classList.toggle('team-complete', unassigned === 0);
      badge.classList.toggle('team-warning', unassigned > 0);
    }
  }

  function renderReportMemberOptions() {
    const select = $('#teamReportMember');
    if (!select || !draft) return;
    const selected = select.value;
    select.innerHTML = `<option value="">選擇成員</option>${draft.members
      .filter(item => item.active !== false && item.weekly_report_required !== false)
      .map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(Team.categoryName(draft, item.category_id))}</option>`).join('')}`;
    if (draft.members.some(item => item.id === selected)) select.value = selected;
  }

  function renderReportScope() {
    const root = $('#teamReportScopeRows');
    const memberId = $('#teamReportMember')?.value || '';
    if (!root || !draft) return;
    if (!memberId) {
      root.className = 'team-report-scope-rows muted';
      root.textContent = draft.members.length ? '請選擇成員查看個人週報範圍。' : '請先新增成員並完成分派。';
      return;
    }
    const member = draft.members.find(item => item.id === memberId);
    const items = Team.reportScope(draft, Store.state.subtasks, memberId);
    root.className = 'team-report-scope-rows';
    root.innerHTML = items.length ? `
      <div class="team-scope-summary"><b>${esc(member?.name || '')}</b> 本期應回報 ${items.length} 項</div>
      ${items.map(item => `<div class="team-scope-item"><div><b>${esc(item.id)} · ${esc(item.name || '')}</b><div class="muted">${esc(item.parent_wp || '')} · ${esc(item.status || 'Not Updated')}</div></div><time>${esc(item.end || '未設定期限')}</time></div>`).join('')}`
      : `<div class="team-empty">${esc(member?.name || '')} 目前沒有已逾期或未來一個月內到期、且尚未完成的指派項目。</div>`;
  }

  function renderAll() {
    if (!draft) return;
    renderCategories();
    renderMembers();
    renderAssignmentFilters();
    renderAssignments();
    renderReportMemberOptions();
    renderReportScope();
    setDirty(dirty);
  }

  function loadFromStore() {
    baseline = Team.clone(Store.state.teamConfig);
    draft = Team.clone(Store.state.teamConfig);
    draft.categories.forEach(item => { delete item._new; });
    dirty = false;
    renderAll();
  }

  function cleanAssignmentsForMember(member) {
    const tasks = new Map(Store.state.subtasks.map(item => [item.id, item]));
    Object.entries(draft.assignments).forEach(([subtaskId, memberId]) => {
      if (memberId !== member.id) return;
      const task = tasks.get(subtaskId);
      if (!task || member.active === false || task.owner_team !== member.category_id) delete draft.assignments[subtaskId];
    });
  }

  function serializableDraft() {
    const taskIds = new Set(Store.state.subtasks.map(item => item.id));
    return {
      schema_version: '1.0',
      categories: draft.categories.map((item, index) => ({
        id: String(item.id || '').trim(),
        name: String(item.name || '').trim(),
        color: item.color,
        active: item.active !== false,
        order: index + 1
      })),
      members: draft.members.map(item => ({
        id: item.id,
        name: String(item.name || '').trim(),
        category_id: item.category_id,
        weekly_report_required: item.weekly_report_required !== false,
        active: item.active !== false
      })),
      assignments: Object.fromEntries(Object.entries(draft.assignments).filter(([subtaskId, memberId]) => taskIds.has(subtaskId) && memberId))
    };
  }

  function validate(config) {
    if (!config.categories.length) throw new Error('至少需要一個工作分類');
    const categoryIds = new Set();
    config.categories.forEach(item => {
      if (!/^[A-Z][A-Z0-9/_-]{0,31}$/.test(item.id)) throw new Error(`分類代碼「${item.id || '空白'}」格式不正確`);
      if (!item.name) throw new Error(`分類 ${item.id} 必須填寫名稱`);
      if (categoryIds.has(item.id)) throw new Error(`分類代碼重複：${item.id}`);
      categoryIds.add(item.id);
    });
    Team.referenced(Store.state.workPackages, Store.state.subtasks).forEach(id => {
      if (!categoryIds.has(id)) throw new Error(`分類 ${id} 仍被甘特圖使用，不能刪除`);
    });
    config.members.forEach(item => {
      if (!item.name) throw new Error('所有成員都必須填寫姓名');
      if (!categoryIds.has(item.category_id)) throw new Error(`${item.name} 的負責分類不存在`);
    });
    const memberMap = new Map(config.members.map(item => [item.id, item]));
    const taskMap = new Map(Store.state.subtasks.map(item => [item.id, item]));
    Object.entries(config.assignments).forEach(([subtaskId, memberId]) => {
      const member = memberMap.get(memberId);
      const task = taskMap.get(subtaskId);
      if (!member || !task) throw new Error(`分派資料無效：${subtaskId}`);
      if (member.active === false) throw new Error(`${member.name} 已停用，不能保留任務分派`);
      if (member.category_id !== task.owner_team) throw new Error(`${subtaskId} 與 ${member.name} 的分類不一致`);
    });
  }

  document.addEventListener('smartport:snapshot-replaced', loadFromStore);

  document.addEventListener('input', event => {
    if (!draft) return;
    const categoryField = event.target.closest('[data-category-field]');
    if (categoryField) {
      const index = Number(categoryField.closest('[data-category-index]').dataset.categoryIndex);
      const item = draft.categories[index];
      const field = categoryField.dataset.categoryField;
      item[field] = categoryField.type === 'checkbox' ? categoryField.checked : categoryField.value;
      setDirty();
      if (['name', 'id', 'color', 'active'].includes(field)) {
        renderMembers(); renderAssignmentFilters(); renderAssignments(); renderReportMemberOptions(); renderReportScope();
      }
      return;
    }
    const memberField = event.target.closest('[data-member-field]');
    if (memberField) {
      const index = Number(memberField.closest('[data-member-index]').dataset.memberIndex);
      const item = draft.members[index];
      const field = memberField.dataset.memberField;
      item[field] = memberField.type === 'checkbox' ? memberField.checked : memberField.value;
      if (field === 'category_id' || field === 'active') cleanAssignmentsForMember(item);
      setDirty();
      renderAssignments(); renderReportMemberOptions(); renderReportScope();
    }
  });

  document.addEventListener('change', event => {
    const assignment = event.target.closest('[data-assignment-id]');
    if (assignment && draft) {
      if (assignment.value) draft.assignments[assignment.dataset.assignmentId] = assignment.value;
      else delete draft.assignments[assignment.dataset.assignmentId];
      setDirty(); renderAssignments(); renderReportScope();
      return;
    }
    if (event.target.matches('#teamAssignmentCategory,#teamAssignmentStatus')) renderAssignments();
    if (event.target.matches('#teamReportMember')) renderReportScope();
  });

  $('#teamAssignmentSearch')?.addEventListener('input', renderAssignments);

  $('#btnAddTeamCategory')?.addEventListener('click', () => {
    if (!draft || draft.categories.length >= 30) return toast('分類上限為 30 個');
    let number = draft.categories.length + 1;
    let id = `TEAM${number}`;
    const ids = new Set(draft.categories.map(item => item.id));
    while (ids.has(id)) { number += 1; id = `TEAM${number}`; }
    draft.categories.push({ id, name: '新分類', color: '#456990', active: true, order: draft.categories.length + 1, _new: true });
    setDirty(); renderAll();
  });

  $('#btnAddTeamMember')?.addEventListener('click', () => {
    if (!draft) return;
    const category = draft.categories.find(item => item.active !== false);
    if (!category) return toast('請先建立並啟用工作分類');
    draft.members.push({
      id: `member-${crypto.randomUUID()}`,
      name: '',
      category_id: category.id,
      weekly_report_required: true,
      active: true
    });
    setDirty(); renderAll();
    requestAnimationFrame(() => $('#teamMemberList [data-member-index]:last-child input[data-member-field="name"]')?.focus());
  });

  document.addEventListener('click', event => {
    const removeCategory = event.target.closest('[data-remove-category]');
    if (removeCategory && draft) {
      const index = Number(removeCategory.dataset.removeCategory);
      const item = draft.categories[index];
      const referenced = Team.referenced(Store.state.workPackages, Store.state.subtasks).includes(item.id);
      if (referenced) return toast(`${item.id} 仍被甘特圖引用，請先改派 WP / Subtask 分類`);
      if (draft.members.some(member => member.category_id === item.id)) return toast(`${item.name} 仍有成員，請先移動或刪除成員`);
      draft.categories.splice(index, 1);
      setDirty(); renderAll();
      return;
    }
    const removeMember = event.target.closest('[data-remove-member]');
    if (removeMember && draft) {
      const index = Number(removeMember.dataset.removeMember);
      const member = draft.members[index];
      const assigned = Object.values(draft.assignments).filter(id => id === member.id).length;
      if (assigned && !confirm(`刪除 ${member.name || '此成員'}，並清除 ${assigned} 個 Subtask 分派？`)) return;
      draft.members.splice(index, 1);
      Object.entries(draft.assignments).forEach(([subtaskId, memberId]) => {
        if (memberId === member.id) delete draft.assignments[subtaskId];
      });
      setDirty(); renderAll();
    }
  });

  $('#btnResetTeamConfig')?.addEventListener('click', () => {
    if (!baseline) return;
    if (dirty && !confirm('放棄尚未儲存的成員與分工變更？')) return;
    draft = Team.clone(baseline);
    dirty = false;
    renderAll();
  });

  $('#btnSaveTeamConfig')?.addEventListener('click', async () => {
    if (!draft) return;
    if (!window.SMARTPORT_ACCESS?.can_write) return toast('只有 PM 可以修改成員與分工');
    let config;
    try {
      config = serializableDraft();
      validate(config);
    } catch (error) {
      toast(error.message || String(error));
      return;
    }
    const button = $('#btnSaveTeamConfig');
    button.disabled = true;
    button.textContent = '等待本機 Agent...';
    try {
      const result = await API.saveTeamConfig(config);
      const saved = result?.team_config || config;
      Store.state.teamConfig = Team.normalize(saved, Store.state.workPackages, Store.state.subtasks);
      baseline = Team.clone(Store.state.teamConfig);
      draft = Team.clone(Store.state.teamConfig);
      dirty = false;
      renderAll();
      document.dispatchEvent(new CustomEvent('smartport:team-config-saved', { detail: Store.state.teamConfig }));
      toast('成員與分工已 commit / push 至 Private Git');
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      button.disabled = false;
      button.textContent = '儲存成員與分工';
    }
  });
})();
