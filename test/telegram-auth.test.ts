import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isAllowedTelegramRequest,
  parseNumericIdList,
} from '../src/channels/telegram-auth.ts';

const allowlist = {
  userIds: parseNumericIdList('12345'),
  privateChatIds: parseNumericIdList('67890'),
};

test('accepts only the configured user in the configured private chat', () => {
  assert.equal(
    isAllowedTelegramRequest(
      { userId: '12345', chatId: '67890', isPrivateChat: true, isForwarded: false, isReplay: false },
      allowlist,
    ),
    true,
  );
});

test('rejects unauthorized, non-private, forwarded, and replayed requests', () => {
  for (const request of [
    { userId: '99999', chatId: '67890', isPrivateChat: true, isForwarded: false, isReplay: false },
    { userId: '12345', chatId: '67890', isPrivateChat: false, isForwarded: false, isReplay: false },
    { userId: '12345', chatId: '67890', isPrivateChat: true, isForwarded: true, isReplay: false },
    { userId: '12345', chatId: '67890', isPrivateChat: true, isForwarded: false, isReplay: true },
  ]) {
    assert.equal(isAllowedTelegramRequest(request, allowlist), false);
  }
});

test('rejects malformed numeric IDs and an empty allowlist', () => {
  assert.throws(() => parseNumericIdList('12345,not-a-number'));
  assert.equal(
    isAllowedTelegramRequest(
      { userId: '12345', chatId: '67890', isPrivateChat: true, isForwarded: false, isReplay: false },
      { userIds: new Set(), privateChatIds: new Set() },
    ),
    false,
  );
});
