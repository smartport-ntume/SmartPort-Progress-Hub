import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
const files = ['store.js','app.js','checkpoint-ui.js','plan-enhancements.js','checkpoint-save.js','reference-pages.js'];
const sources = await Promise.all(files.map(file => readFile(new URL('../js/' + file, import.meta.url), 'utf8')));
const flush = () => new Promise(resolve => setTimeout(resolve, 60));
const baseline = () => ({
  project: { name: 'Test project' },
  work_packages: [{ id: 'WP-C1', name: 'Basic Motion', owner: 'CTL', start: '2026-08-01', end: '2027-03-01' }],
  subtasks: [], checkpoints: [
    { id: 'CP0', date: '2026-09-01', acl: 'ACL-0', name: 'Baseline', criteria: [], fsr_targets: [] },
    { id: 'CP1', date: '2026-10-11', acl: 'ACL-1', name: 'Basic Motion', capability: 'Old capability', review_checks: 'Old checks', fsrTarget: 'M1', criteria: [], fsr_targets: [] },
    { id: 'CP2', date: '2026-11-08', acl: 'ACL-2', name: 'Autonomy', criteria: [], fsr_targets: [] }
  ]
});

async function fixture(t, { storage = [], deferReferences = false } = {}) {
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close());
  const w = dom.window, doc = w.document, calls = [];
  const RealDate = w.Date;
  w.Date = class extends RealDate { constructor(...args) { super(...(args.length ? args : ['2026-10-12T02:00:00Z'])); } };
  let snapshot = baseline(), refs = { reference: { fsr_maturity_levels: [], acl_levels: [
    { checkpoint: 'CP1', date: '10/11', level: 'ACL-1', capability: 'Old capability', review_checks: 'Old checks', fsr_maturity_target: 'M1' }
  ] }, technical_requirements: { groups: [] } };
  let finishWrite, load = async () => structuredClone(snapshot), repairs = 0;
  const oldReferenceReads = [];
  for (const [key,value] of storage) w.sessionStorage.setItem(key,value);
  w.alert = () => {};
  w.SmartPortAPI = {
    getMode: () => 'supabase', getBase: () => 'https://example.supabase.co', getRole: () => 'PM',
    me: async () => ({ role: 'PM', login: 'test-pm', can_write: true, authenticated: true }),
    loadSnapshot: (...args) => load(...args), loadReference: async () => structuredClone(refs),
    async request(path, options = {}) {
      if (!options.method || options.method === 'GET') {
        const value = structuredClone(refs);
        if (deferReferences) return new Promise(resolve => oldReferenceReads.push(() => resolve(value)));
        return value;
      }
      calls.push({ path, options });
      return new Promise(resolve => { finishWrite = resolve; });
    },
    async syncCheckpoint(id) {
      repairs++;
      assert.equal(id, 'CP1');
      return { ok: true };
    }
  };
  for (const source of sources) w.eval(source);
  await new Promise(resolve => setTimeout(resolve, 250));
  const field = name => doc.querySelector(`[name="cp_${name}"]`);
  function open() { doc.querySelector('[data-edit-cp="CP1"]').click(); }
  function submit() { doc.querySelector('#drawerBody').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true })); }
  function result() {
    const patch = JSON.parse(calls.at(-1).options.body);
    return { checkpoint: { ...snapshot.checkpoints[1], ...patch }, reference: {
      checkpoint: 'CP1', date: '10/25', level: 'ACL-1', capability: patch.capability, review_checks: patch.review_checks, fsr_maturity_target: patch.fsrTarget
    } };
  }
  return { w, doc, calls, field, open, submit, result, finish: value => finishWrite(value),
    releaseOldReferences() { oldReferenceReads.splice(0).forEach(release => release()); },
    storage: () => Object.entries(w.sessionStorage),
    setLoad(fn) { load = fn; }, snapshot: () => structuredClone(snapshot), repairs: () => repairs,
    publish(value) { snapshot.checkpoints[1] = structuredClone(value.checkpoint); refs.reference.acl_levels[0] = structuredClone(value.reference); },
    status: () => doc.querySelector('[data-cp-save-status]')?.textContent || '' };
}

