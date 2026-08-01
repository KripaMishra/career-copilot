import assert from 'node:assert/strict';
import test from 'node:test';

import { CareerCopilotService } from '../src/services/career-copilot.ts';

const update = { update_id: 1, message: {
  message_id: 2, date: 1, from: { id: 123, is_bot: false, first_name: 'Owner' },
  chat: { id: 456, type: 'private' }, text: '/job https://linkedin.com/jobs/1',
} };
const allowlist = { userIds: new Set(['123']), privateChatIds: new Set(['456']) };

function dependencies(events: string[], overrides: Record<string, unknown> = {}) {
  return {
    allowlist,
    audit: { append: async (entry: Record<string, unknown>) => { events.push(`audit:${entry.outcome ?? entry.reason}`); } },
    fetchJob: async () => { events.push('fetch'); return { url: 'https://linkedin.com/jobs/1', company: '', title: '', location: '', description: 'untrusted' }; },
    idempotency: {
      claimRequest: async () => { events.push('claim-request'); return true; },
      claim: async () => { events.push('claim'); return { claimed: true, record: { key: 'url:x', firstRequestId: 'telegram:1:2', sightings: 0 } }; },
      recordSighting: async () => { events.push('sighting'); },
      createOutbox: async () => { events.push('outbox:create'); },
      markOutbox: async (_requestId: string, step: string, state: string) => { events.push(`outbox:${step}:${state}`); },
      markSucceeded: async () => { events.push('state:succeeded'); },
      markFailed: async () => { events.push('state:failed'); },
      getOutbox: async () => [],
    },
    sheets: {
      readTracker: async () => { events.push('read-tracker'); return []; },
      appendTrackerRow: async () => { events.push('create-tracker'); },
      updateTrackerRow: async (_row: number, fields: Record<string, unknown>) => { events.push(`tracker:${fields.Status}`); },
      verifyTrackerRow: async () => { events.push('verify-tracker'); },
      appendTopic: async () => { events.push('topic'); },
      appendAudit: async (entry: Record<string, unknown>) => { events.push(`sheets-audit:${entry.outcome}`); },
    },
    profile: { readApproved: async () => { events.push('profile'); return {}; } },
    report: { write: async () => { events.push('report'); return { hash: 'report-hash' }; } },
    topics: { write: async () => { events.push('topics'); } },
    alert: async () => { events.push('alert'); },
    ...overrides,
  };
}

test('runs accepted jobs in ordered, fail-closed write sequence and leaves unknown values blank', async () => {
  const events: string[] = [];
  const result = await new CareerCopilotService(dependencies(events)).process(update);
  assert.equal(result.outcome, 'reviewed');
  assert.deepEqual(events, [
    'claim-request', 'claim', 'outbox:create',
    'outbox:tracker:pending', 'read-tracker', 'outbox:tracker:succeeded', 'create-tracker',
    'outbox:fetch:pending', 'fetch', 'outbox:fetch:succeeded',
    'outbox:profile:pending', 'profile', 'outbox:profile:succeeded',
    'outbox:report:pending', 'report', 'outbox:report:succeeded',
    'outbox:topics:pending', 'topics', 'outbox:topics:succeeded',
    'outbox:audit-prepared:pending', 'sheets-audit:prepared', 'outbox:audit-prepared:succeeded',
    'outbox:tracker-reviewed:pending', 'tracker:reviewed', 'verify-tracker', 'outbox:tracker-reviewed:succeeded',
    'outbox:audit-reviewed:pending', 'sheets-audit:reviewed', 'outbox:audit-reviewed:succeeded', 'state:succeeded',
  ]);
});

test('rejects a replayed Telegram request before idempotency sighting or fetch', async () => {
  const events: string[] = [];
  const result = await new CareerCopilotService(dependencies(events, {
    idempotency: {
      claimRequest: async () => false,
      claim: async () => { throw new Error('must not claim URL'); },
      recordSighting: async () => { throw new Error('must not record sighting'); },
    },
  })).process(update);
  assert.equal(result.outcome, 'rejected');
  assert.equal((result as { reason: string }).reason, 'replayed_update');
  assert.equal(events.includes('fetch'), false);
});

test('preserves prior status and alerts on partial failure without retrying', async () => {
  const events: string[] = [];
  const result = await new CareerCopilotService(dependencies(events, {
    sheets: {
      readTracker: async () => [{ URL: 'https://linkedin.com/jobs/1', Status: 'saved', Priority: 'High' }],
      appendTrackerRow: async () => { events.push('unexpected-create'); },
      updateTrackerRow: async (_row: number, fields: Record<string, unknown>) => { events.push(`tracker:${fields.Status}`); },
      verifyTrackerRow: async () => { events.push('verify-tracker'); },
      appendTopic: async () => { events.push('topic'); },
      appendAudit: async (entry: Record<string, unknown>) => { events.push(`sheets-audit:${entry.outcome}`); },
    },
    report: { write: async () => { events.push('report'); throw new Error('disk full'); } },
  })).process(update);
  assert.equal(result.outcome, 'failed');
  assert.ok(events.includes('tracker:saved'));
  assert.ok(events.includes('alert'));
  assert.equal(events.filter((event) => event === 'fetch').length, 1);
  assert.ok(events.includes('state:failed'));
});
