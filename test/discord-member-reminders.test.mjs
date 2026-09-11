import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { discordUserId, guestTeamConfig, validateTeamConfig } from '../worker/src/team-config.js';
import { refreshWeeklyBatchMemberNames } from '../local-server/supabase-sync.mjs';
import { memberPortalEmbed, membersNeedingReminder, reminderMessages, weeklyPortalLink } from '../local-server/weekly-discord.mjs';
import { WeeklyReportAutomation, weeklySchedule } from '../local-server/weekly-report-automation.mjs';

const alice='123456789012345678';
const bob='223456789012345678';
const token='test-only-weekly-token-1234567890';
const portal='https://example.test/weekly-submit.html';
const config=()=>({categories:[{id:'CTL',name:'控制'}],members:[
  {id:'m1',name:'成員一',discord_user_id:alice},{id:'m2',name:'成員二',discord_user_id:bob}
],category_owners:{CTL:'m1'}});

test('Discord IDs remain exact strings, reject duplicate or malformed bindings and stay hidden from Guest',async()=>{
  const saved=validateTeamConfig(config());
  assert.equal(saved.members[0].discord_user_id,alice);
  assert.equal(discordUserId('  '+alice+' '),alice);
  for(const value of ['@alice',`<@${alice}>`,Number(alice),'012345678901234567','18446744073709551616','1'.repeat(21)]){
    const bad=config();bad.members[0].discord_user_id=value;
    assert.throws(()=>validateTeamConfig(bad),/invalid_discord_user_id/);
  }
  const duplicate=config();duplicate.members[1].discord_user_id=alice;
  assert.throws(()=>validateTeamConfig(duplicate),/duplicate_discord_user_id/);
  assert.equal(JSON.stringify(guestTeamConfig(saved)).includes(alice),false);
  const window={};vm.runInNewContext(await readFile(new URL('../js/team-config.js',import.meta.url),'utf8'),{window});
  assert.equal(window.SmartPortTeam.normalize(saved).members[0].discord_user_id,alice);
});

test('open batches update and clear Discord mappings without changing their frozen member scope',()=>{
  const payload={subtasks:[{id:'C1',end:'2026-09-20'}],team_config:config()};
  const current=config();current.members[0].discord_user_id=bob;current.members[1].discord_user_id='';
  const updated=refreshWeeklyBatchMemberNames(payload,current);
  assert.equal(updated.team_config.members[0].discord_user_id,bob);
  assert.equal('discord_user_id' in updated.team_config.members[1],false);
  assert.equal(updated.subtasks,payload.subtasks);
  assert.equal(updated.team_config.category_owners,payload.team_config.category_owners);
  assert.equal(refreshWeeklyBatchMemberNames(updated,current),null);
  const inactive=config();inactive.members[0].active=false;
  const stopped=refreshWeeklyBatchMemberNames(payload,inactive);
  assert.equal('discord_user_id' in stopped.team_config.members[0],false);
  assert.equal(stopped.team_config.members[0].reminder_disabled,true);
  assert.deepEqual(membersNeedingReminder(stopped.team_config.members,[]).map(m=>m.id),['m2']);
  const resumed=refreshWeeklyBatchMemberNames(stopped,config());
  assert.equal('reminder_disabled' in resumed.team_config.members[0],false);
  assert.deepEqual(membersNeedingReminder(resumed.team_config.members,[]).map(m=>m.id),['m1','m2']);
});

test('only the newest required submission controls who needs a reminder',()=>{
  const members=Array.from({length:8},(_,i)=>({id:`m${i+1}`,name:`成員${i+1}`}));
  members[7].weekly_report_required=false;
  const rows=[
    {member_id:'m1',status:'completed',is_current:false,revision:1},
    {member_id:'m1',status:'failed',is_current:true,revision:2},
    {member_id:'m2',status:'failed',revision:1},{member_id:'m2',status:'completed',revision:2},
    {member_id:'m3',status:'completed',review_status:'CHANGES_REQUESTED'},
    {member_id:'m4',status:'queued'},{member_id:'m5',status:'completed',review_status:'REVIEW_FAILED'},
    {member_id:'m6',status:'completed',review_status:'APPROVED'}
  ];
  assert.deepEqual(membersNeedingReminder(members,rows).map(m=>[m.id,m.reminder_reason]),[
    ['m1','請重新上傳'],['m3','退回補件'],['m7','尚未繳交']
  ]);
});

