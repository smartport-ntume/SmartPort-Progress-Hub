import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { LocalJobQueue } from '../local-server/job-queue.mjs';

async function waitFor(predicate, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for job');
}

test('LocalJobQueue executes Codex work one job at a time', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-job-queue-'));
  const historyFile = path.join(base, 'history.json');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  const queue = new LocalJobQueue({ historyFile });
  let active = 0;
  let maximumActive = 0;
  const order = [];

  const task = name => async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push('start-' + name);
    await new Promise(resolve => setTimeout(resolve, 25));
    order.push('finish-' + name);
    active -= 1;
    return { name };
  };

  const first = await queue.enqueue({ type: 'weekly', submitted_by: 'a' }, task('a'));
  const second = await queue.enqueue({ type: 'weekly', submitted_by: 'b' }, task('b'));
  await waitFor(async () => (await queue.get(second.id))?.status === 'completed');

  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ['start-a', 'finish-a', 'start-b', 'finish-b']);
  assert.deepEqual((await queue.get(first.id)).result, { name: 'a' });
  const persisted = JSON.parse(await fs.readFile(historyFile, 'utf8'));
  assert.equal('result' in persisted[0], false);
});

test('LocalJobQueue marks interrupted jobs failed after restart', async t => {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'smartport-job-restart-'));
  const historyFile = path.join(base, 'history.json');
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  await fs.writeFile(historyFile, JSON.stringify([{
    id: 'old-job', type: 'weekly', status: 'running', created_at: '2026-01-01T00:00:00.000Z'
  }]));

  const queue = new LocalJobQueue({ historyFile });
  const recovered = await queue.get('old-job');
  assert.equal(recovered.status, 'failed');
  assert.equal(recovered.error, 'local_backend_restarted_before_completion');
});

test('LocalJobQueue deduplicates a report and caps pending Codex work', async () => {
  const queue = new LocalJobQueue({ maxActive: 1 });
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const first = await queue.enqueue(
    { type: 'weekly', report_path: 'weekly_reports/a.docx' },
    async () => { await blocked; return { ok: true }; }
  );
  const duplicate = await queue.enqueue(
    { type: 'weekly', report_path: 'weekly_reports/a.docx' },
    async () => ({ should_not_run: true })
  );
  assert.equal(duplicate.id, first.id);
  await assert.rejects(
    queue.enqueue(
      { type: 'weekly', report_path: 'weekly_reports/b.docx' },
      async () => ({ ok: true })
    ),
    error => error.status === 429 && error.message === 'local_codex_queue_full'
  );
  release();
  await waitFor(async () => (await queue.get(first.id))?.status === 'completed');
});
