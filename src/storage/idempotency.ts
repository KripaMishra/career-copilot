import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

export type JobIdentity = { url?: string; company?: string; title?: string; location?: string };
export type JobState = 'pending' | 'succeeded' | 'failed';
export type IdempotencyRecord = {
  key: string;
  firstRequestId: string;
  sightings: number;
  lastRequestId?: string;
  lastSourceId?: string;
};
export type OutboxEntry = {
  requestId: string;
  step: string;
  state: 'pending' | 'succeeded' | 'failed';
  payload?: string;
  updatedAt: number;
};

export function normalizeJobIdentity(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, ' ').toLowerCase();
}

function canonicalUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = '';
  if (url.pathname.length > 1) url.pathname = url.pathname.replace(/\/+$/, '');
  return url.toString();
}

export function buildJobIdempotencyKey(identity: JobIdentity): string {
  if (identity.url?.trim()) return `url:${canonicalUrl(identity.url)}`;
  const values = [identity.company, identity.title, identity.location].map((value) => normalizeJobIdentity(value ?? ''));
  if (values.every(Boolean)) return `identity:${values.join('|')}`;
  throw new Error('A URL or complete company, title, and location identity is required.');
}

export class SqliteIdempotencyStore {
  private readonly database: DatabaseSync;
  private readonly leaseMs: number;

  constructor(databaseUrl: string, options: { leaseMs?: number } = {}) {
    const parsed = new URL(databaseUrl);
    if (parsed.protocol !== 'file:' || !parsed.pathname.startsWith('/')) {
      throw new Error('Idempotency storage requires an absolute file database URL.');
    }
    this.leaseMs = options.leaseMs ?? 60_000;
    this.database = new DatabaseSync(fileURLToPath(parsed));
    this.database.exec('PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;');
    this.database.exec(`
      CREATE TABLE IF NOT EXISTS career_requests (request_id TEXT PRIMARY KEY) STRICT;
      CREATE TABLE IF NOT EXISTS career_idempotency (
        key TEXT PRIMARY KEY,
        first_request_id TEXT NOT NULL,
        sightings INTEGER NOT NULL DEFAULT 0,
        last_request_id TEXT,
        last_source_id TEXT,
        state TEXT NOT NULL DEFAULT 'pending',
        lease_until INTEGER,
        error TEXT
      ) STRICT;
      CREATE TABLE IF NOT EXISTS career_outbox (
        request_id TEXT NOT NULL,
        step TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        payload TEXT,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (request_id, step)
      ) STRICT;
    `);
    this.addColumnIfMissing('career_idempotency', 'state', "TEXT NOT NULL DEFAULT 'pending'");
    this.addColumnIfMissing('career_idempotency', 'lease_until', 'INTEGER');
    this.addColumnIfMissing('career_idempotency', 'error', 'TEXT');
  }

  private addColumnIfMissing(table: string, column: string, definition: string) {
    const columns = this.database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((item) => item.name === column)) this.database.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }

  async claimRequest(requestId: string): Promise<boolean> {
    const result = this.database.prepare('INSERT INTO career_requests (request_id) VALUES (?) ON CONFLICT(request_id) DO NOTHING').run(requestId);
    return Number(result.changes) === 1;
  }

  async claim(key: string, requestId: string): Promise<{ claimed: boolean; record: IdempotencyRecord }> {
    const now = Date.now();
    const leaseUntil = now + this.leaseMs;
    this.database.exec('BEGIN IMMEDIATE');
    try {
      const current = this.database.prepare('SELECT state, lease_until FROM career_idempotency WHERE key = ?').get(key) as { state: JobState; lease_until: number | null } | undefined;
      let claimed = false;
      if (!current) {
        this.database.prepare('INSERT INTO career_idempotency (key, first_request_id, state, lease_until) VALUES (?, ?, \'pending\', ?)').run(key, requestId, leaseUntil);
        claimed = true;
      } else if (current.state === 'succeeded') {
        claimed = false;
      } else if (current.state === 'pending' && current.lease_until !== null && current.lease_until > now) {
        claimed = false;
      } else {
        this.database.prepare('UPDATE career_idempotency SET state = \'pending\', lease_until = ?, last_request_id = ?, error = NULL WHERE key = ?').run(leaseUntil, requestId, key);
        claimed = true;
      }
      this.database.exec('COMMIT');
      return { claimed, record: this.get(key)! };
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async markSucceeded(key: string, requestId: string): Promise<void> {
    const result = this.database.prepare("UPDATE career_idempotency SET state = 'succeeded', lease_until = NULL, last_request_id = ? WHERE key = ? AND state = 'pending'").run(requestId, key);
    if (Number(result.changes) !== 1) throw new Error('Cannot mark an unclaimed job as succeeded.');
  }

  async markFailed(key: string, requestId: string, error?: string): Promise<void> {
    this.database.prepare("UPDATE career_idempotency SET state = 'failed', lease_until = NULL, last_request_id = ?, error = ? WHERE key = ? AND state = 'pending'").run(requestId, error?.slice(0, 500) ?? null, key);
  }

  getState(key: string): { state: JobState; leaseUntil: number | null; error?: string } | undefined {
    const row = this.database.prepare('SELECT state, lease_until AS leaseUntil, error FROM career_idempotency WHERE key = ?').get(key) as { state: JobState; leaseUntil: number | null; error?: string } | undefined;
    return row ? { ...row } : undefined;
  }

  async createOutbox(requestId: string, steps: string[], payload: Record<string, unknown> = {}): Promise<void> {
    const now = Date.now();
    const serialized = JSON.stringify(payload);
    this.database.exec('BEGIN IMMEDIATE');
    try {
      for (const step of steps) {
        this.database.prepare("INSERT INTO career_outbox (request_id, step, state, payload, updated_at) VALUES (?, ?, 'pending', ?, ?) ON CONFLICT(request_id, step) DO NOTHING").run(requestId, step, serialized, now);
      }
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  async markOutbox(requestId: string, step: string, state: OutboxEntry['state']): Promise<void> {
    this.database.prepare('UPDATE career_outbox SET state = ?, updated_at = ? WHERE request_id = ? AND step = ?').run(state, Date.now(), requestId, step);
  }

  getOutbox(requestId: string): OutboxEntry[] {
    return (this.database.prepare('SELECT request_id AS requestId, step, state, payload, updated_at AS updatedAt FROM career_outbox WHERE request_id = ? ORDER BY rowid').all(requestId) as OutboxEntry[]).map((entry) => ({ ...entry }));
  }

  async recordSighting(key: string, requestId: string, sourceId: string): Promise<void> {
    this.database.exec('BEGIN IMMEDIATE');
    try {
      this.database.prepare(`
        INSERT INTO career_idempotency (key, first_request_id, sightings, last_request_id, last_source_id, state)
        VALUES (?, ?, 1, ?, ?, 'failed')
        ON CONFLICT(key) DO UPDATE SET sightings = career_idempotency.sightings + 1, last_request_id = excluded.last_request_id, last_source_id = excluded.last_source_id
      `).run(key, requestId, requestId, sourceId);
      this.database.exec('COMMIT');
    } catch (error) {
      this.database.exec('ROLLBACK');
      throw error;
    }
  }

  get(key: string): IdempotencyRecord | undefined {
    const row = this.database.prepare('SELECT key, first_request_id AS firstRequestId, sightings, last_request_id AS lastRequestId, last_source_id AS lastSourceId FROM career_idempotency WHERE key = ?').get(key) as IdempotencyRecord | undefined;
    return row ? { ...row } : undefined;
  }

  close(): void { this.database.close(); }
}
