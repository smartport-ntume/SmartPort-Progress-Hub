import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const source=await readFile(new URL('../js/weekly-publication.js',import.meta.url),'utf8');
const flush=()=>new Promise(resolve=>setImmediate(resolve));
const preview=()=>({preview_token:'a'.repeat(64),week_key:'2099-W03',report_date:'2099-01-12',due_at:'2099-01-19T04:00:00Z',
  previous_week:'2099-W02',revision:1,resume:false,counts:{REVIEWED:1,MISSING:1,PENDING:1,NOT_REQUIRED:0},members:[
    {member_name:'已審成員',label:'已完成 PM 審閱'},
    {member_name:'<img src=x onerror=alert(1)>',label:'上期未繳交'},
    {member_name:'待審成員',label:'上期 PM 回饋待補'}]});

function fixture(t,saved=null){
  const dom=new JSDOM('<main></main>',{url:'https://weekly.test',runScripts:'outside-only'});
  const {window}=dom,doc=window.document,calls=[],watched=[],waiters=new Map();let published=0;
  t.after(()=>window.close());
  if(saved)window.sessionStorage.setItem('smartport.weeklyPublicationJob',saved);
  window.eval(source);
  const API={
    async weeklyPublication(action,input,key){calls.push({action,input:structuredClone(input),key});return {job:{id:'job-'+calls.length}};},
    async waitForAnalysisJob(id){watched.push(id);return new Promise((resolve,reject)=>waiters.set(id,{resolve,reject}));}
  };
  const pane=window.SmartPortWeeklyPublication.mount(doc.querySelector('main'),{API,onPublished(){published++;}});
  const field=name=>doc.querySelector(`[data-pub="${name}"]`),button=name=>doc.querySelector(`[data-pub-action="${name}"]`);
  async function click(name){assert.equal(button(name).disabled,false);button(name).click();await flush();}
  function set(name,value){field(name).value=value;field(name).dispatchEvent(new window.Event('input',{bubbles:true}));}
  async function finish(id,result){waiters.get(id).resolve({id,status:'completed',result});await flush();}
  return {window,doc,pane,field,button,click,set,finish,calls,watched,waiters,published:()=>published};
}

test('manual publication previews all recipients before sending and ignores a double click',async t=>{
  const f=fixture(t);f.pane.open();
  f.set('week','2099-W03');assert.equal(f.field('due').value,'2099-01-19T12:00');
  assert.equal(f.button('send').hidden,true);
  await f.click('preview');assert.equal(f.calls[0].action,'preview_publish');
  assert.deepEqual(f.calls[0].input,{report_date:'2099-01-12',due_at:'2099-01-19T04:00:00.000Z'});
  assert.equal(f.button('preview').disabled,true);
  await f.finish('job-1',{preview:preview()});
  assert.equal(f.field('preview').querySelectorAll('tbody tr').length,3);
  assert.match(f.field('preview').textContent,/未繳 1 人 · 待審 1 人/);
  assert.equal(f.field('preview').querySelector('img'),null,'names are text, never HTML');
  assert.equal(f.button('send').hidden,false);assert.equal(f.calls.length,1);
  f.button('send').click();f.button('send').click();await flush();
  assert.equal(f.calls.length,2);assert.equal(f.calls[1].action,'publish');
  assert.equal(f.calls[1].input.preview_token,'a'.repeat(64));
  await f.finish('job-2',{sent:true});
  assert.equal(f.published(),1);assert.match(f.field('message').textContent,/發布完成/);
  assert.equal(f.window.sessionStorage.getItem('smartport.weeklyPublicationJob'),null);
});

test('editing the deadline invalidates the preview and an Agent error never implies publication',async t=>{
  const f=fixture(t);f.pane.open();f.set('week','2099-W03');await f.click('preview');
  await f.finish('job-1',{preview:preview()});
  f.set('due','2099-01-20T12:00');assert.equal(f.button('send').hidden,true);assert.equal(f.button('send').disabled,true);
  await f.click('preview');f.waiters.get('job-2').reject(new Error('請先更新 Agent'));await flush();
  assert.equal(f.published(),0);assert.match(f.field('message').textContent,/請先更新 Agent/);
  assert.equal(f.button('send').hidden,true);assert.equal(f.button('preview').disabled,false);
});

test('reload resumes the existing job and preserves update mode without enqueuing another delivery',async t=>{
  const first=fixture(t);
  first.pane.open({batch:{id:'old',report_date:'2026-09-14',due_at:'2026-09-21T04:00:00Z'}});
  assert.equal(first.field('week').disabled,true);assert.equal(first.field('due').disabled,true);
  await first.click('preview');assert.equal(first.calls[0].action,'preview_update');
  await first.finish('job-1',{preview:{...preview(),revision:2,report_date:'2026-09-14',week_key:'2026-W38',due_at:'2026-09-21T04:00:00Z'}});
  assert.equal(first.button('send').textContent,'確認更新回饋並補發');
  await first.click('send');assert.equal(first.calls[1].action,'update');
  const saved=first.window.sessionStorage.getItem('smartport.weeklyPublicationJob');
  const next=fixture(t,saved);await flush();
  assert.deepEqual(next.watched,['job-2']);assert.equal(next.calls.length,0);
  assert.equal(next.field('title').textContent,'更新回饋並補發');
  await next.finish('job-2',{alreadySent:true});
  assert.match(next.field('message').textContent,/沒有重複發送/);assert.equal(next.published(),1);
});

test('reload before enqueue acknowledgment retries with the same idempotency key',async t=>{
  const saved={action:'publish',input:{report_date:'2099-01-12',due_at:'2099-01-19T04:00:00Z',preview_token:'a'.repeat(64)},key:'same-enqueue-key',batch:null};
  const f=fixture(t,JSON.stringify(saved));await flush();
  assert.equal(f.calls[0].key,saved.key);assert.equal(f.calls[0].action,'publish');
  await f.finish('job-1',{sent:true});assert.equal(f.published(),1);
});

test('week helpers handle ISO year boundaries, invalid weeks and already published weeks',t=>{
  const f=fixture(t),helpers=f.window.SmartPortWeeklyPublication;
  assert.equal(helpers.weekOf('2026-12-28'),'2026-W53');assert.equal(helpers.mondayOf('2026-W53'),'2026-12-28');
  assert.throws(()=>helpers.mondayOf('2025-W53'));assert.throws(()=>helpers.mondayOf('2026-W00'));
  const now=new Date('2026-10-04T16:00:00Z');
  assert.equal(helpers.suggestedDate([],now),'2026-10-05');
  assert.equal(helpers.suggestedDate([{report_date:'2026-10-05',discord_message_sent_at:'sent'}],now),'2026-10-12');
  assert.equal(helpers.suggestedDate([{report_date:'2026-10-05',discord_message_sent_at:null}],now),'2026-10-05');
});
