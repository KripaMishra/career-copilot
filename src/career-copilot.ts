import {
  authorizeTelegramUpdate,
  type TelegramAllowlist,
  type TelegramAuditWriter,
  type TelegramUpdate,
} from './telegram-auth.ts';
import { buildJobIdempotencyKey, type OutboxEntry } from './idempotency.ts';

export type CareerJob = { url: string; company?: string; title?: string; location?: string; description?: string; sourceHash?: string };

type Tracker = {
  readTracker(): Promise<Array<Record<string, unknown>>>;
  appendTrackerRow(row: Record<string, unknown>): Promise<void>;
  updateTrackerRow(rowNumber: number, fields: Record<string, unknown>): Promise<void>;
  verifyTrackerRow(rowNumber: number, status: string): Promise<void>;
  appendAudit(row: Record<string, unknown>): Promise<void>;
};

type DurableJobState = {
  claimRequest(requestId: string): Promise<boolean>;
  claim(key: string, requestId: string): Promise<{ claimed: boolean; record: unknown }>;
  recordSighting(key: string, requestId: string, sourceId: string): Promise<void>;
  createOutbox(requestId: string, steps: string[], payload?: Record<string, unknown>): Promise<void>;
  markOutbox(requestId: string, step: string, state: 'pending' | 'succeeded' | 'failed'): Promise<void>;
  markSucceeded(key: string, requestId: string): Promise<void>;
  markFailed(key: string, requestId: string, error?: string): Promise<void>;
  getOutbox(requestId: string): Promise<OutboxEntry[]> | OutboxEntry[];
};

export type CareerCopilotDependencies = {
  allowlist: TelegramAllowlist;
  audit: TelegramAuditWriter;
  fetchJob(url: string): Promise<CareerJob>;
  idempotency: DurableJobState;
  sheets: Tracker & { appendTopic(row: Record<string, unknown>): Promise<void> };
  profile: { readApproved(): Promise<Record<string, unknown>> };
  report: { write(input: { job: CareerJob; profile: Record<string, unknown> }): Promise<{ hash?: string }> };
  topics: { write(input: { job: CareerJob }): Promise<void> };
  alert(message: string): Promise<void>;
};

type FlowResult =
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'duplicate'; requestId: string }
  | { outcome: 'reviewed'; requestId: string }
  | { outcome: 'failed'; requestId: string; error: string };

const outboxSteps = ['tracker', 'fetch', 'profile', 'report', 'topics', 'audit-prepared', 'tracker-reviewed', 'audit-reviewed'];

export class CareerCopilotService {
  private readonly dependencies: CareerCopilotDependencies;
  constructor(dependencies: CareerCopilotDependencies) { this.dependencies = dependencies; }

  async reconcile(requestId: string): Promise<OutboxEntry[]> {
    return this.dependencies.idempotency.getOutbox(requestId);
  }

  async process(update: TelegramUpdate, context: { alert?: (message: string) => Promise<void> } | ((message: string) => Promise<void>) = {}): Promise<FlowResult> {
    const { dependencies } = this;
    const authorization = await authorizeTelegramUpdate(update, dependencies.allowlist, dependencies.audit);
    if (!authorization.accepted) return { outcome: 'rejected', reason: authorization.reason };

    const { request, url } = authorization;
    const requestId = request.requestId!;
    if (!(await dependencies.idempotency.claimRequest(requestId))) {
      await dependencies.audit.append({ kind: 'telegram_rejection', actor: 'telegram', requestId, reason: 'replayed_update', timestamp: new Date().toISOString() });
      return { outcome: 'rejected', reason: 'replayed_update' };
    }

    const key = buildJobIdempotencyKey({ url });
    const claim = await dependencies.idempotency.claim(key, requestId);
    if (!claim.claimed) {
      await dependencies.idempotency.recordSighting(key, requestId, requestId);
      return { outcome: 'duplicate', requestId };
    }

    let rowNumber = -1;
    let previousStatus = '';
    let trackerChanged = false;
    const step = async <T>(name: string, operation: () => Promise<T>): Promise<T> => {
      await dependencies.idempotency.markOutbox(requestId, name, 'pending');
      try {
        const result = await operation();
        await dependencies.idempotency.markOutbox(requestId, name, 'succeeded');
        return result;
      } catch (error) {
        await dependencies.idempotency.markOutbox(requestId, name, 'failed');
        throw error;
      }
    };

    try {
      await dependencies.idempotency.createOutbox(requestId, outboxSteps, { key, url });
      const rows = await step('tracker', () => dependencies.sheets.readTracker());
      rowNumber = rows.findIndex((row) => row.URL === url);
      if (rowNumber < 0) {
        rowNumber = rows.length;
        await dependencies.sheets.appendTrackerRow({ URL: url, Status: '' });
        trackerChanged = true;
      } else {
        previousStatus = String(rows[rowNumber].Status ?? '');
        trackerChanged = true;
      }

      const job = await step('fetch', () => dependencies.fetchJob(url));
      const profile = await step('profile', () => dependencies.profile.readApproved());
      const report = await step('report', () => dependencies.report.write({ job, profile }));
      await step('topics', () => dependencies.topics.write({ job }));
      await step('audit-prepared', () => dependencies.sheets.appendAudit({
        actor: 'telegram', timestamp: new Date().toISOString(), requestId, outcome: 'prepared',
        sourceHash: job.sourceHash ?? '', artifactHash: report.hash ?? '', beforeStatus: previousStatus, afterStatus: previousStatus,
      }));
      await step('tracker-reviewed', async () => {
        await dependencies.sheets.updateTrackerRow(rowNumber, {
          URL: job.url, Company: job.company ?? '', Title: job.title ?? '', Location: job.location ?? '', Report: report.hash ?? '', Status: 'reviewed',
        });
        await dependencies.sheets.verifyTrackerRow(rowNumber, 'reviewed');
        trackerChanged = true;
      });
      await step('audit-reviewed', () => dependencies.sheets.appendAudit({
        actor: 'telegram', timestamp: new Date().toISOString(), requestId, outcome: 'reviewed',
        sourceHash: job.sourceHash ?? '', artifactHash: report.hash ?? '', beforeStatus: previousStatus, afterStatus: 'reviewed',
      }));
      await dependencies.idempotency.markSucceeded(key, requestId);
      return { outcome: 'reviewed', requestId };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'job processing failed';
      try {
        await dependencies.sheets.appendAudit({
          actor: 'telegram', timestamp: new Date().toISOString(), requestId, outcome: 'failure', error: message.slice(0, 200),
          sourceHash: '', artifactHash: '', beforeStatus: previousStatus, afterStatus: previousStatus,
        });
        if (trackerChanged && rowNumber >= 0) {
          await dependencies.sheets.updateTrackerRow(rowNumber, { Status: previousStatus });
          await dependencies.sheets.verifyTrackerRow(rowNumber, previousStatus);
        }
      } finally {
        await dependencies.idempotency.markFailed(key, requestId, message);
        const alert = typeof context === 'function' ? context : (context.alert ?? dependencies.alert);
        await alert(`Job review failed for request ${requestId}; no automatic retry was attempted.`);
      }
      return { outcome: 'failed', requestId, error: message };
    }
  }
}
