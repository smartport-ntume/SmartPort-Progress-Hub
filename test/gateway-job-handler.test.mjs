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

test('GatewayJobHandler maps PM team configuration writes to the managed project API', async () => {
  let captured = null;
  const handler = new GatewayJobHandler({
    app: {
      async fetch(request) {
        captured = request;
        return Response.json({ ok: true, team_config: await request.clone().json() });
      }
    },
    env: {},
    internalBearer: 'internal-secret',
    supabase: {}
  });
  const payload = { categories: [], members: [], category_owners: {} };
  const result = await handler.handle({ kind: 'write_team_config', actor_login: 'vincent', payload });
  assert.equal(new URL(captured.url).pathname, '/api/project/team-config');
  assert.equal(captured.method, 'PUT');
  assert.equal(captured.headers.get('X-SmartPort-Actor'), 'vincent');
  assert.deepEqual(result.team_config, payload);
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
        assert.equal(body.member_name, '黃志峰');
        assert.deepEqual(body.owner_teams, ['CTL', 'STM']);
        return Response.json({ report: { path: 'weekly_reports/2026/report.docx', filename: 'report.docx' } }, { status: 201 });
      }
      if (url.pathname === '/api/reports/analyze') {
        const body = await request.json();
        assert.equal(body.report_path, 'weekly_reports/2026/report.docx');
        assert.deepEqual(body.scope_subtask_ids, ['C1.1', 'S1.1']);
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
      owner_team: 'CTL',
      owner_teams: ['CTL', 'STM'],
      member_id: 'member-1',
      member_name: '黃志峰',
      scope_subtask_ids: ['C1.1', 'S1.1']
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

test('portal weekly report trusts the server-side submission identity instead of browser fields', async () => {
  const filters = [];
  const query = {
    select() { return this; },
    eq(column, value) { filters.push([column, value]); return this; },
    async maybeSingle() {
      return {
        data: {
          id: 'submission-1',
          job_id: 'job-1',
          storage_path: 'portal/batch-1/member-1/upload-1/report.docx',
          filename: 'trusted-report.docx',
          member_id: 'member-1',
          member_name: '可信成員'
        },
        error: null
      };
    }
  };
  const handler = new GatewayJobHandler({
    app: {
      async fetch(request) {
        const body = await request.json();
        assert.equal(body.member_id, 'member-1');
        assert.equal(body.member_name, '可信成員');
        if (new URL(request.url).pathname === '/api/reports/upload') {
          assert.equal(body.filename, 'trusted-report.docx');
          return Response.json({ report: { path: 'weekly_reports/2026/trusted.docx' } }, { status: 201 });
        }
        assert.equal(body.report_path, 'weekly_reports/2026/trusted.docx');
        return Response.json({ analysis: { report_summary: 'trusted' }, proposals: [] });
      }
    },
    env: {},
    internalBearer: 'internal-secret',
    supabase: {
      from(table) {
        assert.equal(table, 'weekly_report_submissions');
        return query;
      },
      storage: {
        from() {
          return {
            async download() { return { data: new Blob(['portal report']), error: null }; },
            async remove() { return { data: [], error: null }; }
          };
        }
      }
    }
  });
  const result = await handler.handle({
    id: 'job-1',
    kind: 'analyze_weekly_report',
    actor_id: 'pm-user-id',
    actor_login: 'pm',
    payload: {
      submission_id: 'submission-1',
      storage_path: 'portal/batch-1/member-1/upload-1/report.docx',
      filename: 'spoofed.docx',
      member_id: 'spoofed-member',
      member_name: '偽造名稱',
      owner_team: 'CTL',
      owner_teams: ['CTL'],
      report_date: '2026-09-14',
      scope_subtask_ids: []
    }
  });
  assert.equal(result.analysis.report_summary, 'trusted');
  assert.deepEqual(filters, [['id', 'submission-1'], ['job_id', 'job-1']]);
});

test('portal weekly report rejects a storage path that does not match its submission row', async () => {
  const query = {
    select() { return this; },
    eq() { return this; },
    async maybeSingle() {
      return {
        data: {
          id: 'submission-1',
          job_id: 'job-1',
          storage_path: 'portal/batch/member/upload/trusted.docx'
        },
        error: null
      };
    }
  };
  const handler = new GatewayJobHandler({
    app: { async fetch() { throw new Error('must not reach internal API'); } },
    env: {},
    internalBearer: 'internal-secret',
    supabase: {
      from() { return query; },
      storage: { from() { throw new Error('must not download mismatched file'); } }
    }
  });
  await assert.rejects(() => handler.handle({
    id: 'job-1',
    kind: 'analyze_weekly_report',
    actor_id: 'pm-user-id',
    actor_login: 'pm',
    payload: {
      submission_id: 'submission-1',
      storage_path: 'portal/batch/member/upload/attacker.docx'
    }
  }), /invalid_weekly_portal_submission/);
});
