(() => {
  const S=window.SmartPortStore?.state;
  if(!S)return;
  let scheduled=false;

  function validDate(v){
    if(!v)return null;
    const d=new Date(String(v)+'T12:00:00');
    return Number.isNaN(+d)?null:d;
  }

  function bounds(){
    const dates=[];
    for(const w of S.workPackages||[]){
      const a=validDate(w.start),b=validDate(w.end);
      if(a)dates.push(a);if(b)dates.push(b);
    }
    for(const cp of S.checkpoints||[]){
      const x=validDate(cp.date);if(x)dates.push(x);
    }
    if(!dates.length)return null;
    return{start:new Date(Math.min(...dates)),end:new Date(Math.max(...dates))};
  }

  function monthCount(a,b){
    return Math.max(1,(b.getFullYear()-a.getFullYear())*12+(b.getMonth()-a.getMonth())+1);
  }

  function ym(d){
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;
  }

  function update(){
    scheduled=false;
    const gantt=document.getElementById('gantt');
    if(!gantt)return;
    const b=bounds();if(!b)return;

    const months=monthCount(b.start,b.end);
    // Owner 110 + WP 300 + timeline. Keep roughly 135 px/month once the range grows.
    const fixed=410;
    const timeline=Math.max(870,months*135);
    const total=fixed+timeline;
    gantt.style.minWidth=`${total}px`;
    gantt.dataset.rangeStart=ym(b.start);
    gantt.dataset.rangeEnd=ym(b.end);
    gantt.dataset.rangeMonths=String(months);

    const panelTitle=gantt.closest('.panel')?.querySelector('.panel-title');
    if(panelTitle){
      let badge=panelTitle.querySelector('#ganttRangeBadge');
      if(!badge){
        badge=document.createElement('span');
        badge.id='ganttRangeBadge';
        badge.className='revision-badge';
        badge.style.marginLeft='8px';
        const toolbar=panelTitle.querySelector('.toolbar');
        panelTitle.insertBefore(badge,toolbar||null);
      }
      badge.textContent=`${ym(b.start)} → ${ym(b.end)} · ${months} months`;
      badge.title='Gantt range is automatically derived from the earliest/latest WP and Checkpoint dates.';
    }
  }

  function schedule(){
    if(scheduled)return;
    scheduled=true;
    setTimeout(update,40);
  }

  const obs=new MutationObserver(schedule);
  if(document.readyState==='loading'){
    document.addEventListener('DOMContentLoaded',()=>{
      schedule();obs.observe(document.body,{childList:true,subtree:true});
    });
  }else{
    schedule();obs.observe(document.body,{childList:true,subtree:true});
  }
})();
