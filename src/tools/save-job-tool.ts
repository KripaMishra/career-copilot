import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { JobInputSchema, SafeResultSchema, safeErrorMessage, type Analysis, type JobInput } from '../contracts/v0.ts';
import { acquireJobText } from './web-fetch-tool.ts';
import { upsertSheetRow, type SheetAdapter } from '../integrations/google-sheets.ts';
import type { CareerStore } from '../storage/career-store.ts';
import type { AppLogger } from '../observability.ts';

export const SaveJobResultSchema = SafeResultSchema.extend({ jobId: z.string().min(1).max(200) });
export type SaveJobDeps = {
  store: CareerStore;
  sheet: SheetAdapter;
  profileText?: string;
  acquire?: typeof acquireJobText;
  analyze: (text: string, profile: string) => Promise<Analysis>;
  logger?: AppLogger;
};

function transient(error: unknown) { const message = error instanceof Error ? error.message : ''; const code = (error as { code?: unknown })?.code; const status = Number((error as { status?: unknown })?.status); return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code)) || status === 408 || status === 429 || status >= 500 || /timeout|temporarily unavailable|network/i.test(message); }
async function retryTransient<T>(operation: () => Promise<T>, attempts = 3): Promise<T> { for (let attempt = 1; ; attempt++) { try { return await operation(); } catch (error) { if (attempt >= attempts || !transient(error)) throw error; } } }
async function timed<T>(phase: string, data: Record<string, unknown>, logger: AppLogger, operation: () => Promise<T>) {
  const started = Date.now(); logger('info', 'job.phase.started', { ...data, phase });
  try { const result = await operation(); logger('info', 'job.phase.succeeded', { ...data, phase, durationMs: Date.now() - started }); return result; }
  catch (error) { logger('error', 'job.phase.failed', { ...data, phase, durationMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' }); throw error; }
}

export async function executeSaveJob(options: SaveJobDeps & { input: JobInput; profileContext?: string }) {
  const input = JobInputSchema.parse(options.input);
  const log: AppLogger = (level, event, data) => { try { options.logger?.(level, event, data); } catch { /* logging cannot break work */ } };
  const storedProfile = await options.store.profileText(input.ownerId);
  const profile = [storedProfile.trim() ? storedProfile : options.profileText, options.profileContext].filter((value) => value?.trim()).join('\n\n').slice(0, 100_000);
  if (!profile) throw new Error('Profile context is required before saving a job.');
  const stored = await options.store.enqueue(input); log('info', stored.duplicate ? 'job.duplicate' : 'job.queued', { jobId: stored.job.jobId, requestId: input.transportEventId });
  if (!stored.job.userId || stored.job.ownerId !== input.ownerId || stored.job.userId !== input.userId || stored.job.chatId !== input.chatId || stored.job.originalUrl !== input.originalUrl || stored.job.canonicalUrl !== input.canonicalUrl) throw new Error('Persisted job does not match the authorized request.');
  const persistedInput: JobInput = { jobId: stored.job.jobId, userId: stored.job.userId, ownerId: stored.job.ownerId, chatId: stored.job.chatId, transportEventId: stored.job.transportEventId, originalUrl: stored.job.originalUrl, canonicalUrl: stored.job.canonicalUrl };
  if (stored.job.status === 'succeeded' && stored.job.safeResult) return SaveJobResultSchema.parse({ jobId: stored.job.jobId, ...stored.job.safeResult });
  if (stored.job.status === 'failed') throw new Error(stored.job.safeError ?? 'Job processing failed.');
  if (stored.job.attempts >= 2) throw new Error('Automatic retry limit reached; send a new save request.');
  let running = stored.job;
  try {
    running = await options.store.markRunning(persistedInput.jobId, stored.job.mastraRunId ?? randomUUID()) ?? stored.job;
    await options.store.assertRunningInput(persistedInput);
    const eventData = { jobId: persistedInput.jobId, requestId: persistedInput.transportEventId, attempt: running.attempts };
    log('info', stored.duplicate ? 'job.resumed' : 'job.started', eventData);
    const acquired = await timed('fetch', eventData, log, () => retryTransient(() => (options.acquire ?? acquireJobText)(persistedInput.canonicalUrl)));
    const analysis = await timed('analysis', eventData, log, () => retryTransient(() => options.analyze(acquired.text, profile)));
    const content = `# ${analysis.title}\n\nCompany: ${analysis.company}\nLocation: ${analysis.location}\n\n${analysis.summary}\n\nNext step: ${analysis.nextStep}\n`;
    const report = await timed('report', eventData, log, () => options.store.saveReport({ ownerId: persistedInput.ownerId, jobId: persistedInput.jobId, content }));
    const sheetData = { ...eventData, reportId: report.reportId };
    const row = await timed('sheets', sheetData, log, () => upsertSheetRow(options.sheet, { jobId: persistedInput.jobId, status: 'succeeded', title: analysis.title, company: analysis.company, reportPath: report.reportId }));
    const result = SafeResultSchema.parse({ summary: `${analysis.title} at ${analysis.company}: ${analysis.nextStep}`, reportId: report.reportId, reportPath: null, sheetReference: String(row.jobId) });
    await timed('complete', sheetData, log, () => options.store.complete(persistedInput.jobId, result, report.reportId, String(row.jobId)));
    log('info', 'job.succeeded', { ...sheetData, status: 'succeeded' });
    return SaveJobResultSchema.parse({ jobId: persistedInput.jobId, ...result });
  } catch (error) {
    const failed = await options.store.fail(persistedInput.jobId, error); log('error', 'job.failed', { jobId: persistedInput.jobId, requestId: persistedInput.transportEventId, attempt: failed?.attempts ?? running.attempts, status: 'failed', errorName: error instanceof Error ? error.name : 'UnknownError' });
    throw new Error(safeErrorMessage(error));
  }
}
