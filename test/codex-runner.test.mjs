import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CodexWeeklyRunner, validateWeeklyAnalysis } from '../local-server/codex-runner.mjs';

const validResult = {
  report_summary: 'One update found',
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
  assert.equal(invocation.options.env.SMARTPORT_TEST_SECRET, undefined);
  await assert.rejects(fs.access(invocation.options.cwd));
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
