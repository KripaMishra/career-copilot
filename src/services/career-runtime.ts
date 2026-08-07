import { randomUUID } from 'node:crypto';
import { assertRawTelegramUpdate, deriveTelegramRequest } from '../channels/telegram-auth.ts';
import { assertJobUrl } from '../tools/job-url.ts';
import { CareerStore } from '../storage/career-store.ts';
import type { Job, JobInput } from '../contracts/v0.ts';

type Command = { kind: 'save'; url: string } | { kind: 'job'; jobId?: string } | { kind: 'queue' };
export function parseCommand(text: string | undefined): Command | null { if (!text) return null; const save = text.match(/^\/save[ \t]+(\S+)$/); if (save) return { kind: 'save', url: save[1] }; const job = text.match(/^\/job(?:[ \t]+(\S+))?$/); if (job) return { kind: 'job', ...(job[1] ? { jobId: job[1] } : {}) }; if (text === '/queue') return { kind: 'queue' }; return null; }
export type RuntimeOptions = { ownerId: string; ownerEnabled?: boolean; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string>; databaseUrl?: string; reportsRoot?: string; store?: CareerStore; processor?: (job: Job) => Promise<unknown>; maxAttempts?: number };
export type TelegramResult = { outcome: 'rejected'; reason: string } | { outcome: 'accepted'; command: string; jobId?: string; duplicate?: boolean };
type RecoveryReply = (text: string, chatId?: string) => Promise<void>;
type Work = { job: Job; reply: (text: string) => Promise<void>; recovery: boolean };

