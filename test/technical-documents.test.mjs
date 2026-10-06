import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { TechnicalDocumentArchive, documentPath, documentSegment } from '../local-server/technical-documents.mjs';
import { GatewayJobHandler } from '../local-server/gateway-job-handler.mjs';

function fixture(options = {}) {
  const bytes = Buffer.from(options.pdf || '%PDF-1.7\nTest fixture\n%%EOF');
  const blobSha = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
  const v = { id: 'version-id', job_id: 'job-1', document_id: '12345678-abcd-4000-8000-000000000001', revision: 1,
    created_at: '2026-10-05T17:00:00Z', status: 'queued', title: '介面定義', member_id: 'm1', wp_id: 'WP-C1', wp_name: 'Basic Motion',
    subtask_id: 'C1.1', subtask_name: 'CAN Command / Feedback Interface', size_bytes: bytes.length, storage_path: 'pdf/random.pdf' };
  const trace = [], files = new Map(); let failIndex = options.failIndex;
  const project = { subtasks: [{ id: 'C1.1', parent_wp: 'WP-C1', owner_team: 'CTL' }],
    team_config: { members: [{ id: 'm1', active: true }], categories: [{ id: 'CTL' }], category_owners: { CTL: options.reassigned ? 'm2' : 'm1' } } };
  const supabase = {
    from(table) {
      const filters = {}; let updates;
      const q = { select() { return q; }, eq(k, value) { filters[k] = value; return q; }, update(value) { updates = value; return q; },
        async maybeSingle() {
          if (table === 'profiles') return { data: { role: 'PM', active: !options.revoked } };
          if (filters.id !== v.id || filters.job_id !== v.job_id) return { data: null };
          if (updates) { trace.push('index'); if (failIndex) { failIndex = false; return { error: { message: 'offline' } }; } Object.assign(v, updates); }
          return { data: { ...v } };
        } }; return q;
    },
    storage: { from(bucket) { assert.equal(bucket, 'technical-documents'); return {
      download: async () => { trace.push('download'); return { data: new Blob([bytes]) }; },
      remove: async () => { trace.push('remove'); return {}; }
    }; } }
  };
  const fetchImpl = async (url, init) => {
    assert.ok(url.startsWith('https://api.github.com/repos/smartport-ntume/SmartPort-Technical-Docs'));
    assert.equal(init.redirect, 'error');
    if (url.endsWith('/SmartPort-Technical-Docs')) return Response.json({ private: !options.public, full_name: 'smartport-ntume/SmartPort-Technical-Docs', permissions: { push: true } });
    if (url.includes('/git/ref/')) return Response.json({ object: { sha: 'a'.repeat(40) } });
    const path = decodeURIComponent(new URL(url).pathname.split('/contents/')[1]);
    if (init.method === 'PUT') { trace.push('put'); const body = JSON.parse(init.body); assert.equal(body.sha, undefined); assert.equal(body.branch, 'main');
      assert.deepEqual(Buffer.from(body.content, 'base64'), bytes); files.set(path, { sha: blobSha, type: 'file' });
      return Response.json({ content: { sha: blobSha }, commit: { sha: 'b'.repeat(40) } }); }
    return files.has(path) ? Response.json(files.get(path)) : new Response('', { status: 404 });
  };
  const service = new TechnicalDocumentArchive({ supabase, getProject: async () => project, fetchImpl, token: 'fixture-token' });
  return { service, v, trace, files, job: { id: 'job-1', actor_id: 'pm', payload: { version_id: 'version-id', path: 'ignored' } } };
}
test('paths include full titles, local date, revision and collision suffix, with safe components', () => {
  const { v } = fixture();
  assert.equal(documentPath(v), 'WP-C1_Basic Motion/C1.1_CAN Command and Feedback Interface/2026-10-06_介面定義_v01_12345678.pdf');
  assert.equal(documentSegment('CON'), '_CON'); assert.equal(documentSegment('..'), 'Document');
  assert.ok(!/[\\/:*?"<>|]/.test(documentSegment('../a\\b:<>*?')));
  assert.ok(Buffer.byteLength(documentSegment('測'.repeat(200))) <= 160);
});
test('archives PDF, confirms durable metadata before cleanup, and never modifies progress', async () => {
  const f = fixture();
  const handler = new GatewayJobHandler({ technicalDocs: f.service, app: { fetch() { throw new Error('PDF must not call Codex or write progress'); } } });
  const r = await handler.handle({ ...f.job, kind: 'archive_technical_document' });
  assert.deepEqual(f.trace, ['download', 'put', 'index', 'remove']);
  assert.equal(f.v.status, 'archived'); assert.match(r.html_url, /\/blob\/b{40}\//);
  await f.service.archive(f.job); assert.equal(f.trace.filter(x => x === 'put').length, 1);
});
test('lost index write is retryable without a second GitHub commit or premature deletion', async () => {
  const f = fixture({ failIndex: true });
  await assert.rejects(() => f.service.archive(f.job), /record_archive/);
  assert.ok(!f.trace.includes('remove'));
  await f.service.archive(f.job);
  assert.equal(f.trace.filter(x => x === 'put').length, 1); assert.equal(f.v.status, 'archived');
});
test('conflicting remote content is retained and staged PDF remains available', async () => {
  const f = fixture(); f.files.set(documentPath(f.v), { type: 'file', sha: 'different' });
  await assert.rejects(() => f.service.archive(f.job), /不同內容/);
  assert.ok(!f.trace.includes('put')); assert.ok(!f.trace.includes('remove'));
});
test('rejects public destination, revoked PM, changed assignment, mismatched job and non-PDF bytes', async () => {
  for (const options of [{ public: true }, { revoked: true }, { reassigned: true }, { pdf: 'not a pdf' }]) {
    const f = fixture(options); await assert.rejects(() => f.service.archive(f.job));
    assert.ok(!f.trace.includes('put')); assert.ok(!f.trace.includes('remove'));
  }
  const f = fixture(); await assert.rejects(() => f.service.archive({ ...f.job, id: 'forged' }), /invalid_technical_document_job/);
  assert.equal(f.trace.length, 0);
});
