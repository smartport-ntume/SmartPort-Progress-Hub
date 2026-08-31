(() => {
  const S = window.SmartPortStore.state;
  let ownerFilter = 'ALL';
  let scheduled = false;

  const owners = [
    { value: 'ALL', label: '全部' },
    { value: 'CTL', label: '控制' },
    { value: 'LOC/NAV', label: '定位＋導航' },
    { value: 'PER', label: '感知' },
    { value: 'STM', label: '狀態機＋任務' },
    { value: 'VERIFY', label: 'Verification' }
  ];

  function itemOwner(id) {
    const wp = (S.workPackages || []).find(x => x.id === id);
    if (wp) return wp.owner || '';
    const sub = (S.subtasks || []).find(x => x.id === id);
    return sub?.owner_team || '';
  }

  function rowId(row) {
    return row?.children?.[1]?.querySelector('b')?.textContent?.trim() || '';
  }

  function installControl() {
    const toolbar = document.querySelector('#dashboard .panel .panel-title .toolbar');
    if (!toolbar || document.getElementById('ganttOwnerFilter')) return;

    const label = document.createElement('label');
    label.className = 'gantt-owner-filter muted';
    label.innerHTML = `<span>Owner</span><select id="ganttOwnerFilter">${owners.map(x => `<option value="${x.value}">${x.label}</option>`).join('')}</select>`;
    toolbar.insertBefore(label, toolbar.firstChild);

    label.querySelector('select').addEventListener('change', e => {
      ownerFilter = e.target.value || 'ALL';
      applyFilter();
    });
  }

  function applyFilter() {
    const rows = [...document.querySelectorAll('#gantt > .g-row:not(.g-head)')];
    let visible = 0;

    rows.forEach(row => {
      const id = rowId(row);
      const owner = itemOwner(id);
      row.dataset.ganttOwner = owner;
      const show = ownerFilter === 'ALL' || owner === ownerFilter;
      row.style.display = show ? '' : 'none';
      if (show) visible += 1;
    });

    const select = document.getElementById('ganttOwnerFilter');
    if (select && select.value !== ownerFilter) select.value = ownerFilter;

    let status = document.getElementById('ganttOwnerStatus');
    const toolbar = document.querySelector('#dashboard .panel .panel-title .toolbar');
    if (toolbar && !status) {
      status = document.createElement('span');
      status.id = 'ganttOwnerStatus';
      status.className = 'muted gantt-owner-status';
      toolbar.appendChild(status);
    }
    if (status) {
      const name = owners.find(x => x.value === ownerFilter)?.label || ownerFilter;
      status.textContent = `${name} · ${visible} rows`;
    }
  }

  function refresh() {
    scheduled = false;
    installControl();
    applyFilter();
  }

  function schedule() {
    if (scheduled) return;
    scheduled = true;
    setTimeout(refresh, 25);
  }

  const style = document.createElement('style');
  style.textContent = `
    .gantt-owner-filter{display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
    .gantt-owner-filter select{height:30px;border:1px solid var(--line);border-radius:7px;background:#fff;color:var(--text);padding:0 28px 0 9px;font-size:12px;cursor:pointer}
    .gantt-owner-status{font-size:11px;white-space:nowrap}
    @media(max-width:900px){.gantt-owner-status{display:none}}
  `;
  document.head.appendChild(style);

  const gantt = document.getElementById('gantt');
  if (gantt) {
    new MutationObserver(schedule).observe(gantt, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', refresh);
  else refresh();
})();
