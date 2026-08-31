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