export function createCareerCopilotRuntime(options: RuntimeOptions) {
  const databaseUrl = options.databaseUrl ?? `file:/tmp/career-copilot-${process.pid}.db`;
  const store = options.store ?? new CareerStore(databaseUrl);
  const maxAttempts = options.maxAttempts ?? 2;
  const seenUpdates = new Set<number>();
  const pending: Work[] = [];
  const queued = new Set<string>();
  let activeJobId: string | null = null;
  let drainPromise: Promise<void> | null = null;
  let recoveryPromise: Promise<void> | null = null;
  const authorized = (userId: string, chatId: string, privateChat: boolean) => (options.ownerEnabled ?? true) && privateChat && options.allowedUserIds.has(userId) && options.privateChatIds.has(chatId);

  const processOne = async ({ job, reply, recovery }: Work) => {
    if (job.attempts >= maxAttempts) { store.fail(job.jobId, new Error('Automatic retry limit reached; use /job for recovery.')); return; }
    activeJobId = job.jobId;
    try {
      const running = store.markRunning(job.jobId, job.mastraRunId ?? randomUUID()) ?? job;
      const result = options.processor ? await options.processor(running) : undefined;
      if (result && typeof result === 'object' && 'status' in result && (result as { status?: unknown }).status !== 'success') throw new Error(`Workflow ended with status ${(result as { status: unknown }).status}.`);
      const done = store.get(job.jobId);
      if (done?.status === 'running') throw new Error('Workflow did not complete.');
      if (!recovery && done?.status === 'succeeded' && !done.notifiedAt) { await reply(done.safeResult?.summary ?? 'Job completed.'); store.markNotified(job.jobId); }
    } catch (error) {
      if (store.get(job.jobId)?.status !== 'succeeded') { store.fail(job.jobId, error); return; }
      if (!recovery) throw error;
    } finally { activeJobId = null; }
  };

  const drain = async () => {
    let recoveryError: unknown;
    while (pending.length) {
      const work = pending.shift()!; queued.delete(work.job.jobId);
      try { await processOne(work); } catch (error) { if (work.recovery && recoveryError === undefined) recoveryError = error; }
    }
    if (recoveryError !== undefined) throw recoveryError;
  };
  const ensureDrain = () => {
    if (!drainPromise) drainPromise = drain().finally(() => { drainPromise = null; if (pending.length) void ensureDrain().catch(() => undefined); });
    return drainPromise;
  };
  const schedule = (work: Work) => {
    if (queued.has(work.job.jobId) || activeJobId === work.job.jobId) return false;
    queued.add(work.job.jobId); pending.push(work); void ensureDrain().catch(() => undefined); return true;
  };
  const reauthorized = (job: Job) => (options.ownerEnabled ?? true) && job.ownerId === options.ownerId && job.userId !== null
    && options.allowedUserIds.has(job.userId) && options.privateChatIds.has(job.chatId);

  const handleTelegramUpdate = async (raw: unknown, reply: (text: string) => Promise<void> = async () => {}): Promise<TelegramResult> => {
    try { assertRawTelegramUpdate(raw); } catch { return { outcome: 'rejected', reason: 'invalid_update' }; }
    const message = raw.message ?? raw.edited_message ?? raw.channel_post ?? raw.edited_channel_post;
    const request = deriveTelegramRequest(raw); const command = parseCommand(message?.text);
    if (!authorized(request.userId, request.chatId, request.isPrivateChat) || request.isBot || request.isEdited || request.isForwarded) return { outcome: 'rejected', reason: 'unauthorized' };
    if (seenUpdates.has(raw.update_id)) return { outcome: 'rejected', reason: 'replayed_update' };
    if (!command) { seenUpdates.add(raw.update_id); return { outcome: 'rejected', reason: 'invalid_command' }; }
    const owned = (job: Job) => job.ownerId === options.ownerId && job.chatId === request.chatId;
    if (command.kind === 'save') {
      let url: URL; try { url = assertJobUrl(command.url); } catch { return { outcome: 'rejected', reason: 'unsupported_job_url' }; }
      const input: JobInput = { jobId: randomUUID(), userId: request.userId, ownerId: options.ownerId, chatId: request.chatId, transportEventId: String(raw.update_id), originalUrl: command.url, canonicalUrl: url.href };
      const stored = store.enqueue(input); if (!stored.duplicate) schedule({ job: stored.job, reply, recovery: false }); await reply(stored.duplicate ? `Job ${stored.job.jobId} is already queued.` : `Accepted job ${stored.job.jobId}.`); seenUpdates.add(raw.update_id);
      return { outcome: 'accepted', command: 'save', jobId: stored.job.jobId, duplicate: stored.duplicate };
    }
    if (command.kind === 'queue') { const jobs = store.list().filter(owned); await reply(jobs.length ? jobs.map((job) => `${job.jobId}: ${job.status}`).join('\n') : 'Queue is empty.'); seenUpdates.add(raw.update_id); return { outcome: 'accepted', command: 'queue' }; }
    const job = (command.jobId ? store.get(command.jobId) : store.list().find(owned)) ?? null;
    if (job && !owned(job)) { await reply('No jobs found.'); seenUpdates.add(raw.update_id); return { outcome: 'accepted', command: 'job' }; }
    await reply(job ? `${job.jobId}: ${job.status}${job.safeError ? ` — ${job.safeError}` : ''}${job.safeResult?.summary ? ` — ${job.safeResult.summary}` : ''}` : 'No jobs found.'); seenUpdates.add(raw.update_id);
    return { outcome: 'accepted', command: 'job', ...(job ? { jobId: job.jobId } : {}) };
  };

  const recoverUnfinished = async (reply: RecoveryReply, settings: { notify?: boolean } = {}) => {
    if (recoveryPromise) return recoveryPromise;
    const notify = settings.notify ?? true;
    recoveryPromise = (async () => {
      for (const job of store.unfinished()) if (reauthorized(job)) schedule({ job, reply: (text) => reply(text, job.chatId), recovery: true });
      await ensureDrain();
      if (!notify) return;
      for (const job of store.list('succeeded')) if (!job.notifiedAt && reauthorized(job)) {
        try { await reply(job.safeResult?.summary ?? 'Job completed.', job.chatId); store.markNotified(job.jobId); } catch { /* best effort; leave notifiedAt null */ }
      }
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  };
  return { store, handleTelegramUpdate, recoverUnfinished, health: () => ({ configurationValid: Boolean(options.ownerId) && (options.ownerEnabled ?? true), databaseOpen: true, processorRunning: activeJobId !== null }), close: () => { if (!options.store) store.close(); } };
}
