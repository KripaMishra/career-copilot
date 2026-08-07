import type { TelegramUpdate } from './telegram-auth.ts';

type TelegramResponse<T> = { ok: boolean; result: T };
type Reply = (text: string) => Promise<void>;
export function createTelegramPollingTransport(token: string, handle: (update: unknown, reply: Reply) => Promise<unknown>) {
  let stopped = false; let offset = 0; let pollController: AbortController | null = null;
  const call = async <T>(method: string, body: Record<string, unknown> = {}, signal: AbortSignal = AbortSignal.timeout(15_000)): Promise<T> => {
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
    if (!response.ok) throw new Error(`Telegram API request failed (${response.status}).`);
    const result = await response.json() as TelegramResponse<T>; if (!result.ok) throw new Error('Telegram API request failed.'); return result.result;
  };
  const sendMessage = async (chatId: string, text: string) => { await call('sendMessage', { chat_id: chatId, text }); };
  const start = async () => {
    if (!token) return;
    while (!stopped) {
      try {
        const controller = new AbortController(); pollController = controller;
        let updates: TelegramUpdate[];
        try { updates = await call<TelegramUpdate[]>('getUpdates', { offset, timeout: 25, allowed_updates: ['message'] }, AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])); }
        finally { if (pollController === controller) pollController = null; }
        for (const update of updates) { const message = update.message; const reply = async (text: string) => { if (message) await sendMessage(String(message.chat.id), text); }; await handle(update, reply); offset = Math.max(offset, update.update_id + 1); }
      } catch { if (!stopped) await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    }
  };
  return { start, sendMessage, stop: () => { stopped = true; pollController?.abort(); } };
}