test('personal links preserve the shared batch credential and frontend selection uses the same member ID',async()=>{
  const url=weeklyPortalLink(portal+'?batch=old&member=old',token,'member-1');
  const parsed=new URL(url);
  assert.equal(parsed.search,'');assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('batch'),token);
  assert.equal(new URLSearchParams(parsed.hash.slice(1)).get('member'),'member-1');
  const window={};vm.runInNewContext(await readFile(new URL('../js/weekly-review-model.js',import.meta.url),'utf8'),{window,URL,URLSearchParams});
  assert.equal(window.SmartPortWeeklyReview.portalLink(portal,token,'member-1'),url);
  assert.equal(window.SmartPortWeeklyReview.portalMember(parsed),'member-1');
  assert.equal(window.SmartPortWeeklyReview.portalMember(new URL(portal)), '');
  const embed=memberPortalEmbed([{memberId:'member-1',memberName:'成員一'}],portal,token);
  assert.match(embed.fields[0].value,/member=member-1/);
  assert.match(embed.description,/仍可.*切換/);
});

test('reminder messages explicitly mention only missing users, escape names and split without truncating recipients',()=>{
  const members=Array.from({length:130},(_,i)=>({id:`member-${i}`,name:`成員${i}`,discord_user_id:String(BigInt(alice)+BigInt(i)),reminder_reason:'尚未繳交'}));
  members[0].name='@everyone <@999999999999999999> **偽造**';
  const messages=reminderMessages({members,baseUrl:portal,token,heading:'催繳',deadline:'明天截止'});
  assert.ok(messages.length>1);
  const mentioned=messages.flatMap(m=>m.allowed_mentions.users||[]);
  assert.deepEqual(mentioned,members.map(m=>m.discord_user_id));
  for(const message of messages){
    assert.ok(message.content.length<=2000);
    assert.ok((message.allowed_mentions.users||[]).length<=100);
    assert.deepEqual(message.allowed_mentions.parse,[]);
    assert.equal(message.content.includes('@everyone'),false);
    for(const id of message.allowed_mentions.users||[])assert.ok(message.content.includes(`<@${id}>`));
  }
  for(const member of members)assert.ok(messages.some(m=>m.content.includes(`member=${member.id}\n`)||m.content.endsWith(`member=${member.id}`)));
});

test('concurrent daily reminders serialize, ignore completed reports and respect the disabled setting',async()=>{
  const now=new Date('2026-09-15T05:01:00Z');
  const options={enabled:true,reminderEnabled:true,timezone:'Asia/Taipei',reminderHour:13,reminderMinute:0,
    publishWeekday:1,publishHour:13,publishMinute:0,dueDays:7,dueHour:12,dueMinute:0,catchUpDays:7,
    portalUrl:portal,discordWebhookUrl:'https://discord.com/api/webhooks/1234567890/test_token'};
  const batch={id:'batch-1',token,status:'OPEN',due_at:'2026-09-21T04:00:00Z',accept_until:'2026-09-28T04:00:00Z',
    discord_message_sent_at:'2026-09-14T05:00:00Z',last_reminder_date:null,payload:{team_config:config()}};
  const requests=[];
  const supabase={from(table){
    if(table==='weekly_report_batches')return {select(){return {eq(){return {async maybeSingle(){return {data:structuredClone(batch)}}}}}},
      update(patch){return {async eq(){Object.assign(batch,patch);return {error:null}}}}};
    return {select(){return {async eq(){return {data:[{member_id:'m1',status:'completed',is_current:true}]}}}}};
  }};
  const automation=new WeeklyReportAutomation({supabase,projectStore:{},options,now:()=>now,logger:{info(){},error(){}},
    fetchFn:async(_url,init)=>{requests.push(JSON.parse(init.body));return {ok:true}}});
  const schedule=weeklySchedule(now,options);
  await Promise.all([automation.sendReminder(schedule),automation.sendReminder(schedule)]);
  assert.equal(requests.length,1);assert.deepEqual(requests[0].allowed_mentions.users,[bob]);
  assert.equal(requests[0].content.includes(alice),false);assert.match(requests[0].content,/member=m2/);
  assert.equal(batch.last_reminder_date,'2026-09-15');
  automation.options.reminderEnabled=false;
  assert.deepEqual(await automation.sendReminder(schedule),{enabled:false});assert.equal(requests.length,1);
});
