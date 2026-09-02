from pathlib import Path
import re

p = Path('js/traceability.js')
s = p.read_text(encoding='utf-8')
old = s

pattern = re.compile(r"  function renderHealth\(\)\{.*?\n  \}\n\n  document\.addEventListener\('click'", re.S)
replacement = "  function renderHealth(){\n    document.getElementById('traceabilityHealthPanel')?.remove();\n  }\n\n  document.addEventListener('click'"
s, n = pattern.subn(replacement, s, count=1)
if n != 1:
    raise SystemExit(f'Expected one renderHealth block, replaced {n}')

s = s.replace("  const obs=new MutationObserver(()=>renderHealth());\n  const start=()=>{renderHealth();const main=document.querySelector('main');if(main)obs.observe(main,{childList:true,subtree:true});setTimeout(renderHealth,800);setTimeout(renderHealth,2200)};\n  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();\n", "  const start=()=>renderHealth();\n  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',start);else start();\n")

s = s.replace(".trace-health-panel{margin-bottom:14px}.trace-health-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:1px;background:#e5e7eb}.trace-health-grid>div{background:#fff;padding:12px 14px;display:flex;justify-content:space-between;align-items:center}.trace-health-grid span{font-size:11px;color:#667085}.trace-health-grid b{font-size:18px}.trace-health-warning{padding:8px 14px;font-size:11px;color:#b42318;background:#fff4f2;border-top:1px solid #fecdca}@media(max-width:850px){.trace-health-grid{grid-template-columns:1fr 1fr}}", "")

if s == old:
    raise SystemExit('No changes made')
p.write_text(s, encoding='utf-8')

for name in ['index.html','README.md']:
    q=Path(name)
    t=q.read_text(encoding='utf-8')
    t=t.replace('20260902.1410','20260902.1420')
    q.write_text(t,encoding='utf-8')

print('Removed Traceability Health panel and bumped build')