test('saving a CP updates Dashboard, Gantt, timeline and detail without waiting for an old snapshot response', async t => {
  const f = await fixture(t);
  const oldPosition = f.doc.querySelectorAll('.cp-marker')[1].style.left;
  f.open(); f.field('date').value = '2026-10-25'; f.field('capability').value = 'New capability';
  f.field('fsr_targets').value = '[{"id":"FSR-01","level":"M2"}]'; f.submit();
  const saved = f.result();
  // PostgreSQL jsonb can return object keys in a different order.
  saved.checkpoint.fsr_targets = [{ level: 'M2', id: 'FSR-01' }];
  // A read that started before the write completes returns the old date late.
  const stale = f.snapshot(); let releaseOld;
  f.setLoad(() => new Promise(resolve => { releaseOld = resolve; }));
  f.doc.querySelector('#btnReload').click(); await flush();
  f.publish(saved); f.setLoad(async () => f.snapshot()); f.finish(saved); await flush();
  releaseOld(stale); await flush();
  assert.equal(f.doc.querySelector('#nextCp').textContent, 'CP1');
  assert.match(f.doc.querySelector('#nextCpDate').textContent, /2026-10-25/);
  assert.notEqual(f.doc.querySelectorAll('.cp-marker')[1].style.left, oldPosition);
  assert.equal(f.doc.querySelectorAll('.cp-marker')[1].style.left, f.doc.querySelectorAll('.cp-point')[1].style.left);
  assert.match(f.doc.querySelector('#cpGrid [data-cp-card="CP1"]').textContent, /2026-10-25/);
  assert.match(f.doc.querySelector('#referenceBody').textContent, /10\/25/);
  f.doc.querySelectorAll('.cp-marker')[1].dispatchEvent(new f.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  assert.match(f.doc.querySelector('#drawerBody').textContent, /2026-10-25/);
  assert.match(f.doc.querySelector('#drawerBody').textContent, /New capability/);
  assert.doesNotMatch(f.doc.querySelector('#drawerBody').textContent, /Old capability/);
});

test('snapshot sync failure stays visible and retries snapshots without writing the CP twice', async t => {
  const f = await fixture(t); f.open(); f.field('date').value = '2026-10-25'; f.submit();
  const saved = f.result(); f.finish({ ...saved, gateway_warning: 'gateway_snapshot_sync_failed: network down' }); await flush();
  assert.match(f.doc.querySelector('#nextCpDate').textContent, /2026-10-25/);
  assert.match(f.status(), /同步/);
  assert.equal(f.doc.querySelector('#drawer').classList.contains('open'), true);
  assert.equal(f.doc.querySelector('#drawerBody button[type="submit"]').textContent, '重試畫面同步');
  f.doc.querySelector('#btnReload').click(); await flush();
  assert.match(f.doc.querySelector('#nextCpDate').textContent, /2026-10-25/, 'another old snapshot cannot hide a confirmed pending write');
  // Reload the browser: retain the sync phase, without replaying the write.
  const next = await fixture(t, { storage: f.storage() });
  next.open(); assert.equal(next.field('date').value, '2026-10-25');
  next.publish(saved); next.submit(); await flush();
  assert.equal(next.calls.length, 0); assert.equal(f.calls.length, 1);
  assert.equal(next.doc.querySelector('#drawer').classList.contains('open'), false);
  assert.match(next.doc.querySelector('#toast').textContent, /已儲存並同步/);
});

test('ACL Roadmap edits use the same canonical CP save and update the Dashboard date', async t => {
  const f = await fixture(t);
  f.doc.querySelector('[data-edit-acl="0"]').click();
  assert.equal(f.doc.querySelector('#refEditModal'), null);
  assert.equal(f.field('date').value, '2026-10-11');
  f.field('date').value = '2026-10-25'; f.submit();
  assert.equal(f.calls[0].path, '/api/project/checkpoints/CP1');
  const saved = f.result(); f.publish(saved); f.finish(saved); await flush();
  assert.match(f.doc.querySelector('#nextCpDate').textContent, /2026-10-25/);
  assert.match(f.doc.querySelector('#referenceBody').textContent, /10\/25/);
  // Reopening the ACL editor reads the same date and does not replace the CP id.
  f.doc.querySelector('[data-edit-acl="0"]').click();
  assert.equal(f.field('date').value, '2026-10-25');
  assert.equal(f.field('id').readOnly, true);
});

test('an old reference response cannot restore stale capability or overwrite an open CP edit', async t => {
  const f = await fixture(t, { deferReferences: true });
  f.doc.querySelectorAll('.cp-marker')[1].dispatchEvent(new f.w.MouseEvent('mousedown', { bubbles: true, button: 0 }));
  f.doc.querySelector('#drawerBody [data-edit-cp]').click();
  f.field('date').value = '2026-10-25'; f.field('capability').value = 'New capability'; f.submit();
  const saved = f.result(); f.publish(saved); f.finish(saved); await flush();
  f.open(); f.field('name').value = 'unsaved next edit';
  f.releaseOldReferences(); await flush();
  assert.equal(f.field('name').value, 'unsaved next edit');
  assert.equal(f.field('capability').value, 'New capability');
  assert.doesNotMatch(f.doc.querySelector('#referenceBody').textContent, /Old capability/);
  assert.match(f.doc.querySelector('#referenceBody').textContent, /New capability/);
});

test('a completed job with a missing or mismatched CP result is not reported as saved', async t => {
  const f = await fixture(t); f.open(); f.field('date').value = '2026-10-25'; f.submit();
  f.finish({ checkpoint: { ...f.result().checkpoint, date: '2026-10-11' } }); await flush();
  assert.match(f.status(), /不符/);
  assert.equal(f.field('date').disabled, false);
  assert.equal(f.w.SmartPortStore.state.checkpoints[1].date, '2026-10-11');
  assert.doesNotMatch(f.doc.querySelector('#toast').textContent, /已儲存/);
});
