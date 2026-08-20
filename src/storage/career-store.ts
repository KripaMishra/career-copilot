import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, existsSync, openSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createClient, type Client, type InStatement, type InValue, type Row } from '@libsql/client';
import { JobInputSchema, JobStatusSchema, SafeResultSchema, safeErrorMessage, type Job, type JobInput, type JobStatus, type SafeResult } from '../contracts/v0.ts';
import { OnboardingDraftSchema, OnboardingStatusProjectionSchema, OnboardingStatusSchema, assertSafeOnboardingDraft, buildOnboardingProfileText, onboardingMissingFields, type OnboardingDraft, type OnboardingRecord, type OnboardingStatus, type OnboardingStatusProjection } from '../contracts/onboarding.ts';
import { redactBrowserEvidence } from '../browser/guard.ts';
import type { AppLogger } from '../observability.ts';

export type LibsqlConnectionConfig = { url: string; authToken?: string };
export type DiscoveryRunStatus = 'running' | 'succeeded' | 'failed';
export type DiscoverySiteStatus = 'pending' | 'ok' | 'blocked' | 'error';
export type DiscoveryCounts = { added: number; duplicate: number; nonQualifying: number; blocked: number; error: number };
export type DiscoveryRun = { runId: string; startedAt: number; status: DiscoveryRunStatus; finishedAt: number | null; counts: DiscoveryCounts };
export type DiscoverySite = { runId: string; site: string; status: DiscoverySiteStatus; cursor: string | null; counts: DiscoveryCounts; blockedReason: string | null; blockedEvidence: string | null; blockedSince: number | null; updatedAt: number };
export type DiscoverySiteInput = { runId: string; site: string; status: DiscoverySiteStatus; cursor?: string | null; counts: DiscoveryCounts; blockedReason?: string | null; blockedEvidence?: string | null; blockedSince?: number | null };

/** A discovery run that has not finished this long after starting is a crashed
 * lease (max run duration is minutes; 48h is impossibly long). createDiscoveryRun
 * expires such rows so a crashed process can never silently disable the schedule. */
export const STALE_DISCOVERY_RUN_MS = 48 * 60 * 60 * 1000;

/** Redaction revalidation seam (D6): resume-derived candidates re-run local
 * redaction at the write boundary; byte-for-byte equality is required before
 * persistence. Wired from the composition root; inert when absent. */
export type PiiRevalidator = {
  redactText(text: string): Promise<string>;
  redactDocument(value: unknown): Promise<unknown>;
};

export class ResumeRevalidationError extends Error {
  constructor() { super('Resume-derived content changed under PII redaction and was rejected.'); }
}

async function revalidateResumeDerived(revalidator: PiiRevalidator | undefined, candidate: { kind: 'document'; value: unknown } | { kind: 'text'; value: string }): Promise<void> {
  if (!revalidator) throw new ResumeRevalidationError();
  const redacted = candidate.kind === 'document' ? await revalidator.redactDocument(candidate.value) : await revalidator.redactText(candidate.value);
  const changed = candidate.kind === 'document' ? JSON.stringify(redacted) !== JSON.stringify(candidate.value) : redacted !== candidate.value;
  if (changed) throw new ResumeRevalidationError();
}

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
    draft: OnboardingDraftSchema.parse(JSON.parse(String(row.draft_json || '{}'))), version: Number(row.version), resumeDerived: Number(row.resume_derived ?? 0) === 1, createdAt: Number(row.created_at), updatedAt: Number(row.updated_at),
  };
}

function rowToDiscoveryCounts(row: Row): DiscoveryCounts {
  return { added: Number(row.added_count), duplicate: Number(row.duplicate_count), nonQualifying: Number(row.non_qualifying_count), blocked: Number(row.blocked_count), error: Number(row.error_count) };
}

