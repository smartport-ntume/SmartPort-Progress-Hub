(() => {
  const esc=value=>String(value??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const day=86400000;
  function weekOf(date) {
    const d=new Date(date+'T00:00:00Z');d.setUTCDate(d.getUTCDate()+4-(d.getUTCDay()||7));
    const year=d.getUTCFullYear(),week=Math.ceil(((d-Date.UTC(year,0,1))/day+1)/7);
    return `${year}-W${String(week).padStart(2,'0')}`;
  }
  function mondayOf(value) {
    const m=/^(\d{4})-W(\d{2})$/.exec(value);if(!m)throw new Error('請選擇有效週次，例如 2026-W41。');
    const d=new Date(Date.UTC(Number(m[1]),0,4));
    d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7)+(Number(m[2])-1)*7);
    const date=d.toISOString().slice(0,10);
    if(weekOf(date)!==value)throw new Error('此年份沒有這個週次。');
    return date;
  }
  const nextDate=date=>new Date(+new Date(date+'T00:00:00Z')+7*day).toISOString().slice(0,10);
  const dueDefault=date=>nextDate(date)+'T12:00';
  const localInput=value=>new Date(+new Date(value)+8*3600000).toISOString().slice(0,16);
  function suggestedDate(batches=[],now=new Date()) {
    const d=new Date(+now+8*3600000);d.setUTCDate(d.getUTCDate()-((d.getUTCDay()+6)%7));
    let date=d.toISOString().slice(0,10);
    while(batches.some(b=>b.report_date===date&&b.discord_message_sent_at))date=nextDate(date);
    return date;
  }

  function mount(parent,{API,onPublished}) {
    const root=document.createElement('section');root.className='weekly-publication';root.hidden=true;
    root.setAttribute('aria-label','發布週報到 Discord');
    root.innerHTML=`<div class="weekly-center-head"><h3 data-pub="title">發布新一期週報</h3><button class="btn" data-pub-action="close">關閉</button></div>
      <p>全體應繳成員都會收到 Word 與繳交連結，包含上期未繳與待審的人。未完成審閱的草稿意見不會帶入。</p>
      <div class="weekly-publication-fields"><label>週次<input type="week" data-pub="week" aria-label="發布週次" required></label>
      <label>截止時間（台灣）<input type="datetime-local" data-pub="due" aria-label="發布截止時間" required></label></div>
      <p class="muted" data-pub="note"></p><button class="btn" data-pub-action="preview">預覽發布名單</button>
      <div data-pub="preview" hidden></div><p data-pub="message" class="weekly-center-message" role="status" aria-live="polite"></p>
      <button class="btn primary" data-pub-action="send" hidden>確認發布到 Discord</button>`;
    parent.append(root);
    const el=name=>root.querySelector(`[data-pub="${name}"]`),button=name=>root.querySelector(`[data-pub-action="${name}"]`);
    const storageKey='smartport.weeklyPublicationJob';
    let busy=false,batch=null,preview=null,requestInput=null;
    const message=(text,error=false)=>{el('message').textContent=text;el('message').classList.toggle('error',error);};
    function controls(){
      button('preview').disabled=busy;button('send').disabled=busy||!preview;
      el('week').disabled=busy||!!batch;el('due').disabled=busy||!!batch;
    }
    function invalidate(){preview=null;el('preview').hidden=true;button('send').hidden=true;controls();}
    function save(value){try{if(value)sessionStorage.setItem(storageKey,JSON.stringify(value));else sessionStorage.removeItem(storageKey);}catch(_){}}
    function renderPreview(value){
      if(!value?.preview_token||!Array.isArray(value.members))throw new Error('Agent 尚未提供發布預覽，請更新並重啟 Agent。');
      preview=value;
      el('week').value=weekOf(value.report_date);el('due').value=localInput(value.due_at);
      requestInput=batch?{batch_id:batch.id}:{report_date:value.report_date,due_at:value.due_at};
      el('preview').hidden=false;
      el('preview').innerHTML=`<h4>${esc(value.week_key)} · 共 ${value.members.length} 人 · 發布第 ${esc(value.revision)} 版</h4>
        <p>已審 ${value.counts.REVIEWED} 人 · 未繳 ${value.counts.MISSING} 人 · 待審 ${value.counts.PENDING} 人${value.counts.NOT_REQUIRED?` · 首次／上期無需繳交 ${value.counts.NOT_REQUIRED} 人`:''}</p>
        <p class="muted">${value.previous_week?`上期來源：${esc(value.previous_week)}`:'首次發布，沒有上期回饋。'}${value.resume?' 此版尚未發完，將沿用已確認的內容，續送剩餘附件。':''}</p>
        <table><thead><tr><th>收件成員</th><th>Word 帶入狀態</th></tr></thead><tbody>${value.members.map(m=>`<tr><td>${esc(m.member_name)}</td><td>${esc(m.label)}</td></tr>`).join('')}</tbody></table>`;
      button('send').textContent=value.resume?'確認續送到 Discord':batch?'確認更新回饋並補發':'確認發布到 Discord';
      button('send').hidden=false;
      message('請確認週次、截止時間及名單。尚未審完或未繳交的人也會收到。');
    }
    async function run(request){
      busy=true;controls();save(request);message('等待 Agent 處理，可繼續查看其他週報。');
      try{
        if(!request.job_id){const queued=await API.weeklyPublication(request.action,request.input,request.key);request.job_id=queued.job.id;save(request);}
        const job=await API.waitForAnalysisJob(request.job_id);
        if(request.action.startsWith('preview_'))renderPreview(job.result?.preview);
        else{
          invalidate();
          message(job.result?.alreadySent?'此週已發布，沒有重複發送。':'Discord 發布完成；原有繳交連結與已上傳紀錄保留。');
          try{await onPublished?.();}catch(error){message('發布已完成，名單重新整理失敗：'+error.message,true);}
        }
      }catch(error){invalidate();message(error.message,true);}
      finally{busy=false;save(null);controls();}
    }
    function open(options={}){
      root.hidden=false;
      if(busy)return;
      batch=options.batch?Object.fromEntries(['id','report_date','week_key','due_at'].map(key=>[key,options.batch[key]])):null;invalidate();message('');
      el('title').textContent=batch?'更新回饋並補發':'發布新一期週報';
      const date=batch?.report_date||suggestedDate(options.batches);
      el('week').value=weekOf(date);el('due').value=batch?localInput(batch.due_at):dueDefault(date);
      el('note').textContent=batch?'只更新上期回饋與狀態；保留本期成員、工作範圍、進度基準、截止時間與繳交紀錄。'
        :'發布後固定此版內容；後續 PM 意見完成時，由你決定是否更新回饋並補發。';
      controls();
    }
    root.addEventListener('input',event=>{
      if(event.target===el('week')){try{el('due').value=dueDefault(mondayOf(el('week').value));}catch(_){}}
      invalidate();
    });
    root.addEventListener('click',event=>{
      const action=event.target.closest('[data-pub-action]')?.dataset.pubAction;
      if(action==='close'){root.hidden=true;return;}
      if(busy)return;
      try{
        if(action==='preview'){
          if(!API.weeklyPublication)throw new Error('請重新整理網站以載入新版發布功能。');
          const due=new Date(el('due').value+'+08:00');
          if(!batch&&(!Number.isFinite(+due)||due<=new Date()))throw new Error('請設定未來的截止時間。');
          requestInput=batch?{batch_id:batch.id}:{report_date:mondayOf(el('week').value),due_at:due.toISOString()};
          invalidate();void run({action:batch?'preview_update':'preview_publish',input:requestInput,key:crypto.randomUUID(),batch});
        }else if(action==='send'&&preview){
          void run({action:batch?'update':'publish',input:{...requestInput,preview_token:preview.preview_token},key:crypto.randomUUID(),batch});
        }
      }catch(error){message(error.message,true);}
    });
    try{
      const saved=JSON.parse(sessionStorage.getItem(storageKey)||'null');
      if(saved&&['preview_publish','preview_update','publish','update'].includes(saved.action)&&saved.input&&typeof saved.key==='string'){
        open({batch:saved.batch});void run(saved);
      }
    }catch(_){save(null);}
    return {open};
  }
  window.SmartPortWeeklyPublication={mount,weekOf,mondayOf,suggestedDate};
})();
