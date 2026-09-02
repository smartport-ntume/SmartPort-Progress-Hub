from pathlib import Path
import re

BUILD_OLD='20260901.1720'
BUILD_NEW='20260902.1410'

# 1) Prevent Traceability Health MutationObserver self-render loop.
p=Path('js/traceability.js')
s=p.read_text(encoding='utf-8')
pat=r"    panel\.innerHTML=(`[^;]*?`);\n  }\n\n  document\.addEventListener"
m=re.search(pat,s,re.S)
if not m:
    raise SystemExit('traceability health assignment pattern not found')
replacement="    const healthHtml="+m.group(1)+";\n    if(panel.innerHTML!==healthHtml)panel.innerHTML=healthHtml;\n  }\n\n  document.addEventListener"
s=s[:m.start()]+replacement+s[m.end():]
p.write_text(s,encoding='utf-8')

# 2) Add Target CP column and clickable CP badges to Plan Editor.
p=Path('js/plan-enhancements.js')
s=p.read_text(encoding='utf-8')
anchor="  function countFor(g){\n    if(g==='ALL')return S.workPackages.length+S.subtasks.length;\n    const ids=new Set(S.workPackages.filter(w=>familyOfWp(w.id)===g).map(w=>w.id));\n    return ids.size+S.subtasks.filter(s=>ids.has(s.parent_wp)).length;\n  }\n"
insert=anchor+"  function wpTargetCps(id){return S.checkpoints.filter(cp=>Array.isArray(cp.criteria)&&cp.criteria.some(c=>c?.[0]===id)).map(cp=>cp.id);}\n  function cpBadge(id){return id?`<button type=\"button\" class=\"trace-chip trace-cp\" data-trace-cp=\"${esc(id)}\">${esc(id)}</button>`:'<span class=\"muted\">—</span>';}\n"
if anchor not in s: raise SystemExit('countFor anchor not found')
s=s.replace(anchor,insert,1)
s=s.replace("tr.innerHTML='<th>WP / Subtask</th><th>Owner</th><th>Start</th><th>End</th><th>Weight</th><th>Actual</th><th>工作內容</th><th>IF / FSR</th><th></th>';",
            "tr.innerHTML='<th>WP / Subtask</th><th>Owner</th><th>Start</th><th>End</th><th>Weight</th><th>Target CP</th><th>Actual</th><th>工作內容</th><th>IF / FSR</th><th></th>';",1)
s=s.replace("<td>${esc(weightOf(w))}</td><td>${p==null?'—':p+'%'}",
            "<td>${esc(weightOf(w))}</td><td>${wpTargetCps(w.id).map(cpBadge).join(' ')||'<span class=\"muted\">—</span>'}</td><td>${p==null?'—':p+'%'}",1)
s=s.replace("<td>${esc(weightOf(s))}</td><td>${p==null?'—':p+'%'}",
            "<td>${esc(weightOf(s))}</td><td>${cpBadge(s.target_cp||'')}</td><td>${p==null?'—':p+'%'}",1)
s=s.replace("colspan=\"9\"","colspan=\"10\"",1)
s=s.replace("#planTable{min-width:1360px}","#planTable{min-width:1460px}",1)
# Add structured FSR targets JSON to CP editor.
needle="<div class=\"field\"><label>FSR Target</label><input name=\"cp_fsr\" value=\"${esc(cp.fsrTarget||cp.fsr_target||ref?.fsr_maturity_target||'')}\"></div>\n      <div class=\"field\"><label>Readiness Criteria JSON</label>"
repl="<div class=\"field\"><label>FSR Target</label><input name=\"cp_fsr\" value=\"${esc(cp.fsrTarget||cp.fsr_target||ref?.fsr_maturity_target||'')}\"></div>\n      <div class=\"field\"><label>FSR Targets JSON</label><textarea name=\"cp_fsr_targets\" rows=\"8\">${esc(JSON.stringify(cp.fsr_targets||[],null,2))}</textarea></div>\n      <div class=\"field\"><label>Readiness Criteria JSON</label>"
if needle not in s: raise SystemExit('CP FSR field anchor not found')
s=s.replace(needle,repl,1)
p.write_text(s,encoding='utf-8')

# 3) Make conflict-safe CP save include structured fsr_targets.
p=Path('js/checkpoint-save.js')
s=p.read_text(encoding='utf-8')
criteria_block="    let criteria=[];\n    try{\n      criteria=JSON.parse(String(fd.get('cp_criteria')||'[]'));\n    }catch(_){\n      alert('Readiness Criteria JSON 格式錯誤');\n      return;\n    }\n"
new_block=criteria_block+"    let fsrTargets=[];\n    try{\n      fsrTargets=JSON.parse(String(fd.get('cp_fsr_targets')||'[]'));\n      if(!Array.isArray(fsrTargets))throw new Error('not array');\n    }catch(_){\n      alert('FSR Targets JSON 格式錯誤');\n      return;\n    }\n"
if criteria_block not in s: raise SystemExit('checkpoint criteria parser not found')
s=s.replace(criteria_block,new_block,1)
s=s.replace("      fsrTarget:String(fd.get('cp_fsr')||'').trim(),\n      criteria",
            "      fsrTarget:String(fd.get('cp_fsr')||'').trim(),\n      fsr_targets:fsrTargets,\n      criteria",1)
p.write_text(s,encoding='utf-8')

# 4) Wire Traceability before legacy checkpoint click handlers; bump asset cache.
p=Path('index.html')
s=p.read_text(encoding='utf-8')
if BUILD_OLD not in s: raise SystemExit('old build not found in index')
s=s.replace(BUILD_OLD,BUILD_NEW)
needle=f'<script src="js/weekly.js?v={BUILD_NEW}"></script>\n<script src="js/checkpoint-ui.js?v={BUILD_NEW}"></script>'
repl=f'<script src="js/weekly.js?v={BUILD_NEW}"></script>\n<script src="js/traceability.js?v={BUILD_NEW}"></script>\n<script src="js/checkpoint-ui.js?v={BUILD_NEW}"></script>'
if needle not in s: raise SystemExit('script insertion anchor not found')
s=s.replace(needle,repl,1)
p.write_text(s,encoding='utf-8')

# 5) README build + traceability capability note.
p=Path('README.md')
s=p.read_text(encoding='utf-8')
if BUILD_OLD not in s: raise SystemExit('old build not found in README')
s=s.replace(BUILD_OLD,BUILD_NEW)
marker='- 19 Work Packages and 96 Subtasks\n'
add=marker+'- Machine-readable traceability backbone: FSR → WP → Subtask → Target CP, with structured CP FSR maturity targets\n- Interactive CP / FSR / WP / Subtask trace drawers and Traceability Health checks\n'
if marker in s and 'Machine-readable traceability backbone' not in s:
    s=s.replace(marker,add,1)
p.write_text(s,encoding='utf-8')

print('Traceability UI integrated and build bumped to',BUILD_NEW)
