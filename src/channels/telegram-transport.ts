import type { AppLogger } from '../observability.ts';
import type { TelegramUpdate } from './telegram-auth.ts';

type TelegramResponse<T> = { ok: boolean; result: T };
type Reply = (text: string) => Promise<void>;

/** Injectable authenticated file download (spec D7): production uses the
 * Telegram impl; tests inject fixtures — no live network. */
export type TelegramFileDownload = (fileId: string, options?: { maxBytes?: number; signal?: AbortSignal }) => Promise<{ bytes: Uint8Array; byteSize: number }>;

export class DownloadLimitExceededError extends Error { readonly byteSize: number; constructor(byteSize: number) { super('Telegram file download exceeds the byte cap.'); this.byteSize = byteSize; } }

/** Authenticated Telegram file download (getFile → GET file path), bounded by
 * maxBytes. Standalone so the runtime can use it before the polling transport
 * exists; the transport reuses it. */
export function createTelegramFileDownloader(token: string, logger?: AppLogger): TelegramFileDownload {
  const log: AppLogger = (level, event, data) => { try { logger?.(level, event, data); } catch { /* logging cannot stop downloads */ } };
  const call = async <T>(method: string, body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<T> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw Object.assign(new Error('Telegram API request failed.'), { status: response.status });
    const result = await response.json() as TelegramResponse<T>; if (!result.ok) throw new Error('Telegram API request failed.'); return result.result;
  };
  return async (fileId, options = {}) => {
    const maxBytes = options.maxBytes ?? 5 * 1024 * 1024;
    const started = Date.now(); log('info', 'telegram.download.started', {});
    try {
      const meta = await call<{ file_path: string }>('getFile', { file_id: fileId }, options.signal ?? AbortSignal.timeout(15_000));
      const url = `https://api.telegram.org/file/bot${token}/${meta.file_path}`;
      const response = await fetch(url, { signal: options.signal ?? AbortSignal.timeout(30_000) });
      if (!response.ok) throw Object.assign(new Error('Telegram file download failed.'), { status: response.status });
      const declared = response.headers.get('content-length');
      if (declared !== null && Number(declared) > maxBytes) throw new DownloadLimitExceededError(Number(declared));
      // stream incrementally and abort as soon as the cap is exceeded, so a
      // chunked/no-content-length response can never be buffered unboundedly.
      // A bodyless response is rejected rather than buffered whole via
      // arrayBuffer(), which would bypass the maxBytes memory bound.
      const reader = response.body?.getReader();
      if (!reader) throw new Error('Telegram file download failed: response has no body.');
      const chunks: Uint8Array[] = [];
      let received = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) {
          received += value.byteLength;
          if (received > maxBytes) { await reader.cancel().catch(() => {}); throw new DownloadLimitExceededError(received); }
          chunks.push(value);
        }
      }
      const buffer = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) { buffer.set(chunk, offset); offset += chunk.byteLength; }
      log('info', 'telegram.download.succeeded', { byteSize: buffer.byteLength, durationMs: Date.now() - started });
      return { bytes: buffer, byteSize: buffer.byteLength };
    } catch (error) {
      log('error', 'telegram.download.failed', { durationMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' });
      throw error;
    }
  };
}

export const TELEGRAM_COMMANDS = [
  { command: 'save', description: 'Save a job URL' },
  { command: 'job', description: 'Show a job status' },
  { command: 'queue', description: 'List saved jobs' },
  { command: 'onboarding', description: 'Start or resume onboarding' },
  { command: 'onboarding_status', description: 'Show onboarding status' },
  { command: 'onboarding_restart', description: 'Restart onboarding draft' },
  { command: 'onboarding_cancel', description: 'Cancel onboarding draft' },
  { command: 'reset_onboarding', description: 'Clear onboarding draft' },
  { command: 'reset_profile', description: 'Clear profile and drafts' },
  { command: 'reset_all', description: 'Clear saved jobs, reports, profile, and onboarding drafts' },
] as const;

export function createTelegramPollingTransport(token: string, handle: (update: unknown, reply: Reply) => Promise<unknown>, logger?: AppLogger) {
  let stopped = false; let offset = 0; let pollController: AbortController | null = null; let commandController: AbortController | null = null; let commandsRegistered = false;
  const log: AppLogger = (level, event, data) => { try { logger?.(level, event, data); } catch { /* logging cannot stop polling */ } };
  const call = async <T>(method: string, body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<T> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw Object.assign(new Error('Telegram API request failed.'), { status: response.status });
    const result = await response.json() as TelegramResponse<T>; if (!result.ok) throw new Error('Telegram API request failed.'); return result.result;
  };
  const downloadFile = createTelegramFileDownloader(token, logger);
  const sendMessage = async (chatId: string, text: string, data: Record<string, unknown> = {}) => {
    const started = Date.now(); const characters = Array.from(text); const chunkCount = Math.max(1, Math.ceil(characters.length / 4096));
    log('info', 'telegram.reply.started', { ...data, chunkCount });
    try {
      for (let start = 0; start < characters.length; start += 4096) await call('sendMessage', { chat_id: chatId, text: characters.slice(start, start + 4096).join('') });
      log('info', 'telegram.reply.sent', { ...data, chunkCount, durationMs: Date.now() - started });
    } catch (error) { log('error', 'telegram.reply.failed', { ...data, chunkCount, durationMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' }); throw error; }
  };
  const registerCommands = async () => {
    if (commandsRegistered || !token || stopped) return;
    commandController = new AbortController();
    try {
      await call('setMyCommands', { commands: TELEGRAM_COMMANDS }, AbortSignal.any([commandController.signal, AbortSignal.timeout(15_000)]));
      commandsRegistered = true;
      log('info', 'telegram.commands.registered', { commandCount: TELEGRAM_COMMANDS.length });
    } catch (error) {
      if (!stopped) log('error', 'telegram.commands.registration.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
    } finally { commandController = null; }
  };
  const start = async () => {
    if (!token) return;
    await registerCommands();
    if (stopped) return;
    log('info', 'telegram.poll.started');
    while (!stopped) {
      try {
        const controller = new AbortController(); pollController = controller;
        let updates: TelegramUpdate[];
        try { updates = await call<TelegramUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])); }
        finally { if (pollController === controller) pollController = null; }
        for (const update of updates) {
          log('info', 'telegram.update.received', { updateId: update.update_id });
          const message = update.message; const reply = async (text: string) => { if (message) await sendMessage(String(message.chat.id), text, { updateId: update.update_id }); }; const result = await handle(update, reply);
          const outcome = result && typeof result === 'object' && 'outcome' in result ? String((result as { outcome: unknown }).outcome) : 'handled';
          const reason = result && typeof result === 'object' && 'reason' in result ? String((result as { reason: unknown }).reason) : undefined;
          const jobId = result && typeof result === 'object' && 'jobId' in result ? String((result as { jobId: unknown }).jobId) : undefined;
          log(outcome === 'rejected' ? 'warn' : 'info', 'telegram.update.handled', { updateId: update.update_id, outcome, ...(reason ? { reason } : {}), ...(jobId ? { jobId } : {}) });
          offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error) {
        if (stopped) break;
        const status = Number((error as { status?: unknown })?.status); log('error', 'telegram.poll.failed', { errorName: error instanceof Error ? error.name : 'UnknownError', ...(Number.isFinite(status) ? { status } : {}) });
        await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    log('info', 'telegram.poll.stopped');
  };
  return { start, sendMessage, stop: () => { stopped = true; commandController?.abort(); pollController?.abort(); }, downloadFile };
}
