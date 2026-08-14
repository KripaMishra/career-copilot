import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InStatement, type Row } from '@libsql/client';
import { JobInputSchema, JobStatusSchema, SafeResultSchema, safeErrorMessage, type Job, type JobInput, type JobStatus, type SafeResult } from '../contracts/v0.ts';
import { OnboardingDraftSchema, OnboardingStatusSchema, assertSafeOnboardingDraft, buildOnboardingProfileText, onboardingMissingFields, type OnboardingDraft, type OnboardingRecord, type OnboardingStatus } from '../contracts/onboarding.ts';

export type LibsqlConnectionConfig = { url: string; authToken?: string };

function rowSafeResult(row: Row): SafeResult | null {
  if (!row.safe_result) return null;
  const parsed = JSON.parse(String(row.safe_result)) as Partial<SafeResult>;
  return SafeResultSchema.parse({
    ...parsed,
    reportId: parsed.reportId ?? (row.report_id ? String(row.report_id) : null),
  });
}

function rowToJob(row: Row): Job {
  return {
    jobId: String(row.job_id), userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id), ownerId: String(row.owner_id), chatId: String(row.chat_id), transportEventId: String(row.transport_event_id),
    originalUrl: String(row.original_url), canonicalUrl: String(row.canonical_url), status: JobStatusSchema.parse(row.status),
    mastraRunId: row.mastra_run_id ? String(row.mastra_run_id) : null, attempts: Number(row.attempts),
    reportId: row.report_id ? String(row.report_id) : null,
    safeResult: rowSafeResult(row), safeError: row.safe_error ? String(row.safe_error) : null,
    notifiedAt: row.notified_at === null ? null : Number(row.notified_at), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function rowToOnboarding(row: Row): OnboardingRecord {
  return {
    ownerId: String(row.owner_id), conversationId: String(row.conversation_id), status: OnboardingStatusSchema.parse(row.status),
    draft: OnboardingDraftSchema.parse(JSON.parse(String(row.draft_json || '{}'))), version: Number(row.version), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
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
    status TEXT NOT NULL CHECK (status IN ('queued','running','succeeded','failed')),
    mastra_run_id TEXT,
    attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0 AND attempts <= 3),
    report_id TEXT,
    safe_result TEXT,
    safe_error TEXT,
    notified_at INTEGER,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS career_reports (
    report_id TEXT PRIMARY KEY,      -- = job_id for reports written by completeWithReport
    owner_id TEXT NOT NULL,
    job_id TEXT NOT NULL,
    content TEXT NOT NULL,
    sha256 TEXT NOT NULL,
    byte_size INTEGER NOT NULL CHECK (byte_size >= 0),
    created_at INTEGER NOT NULL
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
  `CREATE TABLE IF NOT EXISTS career_onboarding (
    owner_id TEXT NOT NULL,
    conversation_id TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('collecting','review','completed','cancelled')),
    draft_json TEXT NOT NULL,
    version INTEGER NOT NULL CHECK (version >= 1),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, conversation_id)
  ) STRICT`,
];

function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
function bytes(content: string) { return Buffer.byteLength(content, 'utf8'); }
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
  readonly #clock: () => number;
  #ready: Promise<void>;

  constructor(config: string | LibsqlConnectionConfig | Client, options: { clock?: () => number } = {}) {
    this.#clock = options.clock ?? Date.now;
    if (typeof config === 'string') { const safe = validateDirectConnectionConfig({ url: config }); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    else if ('execute' in config) { this.#url = ''; this.#client = config; this.#ownsClient = false; }
    else { const safe = validateDirectConnectionConfig(config); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    this.#ready = this.init();
  }

  async init() {
    prepareLocalDatabaseFile(this.#url);
    await this.#client.batch(createSchema, 'write');
    if (this.#url.startsWith('file:/')) { const filename = fileURLToPath(this.#url); if (existsSync(filename)) chmodSync(filename, 0o600); }
  }
  async ready() { await this.#ready; }
  async close() { await this.#ready; if (this.#ownsClient) this.#client.close(); }
  statuses(): JobStatus[] { return ['queued', 'running', 'succeeded', 'failed']; }

  async enqueue(input: JobInput): Promise<{ job: Job; duplicate: boolean }> {
    await this.#ready; const value = JobInputSchema.parse(input); const now = this.#clock();
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
  async markRunning(jobId: string, runId: string) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='running', mastra_run_id=?, attempts=attempts+1, updated_at=? WHERE job_id=? AND status IN ('queued','running')", args: [runId, this.#clock(), jobId] }); return this.get(jobId); }
  async completeWithReport(input: { jobId: string; ownerId: string; content: string; summary: string }) {
    await this.#ready; const now = this.#clock(); let committed = false;
    const transaction = await this.#client.transaction('write');
    try {
      const updated = await transaction.execute({ sql: "UPDATE career_jobs SET status='succeeded', safe_result=?, report_id=?, safe_error=NULL, updated_at=? WHERE job_id=? AND owner_id=? AND status='running'", args: [JSON.stringify(SafeResultSchema.parse({ summary: input.summary, reportId: input.jobId })), input.jobId, now, input.jobId, input.ownerId] });
      if (updated.rowsAffected !== 1) {
        const row = (await transaction.execute({ sql: 'SELECT owner_id, status, safe_result, report_id FROM career_jobs WHERE job_id=?', args: [input.jobId] })).rows[0];
        if (!row || String(row.owner_id) !== input.ownerId) throw new Error('Completion job does not exist.');
        if (String(row.status) !== 'succeeded') throw new Error('Completion job is not in a running state.');
        const existing = rowSafeResult(row);
        if (!existing) throw new Error('Completion job is already succeeded without a result.');
        return { reportId: existing.reportId ?? input.jobId, hash: null, byteSize: null };
      }
      const contentHash = hash(input.content);
      await transaction.execute({ sql: 'INSERT INTO career_reports (report_id,owner_id,job_id,content,sha256,byte_size,created_at) VALUES (?,?,?,?,?,?,?)', args: [input.jobId, input.ownerId, input.jobId, input.content, contentHash, bytes(input.content), now] });
      await transaction.commit(); committed = true;
      return { reportId: input.jobId, hash: `sha256:${contentHash}`, byteSize: bytes(input.content) };
    } catch (error) {
      if (!committed) try { await transaction.rollback(); } catch { /* rollback best effort */ }
      throw error;
    } finally { transaction.close(); }
  }
  async fail(jobId: string, error: unknown) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='failed', safe_result=NULL, safe_error=?, updated_at=? WHERE job_id=?", args: [safeErrorMessage(error), this.#clock(), jobId] }); return this.get(jobId); }
  async markNotified(jobId: string) { await this.#ready; await this.#client.execute({ sql: 'UPDATE career_jobs SET notified_at=?, updated_at=? WHERE job_id=?', args: [this.#clock(), this.#clock(), jobId] }); return this.get(jobId); }
  async unfinished() { return (await this.list()).filter((job) => job.status === 'queued' || job.status === 'running'); }

  async getReport(reportId: string, ownerId: string) { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_reports WHERE report_id = ? AND owner_id = ?', args: [reportId, ownerId] })).rows[0]; return row ? { reportId: String(row.report_id), ownerId: String(row.owner_id), jobId: String(row.job_id), content: String(row.content), sha256: String(row.sha256), byteSize: Number(row.byte_size), createdAt: Number(row.created_at) } : null; }
  async saveProfileDocument(input: { ownerId: string; name: string; content: string; active?: boolean }) {
    await this.#ready; const name = safeDocumentName(input.name); assertSafeProfileContent(input.content); const now = this.#clock();
    const current = (await this.#client.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM career_profile_documents WHERE owner_id=? AND name=?', args: [input.ownerId, name] })).rows[0];
    const version = Number(current?.version ?? 0) + 1; const documentId = `${hash(`${input.ownerId}:${name}`).slice(0, 16)}-v${version}`; const contentHash = hash(input.content);
    const statements: InStatement[] = [];
    if (input.active !== false) statements.push({ sql: 'UPDATE career_profile_documents SET active=0, updated_at=? WHERE owner_id=? AND name=?', args: [now, input.ownerId, name] });
    statements.push({ sql: 'INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [documentId, input.ownerId, name, version, input.active === false ? 0 : 1, input.content, contentHash, bytes(input.content), now, now] });
    await this.#client.batch(statements, 'write');
    return { documentId, hash: `sha256:${contentHash}`, byteSize: bytes(input.content), version };
  }

  async loadOnboarding(ownerId: string, conversationId: string): Promise<OnboardingRecord | null> {
    await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_onboarding WHERE owner_id=? AND conversation_id=?', args: [ownerId, conversationId] })).rows[0];
    return row ? rowToOnboarding(row) : null;
  }
  async startOnboarding(input: { ownerId: string; conversationId: string; restart?: boolean }) {
    await this.#ready; const existing = await this.loadOnboarding(input.ownerId, input.conversationId);
    if (existing && ['collecting', 'review'].includes(existing.status) && !input.restart) return existing;
    const now = this.#clock();
    await this.#client.execute({ sql: `INSERT INTO career_onboarding (owner_id,conversation_id,status,draft_json,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?) ON CONFLICT(owner_id, conversation_id) DO UPDATE SET status='collecting', draft_json='{}', version=career_onboarding.version+1, updated_at=excluded.updated_at`, args: [input.ownerId, input.conversationId, 'collecting', '{}', 1, now, now] });
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }
  async saveOnboardingDraft(input: { ownerId: string; conversationId: string; expectedVersion: number; draft: OnboardingDraft; status?: Extract<OnboardingStatus, 'collecting' | 'review'> }) {
    await this.#ready; const current = await this.loadOnboarding(input.ownerId, input.conversationId);
    if (!current || current.version !== input.expectedVersion || !['collecting', 'review'].includes(current.status)) throw new Error('Onboarding draft version is stale.');
    assertSafeOnboardingDraft(input.draft);
    const draft = OnboardingDraftSchema.parse({ ...current.draft, ...input.draft });
    assertSafeOnboardingDraft(draft);
    const status = input.status ?? 'collecting';
    if (status === 'review' && onboardingMissingFields(draft).length > 0) throw new Error('Onboarding draft is missing required fields.');
    const updated = await this.#client.execute({ sql: 'UPDATE career_onboarding SET status=?, draft_json=?, version=version+1, updated_at=? WHERE owner_id=? AND conversation_id=? AND version=? AND status IN (\'collecting\',\'review\')', args: [status, JSON.stringify(draft), this.#clock(), input.ownerId, input.conversationId, input.expectedVersion] });
    if (updated.rowsAffected !== 1) throw new Error('Onboarding draft version is stale.');
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }
  async cancelOnboarding(input: { ownerId: string; conversationId: string; expectedVersion: number }) {
    await this.#ready;
    const updated = await this.#client.execute({ sql: "UPDATE career_onboarding SET status='cancelled', draft_json='{}', version=version+1, updated_at=? WHERE owner_id=? AND conversation_id=? AND version=? AND status IN ('collecting','review')", args: [this.#clock(), input.ownerId, input.conversationId, input.expectedVersion] });
    if (updated.rowsAffected !== 1) throw new Error('Onboarding draft version is stale.');
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }
  async completeOnboarding(input: { ownerId: string; conversationId: string; expectedVersion: number }) {
    await this.#ready; const name = 'onboarding.md'; const now = this.#clock(); let committed = false;
    const transaction = await this.#client.transaction('write');
    try {
      const row = (await transaction.execute({ sql: 'SELECT * FROM career_onboarding WHERE owner_id=? AND conversation_id=?', args: [input.ownerId, input.conversationId] })).rows[0];
      const current = row ? rowToOnboarding(row) : null;
      if (!current || current.version !== input.expectedVersion || current.status !== 'review') throw new Error('Onboarding draft version is stale.');
      if (onboardingMissingFields(current.draft).length > 0) throw new Error('Onboarding draft is missing required fields.');
      const content = buildOnboardingProfileText(current.draft); assertSafeProfileContent(content);
      const updated = await transaction.execute({ sql: "UPDATE career_onboarding SET status='completed', version=version+1, updated_at=? WHERE owner_id=? AND conversation_id=? AND version=? AND status='review'", args: [now, input.ownerId, input.conversationId, input.expectedVersion] });
      if (updated.rowsAffected !== 1) throw new Error('Onboarding draft version is stale.');
      const currentVersion = (await transaction.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM career_profile_documents WHERE owner_id=? AND name=?', args: [input.ownerId, name] })).rows[0];
      const version = Number(currentVersion?.version ?? 0) + 1; const documentId = `${hash(`${input.ownerId}:${name}`).slice(0, 16)}-v${version}`; const contentHash = hash(content);
      await transaction.execute({ sql: 'UPDATE career_profile_documents SET active=0, updated_at=? WHERE owner_id=? AND name=?', args: [now, input.ownerId, name] });
      await transaction.execute({ sql: 'INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [documentId, input.ownerId, name, version, 1, content, contentHash, bytes(content), now, now] });
      await transaction.commit(); committed = true;
    } catch (error) {
      if (!committed) try { await transaction.rollback(); } catch { /* rollback best effort */ }
      throw error;
    } finally { transaction.close(); }
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }
  async profileText(ownerId: string) {
    await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT name, content FROM career_profile_documents WHERE owner_id=? AND active=1 ORDER BY name', args: [ownerId] })).rows;
    return rows.map((row) => { const name = safeDocumentName(String(row.name)); const content = String(row.content); assertSafeProfileContent(content); return `${name}:\n${content}`; }).join('\n').slice(0, 100_000);
  }
  async listProfileDocuments(ownerId: string) {
    await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT * FROM career_profile_documents WHERE owner_id=? ORDER BY created_at, document_id', args: [ownerId] })).rows;
    return rows.map((row) => ({ documentId: String(row.document_id), ownerId: String(row.owner_id), name: String(row.name), version: Number(row.version), active: Number(row.active) === 1, content: String(row.content), sha256: String(row.sha256), byteSize: Number(row.byte_size), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  }
  static newJobId() { return randomUUID(); }
}
