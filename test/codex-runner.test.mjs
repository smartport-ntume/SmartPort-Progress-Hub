import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexWeeklyRunner, validateWeeklyAnalysis } from '../local-server/codex-runner.mjs';

const validResult = {
  assessment_status: 'completed',
  report_summary: 'One update found',
  review: {
    overall_assessment: '內容完整，但證據連結可更具體。',
    completeness_score: 90,
    evidence_score: 75,
    schedule_alignment_score: 85,
    strengths: ['有明確工作成果'],
    missing_items: ['補上測試紀錄連結'],
    actions: ['下次填寫驗證日期']
  },
  warnings: [],
  proposals: [{
    target_type: 'subtask',
    target_id: 'ST-01',
    progress: 40,
    status: 'On Track',
    blocker: '',
    evidence: 'Bench test passed',
    summary: 'Bench test completed',
    confidence: 0.9,
    rationale: 'Direct evidence'
  }]
};

test('validateWeeklyAnalysis normalizes and rejects unsafe values', () => {
  const result = validateWeeklyAnalysis(validResult);
  assert.equal(result.proposals[0].target_type, 'SUBTASK');
  assert.throws(
    () => validateWeeklyAnalysis({ ...validResult, proposals: [{ ...validResult.proposals[0], progress: 101 }] }),
    /invalid_progress/
  );
  assert.throws(
    () => validateWeeklyAnalysis({ ...validResult, proposals: [{ ...validResult.proposals[0], status: 'Invented' }] }),
    /invalid_status/
  );
  assert.throws(
    () => validateWeeklyAnalysis({ ...validResult, report_summary: 'x'.repeat(8_001) }),
    /report_summary_too_long/
  );
  assert.throws(
    () => validateWeeklyAnalysis({ ...validResult, review: { ...validResult.review, evidence_score: 101 } }),
    /weekly_analysis_incomplete/
  );
});

test('CodexWeeklyRunner uses an isolated read-only structured-output job', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-codex-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  let invocation;
  const runner = new CodexWeeklyRunner({
    runtimeDir,
    extractor: async () => ({ text: 'Weekly evidence', warnings: ['converted'] }),
    command: async (command, args, options) => {
      invocation = { command, args, options };
      const output = args[args.indexOf('-o') + 1];
      await fs.writeFile(output, JSON.stringify(validResult));
      return { code: 0, stdout: '', stderr: '' };
    }
  });

  process.env.SMARTPORT_TEST_SECRET = 'must-not-reach-codex';
  try {
    const result = await runner.analyze({
      filename: 'weekly.docx',
      fileBytes: Buffer.from('placeholder'),
      context: { owner_team: 'CTL' },
      schema: { type: 'object' }
    });
    assert.equal(result.proposals[0].target_type, 'SUBTASK');
    assert.deepEqual(result.warnings, ['converted']);
  } finally {
    delete process.env.SMARTPORT_TEST_SECRET;
  }

  assert.equal(invocation.command, 'codex');
  assert.ok(invocation.args.includes('--ephemeral'));
  assert.ok(invocation.args.includes('--ignore-user-config'));
  assert.ok(invocation.args.includes('--ignore-rules'));
  assert.deepEqual(invocation.args.slice(invocation.args.indexOf('--sandbox'), invocation.args.indexOf('--sandbox') + 2), ['--sandbox', 'read-only']);
  assert.ok(invocation.args.includes('--output-schema'));
  assert.equal(invocation.args.at(-1), '-');
  assert.equal(invocation.args.some(arg => arg.includes('Weekly evidence')), false);
  const input = JSON.parse(invocation.options.input.split('\n\n')[1]);
  assert.equal(input.weekly_report_text, 'Weekly evidence');
  assert.deepEqual(input.project_context, { owner_team: 'CTL' });
  assert.deepEqual(input.output_schema, { type: 'object' });
  assert.match(invocation.options.input, /Traditional Chinese/);
  assert.ok(path.isAbsolute(invocation.args[invocation.args.indexOf('--output-schema') + 1]));
  assert.equal(invocation.options.env.SMARTPORT_TEST_SECRET, undefined);
  await assert.rejects(fs.access(invocation.options.cwd));
});

test('inaccessible input, missing reviews and omitted scores never become a completed zero-score review', () => {
  const summary = 'Unable to assess the report without reading weekly-report.txt and project-context.json. Scores are omitted.';
  assert.throws(() => validateWeeklyAnalysis({ ...validResult, assessment_status: 'input_unavailable', review: null }), /weekly_analysis_incomplete/);
  assert.throws(() => validateWeeklyAnalysis({ ...validResult, assessment_status: undefined }), /weekly_analysis_incomplete/);
  assert.throws(() => validateWeeklyAnalysis({ ...validResult, review: undefined }), /weekly_analysis_incomplete/);
  for (const score of [null, undefined, '', '0', false]) {
    assert.throws(() => validateWeeklyAnalysis({ ...validResult, review: { ...validResult.review, completeness_score: score } }), /weekly_analysis_incomplete/);
  }
  const zeroReview = { ...validResult.review, completeness_score: 0, evidence_score: 0, schedule_alignment_score: 0 };
  assert.throws(() => validateWeeklyAnalysis({ ...validResult, report_summary: summary, review: { ...zeroReview, overall_assessment: summary }, proposals: [] }), /weekly_analysis_incomplete/);
  assert.equal(validateWeeklyAnalysis({ ...validResult, review: { ...zeroReview, overall_assessment: '僅填空白範本，沒有回報成果。' }, proposals: [] }).review.completeness_score, 0);
});

test('an input-unavailable response fails the job even when the CLI exits successfully', async t => {
  const runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-codex-failure-'));
  t.after(() => fs.rm(runtimeDir, { recursive: true, force: true }));
  const runner = new CodexWeeklyRunner({ runtimeDir,
    extractor: async () => ({ text: '有效週報', warnings: [] }),
    command: async (_command, args) => {
      await fs.writeFile(args[args.indexOf('-o') + 1], JSON.stringify({ ...validResult, assessment_status: 'input_unavailable', review: null, proposals: [] }));
      return { code: 0, stdout: '', stderr: '' };
    }
  });
  await assert.rejects(() => runner.analyze({ filename: 'report.docx', fileBytes: Buffer.from('docx'), context: { owner_teams: ['CTL'] }, schema: { type: 'object' } }), /weekly_analysis_incomplete/);
  assert.deepEqual(await fs.readdir(runtimeDir), []);
});

test('CodexWeeklyRunner verifies and caches CLI automation capability', async () => {
  let calls = 0;
  const runner = new CodexWeeklyRunner({
    runtimeDir: os.tmpdir(),
    command: async (_command, args) => {
      calls += 1;
      if (args[0] === '--version') return { code: 0, stdout: 'codex-cli 1.0\n', stderr: '' };
      if (args[0] === 'login') return { code: 0, stdout: 'authenticated\n', stderr: '' };
      return {
        code: 0,
        stdout: '--ephemeral --sandbox --ignore-user-config --ignore-rules --output-schema',
        stderr: ''
      };
    }
  });
  const first = await runner.status();
  const second = await runner.status();
  assert.equal(first.available, true);
  assert.equal(first.authenticated, true);
  assert.equal(first.compatible, true);
  assert.equal(second.version, 'codex-cli 1.0');
  assert.equal(calls, 3);
});
