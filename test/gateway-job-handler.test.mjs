import test from 'node:test';
import assert from 'node:assert/strict';
import { GatewayJobHandler } from '../local-server/gateway-job-handler.mjs';

test('GatewayJobHandler maps a baseline job to the internal API with trusted actor metadata', async () => {
  let captured = null;
  const app = {
    async fetch(request) {
      captured = request;
      return Response.json({ ok: true });
    }
  };
  const handler = new GatewayJobHandler({
    app,
    env: {},
    internalBearer: 'internal-secret',
    supabase: {},
    reportBucket: 'weekly-reports'
  });
  const result = await handler.handle({
    kind: 'write_work_packages',
    actor_login: 'vincent',
    payload: { work_packages: [] }
  });
  assert.deepEqual(result, { ok: true });
  assert.equal(captured.method, 'PUT');
  assert.equal(new URL(captured.url).pathname, '/api/project/work-packages');
  assert.equal(captured.headers.get('Authorization'), 'Bearer internal-secret');
  assert.equal(captured.headers.get('X-SmartPort-Actor'), 'vincent');
  assert.deepEqual(await captured.json(), { work_packages: [] });
});

test('weekly report is archived before temporary Supabase Storage is deleted and analyzed', async () => {
  const calls = [];
  const app = {
    async fetch(request) {
      const url = new URL(request.url);
      calls.push(url.pathname);
      if (url.pathname === '/api/reports/upload') {
        const body = await request.json();
        assert.equal(Buffer.from(body.data_base64, 'base64').toString(), 'weekly report');
        return Response.json({ report: { path: 'weekly_reports/2026/report.docx', filename: 'report.docx' } }, { status: 201 });
      }
      if (url.pathname === '/api/reports/analyze') {
        assert.equal((await request.json()).report_path, 'weekly_reports/2026/report.docx');
        return Response.json({ analysis: { report_summary: 'done' }, proposals: [] });
      }
      throw new Error('unexpected request');
    }
  };
  const storage = {
    from(bucket) {
      assert.equal(bucket, 'weekly-reports');
      return {
        async download(path) {
          calls.push('download:' + path);
          return { data: new Blob(['weekly report'], { type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }), error: null };
        },
        async remove(paths) {
          calls.push('remove:' + paths[0]);
          return { data: [], error: null };
        }
      };
    }
  };
  const handler = new GatewayJobHandler({
    app,
    env: {},
    internalBearer: 'internal-secret',
    supabase: { storage },
    reportBucket: 'weekly-reports'
  });
  const result = await handler.handle({
    kind: 'analyze_weekly_report',
    actor_id: 'user-1',
    actor_login: 'vincent',
    payload: {
      storage_path: 'user-1/job/report.docx',
      filename: 'report.docx',
      report_date: '2026-09-03',
      owner_team: 'CTL'
    }
  });
  assert.equal(result.analysis.report_summary, 'done');
  assert.deepEqual(calls, [
    'download:user-1/job/report.docx',
    '/api/reports/upload',
    'remove:user-1/job/report.docx',
    '/api/reports/analyze'
  ]);
});