function rowToDiscoveryRun(row: Row): DiscoveryRun {
  return { runId: String(row.run_id), startedAt: Number(row.started_at), status: String(row.status) as DiscoveryRunStatus, finishedAt: row.finished_at === null ? null : Number(row.finished_at), counts: rowToDiscoveryCounts(row) };
}

function rowToDiscoverySite(row: Row): DiscoverySite {
  return { runId: String(row.run_id), site: String(row.site), status: String(row.status) as DiscoverySiteStatus, cursor: row.cursor === null ? null : String(row.cursor), counts: rowToDiscoveryCounts(row), blockedReason: row.blocked_reason === null ? null : String(row.blocked_reason), blockedEvidence: row.blocked_evidence === null ? null : String(row.blocked_evidence), blockedSince: row.blocked_since === null ? null : Number(row.blocked_since), updatedAt: Number(row.updated_at) };
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
    resume_derived INTEGER NOT NULL DEFAULT 0 CHECK (resume_derived IN (0,1)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(owner_id, conversation_id)
  ) STRICT`,
  `CREATE TABLE IF NOT EXISTS discovery_runs (
    run_id TEXT PRIMARY KEY,
    started_at INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed')),
    finished_at INTEGER,
    added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    non_qualifying_count INTEGER NOT NULL DEFAULT 0 CHECK (non_qualifying_count >= 0),
    blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
    error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0)
  ) STRICT`,
  `CREATE UNIQUE INDEX IF NOT EXISTS one_running_discovery ON discovery_runs(status) WHERE status='running'`,
  `CREATE TABLE IF NOT EXISTS discovery_sites (
    run_id TEXT NOT NULL,
    site TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending','ok','blocked','error')),
    cursor TEXT,
    added_count INTEGER NOT NULL DEFAULT 0 CHECK (added_count >= 0),
    duplicate_count INTEGER NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
    non_qualifying_count INTEGER NOT NULL DEFAULT 0 CHECK (non_qualifying_count >= 0),
    blocked_count INTEGER NOT NULL DEFAULT 0 CHECK (blocked_count >= 0),
    error_count INTEGER NOT NULL DEFAULT 0 CHECK (error_count >= 0),
    blocked_reason TEXT,
    blocked_evidence TEXT,
    blocked_since INTEGER,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY(run_id, site)
  ) STRICT`,
];

function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
function bytes(content: string) { return Buffer.byteLength(content, 'utf8'); }
const ONBOARDING_PROFILE_DOCUMENT = 'onboarding.md';
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

function assertDiscoveryCounts(counts: DiscoveryCounts): DiscoveryCounts {
  for (const value of Object.values(counts)) if (!Number.isSafeInteger(value) || value < 0) throw new Error('Discovery counts must be non-negative safe integers.');
  return counts;
}

function safeDiscoverySite(site: string) {
  const value = site.trim();
  if (!value || value.length > 100) throw new Error('Discovery site must be between 1 and 100 characters.');
  return value;
}

function safeBlockedReason(reason: string) {
  const value = reason.trim();
  if (!/^[a-z0-9_]{1,100}$/.test(value)) throw new Error('Discovery blocked reason must be a stable reason code.');
  return value;
}

/** Column values (site..updated_at) for a discovery_sites row, normalized once
 * for both the lease-guarded upsert and the lease-free pass writer: blocked
 * rows carry a stable reason, redacted bounded evidence, and blocked_since. */
function discoverySiteRowValues(input: DiscoverySiteInput, now: number): InValue[] {
  const site = safeDiscoverySite(input.site); const counts = assertDiscoveryCounts(input.counts);
  const blockedReason = input.status === 'blocked' ? safeBlockedReason(input.blockedReason ?? '') : null;
  const blockedEvidence = input.status === 'blocked' ? redactBrowserEvidence(input.blockedEvidence ?? '') : null;
  const blockedSince = input.status === 'blocked' ? input.blockedSince ?? now : null;
  return [site, input.status, input.cursor ?? null, counts.added, counts.duplicate, counts.nonQualifying, counts.blocked, counts.error, blockedReason, blockedEvidence, blockedSince, now];
}

export class CareerStore {
  readonly #client: Client;
  readonly #ownsClient: boolean;
  readonly #url: string;
  readonly #clock: () => number;
  readonly #piiRevalidator: PiiRevalidator | undefined;
  readonly #logger: AppLogger | undefined;
  #ready: Promise<void>;

  constructor(config: string | LibsqlConnectionConfig | Client, options: { clock?: () => number; piiRevalidator?: PiiRevalidator; logger?: AppLogger } = {}) {
    this.#clock = options.clock ?? Date.now;
    this.#piiRevalidator = options.piiRevalidator;
    this.#logger = options.logger;
    if (typeof config === 'string') { const safe = validateDirectConnectionConfig({ url: config }); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    else if ('execute' in config) { this.#url = ''; this.#client = config; this.#ownsClient = false; }
    else { const safe = validateDirectConnectionConfig(config); this.#url = safe.url; prepareLocalDatabaseFile(safe.url); this.#client = createClient(safe); this.#ownsClient = true; }
    this.#ready = this.init();
  }

  async init() {
    prepareLocalDatabaseFile(this.#url);
    await this.#client.batch(createSchema, 'write');
    // migration for pre-lineage databases: resume-derived provenance column.
    // Fresh databases already carry it in the CREATE TABLE, so the duplicate-
    // column error is expected there and swallowed; any other failure surfaces.
    try {
      await this.#client.execute({ sql: 'ALTER TABLE career_onboarding ADD COLUMN resume_derived INTEGER NOT NULL DEFAULT 0' });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (!/duplicate column/i.test(message)) throw error;
    }
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
  async byCanonicalUrl(canonicalUrl: string): Promise<Job | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM career_jobs WHERE canonical_url = ? ORDER BY created_at LIMIT 1', args: [canonicalUrl] })).rows[0]; return row ? rowToJob(row) : null; }
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
  async fail(jobId: string, error: unknown) { await this.#ready; await this.#client.execute({ sql: "UPDATE career_jobs SET status='failed', safe_result=NULL, safe_error=?, updated_at=? WHERE job_id=? AND status IN ('queued','running')", args: [safeErrorMessage(error), this.#clock(), jobId] }); return this.get(jobId); }
  async markNotified(jobId: string) { await this.#ready; await this.#client.execute({ sql: 'UPDATE career_jobs SET notified_at=?, updated_at=? WHERE job_id=?', args: [this.#clock(), this.#clock(), jobId] }); return this.get(jobId); }
  async unfinished() { return (await this.list()).filter((job) => job.status === 'queued' || job.status === 'running'); }

  /** Atomic lease acquisition (spec D2): inserts a running run only when no
   * other running row exists. Crashed leases older than STALE_DISCOVERY_RUN_MS
   * are expired to failed first, so a kill mid-run can never silently disable
   * discovery forever; expiry is logged so the skip is at least visible. */
  async createDiscoveryRun(): Promise<{ outcome: 'started'; run: DiscoveryRun } | { outcome: 'skipped_overlap' }> {
    await this.#ready; const runId = randomUUID(); const startedAt = this.#clock();
    const expired = await this.#client.execute({ sql: "UPDATE discovery_runs SET status='failed', finished_at=? WHERE status='running' AND started_at < ?", args: [startedAt, startedAt - STALE_DISCOVERY_RUN_MS] });
    if (Number(expired.rowsAffected ?? 0) > 0) { try { this.#logger?.('error', 'discovery.run.lease.expired', { expiredRuns: Number(expired.rowsAffected) }); } catch { /* logging cannot break leasing */ } }
    const inserted = await this.#client.execute({ sql: "INSERT INTO discovery_runs (run_id,started_at,status) SELECT ?,?,'running' WHERE NOT EXISTS (SELECT 1 FROM discovery_runs WHERE status='running')", args: [runId, startedAt] });
    if (inserted.rowsAffected === 0) return { outcome: 'skipped_overlap' };
    return { outcome: 'started', run: { runId, startedAt, status: 'running', finishedAt: null, counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 } } };
  }
  async getDiscoveryRun(runId: string): Promise<DiscoveryRun | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM discovery_runs WHERE run_id=?', args: [runId] })).rows[0]; return row ? rowToDiscoveryRun(row) : null; }
  async activeDiscoveryRun(): Promise<DiscoveryRun | null> { await this.#ready; const row = (await this.#client.execute("SELECT * FROM discovery_runs WHERE status='running' LIMIT 1")).rows[0]; return row ? rowToDiscoveryRun(row) : null; }
  async finishDiscoveryRun(input: { runId: string; status: Exclude<DiscoveryRunStatus, 'running'>; counts: DiscoveryCounts }): Promise<DiscoveryRun> {
    await this.#ready; const counts = assertDiscoveryCounts(input.counts); const finishedAt = this.#clock();
    if (input.status !== 'succeeded' && input.status !== 'failed') throw new Error('Discovery run must finish as succeeded or failed.');
    const updated = await this.#client.execute({ sql: "UPDATE discovery_runs SET status=?, finished_at=?, added_count=?, duplicate_count=?, non_qualifying_count=?, blocked_count=?, error_count=? WHERE run_id=? AND status='running'", args: [input.status, finishedAt, counts.added, counts.duplicate, counts.nonQualifying, counts.blocked, counts.error, input.runId] });
    if (updated.rowsAffected !== 1) throw new Error('Discovery run is not active.');
    const row = (await this.#client.execute({ sql: 'SELECT * FROM discovery_runs WHERE run_id=?', args: [input.runId] })).rows[0];
    return rowToDiscoveryRun(row!);
  }
  async upsertDiscoverySite(input: DiscoverySiteInput): Promise<DiscoverySite> {
    await this.#ready; const values = discoverySiteRowValues(input, this.#clock());
    const updated = await this.#client.execute({ sql: `INSERT INTO discovery_sites (run_id,site,status,cursor,added_count,duplicate_count,non_qualifying_count,blocked_count,error_count,blocked_reason,blocked_evidence,blocked_since,updated_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,?,?,? FROM discovery_runs WHERE run_id=? AND status='running'
      ON CONFLICT(run_id,site) DO UPDATE SET status=excluded.status,cursor=excluded.cursor,added_count=excluded.added_count,duplicate_count=excluded.duplicate_count,non_qualifying_count=excluded.non_qualifying_count,blocked_count=excluded.blocked_count,error_count=excluded.error_count,blocked_reason=excluded.blocked_reason,blocked_evidence=excluded.blocked_evidence,blocked_since=excluded.blocked_since,updated_at=excluded.updated_at`, args: [input.runId, ...values, input.runId] });
    if (updated.rowsAffected !== 1) throw new Error('Discovery site can only be written for an active run.');
    return (await this.getDiscoverySite(input.runId, input.site))!;
  }
  /** Persist a non-lease discovery pass (e.g. an on-demand /explore_jobs pass):
   * inserts a finished discovery_runs row plus its per-site rows atomically,
   * never holding the running lease — so it can never block a scheduled fire. */
  async recordDiscoveryPass(input: { runId: string; status: Exclude<DiscoveryRunStatus, 'running'>; counts: DiscoveryCounts; sites: DiscoverySiteInput[] }): Promise<DiscoveryRun> {
    await this.#ready; const counts = assertDiscoveryCounts(input.counts); const now = this.#clock();
    if (input.status !== 'succeeded' && input.status !== 'failed') throw new Error('Discovery pass must finish as succeeded or failed.');
    let committed = false;
    const transaction = await this.#client.transaction('write');
    try {
      await transaction.execute({ sql: `INSERT INTO discovery_runs (run_id,started_at,status,finished_at,added_count,duplicate_count,non_qualifying_count,blocked_count,error_count) VALUES (?,?,?,?,?,?,?,?,?)`, args: [input.runId, now, input.status, now, counts.added, counts.duplicate, counts.nonQualifying, counts.blocked, counts.error] });
      for (const site of input.sites) await transaction.execute({ sql: `INSERT INTO discovery_sites (run_id,site,status,cursor,added_count,duplicate_count,non_qualifying_count,blocked_count,error_count,blocked_reason,blocked_evidence,blocked_since,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`, args: [input.runId, ...discoverySiteRowValues(site, now)] });
      await transaction.commit(); committed = true;
    } catch (error) {
      if (!committed) try { await transaction.rollback(); } catch { /* best effort */ }
      throw error;
    } finally { transaction.close(); }
    const row = (await this.#client.execute({ sql: 'SELECT * FROM discovery_runs WHERE run_id=?', args: [input.runId] })).rows[0];
    if (!row) throw new Error('Persisted discovery pass could not be read.');
    return rowToDiscoveryRun(row);
  }
  async getDiscoverySite(runId: string, site: string): Promise<DiscoverySite | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM discovery_sites WHERE run_id=? AND site=?', args: [runId, safeDiscoverySite(site)] })).rows[0]; return row ? rowToDiscoverySite(row) : null; }
  async listDiscoverySites(runId: string): Promise<DiscoverySite[]> { await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT * FROM discovery_sites WHERE run_id=? ORDER BY rowid', args: [runId] })).rows; return rows.map(rowToDiscoverySite); }
  async latestDiscoveryRun(): Promise<DiscoveryRun | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT * FROM discovery_runs ORDER BY started_at DESC, run_id DESC LIMIT 1' })).rows[0]; return row ? rowToDiscoveryRun(row) : null; }
  async capturedTimezone(ownerId: string): Promise<string | null> {
    await this.#ready;
    const row = (await this.#client.execute({ sql: `SELECT content FROM career_profile_documents WHERE owner_id=? AND name=? AND active=1 ORDER BY version DESC LIMIT 1`, args: [ownerId, ONBOARDING_PROFILE_DOCUMENT] })).rows[0];
    if (!row) return null;
    const value = String(row.content).match(/^Timezone:\s*(.+)$/m)?.[1]?.trim();
    return value || null;
  }
  async latestDiscoverySite(site: string): Promise<DiscoverySite | null> { await this.#ready; const row = (await this.#client.execute({ sql: 'SELECT s.* FROM discovery_sites s JOIN discovery_runs r ON r.run_id=s.run_id WHERE s.site=? ORDER BY r.started_at DESC, r.run_id DESC LIMIT 1', args: [safeDiscoverySite(site)] })).rows[0]; return row ? rowToDiscoverySite(row) : null; }
  async discoverySiteAddedCount(runId: string, site: string) { return (await this.getDiscoverySite(runId, site))?.counts.added ?? 0; }

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
    await this.#client.execute({ sql: `INSERT INTO career_onboarding (owner_id,conversation_id,status,draft_json,version,resume_derived,created_at,updated_at) VALUES (?,?,?,?,?,0,?,?) ON CONFLICT(owner_id, conversation_id) DO UPDATE SET status='collecting', draft_json='{}', resume_derived=0, version=career_onboarding.version+1, updated_at=excluded.updated_at`, args: [input.ownerId, input.conversationId, 'collecting', '{}', 1, now, now] });
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }

  /** Persist resume-derived provenance on the onboarding row (D6): once set,
   * every subsequent draft/profile write for this flow re-runs local redaction
   * at the write boundary — including ordinary review edits and confirmation. */
  async markOnboardingResumeDerived(input: { ownerId: string; conversationId: string; expectedVersion: number }) {
    await this.#ready;
    const updated = await this.#client.execute({ sql: "UPDATE career_onboarding SET resume_derived=1, updated_at=? WHERE owner_id=? AND conversation_id=? AND version=? AND status IN ('collecting','review')", args: [this.#clock(), input.ownerId, input.conversationId, input.expectedVersion] });
    if (updated.rowsAffected !== 1) throw new Error('Onboarding draft version is stale.');
    return (await this.loadOnboarding(input.ownerId, input.conversationId))!;
  }
  async saveOnboardingDraft(input: { ownerId: string; conversationId: string; expectedVersion: number; draft: OnboardingDraft; status?: Extract<OnboardingStatus, 'collecting' | 'review'> }) {
    await this.#ready; const current = await this.loadOnboarding(input.ownerId, input.conversationId);
    if (!current || current.version !== input.expectedVersion || !['collecting', 'review'].includes(current.status)) throw new Error('Onboarding draft version is stale.');
    assertSafeOnboardingDraft(input.draft);
    const draft = OnboardingDraftSchema.parse({ ...current.draft, ...input.draft });
    assertSafeOnboardingDraft(draft);
    // D6: lineage is durable state, not a caller flag — once a flow is
    // resume-derived, every write (incl. ordinary review edits) revalidates
    if (current.resumeDerived) await revalidateResumeDerived(this.#piiRevalidator, { kind: 'document', value: draft });
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
    await this.#ready; const name = ONBOARDING_PROFILE_DOCUMENT; const now = this.#clock(); let committed = false;
    const transaction = await this.#client.transaction('write');
    try {
      const row = (await transaction.execute({ sql: 'SELECT * FROM career_onboarding WHERE owner_id=? AND conversation_id=?', args: [input.ownerId, input.conversationId] })).rows[0];
      const current = row ? rowToOnboarding(row) : null;
      if (!current || current.version !== input.expectedVersion || current.status !== 'review') throw new Error('Onboarding draft version is stale.');
      if (onboardingMissingFields(current.draft).length > 0) throw new Error('Onboarding draft is missing required fields.');
      const content = buildOnboardingProfileText(current.draft); assertSafeProfileContent(content);
      // D6: lineage is durable state — a resume-derived flow's confirmation
      // revalidates even when the draft was edited through ordinary turns
      if (current.resumeDerived) await revalidateResumeDerived(this.#piiRevalidator, { kind: 'document', value: content });
      // D6: the draft row is deleted inside the same transaction that activates
      // the profile document, so loadOnboarding returns null afterwards and the
      // next /onboarding starts clean. The version/status guard runs first.
      const deleted = await transaction.execute({ sql: "DELETE FROM career_onboarding WHERE owner_id=? AND conversation_id=? AND version=? AND status='review'", args: [input.ownerId, input.conversationId, input.expectedVersion] });
      if (deleted.rowsAffected !== 1) throw new Error('Onboarding draft version is stale.');
      const currentVersion = (await transaction.execute({ sql: 'SELECT COALESCE(MAX(version), 0) AS version FROM career_profile_documents WHERE owner_id=? AND name=?', args: [input.ownerId, name] })).rows[0];
      const version = Number(currentVersion?.version ?? 0) + 1; const documentId = `${hash(`${input.ownerId}:${name}`).slice(0, 16)}-v${version}`; const contentHash = hash(content);
      await transaction.execute({ sql: 'UPDATE career_profile_documents SET active=0, updated_at=? WHERE owner_id=? AND name=?', args: [now, input.ownerId, name] });
      await transaction.execute({ sql: 'INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)', args: [documentId, input.ownerId, name, version, 1, content, contentHash, bytes(content), now, now] });
      await transaction.commit(); committed = true;
    } catch (error) {
      if (!committed) try { await transaction.rollback(); } catch { /* rollback best effort */ }
      throw error;
    } finally { transaction.close(); }
    return this.loadOnboarding(input.ownerId, input.conversationId);
  }
  async profileText(ownerId: string) {
    await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT name, content FROM career_profile_documents WHERE owner_id=? AND active=1 ORDER BY name', args: [ownerId] })).rows;
    return rows.map((row) => { const name = safeDocumentName(String(row.name)); const content = String(row.content); assertSafeProfileContent(content); return `${name}:\n${content}`; }).join('\n').slice(0, 100_000);
  }
  async onboardingStatus(ownerId: string, conversationId: string): Promise<OnboardingStatusProjection> {
    await this.#ready;
    const row = (await this.#client.execute({ sql: 'SELECT status, version, draft_json FROM career_onboarding WHERE owner_id=? AND conversation_id=?', args: [ownerId, conversationId] })).rows[0];
    const profile = (await this.#client.execute({ sql: 'SELECT 1 FROM career_profile_documents WHERE owner_id=? AND active=1 LIMIT 1', args: [ownerId] })).rows.length > 0;
    const projection = row
      ? { found: true, status: OnboardingStatusSchema.parse(row.status), version: Number(row.version), missingFields: onboardingMissingFields(OnboardingDraftSchema.parse(JSON.parse(String(row.draft_json || '{}')))), profileFound: profile }
      : { found: false, status: null, version: null, missingFields: [], profileFound: profile };
    return OnboardingStatusProjectionSchema.parse(projection);
  }
  async resetOnboarding(ownerId: string, conversationId: string) {
    await this.#ready;
    const result = await this.#client.execute({ sql: "DELETE FROM career_onboarding WHERE owner_id=? AND conversation_id=?", args: [ownerId, conversationId] });
    return { onboardingRows: Number(result.rowsAffected ?? 0) };
  }
  async resetProfile(ownerId: string) {
    await this.#ready;
    const transaction = await this.#client.transaction('write'); let committed = false;
    try {
      const profiles = await transaction.execute({ sql: 'DELETE FROM career_profile_documents WHERE owner_id=?', args: [ownerId] });
      const onboarding = await transaction.execute({ sql: 'DELETE FROM career_onboarding WHERE owner_id=?', args: [ownerId] });
      await transaction.commit(); committed = true;
      return { profileDocuments: Number(profiles.rowsAffected ?? 0), onboardingRows: Number(onboarding.rowsAffected ?? 0) };
    } finally { if (!committed) try { await transaction.rollback(); } catch { /* rollback best effort */ } transaction.close(); }
  }
  async resetAll(ownerId: string) {
    await this.#ready;
    const transaction = await this.#client.transaction('write'); let committed = false;
    try {
      const reports = await transaction.execute({ sql: 'DELETE FROM career_reports WHERE owner_id=?', args: [ownerId] });
      const jobs = await transaction.execute({ sql: 'DELETE FROM career_jobs WHERE owner_id=?', args: [ownerId] });
      const profiles = await transaction.execute({ sql: 'DELETE FROM career_profile_documents WHERE owner_id=?', args: [ownerId] });
      const onboarding = await transaction.execute({ sql: 'DELETE FROM career_onboarding WHERE owner_id=?', args: [ownerId] });
      await transaction.commit(); committed = true;
      return { reports: Number(reports.rowsAffected ?? 0), jobs: Number(jobs.rowsAffected ?? 0), profileDocuments: Number(profiles.rowsAffected ?? 0), onboardingRows: Number(onboarding.rowsAffected ?? 0) };
    } finally { if (!committed) try { await transaction.rollback(); } catch { /* rollback best effort */ } transaction.close(); }
  }
  async listProfileDocuments(ownerId: string) {
    await this.#ready; const rows = (await this.#client.execute({ sql: 'SELECT * FROM career_profile_documents WHERE owner_id=? ORDER BY created_at, document_id', args: [ownerId] })).rows;
    return rows.map((row) => ({ documentId: String(row.document_id), ownerId: String(row.owner_id), name: String(row.name), version: Number(row.version), active: Number(row.active) === 1, content: String(row.content), sha256: String(row.sha256), byteSize: Number(row.byte_size), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at) }));
  }
  static newJobId() { return randomUUID(); }
}
