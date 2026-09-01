(() => {
  const groups=[
    {id:'project',label:'Project',views:['plan','cp']},
    {id:'requirements',label:'Requirements',views:['fsr','item-functions','reference','tr']},
    {id:'workflow',label:'Workflow',views:['reports','review']}
  ];
  let installed=false;

  function loadGanttRange(){
    if(document.querySelector('script[data-smartport-gantt-range]'))return;
    const s=document.createElement('script');
    s.src=`js/gantt-range.js?v=${window.SMARTPORT_BUILD||Date.now()}`;
    s.dataset.smartportGanttRange='1';
    document.head.appendChild(s);
  }

  function collectButtons(nav){
    const required=['dashboard','reports','plan','fsr','cp','review','settings','item-functions','reference','tr'];
    return Object.fromEntries(required.map(v=>[v,nav.querySelector(`button[data-view="${v}"]`)]));
  }

  function installPublic(nav,buttons){
    [...nav.children].forEach(x=>x.remove());
    const dashboard=buttons.dashboard;
    const cp=buttons.cp;
    if(dashboard){dashboard.style.display='';nav.appendChild(dashboard)}
    if(cp){cp.style.display='';cp.textContent='CP / ACL';nav.appendChild(cp)}
    const login=document.createElement('button');
    login.type='button';
    login.textContent='GitHub Login';
    login.addEventListener('click',()=>window.SmartPortAPI?.login());
    nav.appendChild(login);
    nav.classList.add('nav-grouped','nav-public');
  }

  function installInternal(nav,buttons){
    nav.classList.add('nav-grouped');
    const dashboard=buttons.dashboard,settings=buttons.settings;
    [...nav.children].forEach(x=>x.remove());
    if(dashboard)nav.appendChild(dashboard);

    groups.forEach(g=>{
      const wrap=document.createElement('div');wrap.className='nav-menu';wrap.dataset.navGroup=g.id;
      const trigger=document.createElement('button');trigger.type='button';trigger.className='nav-menu-trigger';trigger.innerHTML=`${g.label}<span class="nav-caret">▾</span>`;
      const menu=document.createElement('div');menu.className='nav-menu-popover';
      g.views.forEach(v=>{const b=buttons[v];if(b){b.classList.add('nav-menu-item');b.style.display='';menu.appendChild(b)}});
      wrap.append(trigger,menu);nav.appendChild(wrap);
      trigger.addEventListener('click',e=>{e.stopPropagation();document.querySelectorAll('.nav-menu.open').forEach(x=>{if(x!==wrap)x.classList.remove('open')});wrap.classList.toggle('open')});
    });

    if(settings){const system=document.createElement('div');system.className='nav-system';settings.classList.add('nav-system-button');settings.style.display='';system.appendChild(settings);nav.appendChild(system)}
    nav.addEventListener('click',e=>{if(e.target.closest('button[data-view]'))document.querySelectorAll('.nav-menu.open').forEach(x=>x.classList.remove('open'))});
    document.addEventListener('click',()=>document.querySelectorAll('.nav-menu.open').forEach(x=>x.classList.remove('open')));

    function sync(){groups.forEach(g=>{const wrap=nav.querySelector(`[data-nav-group="${g.id}"]`);if(wrap)wrap.classList.toggle('group-active',g.views.some(v=>buttons[v]?.classList.contains('active')))})}
    const obs=new MutationObserver(sync);Object.values(buttons).filter(Boolean).forEach(b=>obs.observe(b,{attributes:true,attributeFilter:['class','style']}));sync();
  }

  function install(force=false){
    loadGanttRange();
    const nav=document.querySelector('.nav');if(!nav)return;
    if(installed&&!force)return;

    const buttons=collectButtons(nav);
    if(!buttons.dashboard||!buttons.cp)return;
    if(window.SMARTPORT_ACCESS?.role!=='PUBLIC'&&(!buttons['item-functions']||!buttons.reference||!buttons.tr))return;

    installed=true;
    if(window.SMARTPORT_ACCESS?.role==='PUBLIC') installPublic(nav,buttons);
    else installInternal(nav,buttons);

    if(!document.getElementById('smartportNavStyle')){
      const style=document.createElement('style');style.id='smartportNavStyle';style.textContent=`
        .nav.nav-grouped{display:flex;align-items:center;gap:8px;flex-wrap:nowrap;overflow:visible}.nav-menu{position:relative}.nav-menu-trigger{display:flex!important;align-items:center;gap:7px;white-space:nowrap}.nav-menu.group-active>.nav-menu-trigger{background:#fff;color:var(--navy)}.nav-caret{font-size:10px;opacity:.75}.nav-menu-popover{display:none;position:absolute;right:0;top:calc(100% + 8px);min-width:240px;background:#fff;border:1px solid var(--line);border-radius:11px;padding:7px;box-shadow:0 12px 30px rgba(16,24,40,.18);z-index:120}.nav-menu.open>.nav-menu-popover{display:flex;flex-direction:column;gap:3px}.nav .nav-menu-item{display:block!important;width:100%;text-align:left;background:#fff;color:var(--text);border-radius:7px;padding:9px 11px}.nav .nav-menu-item:hover{background:#f4f7fb}.nav .nav-menu-item.active{background:#eef4fb;color:var(--navy);font-weight:700}.nav-system{margin-left:2px}.nav-system-button{white-space:nowrap}.nav-public button{white-space:nowrap}@media(max-width:1100px){.header-right{width:100%}.nav.nav-grouped{flex-wrap:wrap;justify-content:flex-start}.nav-menu-popover{left:0;right:auto}}
      `;document.head.appendChild(style);
    }
  }

  document.addEventListener('smartport:access-changed',()=>{installed=false;setTimeout(()=>install(true),0)});
  const obs=new MutationObserver(()=>install());
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',()=>{install();obs.observe(document.body,{childList:true,subtree:true})});else{install();obs.observe(document.body,{childList:true,subtree:true})}
})();
