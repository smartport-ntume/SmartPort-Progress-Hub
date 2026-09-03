import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { AsyncMutex } from './mutex.mjs';

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value));
}

export class LocalJobQueue {
  constructor({ historyFile, maxHistory = 100, maxActive = 5 } = {}) {
    this.historyFile = historyFile || '';
    this.maxHistory = maxHistory;
    this.maxActive = Math.max(1, Number(maxActive) || 5);
    this.jobs = new Map();
    this.pending = [];
    this.running = false;
    this.persistMutex = new AsyncMutex();
    this.ready = this.load();
  }

  async load() {
    if (!this.historyFile) return;
    try {
      const rows = JSON.parse(await fs.readFile(this.historyFile, 'utf8'));
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row.status === 'queued' || row.status === 'running') {
          row.status = 'failed';
          row.error = 'local_backend_restarted_before_completion';
          row.finished_at = new Date().toISOString();
        } else if (row.status === 'completed' && row.result == null) {
          row.status = 'failed';
          row.error = 'local_backend_restarted_after_completion; submit the report again';
          row.finished_at = new Date().toISOString();
        }
        this.jobs.set(row.id, row);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  publicJob(job) {
    if (!job) return null;
    const {
      id, type, status, created_at, started_at, finished_at,
      submitted_by, report_path, result, error
    } = job;
    return clone({
      id, type, status, created_at, started_at, finished_at,
      submitted_by, report_path,
      ...(status === 'completed' ? { result } : {}),
      ...(status === 'failed' ? { error } : {})
    });
  }

  pruneHistory() {
    const ordered = [...this.jobs.values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
    const keep = new Set(ordered.slice(0, this.maxHistory).map(job => job.id));
    for (const job of ordered) {
      if (job.status === 'queued' || job.status === 'running') keep.add(job.id);
    }
    for (const id of this.jobs.keys()) {
      if (!keep.has(id)) this.jobs.delete(id);
    }
  }

  async persist() {
    if (!this.historyFile) return;
    return this.persistMutex.run(async () => {
      this.pruneHistory();
      await fs.mkdir(path.dirname(this.historyFile), { recursive: true });
      const rows = [...this.jobs.values()]
      .sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)))
        .slice(0, this.maxHistory)
        .map(job => {
          const copy = this.publicJob(job);
          if (copy?.result) delete copy.result;
          return copy;
        });
      const temporary = this.historyFile + '.' + process.pid + '.' + Date.now() + '.tmp';
      await fs.writeFile(temporary, JSON.stringify(rows, null, 2) + '\n');
      await fs.rename(temporary, this.historyFile);
    });
  }

  async enqueue(metadata, task) {
    await this.ready;
    const active = [...this.jobs.values()].filter(job => job.status === 'queued' || job.status === 'running');
    const duplicate = metadata.report_path && active.find(job =>
      job.type === (metadata.type || 'job') && job.report_path === metadata.report_path
    );
    if (duplicate) return this.publicJob(duplicate);
    if (active.length >= this.maxActive) {
      throw Object.assign(new Error('local_codex_queue_full'), { status: 429 });
    }
    const job = {
      id: crypto.randomUUID(),
      type: metadata.type || 'job',
      status: 'queued',
      created_at: new Date().toISOString(),
      started_at: null,
      finished_at: null,
      submitted_by: metadata.submitted_by || '',
      report_path: metadata.report_path || '',
      result: null,
      error: ''
    };
    this.jobs.set(job.id, job);
    this.pending.push({ job, task });
    await this.persist();
    this.drain().catch(() => {});
    return this.publicJob(job);
  }

  async drain() {
    if (this.running) return;
    this.running = true;
    try {
      while (this.pending.length) {
        const { job, task } = this.pending.shift();
        job.status = 'running';
        job.started_at = new Date().toISOString();
        await this.persist();
        try {
          job.result = await task();
          job.status = 'completed';
        } catch (error) {
          job.status = 'failed';
          job.error = error?.message || String(error);
        } finally {
          job.finished_at = new Date().toISOString();
          await this.persist();
        }
      }
    } finally {
      this.running = false;
    }
  }

  async get(id) {
    await this.ready;
    return this.publicJob(this.jobs.get(String(id)));
  }

  async summary() {
    await this.ready;
    const values = [...this.jobs.values()];
    return {
      queued: values.filter(job => job.status === 'queued').length,
      running: values.filter(job => job.status === 'running').length,
      completed: values.filter(job => job.status === 'completed').length,
      failed: values.filter(job => job.status === 'failed').length,
      max_active: this.maxActive
    };
  }
}
