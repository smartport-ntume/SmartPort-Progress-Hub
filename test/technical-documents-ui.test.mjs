import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';

const code = await readFile(new URL('../js/technical-documents.js', import.meta.url), 'utf8');
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
const task = { id: 'C1.1', name: 'CAN Command / Feedback Interface', wp_id: 'WP-C1', wp_name: 'Basic Motion' };
const archived = { id: 'v1', document_id: 'doc1', revision: 1, subtask_id: 'C1.1', title: '介面定義', member_name: '測試', size_bytes: 100, created_at: '2026-10-06T00:00:00Z', status: 'archived', html_url: 'https://github.com/example/private/blob/abc/test.pdf' };
function page() {
  const dom = new JSDOM('<select id="memberSelect"><option>m1</option></select><section id="docs"></section>', { url: 'https://example.test/weekly-submit.html', runScripts: 'outside-only' });
  dom.window.eval(code); return dom;
}
test('PDF UI lists full task titles and versions; blocks stale member responses and escapes content', async t => {
  const dom = page(); t.after(() => dom.window.close()); const { window: w } = dom;
  const calls = []; let first;
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (args.p_member_id === 'm1') return new Promise(resolve => { first = resolve; });
    return { data: { tasks: [{ ...task, id: 'P1.1', name: 'Radar Prototype' }], versions: [] } };
  } };
  const portal = w.SmartPortDocuments.portal({ client, token: 'token', root: w.document.querySelector('#docs'), toast() {} });
  const stale = portal.load('m1'); await portal.load('m2');
  first({ data: { tasks: [task], versions: [archived] } }); await stale;
  assert.match(w.document.querySelector('#technicalTask').textContent, /WP-C1 · Basic Motion ／ P1.1 · Radar Prototype/);
  assert.doesNotMatch(w.document.querySelector('#docs').textContent, /介面定義/);
  const html = w.SmartPortDocuments.list([{ ...archived, title: '<img src=x onerror=alert(1)>', html_url: 'javascript:alert(1)' }]);
  assert.doesNotMatch(html, /<img|href="javascript/); assert.match(html, /&lt;img/);
});
test('upload queues separately from weekly Word, survives lost submit response and resumes same grant', async t => {
  const dom = page(); t.after(() => dom.window.close()); const { window: w } = dom;
  const calls = []; let loseSubmit = true, versions = [archived];
  const client = { rpc: async (name, args) => {
    calls.push({ name, args });
    if (name === 'get_technical_document_portal') return { data: { tasks: [task], versions } };
    if (name === 'prepare_technical_document_upload') return { data: { upload_id: 'grant1', bucket: 'technical-documents', storage_path: 'pdf/random.pdf' } };
    if (name === 'submit_technical_document') { if (loseSubmit) { loseSubmit = false; return { error: { message: 'network interrupted' } }; }
      versions = [{ ...archived, id: 'grant1', revision: 2, status: 'queued' }, archived]; return { data: { status: 'queued' } }; }
    throw new Error(name);
  }, storage: { from(bucket) { assert.equal(bucket, 'technical-documents'); return { upload: async (_path, _file, options) => { assert.equal(options.upsert, false); return {}; } }; } } };
  let portal = w.SmartPortDocuments.portal({ client, token: 'token', root: w.document.querySelector('#docs'), toast() {} });
  await portal.load('m1');
  const $ = s => w.document.querySelector(s);
  $('#technicalTask').value = 'C1.1'; $('#technicalTask').dispatchEvent(new w.Event('change'));
  $('#technicalVersion').value = 'doc1'; $('#technicalVersion').dispatchEvent(new w.Event('change'));
  assert.equal($('#technicalTitle').value, '介面定義');
  Object.defineProperty($('#technicalFile'), 'files', { configurable: true, value: [new w.File(['%PDF-test'], 'x.pdf')] });
  await $('[data-upload-document]').onclick();
  assert.match($('[data-doc-message]').textContent, /network interrupted/);
  assert.equal(w.localStorage.getItem('smartport.pending-pdf:m1'), 'grant1');
  // Recreate the component as a reload would; no extra upload is needed.
  portal = w.SmartPortDocuments.portal({ client, token: 'token', root: $('#docs'), toast() {} });
  await portal.load('m1'); assert.equal($('[data-resume-document]').hidden, false);
  await $('[data-resume-document]').onclick();
  assert.equal(w.localStorage.getItem('smartport.pending-pdf:m1'), null);
  assert.equal(calls.filter(c => c.name === 'prepare_technical_document_upload').length, 1);
  assert.equal(calls.find(c => c.name === 'prepare_technical_document_upload').args.p_document_id, 'doc1');
  assert.equal(calls.filter(c => c.name === 'submit_technical_document').length, 2);
  assert.match($('#docs').textContent, /等待 Agent 歸檔/); assert.match($('#docs').textContent, /歷史版本/);
  assert.ok(!calls.some(c => /weekly|progress/.test(c.name)));
});
test('drawer async results do not replace another subtask or edit form', async t => {
  const dom = page(); t.after(() => dom.window.close()); const { window: w } = dom;
  const root = w.document.querySelector('#docs'); let respond;
  const loading = w.SmartPortDocuments.drawer(root, { listTechnicalDocuments: () => new Promise(r => { respond = r; }) }, 'C1.1');
  root.outerHTML = '<section id="docs"><input value="PM unsaved draft"></section>';
  respond([archived]); await loading;
  assert.equal(w.document.querySelector('input').value, 'PM unsaved draft');
  assert.equal(w.document.querySelector('a'), null);
});

