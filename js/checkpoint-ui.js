(() => {
  const $ = s => document.querySelector(s);
  const $$ = s => [...document.querySelectorAll(s)];
  const API = window.SmartPortAPI;
  let refMap = new Map();
  let referenceLoaded = false;
  let referenceLoading = null;

  function esc(v='') {
    return String(v).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }

  // Fallback only. Canonical binding uses SmartPortStore.state.checkpoints[index].id.
  function cpIdFromText(text) {
    const m = String(text || '').match(/CP\d+/i);
    return m ? m[0].toUpperCase() : '';
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

  function monthCount(start,end) {
    return Math.max(1,(end.getFullYear()-start.getFullYear())*12+(end.getMonth()-start.getMonth())+1);
  }

  function monthLabel(date) {
    return `${date.getFullYear()}/${String(date.getMonth()+1).padStart(2,'0')}`;
  }

  function refreshGanttCalendar() {
    const bounds=ganttBounds(),gantt=$('#gantt');
    if(!bounds||!gantt)return;
    const months=monthCount(bounds.start,bounds.end);
    const targetWidth=Math.max(1280,410+months*135)+'px';
    if(gantt.style.minWidth!==targetWidth) gantt.style.minWidth=targetWidth;

    let cursor=new Date(bounds.start);
    $$('.month-lane .month').forEach((el,i)=>{
      if(i>0)cursor=new Date(cursor.getFullYear(),cursor.getMonth()+1,1,12,0,0);
      const label=monthLabel(cursor);
      if(el.textContent!==label)el.textContent=label;
      if(el.title!==label)el.title=label;
    });
  }

  function readiness(cp) {
    if(!cp?.criteria?.length)return{score:0,vals:[]};
    const S=window.SmartPortStore?.state;
    const vals=cp.criteria.map(([id,req])=>{
      const t=S?.workPackages?.find(x=>x.id===id);
      const act=t?(t.actual_progress??t.actualProgress??t.progress??0):0;
      return{id,req,act,ok:act>=req};
    });
    return{score:Math.round(vals.reduce((a,x)=>a+Math.min(1,x.req?x.act/x.req:1),0)/vals.length*100),vals};
  }

  async function loadReference(force=false) {
    if(referenceLoaded&&!force)return true;
    if(referenceLoading&&!force)return referenceLoading;
    referenceLoading=(async()=>{
      try{
        const data=await API.request('/api/project/reference');
        refMap=new Map((data?.reference?.acl_levels||[]).map(x=>[x.checkpoint,x]));
        referenceLoaded=true;
        return true;
      }catch(_){return false;}
      finally{referenceLoading=null;}
    })();
    return referenceLoading;
  }

  function renderFullCpDetail(id) {
    const S=window.SmartPortStore?.state;
    const cp=S?.checkpoints?.find(x=>x.id===id);
    if(!cp)return false;

    const ref=refMap.get(id)||{};
    const capability=ref.capability||cp.capability||'—';
    const review=ref.review_checks||cp.review_checks||'—';
    const fsr=ref.fsr_maturity_target||cp.fsrTarget||cp.fsr_target||'—';
    const r=readiness(cp);
    const drawer=$('#drawer'),backdrop=$('#drawerBackdrop'),title=$('#drawerTitle'),body=$('#drawerBody');
    if(!drawer||!backdrop||!title||!body)return false;

    title.textContent=`${cp.id} · ${cp.name||''}`;
    body.onsubmit=null;
    body.innerHTML=`
      <div class="field"><label>ACL / Date</label><div class="detail-value">${esc(cp.acl||ref.level||'')} · ${esc(cp.date||'')}</div></div>
      <div class="field"><label>Vehicle Capability / Gate</label><div class="detail-value cp-detail-multiline">${esc(capability).replace(/\n/g,'<br>')}</div></div>
      <div class="field"><label>Review / Check</label><div class="detail-value cp-detail-multiline">${esc(review).replace(/\n/g,'<br>')}</div></div>
      <div class="field"><label>FSR Target</label><div class="detail-value">${esc(fsr)}</div></div>
      <div class="field"><label>Readiness</label><div class="progress"><div style="width:${r.score}%"></div></div><div>${r.score}%</div></div>
      <div class="field"><label>Criteria</label><div class="detail-value">${r.vals.map(x=>`${x.ok?'✓':'△'} ${esc(x.id)}: ${x.act}% / ${x.req}%`).join('<br>')||'—'}</div></div>
      ${window.SMARTPORT_ACCESS?.can_write?`<button type="button" class="btn primary" data-edit-cp="${esc(cp.id)}">編輯 CP</button>`:''}`;
    drawer.classList.add('open');
    backdrop.classList.add('open');
    return true;
  }

  function openFullCpDetail(id) {
    const opened=renderFullCpDetail(id);
    if(!opened){
      const toast=$('#toast');
      if(toast){
        toast.textContent=`找不到 ${id} 的 Checkpoint 資料`;
        toast.classList.add('show');
        clearTimeout(openFullCpDetail.toastTimer);
        openFullCpDetail.toastTimer=setTimeout(()=>toast.classList.remove('show'),3500);
      }
      return;
    }
    if(!refMap.has(id)){
      loadReference().then(ok=>{if(ok)renderFullCpDetail(id);});
    }
  }

  function bindCpElement(el, canonicalId) {
    const id=canonicalId||cpIdFromText(el.textContent);
    if(!id)return;

    // Always overwrite stale/malformed IDs such as CP4ACL-4.
    el.dataset.cpId=id;
    el.classList.add('checkpoint-clickable');
    el.tabIndex=0;
    el.setAttribute('role','button');
    el.onclick=null;

    if(el.dataset.cpMouseBound!=='1'){
      el.dataset.cpMouseBound='1';
      el.addEventListener('mousedown',evt=>{
        if(evt.button!==0)return;
        evt.preventDefault();
        evt.stopPropagation();
        openFullCpDetail(el.dataset.cpId);
      });
    }
    if(el.dataset.cpKeyboardBound!=='1'){
      el.dataset.cpKeyboardBound='1';
      el.addEventListener('keydown',evt=>{
        if(evt.key==='Enter'||evt.key===' '){
          evt.preventDefault();
          openFullCpDetail(el.dataset.cpId);
        }
      });
    }
  }

  function refresh() {
    const S=window.SmartPortStore?.state;
    const checkpoints=S?.checkpoints||[];

    // app.js renders both collections in the same order as S.checkpoints.
    $$('.cp-marker').forEach((el,i)=>bindCpElement(el,checkpoints[i]?.id||cpIdFromText(el.textContent)));
    $$('.cp-point').forEach((el,i)=>bindCpElement(el,checkpoints[i]?.id||cpIdFromText(el.textContent)));
    refreshGanttCalendar();
  }

  const style=document.createElement('style');
  style.textContent=`
    .cp-marker{cursor:pointer;z-index:30!important;pointer-events:auto!important;user-select:none;transition:box-shadow .12s ease,filter .12s ease}
    .cp-marker:hover,.cp-marker:focus-visible{filter:brightness(.98);box-shadow:0 2px 8px rgba(139,91,8,.18);outline:2px solid rgba(82,119,187,.35);outline-offset:2px}
    .today-tag{pointer-events:none!important}
    .checkpoint-clickable{cursor:pointer}
    .month-lane .month{white-space:nowrap;font-size:11px}
    .cp-detail-multiline{line-height:1.55;white-space:normal}
    .cp-detail-multiline br{content:"";display:block;margin-bottom:4px}
  `;
  document.head.appendChild(style);

  let timer=null;
  const observer=new MutationObserver(()=>{
    clearTimeout(timer);
    timer=setTimeout(refresh,40);
  });

  function init(){
    refresh();
    loadReference().then(refresh);
    observer.observe(document.body,{childList:true,subtree:true});
  }

  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init);
  else init();
})();
