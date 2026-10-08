(() => {
  const escape = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function hint(title, text) {
    return `<span class="help-title" tabindex="0" role="button" aria-label="${escape(title)}，顯示說明" data-help="${escape(text)}">${escape(title)}<span aria-hidden="true" class="help-dot">?</span></span>`;
  }
  function rubric(item) {
    if (!item) return '';
    const items = (lines, threshold) => lines?.length ? `<ul>${lines.map(line => `<li>${escape(line)}</li>`).join('')}</ul>` : `<p class="rubric-met">已達 ${threshold} 分要求</p>`;
    return `<section class="task-rubric" aria-label="工項評分"><div class="task-rubric-head"><b>${escape(item.score)}<small> / 100</small></b><span>${hint('回報品質', '評分看本週成果是否說清楚、資料是否足夠，與工項完成百分比無關。')}</span></div><p>${escape(item.summary)}</p><div class="rubric-guide"><div><h5>到 80 分</h5>${items(item.to_80, 80)}</div><div><h5>到 100 分</h5>${items(item.to_100, 100)}</div></div></section>`;
  }
  let tooltip, owner, hideTimer;
  function close() {
    clearTimeout(hideTimer);
    owner?.removeAttribute('aria-describedby');
    owner?.removeAttribute('aria-expanded');
    if (tooltip) tooltip.hidden = true;
    owner = null;
  }
  function show(element) {
    clearTimeout(hideTimer);
    if (owner !== element) close();
    if (!tooltip) {
      tooltip = document.createElement('div'); tooltip.id = 'smartport-help'; tooltip.className = 'ui-tooltip'; tooltip.role = 'tooltip';
      document.body.append(tooltip);
      tooltip.addEventListener('mouseenter', () => clearTimeout(hideTimer));
      tooltip.addEventListener('mouseleave', () => { hideTimer = setTimeout(close, 120); });
    }
    owner = element; tooltip.textContent = element.dataset.help; tooltip.hidden = false;
    element.setAttribute('aria-describedby', tooltip.id); element.setAttribute('aria-expanded', 'true');
    const rect = element.getBoundingClientRect(), box = tooltip.getBoundingClientRect();
    tooltip.style.left = Math.max(12, Math.min(rect.left, innerWidth - box.width - 12)) + 'px';
    tooltip.style.top = (rect.bottom + box.height + 16 < innerHeight ? rect.bottom + 8 : Math.max(8, rect.top - box.height - 8)) + 'px';
  }
  document.addEventListener('mouseover', event => { const element = event.target.closest?.('[data-help]'); if (element) show(element); });
  document.addEventListener('mouseout', event => { if (event.target.closest?.('[data-help]') && !event.relatedTarget?.closest?.('[data-help], .ui-tooltip')) hideTimer = setTimeout(close, 160); });
  document.addEventListener('focusin', event => { if (event.target.matches('[data-help]')) show(event.target); });
  document.addEventListener('focusout', event => { if (event.target === owner) close(); });
  document.addEventListener('click', event => {
    const element = event.target.closest?.('[data-help]');
    if (element) show(element); else if (!event.target.closest?.('.ui-tooltip')) close();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') close();
    else if (['Enter', ' '].includes(event.key) && event.target.matches('.help-title')) { event.preventDefault(); show(event.target); }
  });
  window.addEventListener('resize', close);
  document.addEventListener('scroll', close, true);
  // Move only explicitly identified explanatory copy to its own nearby title.
  // Status, validation errors, dates and project facts stay visible.
  function condense() {
    for (const node of document.querySelectorAll('[data-hint-for]')) {
      const title = document.getElementById(node.dataset.hintFor);
      if (!title) continue;
      title.innerHTML = hint(title.textContent, node.textContent);
      node.remove();
    }
  }
  window.SmartPortUI = { hint, rubric, condense };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', condense); else condense();
})();
