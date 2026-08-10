import type { AppLogger } from '../observability.ts';
import type { TelegramUpdate } from './telegram-auth.ts';

type TelegramResponse<T> = { ok: boolean; result: T };
type Reply = (text: string) => Promise<void>;
export function createTelegramPollingTransport(token: string, handle: (update: unknown, reply: Reply) => Promise<unknown>, logger?: AppLogger) {
  let stopped = false; let offset = 0; let pollController: AbortController | null = null;
  const log: AppLogger = (level, event, data) => { try { logger?.(level, event, data); } catch { /* logging cannot stop polling */ } };
  const call = async <T>(method: string, body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<T> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw Object.assign(new Error('Telegram API request failed.'), { status: response.status });
    const result = await response.json() as TelegramResponse<T>; if (!result.ok) throw new Error('Telegram API request failed.'); return result.result;
  };
  const sendMessage = async (chatId: string, text: string, data: Record<string, unknown> = {}) => {
    const started = Date.now(); const characters = Array.from(text); const chunkCount = Math.max(1, Math.ceil(characters.length / 4096));
    log('info', 'telegram.reply.started', { ...data, chunkCount });
    try {
      for (let start = 0; start < characters.length; start += 4096) await call('sendMessage', { chat_id: chatId, text: characters.slice(start, start + 4096).join('') });
      log('info', 'telegram.reply.sent', { ...data, chunkCount, durationMs: Date.now() - started });
    } catch (error) { log('error', 'telegram.reply.failed', { ...data, chunkCount, durationMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' }); throw error; }
  };
  const start = async () => {
    if (!token) return;
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
  return { start, sendMessage, stop: () => { stopped = true; pollController?.abort(); } };
}
