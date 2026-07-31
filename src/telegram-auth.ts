import { assertJobUrl } from './job-url.ts';

export type TelegramAllowlist = {
  userIds: ReadonlySet<string>;
  privateChatIds: ReadonlySet<string>;
};

export type TelegramRequest = {
  userId: string;
  chatId: string;
  isPrivateChat: boolean;
  isForwarded: boolean;
  isReplay: boolean;
  isEdited?: boolean;
  isBot?: boolean;
  requestId?: string;
  updateId?: number;
  messageId?: number;
};

type TelegramUser = { id: number; is_bot?: boolean };
type TelegramChat = { id: number; type: string };
type TelegramMessage = {
  message_id: number;
  date: number;
  chat: TelegramChat;
  from?: TelegramUser;
  text?: string;
  edit_date?: number;
  forward_origin?: unknown;
  forward_from?: unknown;
  forward_from_chat?: unknown;
  forward_date?: number;
  via_bot?: unknown;
  sender_chat?: unknown;
};

export type TelegramUpdate = {
  update_id: number;
  message?: TelegramMessage;
  edited_message?: TelegramMessage;
  channel_post?: TelegramMessage;
  edited_channel_post?: TelegramMessage;
};

export type TelegramRejectionAuditEntry = {
  kind: 'telegram_rejection';
  requestId: string;
  updateId: number;
  messageId?: number;
  userId?: string;
  chatId?: string;
  reason: string;
  actor: string;
  sourceHash: string;
  artifactHash: string;
  beforeStatus: string;
  afterStatus: string;
  timestamp: string;
};

export type TelegramAuditWriter = {
  append(entry: Record<string, unknown>): Promise<void>;
};

export function parseNumericIdList(value: string | undefined) {
  if (!value?.trim()) {
    return new Set<string>();
  }

  return new Set(
    value.split(',').map((id) => {
      const normalizedId = id.trim();

      if (!/^\d+$/.test(normalizedId)) {
        throw new Error('Telegram allowlist IDs must be numeric.');
      }

      return normalizedId;
    }),
  );
}

export function isAllowedTelegramRequest(request: TelegramRequest, allowlist: TelegramAllowlist) {
  return (
    allowlist.userIds.size > 0 &&
    allowlist.privateChatIds.size > 0 &&
    allowlist.userIds.has(request.userId) &&
    allowlist.privateChatIds.has(request.chatId) &&
    request.isPrivateChat &&
    !request.isBot &&
    !request.isEdited &&
    !request.isForwarded &&
    !request.isReplay
  );
}

export function parseJobCommand(text: string | undefined): string | null {
  const match = text?.match(/^\/job[ \t]+(\S+)$/);
  return match?.[1] ?? null;
}

export function deriveTelegramRequest(
  update: TelegramUpdate,
  options: { seenUpdateIds?: ReadonlySet<number> } = {},
): TelegramRequest {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  const userId = message?.from?.id === undefined ? '' : String(message.from.id);
  const chatId = message?.chat?.id === undefined ? '' : String(message.chat.id);
  const isEdited = Boolean(update.edited_message || update.edited_channel_post || message?.edit_date);
  const isForwarded = Boolean(
    message?.forward_origin ||
      message?.forward_from ||
      message?.forward_from_chat ||
      message?.forward_date ||
      message?.via_bot ||
      message?.sender_chat,
  );

  return {
    userId,
    chatId,
    isPrivateChat: message?.chat?.type === 'private',
    isEdited,
    isBot: message?.from?.is_bot === true,
    isForwarded,
    isReplay: options.seenUpdateIds?.has(update.update_id) ?? false,
    requestId: `telegram:${update.update_id}:${message?.message_id ?? 'unknown'}`,
    updateId: update.update_id,
    messageId: message?.message_id ?? 0,
  };
}

function rejectionReason(request: TelegramRequest, update: TelegramUpdate, allowlist: TelegramAllowlist) {
  if (update.edited_message || update.edited_channel_post || request.isEdited) return 'edited_message';
  if (request.isReplay) return 'replayed_update';
  if (request.isForwarded) return 'forwarded_message';
  if (request.isBot) return 'bot_sender';
  if (!request.isPrivateChat) return 'non_private_chat';
  if (!allowlist.userIds.has(request.userId)) return 'unauthorized_user';
  if (!allowlist.privateChatIds.has(request.chatId)) return 'unauthorized_chat';
  if (!request.userId || !request.chatId) return 'missing_sender';
  const url = parseJobCommand((update.message ?? update.edited_message)?.text);
  if (!url) return 'invalid_command';
  try {
    assertJobUrl(url);
  } catch {
    return 'unsupported_job_url';
  }
  return 'unauthorized_request';
}

export async function authorizeTelegramUpdate(
  update: TelegramUpdate,
  allowlist: TelegramAllowlist,
  audit: TelegramAuditWriter,
  options: { seenUpdateIds?: ReadonlySet<number>; now?: () => Date } = {},
): Promise<{ accepted: true; request: TelegramRequest; url: string } | { accepted: false; request: TelegramRequest; reason: string }> {
  const request = deriveTelegramRequest(update, options);
  const url = parseJobCommand((update.message ?? update.edited_message)?.text);
  const reason = rejectionReason(request, update, allowlist);

  if (reason !== 'unauthorized_request' || !url || !isAllowedTelegramRequest(request, allowlist)) {
    const entry: TelegramRejectionAuditEntry = {
      kind: 'telegram_rejection',
      requestId: request.requestId ?? `telegram:${update.update_id}:unknown`,
      updateId: request.updateId ?? update.update_id,
      ...(request.messageId ? { messageId: request.messageId } : {}),
      ...(request.userId ? { userId: request.userId } : {}),
      ...(request.chatId ? { chatId: request.chatId } : {}),
      reason,
      actor: 'telegram',
      sourceHash: '',
      artifactHash: '',
      beforeStatus: '',
      afterStatus: '',
      timestamp: (options.now ?? (() => new Date()))().toISOString(),
    };
    await audit.append(entry);
    return { accepted: false, request, reason };
  }

  return { accepted: true, request, url };
}
