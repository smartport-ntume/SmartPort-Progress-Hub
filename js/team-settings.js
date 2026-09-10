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

  function memberOptions(selected = '') {
    const members = (draft?.members || []).filter(item => item.active !== false);
    const selectedMember = draft?.members?.find(item => item.id === selected);
    if (selectedMember && !members.some(item => item.id === selectedMember.id)) members.push(selectedMember);
    return `<option value="">— 未設定負責人 —</option>${members.map(item => `
      <option value="${esc(item.id)}" ${item.id === selected ? 'selected' : ''}>${esc(item.name || '未命名成員')}${item.active === false ? '（已停用）' : ''}</option>`).join('')}`;
  }

  function ownedCategories(memberId) {
    return (draft?.categories || []).filter(item => draft?.category_owners?.[item.id] === memberId);
  }

  function renderCategories() {
    const root = $('#teamCategoryList');
    if (!root || !draft) return;
    const referenced = new Set(Team.referenced(Store.state.workPackages, Store.state.subtasks));
    root.innerHTML = draft.categories.map((item, index) => {
      const count = Store.state.subtasks.filter(task => task.owner_team === item.id).length;
      return `
        <div class="team-category-row" data-category-index="${index}">
          <input class="team-color-input" type="color" value="${esc(item.color)}" data-category-field="color" aria-label="${esc(item.name)} 顏色">
          <input class="team-code-input" value="${esc(item.id)}" data-category-field="id" readonly aria-label="分類代碼">
          <div><input value="${esc(item.name)}" data-category-field="name" aria-label="分類名稱"><div class="muted team-task-count">${count} 個 Subtask</div></div>
          <select data-category-owner="${esc(item.id)}" aria-label="${esc(item.name)} 主要負責人">${memberOptions(draft.category_owners[item.id] || '')}</select>
          <label class="team-check"><input type="checkbox" data-category-field="active" ${item.active !== false ? 'checked' : ''}>啟用</label>
          <button type="button" class="btn smallbtn danger" data-remove-category="${index}" ${referenced.has(item.id) ? 'disabled title="仍被甘特圖引用"' : ''}>刪除</button>
        </div>`;
    }).join('');

    const usedCategories = new Set(Team.referenced(Store.state.workPackages, Store.state.subtasks));
    const missing = draft.categories.filter(item => item.active !== false && usedCategories.has(item.id) && !draft.category_owners[item.id]);
    const badge = $('#teamUnassignedBadge');
    if (badge) {
      badge.textContent = missing.length ? `${missing.length} 個分類未設定負責人` : '使用中的分類皆已設定';
      badge.classList.toggle('team-complete', missing.length === 0);
      badge.classList.toggle('team-warning', missing.length > 0);
    }
  }

  function renderMembers() {
    const root = $('#teamMemberList');
    if (!root || !draft) return;
    if (!draft.members.length) {
      root.innerHTML = '<div class="team-empty">尚未建立成員。先按「＋成員」，只需要填姓名。</div>';
      return;
    }
    root.innerHTML = draft.members.map((item, index) => {
      const categories = ownedCategories(item.id);
      const responsibility = categories.length
        ? categories.map(category => `<span class="team-category-chip">${esc(category.name)}</span>`).join('')
        : '<span class="muted">尚未負責分類</span>';
      return `
        <div class="team-member-row" data-member-index="${index}">
          <input value="${esc(item.name)}" data-member-field="name" placeholder="姓名" aria-label="成員姓名">
          <div class="team-member-categories">${responsibility}</div>
          <label class="team-check"><input type="checkbox" data-member-field="weekly_report_required" ${item.weekly_report_required !== false ? 'checked' : ''}>需交週報</label>
          <label class="team-check"><input type="checkbox" data-member-field="active" ${item.active !== false ? 'checked' : ''}>在組</label>
          <button type="button" class="btn smallbtn danger" data-remove-member="${index}">刪除</button>
        </div>`;
    }).join('');
  }

  function memberCategoryLabel(memberId) {
    const categories = ownedCategories(memberId);
    return categories.length ? categories.map(item => item.name).join('、') : '尚未負責分類';
  }

  function renderReportMemberOptions() {
    const select = $('#teamReportMember');
    if (!select || !draft) return;
    const selected = select.value;
    select.innerHTML = `<option value="">選擇成員</option>${draft.members
      .filter(item => item.active !== false && item.weekly_report_required !== false)
      .map(item => `<option value="${esc(item.id)}">${esc(item.name)} · ${esc(memberCategoryLabel(item.id))}</option>`).join('')}`;
    if (draft.members.some(item => item.id === selected)) select.value = selected;
  }

  function renderReportScope() {
    const root = $('#teamReportScopeRows');
    const memberId = $('#teamReportMember')?.value || '';
    if (!root || !draft) return;
    if (!memberId) {
      root.className = 'team-report-scope-rows muted';
      root.textContent = draft.members.length ? '請選擇成員查看個人週報範圍。' : '請先新增成員並設定分類負責人。';
      return;
    }
    const member = draft.members.find(item => item.id === memberId);
    const items = Team.reportScope(draft, Store.state.subtasks, memberId, new Date(), Store.state.checkpoints);
    const categories = memberCategoryLabel(memberId);
    root.className = 'team-report-scope-rows';
    root.innerHTML = items.length ? `
      <div class="team-scope-summary"><b>${esc(member?.name || '')}</b> · ${esc(categories)} · 本期應回報 ${items.length} 項</div>
      ${items.map(item => `<div class="team-scope-item"><div><b>${esc(item.id)} · ${esc(item.name || '')}</b><div class="muted">${esc(item.parent_wp || '')} · ${esc(Team.categoryName(draft, item.owner_team))} · ${esc(item.status || 'Not Updated')}</div></div><time>${esc(item.end || '未設定期限')}</time></div>`).join('')}`
      : `<div class="team-empty">${esc(member?.name || '')} 目前沒有逾期，或下一個 CP 檢核前應完成的分類工作。</div>`;
  }

  function renderAll() {
    if (!draft) return;
    renderCategories();
    renderMembers();
    renderReportMemberOptions();
    renderReportScope();
    setDirty(dirty);
  }

  function loadFromStore() {
    baseline = Team.clone(Store.state.teamConfig);
    draft = Team.clone(Store.state.teamConfig);
    dirty = false;
    renderAll();
  }

  function serializableDraft() {
    const categoryIds = new Set(draft.categories.map(item => item.id));
    const memberIds = new Set(draft.members.map(item => item.id));
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
        weekly_report_required: item.weekly_report_required !== false,
        active: item.active !== false
      })),
      category_owners: Object.fromEntries(Object.entries(draft.category_owners)
        .filter(([categoryId, memberId]) => categoryIds.has(categoryId) && memberIds.has(memberId)))
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
    const memberMap = new Map();
    config.members.forEach(item => {
      if (!item.name) throw new Error('所有成員都必須填寫姓名');
      if (memberMap.has(item.id)) throw new Error(`成員資料重複：${item.name}`);
      memberMap.set(item.id, item);
    });
    Object.entries(config.category_owners).forEach(([categoryId, memberId]) => {
      const member = memberMap.get(memberId);
      if (!categoryIds.has(categoryId)) throw new Error(`負責分類不存在：${categoryId}`);
      if (!member) throw new Error(`分類 ${categoryId} 的負責人不存在`);
      if (member.active === false) throw new Error(`${member.name} 已停用，不能擔任分類負責人`);
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
      renderMembers();
      renderReportMemberOptions();
      renderReportScope();
      return;
    }
    const memberField = event.target.closest('[data-member-field]');
    if (memberField) {
      const index = Number(memberField.closest('[data-member-index]').dataset.memberIndex);
      const item = draft.members[index];
      const field = memberField.dataset.memberField;
      item[field] = memberField.type === 'checkbox' ? memberField.checked : memberField.value;
      if (field === 'active' && item.active === false) {
        Object.entries(draft.category_owners).forEach(([categoryId, memberId]) => {
          if (memberId === item.id) delete draft.category_owners[categoryId];
        });
        renderMembers();
      }
      setDirty();
      renderCategories();
      renderReportMemberOptions();
      renderReportScope();
    }
  });

  document.addEventListener('change', event => {
    const owner = event.target.closest('[data-category-owner]');
    if (owner && draft) {
      if (owner.value) draft.category_owners[owner.dataset.categoryOwner] = owner.value;
      else delete draft.category_owners[owner.dataset.categoryOwner];
      setDirty();
      renderCategories();
      renderMembers();
      renderReportMemberOptions();
      renderReportScope();
      return;
    }
    if (event.target.matches('#teamReportMember')) renderReportScope();
  });

  $('#btnAddTeamCategory')?.addEventListener('click', () => {
    if (!draft || draft.categories.length >= 30) return toast('分類上限為 30 個');
    let number = draft.categories.length + 1;
    let id = `TEAM${number}`;
    const ids = new Set(draft.categories.map(item => item.id));
    while (ids.has(id)) { number += 1; id = `TEAM${number}`; }
    draft.categories.push({ id, name: '新分類', color: '#456990', active: true, order: draft.categories.length + 1 });
    setDirty();
    renderAll();
  });

  $('#btnAddTeamMember')?.addEventListener('click', () => {
    if (!draft) return;
    draft.members.push({
      id: `member-${crypto.randomUUID()}`,
      name: '',
      weekly_report_required: true,
      active: true
    });
    setDirty();
    renderAll();
    requestAnimationFrame(() => $('#teamMemberList [data-member-index]:last-child input[data-member-field="name"]')?.focus());
  });

  document.addEventListener('click', event => {
    const removeCategory = event.target.closest('[data-remove-category]');
    if (removeCategory && draft) {
      const index = Number(removeCategory.dataset.removeCategory);
      const item = draft.categories[index];
      const referenced = Team.referenced(Store.state.workPackages, Store.state.subtasks).includes(item.id);
      if (referenced) return toast(`${item.id} 仍被甘特圖引用，請先修改 WP / Subtask 分類`);
      delete draft.category_owners[item.id];
      draft.categories.splice(index, 1);
      setDirty();
      renderAll();
      return;
    }
    const removeMember = event.target.closest('[data-remove-member]');
    if (removeMember && draft) {
      const index = Number(removeMember.dataset.removeMember);
      const member = draft.members[index];
      const categories = ownedCategories(member.id);
      if (categories.length && !confirm(`刪除 ${member.name || '此成員'}，並清除 ${categories.length} 個分類的負責人設定？`)) return;
      draft.members.splice(index, 1);
      Object.entries(draft.category_owners).forEach(([categoryId, memberId]) => {
        if (memberId === member.id) delete draft.category_owners[categoryId];
      });
      setDirty();
      renderAll();
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
      toast('分類負責人已 commit / push 至 Private Git');
    } catch (error) {
      toast(error.message || String(error));
    } finally {
      button.disabled = false;
      button.textContent = '儲存成員與分工';
    }
  });
})();
