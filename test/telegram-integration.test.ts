import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { createCareerCopilotRuntime } from '../src/services/career-runtime.ts';
import { resolveRuntimeConfig } from '../src/config/runtime.ts';

const update = {
  update_id: 99,
  message: {
    message_id: 7,
    date: 1,
    from: { id: 1, is_bot: false, first_name: 'RAW_CANARY' },
    chat: { id: 2, type: 'private' },
    text: '/save https://linkedin.com/jobs/1',
  },
};

function runtimeFixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'career-runtime-'));
  const config = resolveRuntimeConfig({
    dataDir: path.join(root, 'data'), profileDir: path.join(root, 'profile'), reportsDir: path.join(root, 'reports'), topicsDir: path.join(root, 'topics'),
    env: {
      TELEGRAM_ALLOWED_USER_IDS: '1', CAREER_COPILOT_PRIVATE_CHAT_IDS: '2', GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet',
      CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner-v0', CAREER_COPILOT_INTAKE_HASH_KEY: 'h'.repeat(32),
    },
  });
  return { root, config, runtime: createCareerCopilotRuntime(config) };
}

test('P13-enqueue-before-ack', async () => {
  const { root, runtime } = runtimeFixture();
  try {
    const events: string[] = [];
    const accepted = { ...update, message: { ...update.message, text: '/save https://linkedin.com/jobs/1' } };
    const result = await runtime.handleTelegramUpdate(accepted, async () => {
      events.push(`ack:${runtime.store.getCommandCount()}`);
    });
    assert.equal(result.outcome, 'enqueued');
    assert.deepEqual(events, ['ack:1']);
    const serialized = JSON.stringify(result);
    for (const privateValue of ['binding', 'owner-v0', 'telegram:1:2', 'telegram:2', 'authorizationRevision']) {
      assert.equal(serialized.includes(privateValue), false, `public receipt leaked ${privateValue}`);
    }
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('enqueue rollback never acknowledges', async () => {
  const { root, runtime } = runtimeFixture();
  try {
    runtime.store.recordInboundAndEnqueue = () => { throw new Error('atomic persistence failed'); };
    let replies = 0;
    await assert.rejects(() => runtime.handleTelegramUpdate(update, async () => { replies += 1; }), /atomic persistence failed/);
    assert.equal(replies, 0);
    assert.equal(runtime.store.getCommandCount(), 0);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('revocation after durable enqueue returns a generic rejection and suppresses acknowledgement', async () => {
  const { root, config, runtime } = runtimeFixture();
  try {
    const persist = runtime.store.recordInboundAndEnqueue.bind(runtime.store);
    runtime.store.recordInboundAndEnqueue = (input) => {
      const result = persist(input);
      config.owner.enabled = false;
      return result;
    };
    let replies = 0;
    const result = await runtime.handleTelegramUpdate(update, async () => { replies += 1; });
    assert.deepEqual(result, { outcome: 'rejected', reason: 'unauthorized' });
    assert.equal(runtime.store.getCommandCount(), 1);
    assert.equal(replies, 0);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('malformed, unauthorized, and invalid Telegram inputs never reply', async () => {
  const { root, runtime } = runtimeFixture();
  try {
    let replies = 0;
    for (const malformed of [
      { update_id: 100, message: { message_id: 1, date: 1, chat: null, text: '/save https://linkedin.com/jobs/1' } },
      { update_id: 101, message: { ...update.message, text: `/${'x'.repeat(5000)}` } },
      { update_id: Number.MAX_SAFE_INTEGER + 1, message: update.message },
      { update_id: 102, message: { ...update.message, text: '/save https://example.com/jobs/1' } },
      { ...update, update_id: 103, message: { ...update.message, from: { ...update.message.from, id: 999 } } },
      { ...update, update_id: 104, message: { ...update.message, text: '/status RAW_SECRET' } },
    ]) {
      const result = await runtime.handleTelegramUpdate(malformed, async () => { replies += 1; });
      assert.equal(result.outcome, 'rejected');
    }
    assert.equal(replies, 0);
    assert.equal(runtime.store.getCommandCount(), 0);
  } finally { runtime.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('privacy-raw-update-not-retained', async () => {
  const { root, config, runtime } = runtimeFixture();
  try {
    const result = await runtime.handleTelegramUpdate(update);
    assert.equal(result.outcome, 'enqueued');
    runtime.close();
    const database = new DatabaseSync(new URL(config.databaseUrl));
    const retained = JSON.stringify(database.prepare("SELECT * FROM career_inbound_events").all());
    database.close();
    assert.equal(retained.includes('RAW_CANARY'), false);
    assert.equal(retained.includes('/save'), false);
  } finally { try { runtime.close(); } catch {} fs.rmSync(root, { recursive: true, force: true }); }
});
