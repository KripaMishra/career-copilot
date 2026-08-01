import assert from 'node:assert/strict';
import test from 'node:test';

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTelegramIngress } from '../src/channels/telegram-ingress.ts';
import { createCareerCopilotRuntime } from '../src/services/career-runtime.ts';
import { resolveRuntimeConfig } from '../src/config/runtime.ts';

const update = {
  update_id: 99,
  message: {
    message_id: 7,
    date: 1,
    from: { id: 1, is_bot: false, first_name: 'Owner' },
    chat: { id: 2, type: 'private' },
    text: '/job https://linkedin.com/jobs/1',
  },
};

test('passes the verified raw Telegram update to the Career Copilot service', async () => {
  let received: unknown;
  const ingress = createTelegramIngress({
    service: {
      process: async (raw) => { received = raw; return { outcome: 'reviewed', requestId: 'telegram:99:7' }; },
    },
  });
  const result = await ingress.handle(update);
  assert.equal(result.outcome, 'reviewed');
  assert.equal(received, update);
});

test('runs a raw Telegram update through the concrete runtime with injected boundaries', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-runtime-'));
  const config = resolveRuntimeConfig({
    dataDir: path.join(root, 'data'), profileDir: path.join(root, 'profile'), reportsDir: path.join(root, 'reports'), topicsDir: path.join(root, 'topics'),
    env: { TELEGRAM_ALLOWED_USER_IDS: '1', CAREER_COPILOT_PRIVATE_CHAT_IDS: '2', GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet' },
  });
  fs.mkdirSync(config.profilePath, { recursive: true });
  const events: string[] = [];
  const runtime = createCareerCopilotRuntime(config, {
    fetchJob: async (url) => ({ url, company: '', title: '', location: '', sourceHash: 'source' }),
    idempotency: {
      claimRequest: async () => true, claim: async () => ({ claimed: true, record: {} }), recordSighting: async () => {},
      createOutbox: async () => {}, markOutbox: async () => {}, markSucceeded: async () => {}, markFailed: async () => {}, getOutbox: async () => [],
    },
    sheets: {
      readTracker: async () => { events.push('read'); return []; }, appendTrackerRow: async () => { events.push('create'); },
      updateTrackerRow: async () => { events.push('update'); }, verifyTrackerRow: async () => { events.push('verify'); },
      appendAudit: async (row) => { events.push(String(row.outcome)); }, appendTopic: async () => {},
    },
    profile: { readApproved: async () => ({}) }, report: { write: async () => ({ hash: 'artifact' }) }, topics: { write: async () => {} }, alert: async () => {},
  });
  const result = await runtime.handleTelegramUpdate(update);
  assert.equal(result.outcome, 'reviewed');
  assert.deepEqual(events, ['read', 'create', 'prepared', 'update', 'verify', 'reviewed']);
  fs.rmSync(root, { recursive: true });
});
