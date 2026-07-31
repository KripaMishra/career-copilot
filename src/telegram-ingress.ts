import { TelegramAdapter, type TelegramAdapterConfig } from '@chat-adapter/telegram';
import type { TelegramUpdate } from './telegram-auth.ts';

export type TelegramIngressService = {
  process(update: TelegramUpdate, context?: unknown): Promise<unknown>;
};
export type TelegramUpdateHandler = (update: TelegramUpdate, reply: (text: string) => Promise<void>) => Promise<void>;

function assertRawTelegramUpdate(value: unknown): asserts value is TelegramUpdate {
  if (!value || typeof value !== 'object' || !Number.isInteger((value as { update_id?: unknown }).update_id)) {
    throw new Error('Invalid Telegram update.');
  }
}

export function createTelegramIngress(options: { service: TelegramIngressService }) {
  return {
    async handle(raw: unknown, reply: (text: string) => Promise<void> = async () => {}) {
      assertRawTelegramUpdate(raw);
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
    const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    const reply = async (text: string) => {
      if (!message) return;
      await this.postMessage(this.encodeThreadId({ chatId: String(message.chat.id) }), text);
    };
    void this.handleUpdate(update, reply);
  }
}
