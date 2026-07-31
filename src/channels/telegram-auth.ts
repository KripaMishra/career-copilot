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
    !request.isForwarded &&
    !request.isReplay
  );
}
