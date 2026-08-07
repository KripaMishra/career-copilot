import type { TelegramUpdate } from './telegram-auth.ts';

type TelegramResponse<T> = { ok: boolean; result: T };
type Reply = (text: string) => Promise<void>;
type Observe = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void;
export function createTelegramPollingTransport(token: string, handle: (update: unknown, reply: Reply) => Promise<unknown>, observer?: Observe) {
  let stopped = false; let offset = 0; let pollController: AbortController | null = null;
  const observe: Observe = (level, event, data) => { try { observer?.(level, event, data); } catch { /* observability cannot stop polling */ } };
  const call = async <T>(method: string, body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<T> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw Object.assign(new Error('Telegram API request failed.'), { status: response.status });
    const result = await response.json() as TelegramResponse<T>; if (!result.ok) throw new Error('Telegram API request failed.'); return result.result;
  };
  const sendMessage = async (chatId: string, text: string) => { await call('sendMessage', { chat_id: chatId, text }); };
  const start = async () => {
    if (!token) return;
    observe('info', 'telegram.poll.started');
    while (!stopped) {
      try {
        const controller = new AbortController(); pollController = controller;
        let updates: TelegramUpdate[];
        try { updates = await call<TelegramUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])); }
        finally { if (pollController === controller) pollController = null; }
        for (const update of updates) {
          observe('info', 'telegram.update.received', { updateId: update.update_id });
          const message = update.message; const reply = async (text: string) => { if (message) await sendMessage(String(message.chat.id), text); }; const result = await handle(update, reply);
          const outcome = result && typeof result === 'object' && 'outcome' in result ? String((result as { outcome: unknown }).outcome) : 'handled';
          const reason = result && typeof result === 'object' && 'reason' in result ? String((result as { reason: unknown }).reason) : undefined;
          const jobId = result && typeof result === 'object' && 'jobId' in result ? String((result as { jobId: unknown }).jobId) : undefined;
          observe(outcome === 'rejected' ? 'warn' : 'info', 'telegram.update.handled', { updateId: update.update_id, outcome, ...(reason ? { reason } : {}), ...(jobId ? { jobId } : {}) });
          offset = Math.max(offset, update.update_id + 1);
        }
      } catch (error) {
        const status = Number((error as { status?: unknown })?.status); observe('error', 'telegram.poll.failed', { errorName: error instanceof Error ? error.name : 'UnknownError', ...(Number.isFinite(status) ? { status } : {}) });
        if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1_000));
      }
    }
    observe('info', 'telegram.poll.stopped');
  };
  return { start, sendMessage, stop: () => { stopped = true; pollController?.abort(); } };
}