test('real Dashboard Gantt and traceability drawers expose private PDF links to members only', async t => {
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8');
  const dom = new JSDOM(html, { url: 'https://example.test/', runScripts: 'outside-only' });
  t.after(() => dom.window.close()); const { window: w } = dom;
  let role = 'PM'; const loaded = [];
  w.SmartPortAPI = {
    getMode: () => 'supabase', getBase: () => 'https://example.test', getRole: () => role,
    me: async () => ({ role, login: 'fixture', can_write: true }),
    loadSnapshot: async () => ({ work_packages: [{ id: 'WP-C1', name: 'Basic Motion', start: '2026-01-01', end: '2026-12-31' }],
      subtasks: [{ id: 'C1.1', name: task.name, parent_wp: 'WP-C1', start: '2026-01-01', end: '2026-12-31' }] }),
    listTechnicalDocuments: async id => { loaded.push(id); return [archived]; }
  };
  for (const script of ['store.js', 'technical-documents.js', 'app.js', 'traceability.js']) w.eval(await readFile(new URL('../js/' + script, import.meta.url), 'utf8'));
  await tick();
  w.document.querySelector('#showSubs').checked = true;
  w.document.querySelector('#showSubs').dispatchEvent(new w.Event('change'));
  const bar = w.document.querySelector('.sub-row-gantt .bar'); assert.ok(bar);
  bar.click(); await tick();
  assert.equal(w.document.querySelector('#taskTechnicalDocuments a').href, archived.html_url);
  assert.ok(w.document.querySelector('.reviewed-result'), 'current reviewed result remains visible');
  assert.equal(w.document.querySelector('[name="exec_progress"]'), null, 'the drawer no longer asks PM to re-enter weekly results');
  w.SmartPortTraceability.openSubtask('C1.1'); await tick();
  assert.equal(w.document.querySelector('#taskTechnicalDocuments a').href, archived.html_url);
  assert.deepEqual(loaded, ['C1.1', 'C1.1']);
  role = 'GUEST'; bar.click(); await tick(); assert.equal(w.document.querySelector('#taskTechnicalDocuments'), null);
  assert.equal(loaded.length, 2);
});
