import assert from 'node:assert/strict';
import test from 'node:test';

import { authorizeTelegramUpdate, deriveTelegramRequest, parseIntakeCommand } from '../src/channels/telegram-auth.ts';
import { CareerCopilotTelegramAdapter } from '../src/channels/telegram-ingress.ts';

const allowlist = { userIds: new Set(['12345']), privateChatIds: new Set(['67890']) };
const message = (overrides: Record<string, unknown> = {}) => ({
  message_id: 9, date: 1_700_000_000,
  from: { id: 12345, is_bot: false, first_name: 'Owner' },
  chat: { id: 67890, type: 'private' },
  text: '/save https://linkedin.com/jobs/view/123',
  ...overrides,
});

test('parses only /save URL as active and /job as parked', () => {
  assert.deepEqual(parseIntakeCommand('/save https://linkedin.com/jobs/view/123'), { kind: 'save_job', url: 'https://linkedin.com/jobs/view/123' });
  assert.deepEqual(parseIntakeCommand('/job https://linkedin.com/jobs/view/123'), { kind: 'parked_job' });
  assert.deepEqual(parseIntakeCommand('/job'), { kind: 'parked_job' });
  assert.equal(parseIntakeCommand('/save'), null);
  assert.equal(parseIntakeCommand('/save https://linkedin.com/jobs/view/123 extra'), null);
  assert.equal(parseIntakeCommand('/status'), null);
});

test('derives Telegram message safety state before any work', () => {
  const request = deriveTelegramRequest({ update_id: 42, message: message() });
  assert.equal(request.userId, '12345');
  assert.equal(request.chatId, '67890');
  assert.equal(request.isPrivateChat, true);
  assert.equal(request.requestId, 'telegram:42:9');
});

test('rejects unsafe updates without retaining message contents', async () => {
  const audit: Array<Record<string, unknown>> = [];
  const result = await authorizeTelegramUpdate(
    { update_id: 42, edited_message: message({ edit_date: 1_700_000_001, text: '/save SECRET' }) },
    allowlist,
    { append: async (entry) => audit.push(entry) },
  );
  assert.equal(result.accepted, false);
  assert.equal(JSON.stringify(audit).includes('SECRET'), false);
});

test('adapter validates malformed updates before invoking its handler', async () => {
  let calls = 0;
  class TestAdapter extends CareerCopilotTelegramAdapter {
    dispatch(update: never) { this.processUpdate(update); }
  }
  const adapter = new TestAdapter({ botToken: 'test-token', allowedUserIds: ['12345'] }, async () => { calls += 1; });
  assert.doesNotThrow(() => adapter.dispatch({ update_id: 1, message: { ...message(), chat: null } } as never));
  assert.equal(calls, 0);
});

test('accepts supported /save and parks /job without URL work', async () => {
  const audit = { append: async () => {} };
  const save = await authorizeTelegramUpdate({ update_id: 43, message: message() }, allowlist, audit);
  const parked = await authorizeTelegramUpdate({ update_id: 44, message: message({ text: '/job https://example.invalid/secret' }) }, allowlist, audit);
  assert.equal(save.accepted, true);
  assert.equal(save.accepted && save.intent.kind, 'save_job');
  assert.equal(parked.accepted, true);
  assert.equal(parked.accepted && parked.intent.kind, 'parked_job');
});
