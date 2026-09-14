import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { weeklyAssessmentIssue } from '../worker/src/weekly-assessment.js';
import { validateWeeklyAnalysis } from '../local-server/codex-runner.mjs';
import { zeroAnalysis, screenshotFailures } from './fixtures/weekly-input-failures.mjs';

const window = {};
vm.runInNewContext(await readFile(new URL('../js/weekly-review-model.js', import.meta.url), 'utf8'), { window });
const browserModel = window.SmartPortWeeklyReview;

test('both reported zero-score failures are blocked in the PM center, member feedback and server', () => {
  for (const analysis of screenshotFailures) {
    assert.match(weeklyAssessmentIssue(analysis), /Codex 未取得完整週報/);
    assert.equal(browserModel.assessmentIssue(analysis), weeklyAssessmentIssue(analysis));
    assert.equal(browserModel.status({ status: 'completed', review_status: 'PENDING', analysis_result: { analysis } }).key, 'failed');
    assert.equal(browserModel.status({ status: 'completed', review: analysis.review, summary: analysis.report_summary }).key, 'failed');
    assert.throws(() => validateWeeklyAnalysis({ ...analysis, assessment_status: 'completed' }), /weekly_analysis_incomplete/);
  }
});

test('input failures can appear only in missing items, actions, warnings or generic summaries', () => {
  const failures = [
    { review: { ...zeroAnalysis().review, missing_items: ['Unable to inspect weekly-report.txt.'] } },
    { review: { ...zeroAnalysis().review, actions: ['Could not access project-context.json.'] } },
    { warnings: ['Couldn’t read proposal.schema.json.'] },
    { report_summary: 'The report and project context could not be read.' },
    { report_summary: 'Unable to assess the report without file access.' },
    { report_summary: 'The supplied report contents were not available.' },
    { report_summary: '無法讀取週報與專案資料，因此未進行評分。' }
  ];
  for (const extra of failures) {
    const analysis = zeroAnalysis(extra);
    assert.match(weeklyAssessmentIssue(analysis), /Codex 未取得完整週報/, JSON.stringify(extra));
    assert.equal(browserModel.assessmentIssue(analysis), weeklyAssessmentIssue(analysis));
  }
});

test('genuine zero-score reviews and unreadable peripheral evidence remain reviewable', () => {
  const valid = [
    zeroAnalysis(),
    zeroAnalysis({ report_summary: 'Read weekly-report.txt and project-context.json; the report only contains template prompts.' }),
    zeroAnalysis({ review: { ...zeroAnalysis().review, missing_items: ['Unable to inspect the LiDAR raw-data attachment referenced by weekly-report.txt.'] } }),
    zeroAnalysis({ review: { ...zeroAnalysis().review, missing_items: ['Unable to assess checkpoint completion because no test evidence was provided.'] } })
  ];
  for (const analysis of valid) {
    assert.equal(weeklyAssessmentIssue(analysis), '', JSON.stringify(analysis));
    assert.equal(browserModel.assessmentIssue(analysis), '');
    assert.equal(browserModel.status({ status: 'completed', analysis_result: { analysis } }).key, 'pending');
    assert.equal(validateWeeklyAnalysis({ ...analysis, assessment_status: 'completed' }).review.completeness_score, 0);
  }
});
