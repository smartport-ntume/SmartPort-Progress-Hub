import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseRealtimeAgent } from '../local-server/supabase-realtime-agent.mjs';

function fakeSupabase(job) {
  const stateWrites = [];
  const jobWrites = [];
  let eventHandler = null;
  let claimed = false;

  function thenable(result) {
    return { then(resolve) { return Promise.resolve(resolve(result)); } };
  }

  return {
    stateWrites,
    jobWrites,
    emit(row) { eventHandler?.({ new: row }); },
    from(table) {
      if (table === 'agent_state') {
        return {
          async upsert(payload) {
            stateWrites.push(payload);
            return { data: payload, error: null };
          }
        };
      }
      if (table !== 'gateway_jobs') throw new Error('unexpected table ' + table);
      return {
        select() {
          const query = {
            eq() { return query; },
            order() { return query; },
            limit() { return Promise.resolve({ data: [], error: null }); }
          };
          return query;
        },
        update(payload) {
          jobWrites.push(payload);
          const query = thenable({ data: null, error: null });
          query.eq = () => query;
          return query;
        }
      };
    },
    async rpc(name) {
      assert.equal(name, 'claim_gateway_job');
      if (claimed) return { data: null, error: null };
      claimed = true;
      return { data: job, error: null };
    },
    channel() {
      return {
        on(_type, _filter, callback) { eventHandler = callback; return this; },
        subscribe(callback) { queueMicrotask(() => callback('SUBSCRIBED')); return this; }
      };
    },
    async removeChannel() { return 'ok'; }
  };
}

test('Realtime Agent processes an INSERT event once and does not need an interval poll', async () => {
  const job = {
    id: 'job-1', kind: 'refresh_snapshots', actor_login: 'vincent',
    status: 'running', payload: {}
  };
  const supabase = fakeSupabase(job);
  let handled = 0;
  const agent = new SupabaseRealtimeAgent({
    supabase,
    agentId: 'test-agent',
    version: 'test',
    logger: { info() {}, error() {} },
    async handleJob(received) {
      handled += 1;
      assert.equal(received.id, 'job-1');
      return { ok: true };
    }
  });

  await agent.start();
  supabase.emit({ id: 'job-1' });
  await agent.chain;

  assert.equal(handled, 1);
  assert.ok(supabase.jobWrites.some(write => write.status === 'completed'));
  assert.equal(supabase.stateWrites.at(-1).status, 'online');
  await agent.stop();
  assert.equal(supabase.stateWrites.at(-1).status, 'offline');
});
