import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMembership } from '../supabase/functions/github-org-access/verify.mjs';
const user = { identities: [{ provider: 'github', id: '42' }], user_metadata: { user_name: 'untrusted' } };
function mock(id=42, state='active', status=200) {
  return async url => new Response(JSON.stringify(url.endsWith('/user') ? { id, login:'member' } : url.includes('/user/teams') ? [] : { state, organization:{login:'smartport-ntume'} }), { status:url.endsWith('/user') ? 200 : status });
}
test('active private membership grants verified login', async () => assert.deepEqual(await verifyMembership(user,'token',mock()),{login:'member',role:'ENGINEER'}));
test('cannot borrow another GitHub account token', async () => assert.rejects(verifyMembership(user,'token',mock(43)),/身分/));
test('pending invitation is not membership', async () => assert.rejects(verifyMembership(user,'token',mock(42,'pending')),/邀請/));
test('missing membership and restricted OAuth fail closed', async () => {
  for (const status of [403,404,500]) await assert.rejects(verifyMembership(user,'token',mock(42,'active',status)));
});
test('no provider token or verified GitHub identity fails closed', async () => {
  await assert.rejects(verifyMembership(user,'',mock()));
  await assert.rejects(verifyMembership({user_metadata:{provider_id:'42'}},'token',mock()));
});

test('PM team membership grants PM; org owner alone does not', async () => {
  const fetcher = async url => url.includes('/user/teams')
    ? Response.json([{slug:'smartport-pm',organization:{login:'smartport-ntume'}}]) : mock()(url);
  assert.equal((await verifyMembership(user,'token',fetcher)).role,'PM');
});
test('same team slug in another org does not grant PM', async () => {
  const fetcher = async url => url.includes('/user/teams')
    ? Response.json([{slug:'smartport-pm',organization:{login:'other-org'}}]) : mock()(url);
  assert.equal((await verifyMembership(user,'token',fetcher)).role,'ENGINEER');
});
test('PM membership beyond first page is found', async () => {
  const fetcher = async url => !url.includes('/user/teams') ? mock()(url)
    : Response.json(url.endsWith('page=1') ? Array.from({length:100},()=>({slug:'other'})) : [{slug:'smartport-pm',organization:{login:'smartport-ntume'}}]);
  assert.equal((await verifyMembership(user,'token',fetcher)).role,'PM');
});
test('team API errors never silently grant a role', async () => {
  const fetcher = async url => url.includes('/user/teams') ? new Response('{}',{status:403}) : mock()(url);
  await assert.rejects(verifyMembership(user,'token',fetcher),/PM team/);
});
