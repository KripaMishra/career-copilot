import assert from 'node:assert/strict';
import test from 'node:test';

import { OwnerAuthorization, isAllowedTelegramRequest, parseNumericIdList } from '../src/channels/telegram-auth.ts';

const configured = {
  resourceId: 'owner-v0', enabled: true, authorizationRevision: 7,
  telegram: { userIds: new Set(['12345']), privateChatIds: new Set(['67890']) },
  studioEnabled: true, stdioEnabled: true,
};
const authorization = () => new OwnerAuthorization(() => configured);

test('configured owner context is available while intake authorization is disabled', () => {
  const auth = new OwnerAuthorization(() => ({ ...configured, enabled: false }));
  assert.deepEqual(auth.configuredOwnerContext(), { resourceId: configured.resourceId, authorizationRevision: 7 });
  assert.throws(() => auth.authorize({ channel: 'telegram', userId: '12345', chatId: '67890', privateChat: true }), /revoked/i);
});

test('P4-telegram-user-and-private-chat', () => {
  const auth = authorization();
  const binding = auth.authorize({ channel: 'telegram', userId: '12345', chatId: '67890', privateChat: true });
  assert.equal(binding.resourceId, 'owner-v0');
  assert.equal(binding.threadId, 'telegram:67890');
  for (const principal of [
    { channel: 'telegram' as const, userId: 'other', chatId: '67890', privateChat: true },
    { channel: 'telegram' as const, userId: '12345', chatId: 'other', privateChat: true },
    { channel: 'telegram' as const, userId: '12345', chatId: '67890', privateChat: false },
  ]) assert.throws(() => auth.authorize(principal), /unauthorized/i);
});

test('P4-cross-principal-denied', () => {
  const auth = authorization();
  const telegram = auth.authorize({ channel: 'telegram', userId: '12345', chatId: '67890', privateChat: true });
  const studioPrincipal = { channel: 'studio' as const, remoteAddress: '127.0.0.1', conversationId: '67890' };
  assert.equal(auth.authorize(studioPrincipal).resourceId, telegram.resourceId);
  for (const boundary of ['enqueue', 'read', 'resume'] as const) {
    assert.throws(() => auth.reauthorize(telegram, boundary, studioPrincipal), /unauthorized/i);
    assert.throws(() => auth.reauthorize(telegram, boundary), /principal context/i);
  }
  assert.deepEqual(auth.reauthorize(telegram, 'delivery'), telegram);
});

test('revoking the originating Telegram user while retaining the chat blocks delivery and effects', () => {
  let current = configured;
  const auth = new OwnerAuthorization(() => current);
  const binding = auth.authorize({ channel: 'telegram', userId: '12345', chatId: '67890', privateChat: true });
  for (const boundary of ['delivery', 'effect'] as const) {
    assert.deepEqual(auth.reauthorize(binding, boundary), binding);
    assert.throws(() => auth.reauthorize({ ...binding, threadId: 'telegram:other' }, boundary), /revoked|unauthorized/i);
    assert.throws(() => auth.reauthorize({ ...binding, principalKey: 'telegram:12345:other' }, boundary), /revoked|unauthorized/i);
  }
  current = { ...configured, telegram: { ...configured.telegram, userIds: new Set() } };
  for (const boundary of ['delivery', 'effect'] as const) assert.throws(() => auth.reauthorize(binding, boundary), /revoked|unauthorized/i);
});

test('rejects malformed numeric IDs and an empty allowlist', () => {
  assert.throws(() => parseNumericIdList('12345,not-a-number'));
  assert.equal(isAllowedTelegramRequest(
    { userId: '12345', chatId: '67890', isPrivateChat: true, isForwarded: false, isReplay: false },
    { userIds: new Set(), privateChatIds: new Set() },
  ), false);
});

test('P4-studio-ui-loopback-owner', () => {
  const auth = authorization();
  const binding = auth.authorize({ channel: 'studio', remoteAddress: '127.0.0.1', conversationId: 'conversation-1' });
  assert.equal(binding.resourceId, 'owner-v0');
  assert.equal(binding.threadId, 'studio:conversation-1');
  assert.equal(binding.principalKey, 'studio:loopback:conversation-1');
  assert.throws(() => auth.authorize({ channel: 'studio', remoteAddress: '192.0.2.1', conversationId: 'conversation-1' }), /unauthorized/i);
});

test('P4-stdio-configured-local-owner', () => {
  assert.deepEqual(authorization().authorize({ channel: 'stdio' }), {
    resourceId: 'owner-v0', threadId: 'stdio:local', destination: 'stdio:local', channel: 'stdio',
    principalKey: 'stdio:local', authorizationRevision: 7,
  });
});

test('P4-api-disabled-until-authenticated-binding', () => {
  assert.throws(() => authorization().authorize({ channel: 'api', authenticatedIdentity: 'caller', conversationId: 'one' }), /disabled/i);
  const enabled = new OwnerAuthorization(() => ({ ...configured, apiIdentity: 'owner@example.com' }));
  const binding = enabled.authorize({ channel: 'api', authenticatedIdentity: 'owner@example.com', conversationId: 'one' });
  assert.equal(binding.resourceId, 'owner-v0');
  assert.equal(binding.destination, 'api:owner@example.com');
  assert.equal(binding.principalKey, 'api:owner@example.com:one');
  assert.deepEqual(enabled.reauthorize(binding, 'delivery'), binding);
  assert.throws(() => enabled.authorize({ channel: 'api', authenticatedIdentity: 'other@example.com', conversationId: 'one' }), /disabled|unauthorized/i);
  assert.throws(() => enabled.authorize({ channel: 'api', authenticatedIdentity: 'owner@example.com', conversationId: 'bad@conversation' }), /unauthorized/i);
});

test('delivery and effect reauthorization reject every forged non-Telegram correlation', () => {
  const auth = new OwnerAuthorization(() => ({ ...configured, apiIdentity: 'api-owner' }));
  const bindings = [
    auth.authorize({ channel: 'studio', remoteAddress: '127.0.0.1', conversationId: 'conversation-1' }),
    auth.authorize({ channel: 'stdio' }),
    auth.authorize({ channel: 'api', authenticatedIdentity: 'api-owner', conversationId: 'conversation-1' }),
  ];
  for (const boundary of ['delivery', 'effect'] as const) {
    for (const binding of bindings) {
      assert.deepEqual(auth.reauthorize(binding, boundary), binding);
      for (const forged of [
        { ...binding, destination: 'forged' },
        { ...binding, threadId: 'forged' },
        { ...binding, principalKey: `${binding.principalKey}:forged` },
      ]) assert.throws(() => auth.reauthorize(forged, boundary), /destination|unauthorized|revoked/i);
    }
    assert.throws(() => auth.reauthorize({ ...bindings[0], channel: 'unknown' as 'studio' }, boundary), /destination|unauthorized|revoked/i);
  }
});
