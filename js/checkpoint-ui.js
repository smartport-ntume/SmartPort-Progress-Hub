(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];

  function cpIdFromText(text) {
    const m = String(text || '').match(/\bCP[\w.-]*\b/i);
    return m ? m[0] : '';
  }

  function markerFor(id) {
    if (!id) return null;
    return $$('.cp-marker').find(el => cpIdFromText(el.textContent) === id) || null;
  }

  function pointFor(id) {
    if (!id) return null;
    return $$('.cp-point').find(el => cpIdFromText(el.textContent) === id) || null;
  }

  function openCheckpoint(id) {
    const marker = markerFor(id);
    if (marker) {
      marker.click();
      return true;
    }
    const point = pointFor(id);
    if (point) {
      point.click();
      return true;
    }
    return false;
  }

  function makeKeyboardClickable(el, idGetter) {
    if (!el || el.dataset.cpClickBound === '1') return;
    el.dataset.cpClickBound = '1';
    el.classList.add('checkpoint-clickable');
    el.tabIndex = 0;
    el.setAttribute('role', 'button');
    el.addEventListener('click', e => {
      if (e.target.closest('button,a,input,select,textarea')) return;
      const id = idGetter();
      if (id) openCheckpoint(id);
    });
    el.addEventListener('keydown', e => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      e.preventDefault();
      const id = idGetter();
      if (id) openCheckpoint(id);
    });
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

    // Keep roughly 135 px per month once the project becomes longer than the original view.
    const months = monthCount(bounds.start, bounds.end);
    const leftColumns = 410;
    gantt.style.minWidth = Math.max(1280, leftColumns + months * 135) + 'px';

    // app.js creates one .month element for each consecutive month in the project range.
    // Show the month row as YYYY/MM so cross-year schedules stay unambiguous.
    let cursor = new Date(bounds.start);
    $$('.month-lane .month').forEach((el, i) => {
      if (i > 0) cursor = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1, 12, 0, 0);
      el.textContent = monthLabel(cursor);
      el.title = monthLabel(cursor);
    });
  }

  function refresh() {
    // Gantt CP labels: keep the original app.js onclick, but make the hit target explicit.
    $$('.cp-marker').forEach(el => {
      el.classList.add('checkpoint-clickable');
      el.tabIndex = 0;
      el.setAttribute('role', 'button');
      if (el.dataset.cpKeyboardBound !== '1') {
        el.dataset.cpKeyboardBound = '1';
        el.addEventListener('keydown', e => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            el.click();
          }
        });
      }
    });

    refreshGanttCalendar();

    // Dashboard summary cards.
    const currentCard = $('#currentAcl')?.closest('.card');
    makeKeyboardClickable(currentCard, () => cpIdFromText($('#currentCpSub')?.textContent));

    const nextCard = $('#nextCp')?.closest('.card');
    makeKeyboardClickable(nextCard, () => cpIdFromText($('#nextCp')?.textContent));

    // CP / ACL cards.
    $$('[data-cp-card]').forEach(card => {
      makeKeyboardClickable(card, () => card.dataset.cpCard || cpIdFromText(card.textContent));
    });
  }

  const style = document.createElement('style');
  style.textContent = `
    .cp-marker{cursor:pointer;z-index:12;pointer-events:auto;transition:transform .12s ease,box-shadow .12s ease,filter .12s ease}
    .cp-marker:hover,.cp-marker:focus-visible{filter:brightness(.98);box-shadow:0 2px 8px rgba(139,91,8,.18);outline:2px solid rgba(82,119,187,.35);outline-offset:2px}
    .today-tag{pointer-events:none!important}
    .checkpoint-clickable{cursor:pointer}
    .card.checkpoint-clickable,.cp-card.checkpoint-clickable{transition:box-shadow .12s ease,transform .12s ease,border-color .12s ease}
    .card.checkpoint-clickable:hover,.cp-card.checkpoint-clickable:hover{box-shadow:0 4px 14px rgba(16,24,40,.10);transform:translateY(-1px);border-color:#b9c6d8}
    .card.checkpoint-clickable:focus-visible,.cp-card.checkpoint-clickable:focus-visible{outline:2px solid #5277bb;outline-offset:2px}
    .month-lane .month{white-space:nowrap;font-size:11px}
  `;
  document.head.appendChild(style);

  let timer = null;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(refresh, 20);
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      refresh();
      observer.observe(document.body, { childList: true, subtree: true });
    });
  } else {
    refresh();
    observer.observe(document.body, { childList: true, subtree: true });
  }
})();
