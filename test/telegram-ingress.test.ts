import assert from 'node:assert/strict';
import test from 'node:test';

import {
  authorizeTelegramUpdate,
  parseJobCommand,
  deriveTelegramRequest,
} from '../src/telegram-auth.ts';

const allowlist = {
  userIds: new Set(['12345']),
  privateChatIds: new Set(['67890']),
};

const message = (overrides: Record<string, unknown> = {}) => ({
  message_id: 9,
  date: 1_700_000_000,
  from: { id: 12345, is_bot: false, first_name: 'Owner' },
  chat: { id: 67890, type: 'private' },
  text: '/job https://linkedin.com/jobs/view/123',
  ...overrides,
});

test('parses only the exact /job URL command', () => {
  assert.equal(parseJobCommand('/job https://linkedin.com/jobs/view/123'), 'https://linkedin.com/jobs/view/123');
  assert.equal(parseJobCommand('/job'), null);
  assert.equal(parseJobCommand('/job https://linkedin.com/jobs/view/123 extra'), null);
  assert.equal(parseJobCommand('/jobs https://linkedin.com/jobs/view/123'), null);
});

test('derives Telegram message safety state before any work', () => {
  const request = deriveTelegramRequest({ update_id: 42, message: message() });
  assert.equal(request.userId, '12345');
  assert.equal(request.chatId, '67890');
  assert.equal(request.isPrivateChat, true);
  assert.equal(request.isEdited, false);
  assert.equal(request.isForwarded, false);
  assert.equal(request.requestId, 'telegram:42:9');
});

test('rejects unsafe updates and audits metadata without message contents', async () => {
  const audit: Array<Record<string, unknown>> = [];
  const result = await authorizeTelegramUpdate(
    { update_id: 42, edited_message: message({ edit_date: 1_700_000_001, text: '/job SECRET' }) },
    allowlist,
    { append: async (entry) => audit.push(entry) },
  );

  assert.equal(result.accepted, false);
  assert.equal(audit.length, 1);
  assert.equal(audit[0].reason, 'edited_message');
  assert.equal(JSON.stringify(audit[0]).includes('SECRET'), false);
});

test('rejects unsupported URLs before accepting the request', async () => {
  const audit: Array<Record<string, unknown>> = [];
  const result = await authorizeTelegramUpdate(
    { update_id: 44, message: message({ text: '/job https://example.com/jobs/1' }) },
    allowlist,
    { append: async (entry) => audit.push(entry) },
  );

  assert.equal(result.accepted, false);
  assert.equal(audit[0].reason, 'unsupported_job_url');
});

test('fails closed when a rejected request cannot be audited', async () => {
  await assert.rejects(
    authorizeTelegramUpdate(
      { update_id: 43, message: message({ from: { id: 999, is_bot: false, first_name: 'Other' } }) },
      allowlist,
      { append: async () => { throw new Error('audit unavailable'); } },
    ),
    /audit unavailable/,
  );
});
