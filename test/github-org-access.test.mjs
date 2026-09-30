import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyMembership } from '../supabase/functions/github-org-access/verify.mjs';
const user = { identities: [{ provider: 'github', id: '42' }], user_metadata: { user_name: 'untrusted' } };
function mock(id=42, state='active', status=200) {
  return async url => new Response(JSON.stringify(url.endsWith('/user') ? { id, login:'member' } : { state, organization:{login:'smartport-ntume'} }), { status:url.endsWith('/user') ? 200 : status });
}
test('active private membership grants verified login', async () => assert.equal(await verifyMembership(user,'token',mock()),'member'));
test('cannot borrow another GitHub account token', async () => assert.rejects(verifyMembership(user,'token',mock(43)),/身分/));
test('pending invitation is not membership', async () => assert.rejects(verifyMembership(user,'token',mock(42,'pending')),/邀請/));
test('missing membership and restricted OAuth fail closed', async () => {
  for (const status of [403,404,500]) await assert.rejects(verifyMembership(user,'token',mock(42,'active',status)));
});
test('no provider token or verified GitHub identity fails closed', async () => {
  await assert.rejects(verifyMembership(user,'',mock()));
  await assert.rejects(verifyMembership({user_metadata:{provider_id:'42'}},'token',mock()));
});
