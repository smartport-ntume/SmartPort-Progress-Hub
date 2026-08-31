(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const API = window.SmartPortAPI;
  let refMap = new Map();

  function esc(v='') {
    return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  function cpIdFromText(text) {
    const m = String(text || '').match(/\bCP[\w.-]*\b/i);
    return m ? m[0] : '';
  }

  function parseDate(v) {
    if (!v) return null;
    const x = new Date(String(v) + 'T12:00:00');
    return Number.isNaN(+x) ? null : x;
  }

  function ganttBounds() {
    const S = window.SmartPortStore?.state;
    if (!S) return null;
    const dates = [];
    (S.workPackages || []).forEach(w => {
      const a = parseDate(w.start), b = parseDate(w.end);
      if (a) dates.push(a);
      if (b) dates.push(b);
    });
    (S.checkpoints || []).forEach(cp => {
      const x = parseDate(cp.date);
      if (x) dates.push(x);
    });
    if (!dates.length) return null;
    return {
      start: new Date(Math.min(...dates.map(x => +x))),
      end: new Date(Math.max(...dates.map(x => +x)))
    };
  }

  function monthCount(start, end) {
    return Math.max(1,
      (end.getFullYear() - start.getFullYear()) * 12 +
      (end.getMonth() - start.getMonth()) + 1
    );
  }

  function monthLabel(date) {
    return `${date.getFullYear()}/${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function refreshGanttCalendar() {
    const bounds = ganttBounds();
    const gantt = $('#gantt');
    if (!bounds || !gantt) return;

    const months = monthCount(bounds.start, bounds.end);
    const leftColumns = 410;
    gantt.style.minWidth = Math.max(1280, leftColumns + months * 135) + 'px';

    let cursor = new Date(bounds.start);
    $$('.month-lane .month').forEach((el, i) => {
      if (i > 0) cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12, 0, 0);
      el.textContent = monthLabel(cursor);
      el.title = monthLabel(cursor);
    });
  }

  function readiness(cp) {
    if (!cp?.criteria?.length) return { score: 0, vals: [] };
    const S = window.SmartPortStore?.state;
    const vals = cp.criteria.map(([id, req]) => {
      const t = S?.workPackages?.find(x => x.id === id);
      const act = t ? (t.actual_progress ?? t.actualProgress ?? t.progress ?? 0) : 0;
      return { id, req, act, ok: act >= req };
    });
    const score = Math.round(vals.reduce((a,x)=>a+Math.min(1,x.req?x.act/x.req:1),0)/vals.length*100);
    return { score, vals };
  }

  function openFullCpDetail(id) {
    const S = window.SmartPortStore?.state;
    const cp = S?.checkpoints?.find(x => x.id === id);
    if (!cp) return;
    const ref = refMap.get(id) || {};
    const capability = ref.capability || cp.capability || '—';
    const review = ref.review_checks || cp.review_checks || '—';
    const fsr = ref.fsr_maturity_target || cp.fsrTarget || cp.fsr_target || '—';
    const r = readiness(cp);

    const drawer = $('#drawer');
    const backdrop = $('#drawerBackdrop');
    const title = $('#drawerTitle');
    const body = $('#drawerBody');
    if (!drawer || !backdrop || !title || !body) return;

    title.textContent = `${cp.id} · ${cp.name || ''}`;
    body.innerHTML = `
      <div class="field"><label>ACL / Date</label><div class="detail-value">${esc(cp.acl||ref.level||'')} · ${esc(cp.date||'')}</div></div>
      <div class="field"><label>Vehicle Capability / Gate</label><div class="detail-value cp-detail-multiline">${esc(capability).replace(/\n/g,'<br>')}</div></div>
      <div class="field"><label>Review / Check</label><div class="detail-value cp-detail-multiline">${esc(review).replace(/\n/g,'<br>')}</div></div>
      <div class="field"><label>FSR Target</label><div class="detail-value">${esc(fsr)}</div></div>
      <div class="field"><label>Readiness</label><div class="progress"><div style="width:${r.score}%"></div></div><div>${r.score}%</div></div>
      <div class="field"><label>Criteria</label><div class="detail-value">${r.vals.map(x=>`${x.ok?'✓':'△'} ${esc(x.id)}: ${x.act}% / ${x.req}%`).join('<br>')||'—'}</div></div>
      ${window.SMARTPORT_ACCESS?.can_write?`<button type="button" class="btn primary" data-edit-cp="${esc(cp.id)}">編輯 CP</button>`:''}`;

    drawer.classList.add('open');
    backdrop.classList.add('open');
  }

  async function loadReference() {
    try {
      const token = sessionStorage.getItem('smartport.session') || '';
      const res = await fetch(API.getBase() + '/api/project/reference', {
        credentials: 'include',
        headers: { ...(token ? { 'Authorization': `Bearer ${token}` } : {}) }
      });
      if (!res.ok) return;
      const data = await res.json();
      refMap = new Map((data?.reference?.acl_levels || []).map(x => [x.checkpoint, x]));
    } catch (_) {}
  }

  function refresh() {
    $$('.cp-marker').forEach(el => {
      el.classList.add('checkpoint-clickable');
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
    });
    refreshGanttCalendar();
  }

  // Capture phase: take ownership before app.js legacy onclick runs.
  document.addEventListener('click', e => {
    const marker = e.target.closest?.('.cp-marker');
    if (marker) {
      const id = cpIdFromText(marker.textContent);
      if (id) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openFullCpDetail(id);
      }
      return;
    }

    const point = e.target.closest?.('.cp-point');
    if (point) {
      const id = cpIdFromText(point.textContent);
      if (id) {
        e.preventDefault();
        e.stopImmediatePropagation();
        openFullCpDetail(id);
      }
      return;
    }
  }, true);

  const style = document.createElement('style');
  style.textContent = `
    .cp-marker{cursor:pointer;z-index:12;pointer-events:auto;transition:box-shadow .12s ease,filter .12s ease}
    .cp-marker:hover,.cp-marker:focus-visible{filter:brightness(.98);box-shadow:0 2px 8px rgba(139,91,8,.18);outline:2px solid rgba(82,119,187,.35);outline-offset:2px}
    .today-tag{pointer-events:none!important}
    .checkpoint-clickable{cursor:pointer}
    .month-lane .month{white-space:nowrap;font-size:11px}
    .cp-detail-multiline{line-height:1.55;white-space:normal}
    .cp-detail-multiline br{content:"";display:block;margin-bottom:4px}
  `;
  document.head.appendChild(style);

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 30);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', async () => {
      await loadReference();
      refresh();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    loadReference().then(refresh);
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
