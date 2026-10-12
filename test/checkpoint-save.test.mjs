import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const [apiSource, editorSource, saveSource] = await Promise.all([
  'supabase-api.js', 'plan-enhancements.js', 'checkpoint-save.js'
].map(file => readFile(new URL('../js/' + file, import.meta.url), 'utf8')));
const flush = () => new Promise(resolve => setImmediate(resolve));
const cp = () => ({ id: 'CP1', date: '2026-10-11', acl: 'ACL-1', name: 'Motion', criteria: [], fsr_targets: [] });

function apiFixture(t, initial = { id: 'job-1', kind: 'patch_checkpoint', status: 'queued' }) {
  const dom = new JSDOM('', { url: 'https://example.test', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, timers = new Map(), calls = [], updates = [];
  let nextTimer = 0, readCount = 0, removed = 0, eventHandler, subscription;
  let row = structuredClone(initial), read = async () => ({ data: row });
  w.setTimeout = (fn, ms) => { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; };
  w.clearTimeout = id => timers.delete(id);
  const client = {
    auth: { onAuthStateChange() {} },
    rpc(name, payload) {
      calls.push({ name, payload });
      return { abortSignal() { return this; }, then(resolve, reject) { return Promise.resolve({ data: initial }).then(resolve, reject); } };
    },
    from(table) {
      assert.equal(table, 'gateway_jobs');
      return {
        select() { return this; }, eq() { return this; }, abortSignal() { return this; },
        maybeSingle() { readCount++; return read(); }
      };
    },
    channel() {
      return {
        on(_type, _filter, fn) { eventHandler = fn; return this; },
        subscribe(fn) { subscription = fn; return this; }
      };
    },
    async removeChannel() { removed++; }
  };
  w.supabase = { createClient: () => client };
  w.eval(apiSource);
  const api = w.createSmartPortSupabaseAPI({ supabase: { url: 'https://example.supabase.co', anonKey: 'publishable-key-with-enough-length' } });
  async function fire(ms) {
    const entry = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(entry, `expected ${ms} ms timer`);
    timers.delete(entry[0]); entry[1].fn(); await flush();
  }
  return {
    api, calls, updates, timers, fire, setRow(value) { row = value; }, setRead(fn) { read = fn; },
    emit(value) { eventHandler({ new: value }); }, subscribe(status) { subscription(status); },
    reads: () => readCount, removed: () => removed,
    save(options = {}) { return api.request('/api/project/checkpoints/CP1', {
      method: 'PATCH', body: JSON.stringify({ date: '2026-10-18' }), idempotencyKey: 'same-edit-key',
      onUpdate: row => updates.push(row), ...options
    }); }
  };
}

test('CP save catches a missed completion event and cleans up its bounded status checks', async t => {
  const f = apiFixture(t), saving = f.save(); await flush();
  assert.equal(f.calls.length, 1);
  assert.equal(f.calls[0].payload.p_kind, 'patch_checkpoint');
  assert.equal(f.updates.at(-1).status, 'queued');
  f.setRow({ id: 'job-1', status: 'completed', result: { checkpoint: { ...cp(), date: '2026-10-18' } } });
  await f.fire(5000);
  assert.equal((await saving).checkpoint.date, '2026-10-18');
  assert.equal(f.removed(), 1); assert.equal(f.timers.size, 0);
});

test('CP timeout retains job identity and resumes it without another enqueue, including a stalled first read', async t => {
  const f = apiFixture(t);
  f.setRead(() => new Promise(() => {}));
  const saving = f.save();
  const rejected = assert.rejects(saving, error => error.code === 'gateway_job_wait_timeout' && error.job.id === 'job-1');
  await flush(); await f.fire(60_000); await rejected;
  assert.equal(f.removed(), 1);
  f.setRead(async () => ({ data: { id: 'job-1', status: 'completed', result: { ok: true } } }));
  const result = await f.save({ jobId: 'job-1' });
  assert.equal(result.ok, true); assert.equal(f.calls.length, 1);
});

test('CP state survives a Realtime outage and does not regress on an older HTTP read', async t => {
  const f = apiFixture(t); let release;
  f.setRead(() => new Promise(resolve => { release = resolve; }));
  const saving = f.save(); await flush();
  f.emit({ id: 'job-1', status: 'running' });
  release({ data: { id: 'job-1', status: 'queued' } }); await flush();
  assert.equal(f.updates.at(-1).status, 'running');
  f.setRead(async () => ({ error: { message: 'network unavailable' } }));
  f.subscribe('CHANNEL_ERROR'); await flush();
  f.setRead(async () => ({ data: { id: 'job-1', status: 'completed', result: { ok: true } } }));
  await f.fire(5000); assert.equal((await saving).ok, true);
});

test('CP Agent failure is terminal and is never displayed as a successful save', async t => {
  const f = apiFixture(t), saving = f.save();
  const rejected = assert.rejects(saving, error => error.job.status === 'failed' && /Git push/.test(error.message));
  await flush(); f.emit({ id: 'job-1', status: 'failed', error: 'Git push failed' }); await rejected;
  assert.equal(f.timers.size, 0);
});

function editorFixture(t, storage = []) {
  const dom = new JSDOM('<button data-edit-cp="CP1">Edit</button><button id="btnReload"></button><div id="drawer"><h2 id="drawerTitle"></h2><form id="drawerBody"></form></div><div id="drawerBackdrop"></div><div id="toast"></div>', {
    url: 'https://example.test', runScripts: 'outside-only'
  });
  t.after(() => dom.window.close());
  const w = dom.window, doc = w.document, calls = [], waiters = [], alerts = [];
  let reloads = 0;
  w.alert = message => alerts.push(message);
  w.SMARTPORT_ACCESS = { can_write: true, login: 'pm' };
  w.SmartPortStore = { state: { checkpoints: [cp()], workPackages: [], subtasks: [] } };
  w.SmartPortAPI = {
    getMode: () => 'supabase', getBase: () => 'https://example.supabase.co',
    async request(path, options) {
      if (!options) return { reference: { acl_levels: [] } };
      calls.push({ path, ...options });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    },
    async saveCheckpoints() { assert.fail('legacy whole-file save must not run'); }
  };
  for (const [key, value] of storage) w.sessionStorage.setItem(key, value);
  doc.querySelector('#btnReload').onclick = () => { reloads++; };
  w.eval(editorSource); w.eval(saveSource);
  function open() { doc.querySelector('[data-edit-cp]').click(); }
  const input = name => doc.querySelector(`[name="cp_${name}"]`);
  const button = () => doc.querySelector('button[type="submit"]');
  function submit() { doc.querySelector('form').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
  open();
  return { w, doc, calls, waiters, alerts, open, input, button, submit, reloads: () => reloads,
    storage: () => Object.entries(w.sessionStorage), message: () => doc.querySelector('[data-cp-save-status]')?.textContent || '' };
}

test('real CP editor prevents double submit and resumes after timeout and page reload with the same date and job', async t => {
  const f = editorFixture(t);
  f.input('date').value = '2026-10-18'; f.submit(); f.submit();
  assert.equal(f.calls.length, 1); assert.equal(f.button().disabled, true);
  assert.equal(JSON.parse(f.calls[0].body).date, '2026-10-18');
  f.calls[0].onUpdate({ id: 'job-1', status: 'queued' });
  assert.match(f.message(), /等待 Agent/);
  f.calls[0].onUpdate({ id: 'job-1', status: 'running' });
  assert.equal(f.button().textContent, '寫入中…');
  f.waiters[0].reject(Object.assign(new Error('timeout'), { job: { id: 'job-1', status: 'running' } }));
  await flush();
  assert.equal(f.button().disabled, false); assert.equal(f.button().textContent, '查看儲存狀態');
  assert.equal(f.input('date').disabled, true); assert.equal(f.reloads(), 0);
  const next = editorFixture(t, f.storage());
  assert.equal(next.input('date').value, '2026-10-18');
  assert.equal(next.button().textContent, '查看儲存狀態'); next.submit();
  assert.equal(next.calls[0].jobId, 'job-1'); assert.equal(next.calls[0].idempotencyKey, f.calls[0].idempotencyKey);
  next.waiters[0].resolve({ checkpoint: { ...cp(), date: '2026-10-18' } }); await flush();
  assert.equal(next.w.SmartPortStore.state.checkpoints[0].date, '2026-10-18');
  assert.equal(next.reloads(), 1); assert.equal(next.storage().length, 0);
  assert.equal(next.doc.querySelector('#drawer').classList.contains('open'), false);
});

test('lost enqueue acknowledgement reuses the original idempotency key; confirmed failure unlocks editing', async t => {
  const f = editorFixture(t); f.input('date').value = '2026-10-18'; f.submit();
  f.waiters[0].reject(new Error('Failed to fetch')); await flush();
  const next = editorFixture(t, f.storage()); next.submit();
  assert.equal(next.calls[0].idempotencyKey, f.calls[0].idempotencyKey);
  assert.equal(next.calls[0].jobId, null); assert.equal(JSON.parse(next.calls[0].body).date, '2026-10-18');
  next.waiters[0].reject(Object.assign(new Error('Git push failed'), { job: { id: 'job-1', status: 'failed' } }));
  await flush();
  assert.equal(next.storage().length, 0); assert.equal(next.input('date').disabled, false);
  assert.match(next.message(), /Git push failed/); assert.equal(next.reloads(), 0);
  next.submit(); assert.notEqual(next.calls[1].idempotencyKey, next.calls[0].idempotencyKey);
  next.waiters[1].reject(Object.assign(new Error('PM permission required'), { queueRejected: true })); await flush();
  assert.equal(next.input('date').disabled, false); assert.equal(next.storage().length, 0);
});

test('CP completion never closes an unrelated draft and invalid JSON never enqueues', async t => {
  const f = editorFixture(t);
  f.input('criteria').value = '{}'; f.submit(); assert.equal(f.calls.length, 0); assert.equal(f.alerts.length, 1);
  f.input('criteria').value = '[]'; f.submit();
  f.doc.querySelector('#drawerBody').innerHTML = '<input name="other" value="unsaved draft">';
  f.waiters[0].resolve({ checkpoint: { ...cp(), date: '2026-10-18' } }); await flush();
  assert.equal(f.doc.querySelector('[name="other"]').value, 'unsaved draft');
  assert.equal(f.doc.querySelector('#drawer').classList.contains('open'), true);
});
