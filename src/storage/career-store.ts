import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { JobInputSchema, JobStatusSchema, safeErrorMessage, type Job, type JobInput, type JobStatus, type SafeResult } from '../contracts/v0.ts';

function assertLocalFileUrl(value: string) {
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('Career store requires an absolute local file URL.'); }
  if (!value.startsWith('file:/') || url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || !url.pathname.startsWith('/') || url.search || url.hash || url.username || url.password) throw new Error('Career store requires an absolute local file URL.');
  return url.pathname;
}

const schema = `
CREATE TABLE IF NOT EXISTS career_jobs (
  job_id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL,
  user_id TEXT,
  chat_id TEXT NOT NULL,
  transport_event_id TEXT NOT NULL UNIQUE,
  original_url TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('queued','running','needs_input','succeeded','failed')),
  mastra_run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
  report_path TEXT,
  sheet_reference TEXT,
  safe_result TEXT,
  safe_error TEXT,
  notified_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) STRICT;
`;

function rowToJob(row: Record<string, unknown>): Job {
  return {
    jobId: String(row.job_id), userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id), ownerId: String(row.owner_id), chatId: String(row.chat_id), transportEventId: String(row.transport_event_id),
    originalUrl: String(row.original_url), canonicalUrl: String(row.canonical_url), status: JobStatusSchema.parse(row.status),
    mastraRunId: row.mastra_run_id ? String(row.mastra_run_id) : null, attempts: Number(row.attempts),
    reportPath: row.report_path ? String(row.report_path) : null, sheetReference: row.sheet_reference ? String(row.sheet_reference) : null,
    safeResult: row.safe_result ? JSON.parse(String(row.safe_result)) as SafeResult : null, safeError: row.safe_error ? String(row.safe_error) : null,
    notifiedAt: row.notified_at === null ? null : Number(row.notified_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

export class CareerStore {
  readonly #db: DatabaseSync;
  constructor(databaseUrl: string) {
    const filename = assertLocalFileUrl(databaseUrl);
    this.#db = new DatabaseSync(filename);
    chmodSync(filename, 0o600);
    this.#db.exec(schema);
    const columns = this.#db.prepare('PRAGMA table_info(career_jobs)').all() as Array<Record<string, unknown>>;
    if (!columns.some((column) => column.name === 'user_id')) this.#db.exec('ALTER TABLE career_jobs ADD COLUMN user_id TEXT');
  }
  close() { this.#db.close(); }
  statuses(): JobStatus[] { return ['queued', 'running', 'needs_input', 'succeeded', 'failed']; }
  enqueue(input: JobInput): { job: Job; duplicate: boolean } {
    const value = JobInputSchema.parse(input);
    const now = Date.now();
    const existing = this.#db.prepare('SELECT * FROM career_jobs WHERE transport_event_id = ?').get(value.transportEventId) as Record<string, unknown> | undefined;
    if (existing) return { job: rowToJob(existing), duplicate: true };
    this.#db.prepare(`INSERT INTO career_jobs (job_id,user_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'queued', ?,?)`).run(value.jobId, value.userId, value.ownerId, value.chatId, value.transportEventId, value.originalUrl, value.canonicalUrl, now, now);
    return { job: this.get(value.jobId)!, duplicate: false };
  }
  get(jobId: string): Job | null { const row = this.#db.prepare('SELECT * FROM career_jobs WHERE job_id = ?').get(jobId) as Record<string, unknown> | undefined; return row ? rowToJob(row) : null; }
  assertRunningInput(input: JobInput): Job {
    const value = JobInputSchema.parse(input); const job = this.get(value.jobId);
    if (!job || job.status !== 'running'
      || job.userId !== value.userId || job.ownerId !== value.ownerId || job.chatId !== value.chatId || job.transportEventId !== value.transportEventId
      || job.originalUrl !== value.originalUrl || job.canonicalUrl !== value.canonicalUrl) throw new Error('Persisted running job does not match workflow input.');
    return job;
  }
  list(status?: JobStatus): Job[] {
    const rows = (status ? this.#db.prepare('SELECT * FROM career_jobs WHERE status = ? ORDER BY created_at').all(status) : this.#db.prepare('SELECT * FROM career_jobs ORDER BY created_at').all()) as Record<string, unknown>[];
    return rows.map(rowToJob);
  }
  markRunning(jobId: string, runId: string) { this.#db.prepare("UPDATE career_jobs SET status='running', mastra_run_id=?, attempts=attempts+1, updated_at=? WHERE job_id=? AND status IN ('queued','running')").run(runId, Date.now(), jobId); return this.get(jobId); }
  complete(jobId: string, result: SafeResult, reportPath: string, sheetReference: string) { this.#db.prepare("UPDATE career_jobs SET status='succeeded', safe_result=?, report_path=?, sheet_reference=?, safe_error=NULL, updated_at=? WHERE job_id=?").run(JSON.stringify(result), reportPath, sheetReference, Date.now(), jobId); return this.get(jobId); }
  fail(jobId: string, error: unknown) { this.#db.prepare("UPDATE career_jobs SET status='failed', safe_error=?, updated_at=? WHERE job_id=?").run(safeErrorMessage(error), Date.now(), jobId); return this.get(jobId); }
  markNotified(jobId: string) { this.#db.prepare('UPDATE career_jobs SET notified_at=?, updated_at=? WHERE job_id=?').run(Date.now(), Date.now(), jobId); return this.get(jobId); }
  unfinished() { return this.list().filter((job) => job.status === 'queued' || job.status === 'running'); }
  static newJobId() { return randomUUID(); }
}
