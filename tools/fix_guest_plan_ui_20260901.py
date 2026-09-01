from pathlib import Path

p = Path('js/plan-enhancements.js')
s = p.read_text(encoding='utf-8')
old = s

s = s.replace(
    "    wrap.innerHTML=groups.map(g=>`<button type=\"button\" class=\"btn smallbtn ${filter===g.id?'primary':''}\" data-plan-family=\"${g.id}\" aria-pressed=\"${filter===g.id?'true':'false'}\">${g.label} · ${countFor(g.id)}</button>`).join('');",
    "    const filterHtml=groups.map(g=>`<button type=\"button\" class=\"btn smallbtn ${filter===g.id?'primary':''}\" data-plan-family=\"${g.id}\" aria-pressed=\"${filter===g.id?'true':'false'}\">${g.label} · ${countFor(g.id)}</button>`).join('');\n    if(wrap.innerHTML!==filterHtml)wrap.innerHTML=filterHtml;"
)

s = s.replace("  function renderPlanRows(){", "  function renderPlanRows(resetScroll=false){")
s = s.replace(
    "    const scroller=tbody.closest('div[style*=\"overflow\"]');if(scroller)scroller.scrollTop=0;",
    "    const scroller=tbody.closest('div[style*=\"overflow\"]');if(resetScroll&&scroller)scroller.scrollTop=0;"
)
s = s.replace(
    "    if(family){e.preventDefault();e.stopImmediatePropagation();filter=String(family.dataset.planFamily||'ALL').toUpperCase();renderPlanRows();return;}",
    "    if(family){e.preventDefault();e.stopImmediatePropagation();filter=String(family.dataset.planFamily||'ALL').toUpperCase();renderPlanRows(true);return;}"
)

if s == old:
    raise SystemExit('Expected plan enhancement patterns were not found')
if 'function renderPlanRows(resetScroll=false)' not in s:
    raise SystemExit('renderPlanRows patch failed')
if 'if(resetScroll&&scroller)scroller.scrollTop=0' not in s:
    raise SystemExit('scroll preservation patch failed')
if 'renderPlanRows(true);return;' not in s:
    raise SystemExit('filter click patch failed')

p.write_text(s, encoding='utf-8')
print('Fixed Guest Plan scroll preservation and family filters')
