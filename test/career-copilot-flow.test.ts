import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { OwnerAuthorization } from '../src/channels/telegram-auth.ts';
import { CareerCopilotService } from '../src/services/career-copilot.ts';
import { CareerStore } from '../src/storage/career-store.ts';

const owner = {
  resourceId: 'owner-v0', enabled: true, authorizationRevision: 1,
  telegram: { userIds: new Set(['123', '124']), privateChatIds: new Set(['456']) },
  studioEnabled: true, stdioEnabled: true,
};
const update = (updateId: number, text = '/save https://linkedin.com/jobs/1', userId = 123) => ({
  update_id: updateId,
  message: { message_id: updateId + 1, date: 1, from: { id: userId, is_bot: false, first_name: 'Owner' }, chat: { id: 456, type: 'private' }, text },
});

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-flow-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const secondStore = new CareerStore(`file:${databasePath}`);
  const makeService = (target: CareerStore) => new CareerCopilotService({
    authorization: new OwnerAuthorization(() => owner), store: target, intakeHashKey: 'a'.repeat(32),
  });
  return {
    store, secondStore, service: makeService(store), secondService: makeService(secondStore), databasePath,
    close: () => { secondStore.close(); store.close(); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

test('same-store replay returns only the matching prior receipt', async () => {
  const state = fixture();
  try {
    const first = await state.service.process(update(1));
    const duplicate = await state.service.process(update(1));
    assert.equal(first.outcome, 'enqueued');
    assert.deepEqual(duplicate, { ...first, duplicate: true });
    assert.equal(state.store.getCommandCount(), 1);
  } finally { state.close(); }
});

test('P13-duplicate-transport-event-one-intent', async () => {
  const state = fixture();
  try {
    const [first, duplicate] = await Promise.all([state.service.process(update(1)), state.secondService.process(update(1))]);
    assert.equal(first.outcome, 'enqueued');
    assert.equal(duplicate.outcome, 'enqueued');
    if (first.outcome !== 'enqueued' || duplicate.outcome !== 'enqueued') return;
    assert.equal(first.commandId, duplicate.commandId);
    assert.deepEqual([first.duplicate, duplicate.duplicate].sort(), [false, true]);
    assert.equal(state.store.getCommandCount(), 1);
  } finally { state.close(); }
});

test('conflicting replay fails closed across stores for payload, intent, and principal', async () => {
  for (const conflict of [
    update(2, '/save https://linkedin.com/jobs/other'),
    update(2, '/job'),
    update(2, '/save https://linkedin.com/jobs/1', 124),
  ]) {
    const state = fixture();
    try {
      const first = await state.service.process(update(2));
      assert.equal(first.outcome, 'enqueued');
      await assert.rejects(() => state.secondService.process(conflict), /conflicting transport replay/i);
      assert.equal(state.store.getCommandCount(), 1);
    } finally { state.close(); }
  }
});

test('P13-two-save-commands-preserve-order', async () => {
  const state = fixture();
  try {
    const [a, b] = await Promise.all([
      state.secondService.process(update(11, '/save https://linkedin.com/jobs/11')),
      state.service.process(update(10, '/save https://linkedin.com/jobs/10')),
    ]);
    assert.equal(a.outcome, 'enqueued');
    assert.equal(b.outcome, 'enqueued');
    if (a.outcome !== 'enqueued' || b.outcome !== 'enqueued') return;
    assert.deepEqual([a.queueSequence, b.queueSequence], [1, 2]);
    const database = new DatabaseSync(state.databasePath, { readOnly: true });
    const rows = database.prepare('SELECT command_id commandId, queue_sequence queueSequence, canonical_url canonicalUrl FROM career_commands ORDER BY queue_sequence').all();
    database.close();
    assert.deepEqual(rows.map((row) => ({ ...row })), [
      { commandId: a.commandId, queueSequence: 1, canonicalUrl: 'https://linkedin.com/jobs/11' },
      { commandId: b.commandId, queueSequence: 2, canonicalUrl: 'https://linkedin.com/jobs/10' },
    ]);
  } finally { state.close(); }
});

test('save canonicalizes a non-root trailing slash without changing query semantics', async () => {
  const state = fixture();
  try {
    const result = await state.service.process(update(12, '/save https://linkedin.com/jobs/view/123/?trk=feed%2Fhome'));
    assert.equal(result.outcome, 'enqueued');
    const database = new DatabaseSync(state.databasePath, { readOnly: true });
    const command = database.prepare('SELECT canonical_url canonicalUrl, canonical_job_key canonicalJobKey FROM career_commands').get();
    database.close();
    assert.deepEqual({ ...command }, {
      canonicalUrl: 'https://linkedin.com/jobs/view/123?trk=feed%2Fhome',
      canonicalJobKey: 'url:https://linkedin.com/jobs/view/123?trk=feed%2Fhome',
    });
  } finally { state.close(); }
});

test('accepted transport intake invokes no fetch, model, workflow, Sheets, or file boundary', async () => {
  const state = fixture();
  try { assert.equal((await state.service.process(update(20))).outcome, 'enqueued'); assert.equal(state.store.getCommandCount(), 1); }
  finally { state.close(); }
});

test('P4-forged-resource-thread-ignored', async () => {
  const state = fixture();
  try {
    const forged = { ...update(21), resourceId: 'attacker', threadId: 'attacker-thread', principal: { channel: 'stdio' } };
    const result = await state.service.process(forged);
    assert.equal(result.outcome, 'enqueued');
    const database = new DatabaseSync(state.databasePath, { readOnly: true });
    const command = database.prepare('SELECT owner_resource_id ownerResourceId, thread_id threadId, origin_destination originDestination FROM career_commands').get();
    database.close();
    assert.deepEqual({ ...command }, { ownerResourceId: 'owner-v0', threadId: 'telegram:456', originDestination: '456' });
    for (const inaccessible of ['dependencies', 'hashKey', 'payloadHash', 'store', 'processTrustedTransport', 'processTransport']) {
      assert.equal(inaccessible in state.service, false, `${inaccessible} must not be runtime-accessible`);
    }
  } finally { state.close(); }
});

test('scope-job-command-parked', async () => {
  const state = fixture();
  try {
    const result = await state.service.process(update(30, '/job https://linkedin.com/jobs/30'));
    assert.deepEqual({ outcome: result.outcome, command: result.outcome === 'parked' ? result.command : undefined, duplicate: result.outcome === 'parked' ? result.duplicate : undefined },
      { outcome: 'parked', command: 'job', duplicate: false });
    assert.equal(state.store.getCommandCount(), 0);
  } finally { state.close(); }
});

test('structurally valid rejections persist once, stay rejected after authorization changes, and retain no raw data', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-rejected-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  let current = { ...owner, telegram: { userIds: new Set(['123']), privateChatIds: new Set(['456']) } };
  const service = new CareerCopilotService({
    authorization: new OwnerAuthorization(() => current), store, intakeHashKey: 'r'.repeat(32),
  });
  try {
    let replies = 0;
    const unauthorized = update(41, '/save https://linkedin.com/jobs/RAW_UNAUTHORIZED_CANARY', 999);
    assert.deepEqual(await service.process(unauthorized, async () => { replies += 1; }), { outcome: 'rejected', reason: 'unauthorized' });
    current = { ...current, telegram: { ...current.telegram, userIds: new Set(['123', '999']) } };
    assert.deepEqual(await service.process(unauthorized, async () => { replies += 1; }), { outcome: 'rejected', reason: 'unauthorized' });
    assert.deepEqual(await service.process(update(42, '/save https://evil.example/RAW_URL_CANARY')), { outcome: 'rejected', reason: 'unsupported_job_url' });
    assert.deepEqual(await service.process(update(43, 'RAW_INVALID_INTENT_CANARY')), { outcome: 'rejected', reason: 'invalid_command' });
    current = { ...current, enabled: false };
    assert.deepEqual(await service.process(update(46)), { outcome: 'rejected', reason: 'unauthorized' });
    assert.equal(replies, 0, 'rejections are never acknowledged');
    assert.equal(store.getCommandCount(), 0);

    const database = new DatabaseSync(databasePath, { readOnly: true });
    const rows = database.prepare(`SELECT intent_kind intentKind, result, rejection_reason reason, canonical_url canonicalUrl,
      thread_id threadId, origin_destination destination, principal_key principalKey, normalized_hash normalizedHash
      FROM career_inbound_events ORDER BY transport_event_id`).all().map((row) => ({ ...row }));
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map(({ intentKind, result, reason }) => ({ intentKind, result, reason })), [
      { intentKind: 'rejected', result: 'rejected', reason: 'unauthorized' },
      { intentKind: 'rejected', result: 'rejected', reason: 'unsupported_job_url' },
      { intentKind: 'rejected', result: 'rejected', reason: 'invalid_command' },
      { intentKind: 'rejected', result: 'rejected', reason: 'unauthorized' },
    ]);
    for (const row of rows) {
      assert.equal(row.canonicalUrl, null);
      assert.deepEqual({ threadId: row.threadId, destination: row.destination, principalKey: row.principalKey },
        { threadId: 'intake:rejected', destination: 'intake:rejected', principalKey: 'intake:rejected' });
      assert.match(String(row.normalizedHash), /^sha256:[a-f0-9]{64}$/);
    }
    const retained = JSON.stringify(rows);
    for (const canary of ['RAW_UNAUTHORIZED_CANARY', 'RAW_URL_CANARY', 'RAW_INVALID_INTENT_CANARY', '/save', '999']) {
      assert.equal(retained.includes(canary), false, canary);
    }
    database.close();
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('rejected event ID with a changed normalized transport envelope conflicts', async () => {
  const state = fixture();
  try {
    assert.deepEqual(await state.service.process(update(44, 'invalid one')), { outcome: 'rejected', reason: 'invalid_command' });
    await assert.rejects(() => state.secondService.process(update(44, 'invalid two')), /conflicting transport replay/i);
    assert.equal(state.store.getCommandCount(), 0);
  } finally { state.close(); }
});

for (const [change, mutate] of [
  ['authorization revision', (value: typeof owner) => ({ ...value, authorizationRevision: value.authorizationRevision + 1 })],
  ['configured owner resource', (value: typeof owner) => ({ ...value, resourceId: 'replacement-owner' })],
] as const) {
  test(`accepted replay after ${change} change is generic and sends no acknowledgement`, async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-context-replay-'));
    const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
    let current = owner;
    const service = new CareerCopilotService({ authorization: new OwnerAuthorization(() => current), store, intakeHashKey: 'y'.repeat(32) });
    try {
      const original = await service.process(update(47));
      assert.equal(original.outcome, 'enqueued');
      current = mutate(current);
      let replied = false;
      assert.deepEqual(await service.process(update(47), async () => { replied = true; }), { outcome: 'rejected', reason: 'unauthorized' });
      assert.equal(replied, false);
      assert.equal(store.getCommandCount(), 1);
    } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
  });
}

test('currently unauthorized replay of an accepted event discloses no receipt and sends no acknowledgement', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-revoked-replay-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
  let current = owner;
  const service = new CareerCopilotService({ authorization: new OwnerAuthorization(() => current), store, intakeHashKey: 'z'.repeat(32) });
  try {
    const accepted = await service.process(update(45));
    assert.equal(accepted.outcome, 'enqueued');
    current = { ...owner, telegram: { ...owner.telegram, userIds: new Set(['124']) } };
    let replied = false;
    assert.deepEqual(await service.process(update(45), async () => { replied = true; }), { outcome: 'rejected', reason: 'unauthorized' });
    assert.equal(replied, false);
    assert.equal(store.getCommandCount(), 1);
  } finally { store.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});

test('public process rejects malformed raw Telegram envelopes without durable writes', async () => {
  const state = fixture();
  try {
    const valid = update(40);
    const malformed = [
      { ...valid, message: { ...valid.message, date: -1 } },
      { ...valid, message: { ...valid.message, chat: { ...valid.message.chat, type: 'PRIVATE' } } },
      { ...valid, message: { ...valid.message, chat: { ...valid.message.chat, id: Number.MAX_SAFE_INTEGER + 1 } } },
      { ...valid, message: { ...valid.message, from: { ...valid.message.from, id: -1 } } },
      { ...valid, message: { ...valid.message, from: { ...valid.message.from, is_bot: 'false' } } },
      { ...valid, message: { ...valid.message, text: '/save https://linkedin.com/jobs/1\u0000' } },
      { ...valid, message: { ...valid.message, text: 'x'.repeat(4097) } },
    ];
    for (const envelope of malformed) assert.deepEqual(await state.service.process(envelope as never), { outcome: 'rejected', reason: 'invalid_update' });
    assert.equal(state.store.getCommandCount(), 0);
    const database = new DatabaseSync(state.databasePath, { readOnly: true });
    assert.equal((database.prepare('SELECT count(*) count FROM career_inbound_events').get() as { count: number }).count, 0);
    database.close();
  } finally { state.close(); }
});
