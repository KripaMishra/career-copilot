import { TelegramAdapter, type TelegramAdapterConfig } from '@chat-adapter/telegram';
import { assertRawTelegramUpdate, type TelegramUpdate } from './telegram-auth.ts';

export type TelegramIngressService = {
  process(update: TelegramUpdate, reply?: (text: string) => Promise<void>): Promise<unknown>;
};
export type TelegramUpdateHandler = (update: TelegramUpdate, reply: (text: string) => Promise<void>) => Promise<void>;

export function createTelegramIngress(options: { service: TelegramIngressService }) {
  return {
    async handle(raw: unknown, reply: (text: string) => Promise<void> = async () => {}) {
      try { assertRawTelegramUpdate(raw); }
      catch { return { outcome: 'rejected' as const, reason: 'invalid_update' }; }
      return options.service.process(raw, reply);
    },
  };
}

export class CareerCopilotTelegramAdapter extends TelegramAdapter {
  private readonly handleUpdate: TelegramUpdateHandler;

  constructor(config: TelegramAdapterConfig, handleUpdate: TelegramUpdateHandler) {
    super(config);
    this.handleUpdate = handleUpdate;
  }

  protected processUpdate(update: TelegramUpdate, _options?: unknown): void {
    try { assertRawTelegramUpdate(update); }
    catch { return; }
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    const reply = async (text: string) => {
      if (!message?.chat || !Number.isSafeInteger(message.chat.id)) return;
      await this.postMessage(this.encodeThreadId({ chatId: String(message.chat.id) }), text);
    };
    void this.handleUpdate(update, reply);
  }
}
