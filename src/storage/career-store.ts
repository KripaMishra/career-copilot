import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InStatement, type Row } from '@libsql/client';
import { JobInputSchema, JobStatusSchema, SafeResultSchema, safeErrorMessage, type Job, type JobInput, type JobStatus, type SafeResult } from '../contracts/v0.ts';

export type LibsqlConnectionConfig = { url: string; authToken?: string };

function rowSafeResult(row: Row): SafeResult | null {
  if (!row.safe_result) return null;
  const parsed = JSON.parse(String(row.safe_result)) as Partial<SafeResult>;
  return SafeResultSchema.parse({
    ...parsed,
    reportId: parsed.reportId ?? (row.report_id ? String(row.report_id) : null),
    reportPath: parsed.reportPath ?? (row.report_path ? String(row.report_path) : null),
    sheetReference: parsed.sheetReference ?? (row.sheet_reference ? String(row.sheet_reference) : null),
  });
}

function rowToJob(row: Row): Job {
  return {
    jobId: String(row.job_id), userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id), ownerId: String(row.owner_id), chatId: String(row.chat_id), transportEventId: String(row.transport_event_id),
    originalUrl: String(row.original_url), canonicalUrl: String(row.canonical_url), status: JobStatusSchema.parse(row.status),
    mastraRunId: row.mastra_run_id ? String(row.mastra_run_id) : null, attempts: Number(row.attempts),
    reportId: row.report_id ? String(row.report_id) : null, reportPath: row.report_path ? String(row.report_path) : null, sheetReference: row.sheet_reference ? String(row.sheet_reference) : null,
    safeResult: rowSafeResult(row), safeError: row.safe_error ? String(row.safe_error) : null,
    notifiedAt: row.notified_at === null ? null : Number(row.notified_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function normalizeJobForImport(job: Job): Job {
  const reportId = job.reportId ?? job.safeResult?.reportId ?? null;
  const reportPath = job.reportPath ?? job.safeResult?.reportPath ?? null;
  const sheetReference = job.sheetReference ?? job.safeResult?.sheetReference ?? null;
  return {
    ...job,
    status: JobStatusSchema.parse(job.status),
    reportId,
    reportPath,
    sheetReference,
    safeResult: job.safeResult ? SafeResultSchema.parse({ ...job.safeResult, reportId: job.safeResult.reportId ?? reportId, reportPath: job.safeResult.reportPath ?? reportPath, sheetReference: job.safeResult.sheetReference ?? sheetReference }) : null,
  };
}

function jobsMatch(left: Job, right: Job) {
  const a = normalizeJobForImport(left); const b = normalizeJobForImport(right);
  const fields: (keyof Job)[] = ['jobId', 'userId', 'ownerId', 'chatId', 'transportEventId', 'originalUrl', 'canonicalUrl', 'status', 'mastraRunId', 'attempts', 'reportId', 'reportPath', 'sheetReference', 'safeError', 'notifiedAt', 'createdAt', 'updatedAt'];
  return fields.every((field) => a[field] === b[field]) && JSON.stringify(a.safeResult) === JSON.stringify(b.safeResult);
}

const createSchema: InStatement[] = [
  `CREATE TABLE IF NOT EXISTS career_jobs (
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
    report_id TEXT,
    report_path TEXT,
    sheet_reference TEXT,
    safe_result TEXT,
    safe_error TEXT,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS career_reports (
    report_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at INTEGER NOT NULL,
    UNIQUE(job_id, version)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS career_profile_documents (
    document_id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    name TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    active INTEGER NOT NULL CHECK (active IN (0,1)),
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    UNIQUE(owner_id, name, version)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS career_report_counters (
    job_id TEXT PRIMARY KEY,
    next_version INTEGER NOT NULL CHECK (next_version >= 2)
  ) STRICT`,
];

const migrations = [
  ['user_id', 'ALTER TABLE career_jobs ADD COLUMN user_id TEXT'],
  ['report_id', 'ALTER TABLE career_jobs ADD COLUMN report_id TEXT'],
  ['report_path', 'ALTER TABLE career_jobs ADD COLUMN report_path TEXT'],
] as const;

function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
function bytes(content: string) { return Buffer.byteLength(content, 'utf8'); }
function assertImportMatch(ok: boolean, message: string) { if (!ok) throw new Error(message); }
export function safeDocumentName(name: string) { const trimmed = name.trim(); if (!trimmed || trimmed.length > 200 || /credential|secret|private|token|password|passwd|api[_-]?key|id[_-]?rsa/i.test(trimmed)) throw new Error('unsafe profile document name is rejected.'); return trimmed; }
export function assertSafeTextContent(content: string) { if (/-----BEGIN [^-]+-----|(?:api[_ -]?key|password|secret|token)\s*[:=]/i.test(content)) throw new Error('unsafe text content is rejected.'); }
function assertSafeProfileContent(content: string) { try { assertSafeTextContent(content); } catch { throw new Error('unsafe profile content is rejected.'); } }
function isLocalFileUrl(value: string) { try { const url = new URL(value); return value.startsWith('file:/') && url.protocol === 'file:'; } catch { return false; } }
function prepareLocalDatabaseFile(value: string) { if (!isLocalFileUrl(value)) return; const filename = fileURLToPath(value); const fd = openSync(filename, 'a', 0o600); try { chmodSync(filename, 0o600); } finally { closeSync(fd); } }
function validateDirectConnectionConfig(config: LibsqlConnectionConfig): LibsqlConnectionConfig {
  const url = new URL(config.url);
  if (url.username || url.password || url.search || url.hash) throw new Error('Database URL must not contain credentials, query, or fragment.');
  if (isLocalFileUrl(config.url)) { if (config.authToken) throw new Error('TURSO_AUTH_TOKEN must not be set for a local file database.'); return config; }
  if (!['libsql:', 'https:'].includes(url.protocol)) throw new Error('Database URL must be an absolute file:, libsql:, or https: URL.');
  if (!url.hostname.toLowerCase().endsWith('.turso.io')) throw new Error('Remote database URL must be a Turso host.');
  if (!config.authToken?.trim()) throw new Error('TURSO_AUTH_TOKEN is required for remote Turso databases.');
  return config;
}

export class CareerStore {
  readonly #client: Client;
  readonly #ownsClient: boolean;
  readonly #url: string;
  #ready: Promise<void>;

  constructor(config: string | LibsqlConnectionConfig | Client) {
    if (typeof config === 'string') { const safe = validateDirectConnectionConfig({ url: config }); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    else if ('execute' in config) { this.#url = ''; this.#client = config; this.#ownsClient = false; }
    else { const safe = validateDirectConnectionConfig(config); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    this.#ready = this.init();
  }

  async init() {
    prepareLocalDatabaseFile(this.#url);
    await this.#client.batch(createSchema, 'write');
    const columns = (await this.#client.execute('PRAGMA table_info(career_jobs)')).rows;
    for (const [name, sql] of migrations) if (!columns.some((column) => column.name === name)) await this.#client.execute(sql);
    if (this.#url.startsWith('file:/')) { const filename = fileURLToPath(this.#url); if (existsSync(filename)) chmodSync(filename, 0o600); }
  }
  async ready() { await this.#ready; }
  async close() { await this.#ready; if (this.#ownsClient) this.#client.close(); }
  statuses(): JobStatus[] { return ['queued', 'running', 'needs_input', 'succeeded', 'failed']; }

  async enqueue(input: JobInput): Promise<{ job: Job; duplicate: boolean }> {
    await this.#ready; const value = JobInputSchema.parse(input); const now = Date.now();
    const inserted = await this.#client.execute({ sql: `INSERT INTO career_jobs (job_id,user_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?, 'queued', ?,?) ON CONFLICT(transport_event_id) DO NOTHING`, args: [value.jobId, value.userId, value.ownerId, value.chatId, value.transportEventId, value.originalUrl, value.canonicalUrl, now, now] });
    const row = (await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE transport_event_id = ?', args: [value.transportEventId] })).rows[0];
    if (!row) throw new Error('Persisted job could not be read after enqueue.');
    return { job: rowToJob(row), duplicate: inserted.rowsAffected === 0 };
  }
  async get(jobId: string): Promise<Job | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE job_id = ?', args: [jobId] })).rows[0]; return row ? rowToJob(row) : null; }
  async getByTransportEventId(transportEventId: string): Promise<Job | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE transport_event_id = ?', args: [transportEventId] })).rows[0]; return row ? rowToJob(row) : null; }
  async assertRunningInput(input: JobInput): Promise<Job> {
    const value = JobInputSchema.parse(input); const job = await this.get(value.jobId);
    if (!job || job.status !== 'running'
      || job.userId !== value.userId || job.ownerId !== value.ownerId || job.chatId !== value.chatId || job.transportEventId !== value.transportEventId
      || job.originalUrl !== value.originalUrl || job.canonicalUrl !== value.canonicalUrl) throw new Error('Persisted running job does not match workflow input.');
    return job;
  }
  async list(status?: JobStatus): Promise<Job[]> {
    await this.#ready; const rows = (status ? await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE status = ? ORDER BY created_at', args: [status] }) : await this.#client.execute('SELECT * FROM career_jobs ORDER BY created_at')).rows;
    return rows.map(rowToJob);
  }
  async markRunning(jobId: string, runId: string) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='running', mastra_run_id=?, attempts=attempts+1, updated_at=? WHERE job_id=? AND status IN ('queued','running')", args: [runId, Date.now(), jobId] }); return this.get(jobId); }
  async complete(jobId: string, result: SafeResult, reportId: string | null, sheetReference: string | null) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='succeeded', safe_result=?, report_id=?, report_path=NULL, sheet_reference=?, safe_error=NULL, updated_at=? WHERE job_id=?", args: [JSON.stringify(result), reportId, sheetReference, Date.now(), jobId] }); return this.get(jobId); }
  async fail(jobId: string, error: unknown) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='failed', safe_error=?, updated_at=? WHERE job_id=?", args: [safeErrorMessage(error), Date.now(), jobId] }); return this.get(jobId); }
  async markNotified(jobId: string) { await this.#ready; await this.#client.execute({ sql: 'UPDATE career_jobs SET notified_at=?, updated_at=? WHERE job_id=?', args: [Date.now(), Date.now(), jobId] }); return this.get(jobId); }
  async unfinished() { return (await this.list()).filter((job) => job.status === 'queued' || job.status === 'running'); }

  async saveReport(input: { ownerId: string; jobId: string; content: string }) {
    await this.#ready; const now = Date.now();
    const job = (await this.#client.execute({ sql: 'SELECT owner_id FROM career_jobs WHERE job_id = ?', args: [input.jobId] })).rows[0];
    if (!job) throw new Error('Report job does not exist.');
    const ownerId = String(job.owner_id);
    if (ownerId !== input.ownerId) throw new Error('Report owner does not match job owner.');
    const allocated = (await this.#client.execute({ sql: `INSERT INTO career_report_counters (job_id,next_version) VALUES (?, COALESCE((SELECT MAX(version) FROM career_reports WHERE job_id=?), 0) + 2) ON CONFLICT(job_id) DO UPDATE SET next_version=next_version+1 RETURNING next_version - 1 AS version`, args: [input.jobId, input.jobId] })).rows[0];
    const version = Number(allocated?.version); const reportId = `${input.jobId}-v${version}`; const contentHash = hash(input.content);
    await this.#client.execute({ sql: 'INSERT INTO career_reports (report_id,owner_id,job_id,version,content,sha256,byte_size,created_at) VALUES (?,?,?,?,?,?,?,?)', args: [reportId, ownerId, input.jobId, version, input.content, contentHash, bytes(input.content), now] });
    return { reportId, hash: `sha256:${contentHash}`, byteSize: bytes(input.content), version };
  }
  async getReport(reportId: string, ownerId: string) { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_reports WHERE report_id = ? AND owner_id = ?', args: [reportId, ownerId] })).rows[0]; return row ? { reportId: String(row.report_id), ownerId: String(row.owner_id), jobId: String(row.job_id), version: Number(row.version), content: String(row.content), sha256: String(row.sha256), byteSize: Number(row.byte_size), createdAt: Number(row.created_at) } : null; }
  async saveProfileDocument(input: { ownerId: string; name: string; content: string; active?: boolean }) {
    await this.#ready; const name = safeDocumentName(input.name); assertSafeProfileContent(input.content); const now = Date.now();
    const current = (await this.#client.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM career_profile_documents WHERE owner_id=? AND name=?', args: [input.ownerId, name] })).rows[0];
    const version = Number(current?.version ?? 0) + 1; const documentId = `${hash(`${input.ownerId}:${name}`).slice(0, 16)}-v${version}`; const contentHash = hash(input.content);
    const statements: InStatement[] = [];
    if (input.active !== false) statements.push({ sql: 'UPDATE career_profile_documents SET active=0, updated_at=? WHERE owner_id=? AND name=?', args: [now, input.ownerId, name] });
    statements.push({ sql: 'INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [documentId, input.ownerId, name, version, input.active === false ? 0 : 1, input.content, contentHash, bytes(input.content), now, now] });
    await this.#client.batch(statements, 'write');
    return { documentId, hash: `sha256:${contentHash}`, byteSize: bytes(input.content), version };
  }
  async importJob(job: Job) {
    await this.#ready; const value = normalizeJobForImport(job);
    const inserted = await this.#client.execute({ sql: `INSERT INTO career_jobs (job_id,user_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,mastra_run_id,attempts,report_id,report_path,sheet_reference,safe_result,safe_error,notified_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO NOTHING`, args: [value.jobId, value.userId, value.ownerId, value.chatId, value.transportEventId, value.originalUrl, value.canonicalUrl, value.status, value.mastraRunId, value.attempts, value.reportId, value.reportPath, value.sheetReference, value.safeResult ? JSON.stringify(value.safeResult) : null, value.safeError, value.notifiedAt, value.createdAt, value.updatedAt] });
    if (inserted.rowsAffected > 0) return { imported: true };
    const existing = (await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE job_id=?', args: [value.jobId] })).rows[0];
    assertImportMatch(Boolean(existing), 'Imported job collision could not be read.');
    assertImportMatch(jobsMatch(rowToJob(existing), value), 'Imported job collision does not match source job.');
    return { imported: false };
  }
  async importReport(input: { reportId: string; ownerId: string; jobId: string; content: string; createdAt?: number }) {
    await this.#ready; assertSafeTextContent(input.content); const contentHash = hash(input.content); const byteSize = bytes(input.content);
    const job = (await this.#client.execute({ sql: 'SELECT owner_id, report_id FROM career_jobs WHERE job_id = ?', args: [input.jobId] })).rows[0];
    if (!job) throw new Error('Report job does not exist.');
    if (String(job.owner_id) !== input.ownerId) throw new Error('Report owner does not match job owner.');
    if (job.report_id && String(job.report_id) !== input.reportId) throw new Error('Imported report does not match existing job report.');
    const existing = (await this.#client.execute({ sql: 'SELECT * FROM career_reports WHERE report_id=?', args: [input.reportId] })).rows[0];
    if (existing) {
      assertImportMatch(String(existing.owner_id) === input.ownerId && String(existing.job_id) === input.jobId && String(existing.sha256) === contentHash && Number(existing.byte_size) === byteSize, 'Imported report collision does not match source content.');
      if (!job.report_id) await this.#client.execute({ sql: 'UPDATE career_jobs SET report_id=?, updated_at=? WHERE job_id=? AND report_id IS NULL', args: [input.reportId, input.createdAt ?? Date.now(), input.jobId] });
      return { reportId: String(existing.report_id), hash: `sha256:${String(existing.sha256)}`, byteSize: Number(existing.byte_size), version: Number(existing.version), imported: false };
    }
    const allocated = (await this.#client.execute({ sql: `INSERT INTO career_report_counters (job_id,next_version) VALUES (?, COALESCE((SELECT MAX(version) FROM career_reports WHERE job_id=?), 0) + 2) ON CONFLICT(job_id) DO UPDATE SET next_version=next_version+1 RETURNING next_version - 1 AS version`, args: [input.jobId, input.jobId] })).rows[0];
    const version = Number(allocated?.version); const now = input.createdAt ?? Date.now();
    await this.#client.batch([
      { sql: 'INSERT INTO career_reports (report_id,owner_id,job_id,version,content,sha256,byte_size,created_at) VALUES (?,?,?,?,?,?,?,?)', args: [input.reportId, input.ownerId, input.jobId, version, input.content, contentHash, byteSize, now] },
      { sql: 'UPDATE career_jobs SET report_id=?, updated_at=? WHERE job_id=? AND (report_id IS NULL OR report_id=?)', args: [input.reportId, now, input.jobId, input.reportId] },
    ], 'write');
    return { reportId: input.reportId, hash: `sha256:${contentHash}`, byteSize, version, imported: true };
  }
  async importProfileDocument(input: { ownerId: string; name: string; content: string; active?: boolean; createdAt?: number }) {
    await this.#ready; const name = safeDocumentName(input.name); assertSafeProfileContent(input.content); const contentHash = hash(input.content);
    const documentId = `import-${hash(`${input.ownerId}\0${name}\0${contentHash}`).slice(0, 32)}`;
    const existing = (await this.#client.execute({ sql: 'SELECT document_id,sha256,byte_size,version FROM career_profile_documents WHERE document_id=?', args: [documentId] })).rows[0];
    if (existing) return { documentId: String(existing.document_id), hash: `sha256:${String(existing.sha256)}`, byteSize: Number(existing.byte_size), version: Number(existing.version), imported: false };
    const current = (await this.#client.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM career_profile_documents WHERE owner_id=? AND name=?', args: [input.ownerId, name] })).rows[0];
    const version = Number(current?.version ?? 0) + 1; const now = input.createdAt ?? Date.now();
    await this.#client.execute({ sql: 'INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [documentId, input.ownerId, name, version, input.active === false ? 0 : 1, input.content, contentHash, bytes(input.content), now, now] });
    return { documentId, hash: `sha256:${contentHash}`, byteSize: bytes(input.content), version, imported: true };
  }
  async profileText(ownerId: string) {
    await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT name, content FROM career_profile_documents WHERE owner_id=? AND active=1 ORDER BY name', args: [ownerId] })).rows;
    return rows.map((row) => { const name = safeDocumentName(String(row.name)); const content = String(row.content); assertSafeProfileContent(content); return `${name}:\n${content}`; }).join('\n').slice(0, 100_000);
  }
  static newJobId() { return randomUUID(); }
}
