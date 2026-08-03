import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import {
  CareerStore,
  MIGRATIONS,
  buildJobIdempotencyKey,
  normalizeJobIdentity,
} from '../src/storage/career-store.ts';

test('migrates the baseline same-volume store without dropping legacy data', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-store-upgrade-'));
  const databasePath = path.join(dir, 'state.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE career_idempotency (
      key TEXT PRIMARY KEY, first_request_id TEXT NOT NULL, sightings INTEGER NOT NULL DEFAULT 0,
      last_request_id TEXT, last_source_id TEXT, state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER, error TEXT
    ) STRICT;
    CREATE TABLE career_outbox (
      request_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step)
    ) STRICT;
    INSERT INTO career_requests VALUES ('request-a');
    INSERT INTO career_idempotency VALUES ('url:https://linkedin.com/jobs/old', 'request-a', 2, 'request-b', 'telegram:1:2', 'succeeded', NULL, NULL);
    INSERT INTO career_outbox VALUES ('request-a', 'report', 'succeeded', '{}', 1);
  `);
  database.close();

  const store = new CareerStore(`file:${databasePath}`);
  assert.deepEqual(store.get('url:https://linkedin.com/jobs/old'), {
    key: 'url:https://linkedin.com/jobs/old', firstRequestId: 'request-a', sightings: 2,
    lastRequestId: 'request-b', lastSourceId: 'telegram:1:2',
  });
  store.close();
  const upgraded = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(upgraded.prepare('SELECT count(*) AS count FROM career_outbox').get()!.count, 1);
  assert.equal(upgraded.prepare('SELECT count(*) AS count FROM schema_migrations').get()!.count, MIGRATIONS.length);
  assert.deepEqual(
    upgraded.prepare('SELECT version, legacy_outbox_preserved FROM schema_migrations ORDER BY version').all().map((row) => ({ ...row })),
    MIGRATIONS.map(({ version }) => ({ version, legacy_outbox_preserved: version === 1 ? 1 : 0 })),
  );
  assert.match((upgraded.prepare("SELECT sql FROM sqlite_schema WHERE name = 'career_requests'").get() as { sql: string }).sql, /length\(request_id\) > 0/);
  assert.match((upgraded.prepare("SELECT sql FROM sqlite_schema WHERE name = 'career_idempotency'").get() as { sql: string }).sql, /state IN \('pending', 'succeeded', 'failed'\)/);
  upgraded.close();
  fs.rmSync(dir, { recursive: true });
});

test('rejects a legacy-shaped outbox injected after a fresh migration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-store-fresh-outbox-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  store.close();
  const database = new DatabaseSync(databasePath);
  assert.equal(database.prepare('SELECT legacy_outbox_preserved FROM schema_migrations WHERE version = 1').get()!.legacy_outbox_preserved, 0);
  database.exec(`
    CREATE TABLE career_outbox (
      request_id TEXT NOT NULL,
      step TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      payload TEXT,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (request_id, step)
    ) STRICT;
  `);
  database.close();

  assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
  fs.rmSync(dir, { recursive: true });
});

test('requires a provenance-claimed legacy outbox to remain installed', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-store-outbox-provenance-'));
  const databasePath = path.join(dir, 'state.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE career_idempotency (
      key TEXT PRIMARY KEY, first_request_id TEXT NOT NULL, sightings INTEGER NOT NULL DEFAULT 0,
      last_request_id TEXT, last_source_id TEXT, state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER, error TEXT
    ) STRICT;
    CREATE TABLE career_outbox (
      request_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step)
    ) STRICT;
  `);
  database.close();
  const store = new CareerStore(`file:${databasePath}`);
  store.close();
  const migrated = new DatabaseSync(databasePath);
  assert.equal(migrated.prepare('SELECT legacy_outbox_preserved FROM schema_migrations WHERE version = 1').get()!.legacy_outbox_preserved, 1);
  migrated.exec('DROP TABLE career_outbox');
  migrated.close();

  assert.throws(() => new CareerStore(`file:${databasePath}`), /installed schema/i);
  fs.rmSync(dir, { recursive: true });
});

test('rolls back legacy canonicalization when preserved rows violate canonical checks', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-store-rollback-'));
  const databasePath = path.join(dir, 'state.db');
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE career_requests (request_id TEXT PRIMARY KEY) STRICT;
    CREATE TABLE career_idempotency (
      key TEXT PRIMARY KEY, first_request_id TEXT NOT NULL, sightings INTEGER NOT NULL DEFAULT 0,
      last_request_id TEXT, last_source_id TEXT, state TEXT NOT NULL DEFAULT 'pending', lease_until INTEGER, error TEXT
    ) STRICT;
    CREATE TABLE career_outbox (
      request_id TEXT NOT NULL, step TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'pending', payload TEXT,
      updated_at INTEGER NOT NULL, PRIMARY KEY (request_id, step)
    ) STRICT;
    INSERT INTO career_requests VALUES ('request-a');
    INSERT INTO career_idempotency VALUES ('bad', 'request-a', -1, NULL, NULL, 'pending', NULL, NULL);
    INSERT INTO career_outbox VALUES ('request-a', 'report', 'pending', '{}', 1);
  `);
  const before = database.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all();
  database.close();
  assert.throws(() => new CareerStore(`file:${databasePath}`), /constraint/i);
  const restored = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual(restored.prepare("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name").all(), before);
  assert.equal(restored.prepare('SELECT sightings FROM career_idempotency').get()!.sightings, -1);
  assert.equal(restored.prepare('SELECT count(*) AS count FROM career_outbox').get()!.count, 1);
  restored.close();
  fs.rmSync(dir, { recursive: true });
});

test('durable queue claims oldest runnable command and reports FIFO positions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-queue-fifo-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
  const enqueue = (commandId: string) => store.enqueueCommand({
    commandId,
    attemptId: `${commandId}:attempt-1`,
    requestId: `${commandId}:request`,
    canonicalJobKey: `job:${commandId}`,
    canonicalUrl: `https://example.com/jobs/${commandId}`,
    ownerResourceId: 'owner-1',
    threadId: 'thread-1',
    originChannel: 'telegram',
    originDestination: 'chat-1',
  });
  assert.equal(enqueue('command-a').position, 1);
  assert.equal(enqueue('command-b').position, 2);
  assert.equal(store.claimNextRunnable('worker-1')?.commandId, 'command-a');
  assert.equal(store.queuePosition('command-b'), 1);
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('due retry claims resume the same run with a higher generation', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-queue-retry-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  store.enqueueCommand({
    commandId: 'command-retry', attemptId: 'attempt-retry', requestId: 'request-retry', canonicalJobKey: 'job:retry',
    canonicalUrl: 'https://example.com/jobs/retry', ownerResourceId: 'owner-1', threadId: 'thread-1', originChannel: 'telegram', originDestination: 'chat-1',
  });
  const starting = store.claimNextRunnable('worker-1')!;
  const startingFence = { ...starting, sourceState: 'starting' as const };
  const database = new DatabaseSync(databasePath);
  database.prepare("UPDATE career_commands SET start_dispatch_state = 'dispatched' WHERE command_id = ? AND queue_state = 'starting'").run(starting.commandId);
  database.close();
  assert.equal(store.markRunning(startingFence).applied, true);
  assert.equal(store.scheduleRetry({ ...starting, sourceState: 'running' }, {
    scheduleKey: 'command-retry:direct:1', stage: 'direct_acquisition',
    failure: { class: 'transient', code: 'temporary_failure' },
    policy: (() => { const calculatedAt = Date.now(); return { retry: true as const, delayMs: 20, attempt: 1, calculatedAt, policyTargetAt: calculatedAt + 20, source: 'jitter' as const }; })(),
  }).applied, true);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  const resuming = store.claimNextRunnable('worker-2')!;
  assert.deepEqual({ commandId: resuming.commandId, runId: resuming.runId, queueState: resuming.queueState, claimGeneration: resuming.claimGeneration }, {
    commandId: starting.commandId, runId: starting.runId, queueState: 'resuming', claimGeneration: starting.claimGeneration + 1,
  });
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('canonical URL wins over fallback identity and normalizes safely', () => {
  assert.equal(
    buildJobIdempotencyKey({
      url: 'HTTPS://LinkedIn.com/jobs/view/123/#details',
      company: 'Acme',
      title: 'Engineer',
      location: 'Remote',
    }),
    'url:https://linkedin.com/jobs/view/123',
  );
  assert.equal(normalizeJobIdentity(' Senior   Engineer '), 'senior engineer');
  assert.equal(
    buildJobIdempotencyKey({ company: ' Acme ', title: 'Engineer', location: ' Remote ' }),
    'identity:acme|engineer|remote',
  );
});

test('claims are durable and atomic across store instances', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-'));
  const db = path.join(dir, 'state.db');
  const first = new CareerStore(`file:${db}`);
  const second = new CareerStore(`file:${db}`);

  const results = await Promise.all([
    first.claim('url:https://linkedin.com/jobs/1', 'request-a'),
    second.claim('url:https://linkedin.com/jobs/1', 'request-b'),
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1);

  first.close();
  second.close();
  const reopened = new CareerStore(`file:${db}`);
  assert.equal((await reopened.claim('url:https://linkedin.com/jobs/1', 'request-c')).claimed, false);
  reopened.close();
  fs.rmSync(dir, { recursive: true });
});

test('tracks pending, failed, and succeeded states with lease recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-state-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`, { leaseMs: 10 });
  assert.equal((await store.claim('url:https://linkedin.com/jobs/state', 'request-a')).claimed, true);
  assert.equal((await store.claim('url:https://linkedin.com/jobs/state', 'request-b')).claimed, false);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal((await store.claim('url:https://linkedin.com/jobs/state', 'request-c')).claimed, true);
  await store.markFailed('url:https://linkedin.com/jobs/state', 'request-c');
  assert.equal((await store.claim('url:https://linkedin.com/jobs/state', 'request-d')).claimed, true);
  await store.markSucceeded('url:https://linkedin.com/jobs/state', 'request-d');
  assert.equal((await store.claim('url:https://linkedin.com/jobs/state', 'request-e')).claimed, false);
  assert.equal(store.getState('url:https://linkedin.com/jobs/state')?.state, 'succeeded');
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('persists only stable safe idempotency failure codes', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-safe-error-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
  const key = 'url:https://linkedin.com/jobs/safe-error';
  await store.claim(key, 'request-a');
  await store.markFailed(key, 'request-a', 'provider leaked candidate@example.com');
  assert.equal(store.getState(key)?.error, undefined);
  await store.claim(key, 'request-b');
  await store.markFailed(key, 'request-b', 'job_processing_failed');
  assert.equal(store.getState(key)?.error, 'job_processing_failed');
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('duplicates record a sighting without replacing the original request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
  await store.claim('identity:acme|engineer|remote', 'request-a');
  await store.recordSighting('identity:acme|engineer|remote', 'request-b', 'telegram:2:8');

  assert.deepEqual(store.get('identity:acme|engineer|remote'), {
    key: 'identity:acme|engineer|remote',
    firstRequestId: 'request-a',
    sightings: 1,
    lastRequestId: 'request-b',
    lastSourceId: 'telegram:2:8',
  });
  store.close();
  fs.rmSync(dir, { recursive: true });
});

test('rejects unsafe transport correlation IDs before persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-correlation-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const base = {
    channel: 'telegram' as const, payloadHash: `sha256:${'1'.repeat(64)}`, ownerResourceId: 'owner',
    threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4,
    intentKind: 'parked_job' as const, requestId: 'telegram:1',
  };
  for (const transportEventId of ['', 'x'.repeat(257), 'bad\nevent', 'bad\u0000event']) {
    assert.throws(() => store.recordInboundAndEnqueue({ ...base, transportEventId }), /transport event ID/i);
  }
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) count FROM career_inbound_events').get()!.count, 0);
  assert.equal(database.prepare('SELECT count(*) count FROM career_commands').get()!.count, 0);
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('validates the complete discriminated atomic intake before persistence', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-shape-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const parked = {
    channel: 'telegram' as const, transportEventId: '1', payloadHash: `sha256:${'1'.repeat(64)}`,
    ownerResourceId: 'owner', threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4,
    intentKind: 'parked_job' as const, requestId: 'telegram:1',
  };
  const save = {
    ...parked, intentKind: 'save_job' as const, canonicalUrl: 'https://example.com/jobs/1',
    canonicalJobKey: 'url:https://example.com/jobs/1', commandId: 'command-1', attemptId: 'attempt-1',
  };
  const invalid = [
    { ...parked, channel: 'email' },
    { ...parked, intentKind: 'unknown' },
    { ...parked, canonicalUrl: save.canonicalUrl },
    { ...parked, canonicalUrl: undefined },
    { ...save, canonicalUrl: undefined },
    { ...save, canonicalJobKey: 'url:https://example.com/jobs/other' },
    { ...save, canonicalUrl: 'http://example.com/jobs/1', canonicalJobKey: 'url:http://example.com/jobs/1' },
    { ...save, canonicalUrl: 'https://user:pass@example.com/jobs/1', canonicalJobKey: 'url:https://user:pass@example.com/jobs/1' },
    { ...save, canonicalUrl: 'https://example.com:8443/jobs/1', canonicalJobKey: 'url:https://example.com:8443/jobs/1' },
    { ...save, canonicalUrl: 'https://example.com/jobs/1#fragment', canonicalJobKey: 'url:https://example.com/jobs/1#fragment' },
    { ...save, canonicalUrl: 'HTTPS://EXAMPLE.COM/jobs/1', canonicalJobKey: 'url:HTTPS://EXAMPLE.COM/jobs/1' },
    { ...save, commandId: 'bad\ncommand' },
    { ...save, attemptId: 'x'.repeat(257) },
    { ...save, authorizationRevision: -1 },
    Object.fromEntries(Object.entries(save).filter(([key]) => key !== 'authorizationRevision')),
  ];
  for (const input of invalid) assert.throws(() => store.recordInboundAndEnqueue(input as never));
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) count FROM career_inbound_events').get()!.count, 0);
  assert.equal(database.prepare('SELECT count(*) count FROM career_commands').get()!.count, 0);
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('parked intake returns its stored issuance authorization for new and duplicate results', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-parked-authorization-'));
  const store = new CareerStore(`file:${path.join(dir, 'state.db')}`);
  const input = {
    channel: 'telegram' as const, transportEventId: 'parked', payloadHash: `sha256:${'2'.repeat(64)}`,
    ownerResourceId: 'owner', threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4,
    intentKind: 'parked_job' as const, requestId: 'telegram:parked',
  };
  const first = store.recordInboundAndEnqueue(input);
  assert.deepEqual(first, {
    intentKind: 'parked_job', duplicate: false,
    issuanceAuthorization: { channel: 'telegram', ownerResourceId: 'owner', threadId: 'telegram:2', destination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4 },
  });
  assert.deepEqual(store.recordInboundAndEnqueue(input), { ...first, duplicate: true });
  store.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v4 normalized SQL rejects NULL bypasses and preserves legacy compatibility', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-null-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`); store.close();
  const database = new DatabaseSync(databasePath);
  const columns = `event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, rejection_reason, created_at,
    intent_kind, canonical_url, thread_id, origin_destination, principal_key, authorization_revision`;
  const insert = database.prepare(`INSERT INTO career_inbound_events (${columns}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const required = ['owner', 'telegram:2', '2', 'telegram:1:2', 4] as const;
  for (let index = 0; index < required.length; index += 1) {
    const values = [...required]; values[index] = null as never;
    assert.throws(() => insert.run(`event-${index}`, 'telegram', String(index), `sha256:${'1'.repeat(64)}`, values[0], 'accepted', null, 1,
      'parked_job', null, values[1], values[2], values[3], values[4]), /invalid normalized inbound event/i);
  }
  for (const [eventId, channel, transportId] of [
    ['telegram:wrong', 'Telegram', 'wrong'],
    ['forged-event-id', 'telegram', 'right'],
  ]) {
    assert.throws(() => insert.run(eventId, channel, transportId, `sha256:${'1'.repeat(64)}`, ...required.slice(0, 1), 'accepted', null, 1,
      'parked_job', null, ...required.slice(1)), /invalid normalized inbound event/i);
  }
  database.exec(`INSERT INTO career_inbound_events (event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, created_at)
    VALUES ('legacy', 'telegram', 'legacy', 'sha256:${'2'.repeat(64)}', 'owner', 'accepted', 1)`);
  assert.throws(() => database.exec("UPDATE career_inbound_events SET owner_resource_id = 'other' WHERE event_id = 'legacy'"), /immutable/i);
  assert.equal((database.prepare("SELECT authorization_revision FROM career_inbound_events WHERE event_id = 'legacy'").get() as { authorization_revision: null }).authorization_revision, null);
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('v4 accepted saves require exact command correlations on insert and pending promotion', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-correlation-sql-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`); store.close();
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA foreign_keys = ON');
  const command = database.prepare(`INSERT INTO career_commands
    (command_id, attempt_id, request_id, canonical_job_key, canonical_url, owner_resource_id, thread_id,
     origin_channel, origin_destination, queue_state, created_at, updated_at, queued_at, authorization_revision)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 1, 1, 1, ?)`);
  const inbound = database.prepare(`INSERT INTO career_inbound_events
    (event_id, channel, transport_event_id, normalized_hash, owner_resource_id, result, rejection_reason, created_at,
     intent_kind, canonical_url, thread_id, origin_destination, principal_key, authorization_revision, command_id, enqueue_position)
    VALUES (?, ?, ?, 'sha256:${'4'.repeat(64)}', ?, ?, ?, 1, 'save_job', ?, ?, ?, 'telegram:1:2', ?, ?, ?)`);
  const expected = {
    canonicalUrl: 'https://example.com/jobs/1', canonicalJobKey: 'url:https://example.com/jobs/1', owner: 'owner',
    thread: 'telegram:2', channel: 'telegram', destination: '2', revision: 4,
  };
  const mismatches = [
    ['command_id', { commandId: 'missing-command' }],
    ['owner_resource_id', { owner: 'other-owner' }],
    ['thread_id', { thread: 'telegram:other' }],
    ['origin_channel', { channel: 'api' }],
    ['origin_destination', { destination: 'other-destination' }],
    ['canonical_url', { canonicalUrl: 'https://example.com/jobs/other' }],
    ['authorization_revision', { revision: 5 }],
    ['request_id', { requestId: 'telegram:wrong' }],
    ['canonical_job_key', { canonicalJobKey: 'url:https://example.com/jobs/forged' }],
    ['enqueue_position', { enqueuePosition: 2 }],
  ] as const;
  for (const mode of ['direct', 'pending'] as const) {
    for (const [field, override] of mismatches) {
      database.exec('BEGIN');
      const transportId = `${mode}-${field}`;
      const eventId = `${expected.channel}:${transportId}`;
      const values = { commandId: `command-${mode}-${field}`, requestId: eventId, enqueuePosition: 1, ...expected, ...override };
      if (field !== 'command_id') command.run(values.commandId, `attempt-${mode}-${field}`, values.requestId, values.canonicalJobKey,
        values.canonicalUrl, values.owner, values.thread, values.channel, values.destination, values.revision);
      if (mode === 'direct') {
        assert.throws(() => inbound.run(eventId, expected.channel, transportId, expected.owner, 'accepted', null,
          expected.canonicalUrl, expected.thread, expected.destination, expected.revision, values.commandId, values.enqueuePosition),
        /constraint|correlation|invalid normalized/i, `${field} direct insert`);
      } else {
        inbound.run(eventId, expected.channel, transportId, expected.owner, 'rejected', 'intake_pending',
          expected.canonicalUrl, expected.thread, expected.destination, expected.revision, null, null);
        assert.throws(() => database.prepare(`UPDATE career_inbound_events SET result = 'accepted', rejection_reason = NULL,
          command_id = ?, enqueue_position = ? WHERE event_id = ?`).run(values.commandId, values.enqueuePosition, eventId),
        /constraint|correlation|immutable/i, `${field} pending promotion`);
      }
      database.exec('ROLLBACK');
    }
  }
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('actual store writes satisfy v4 request, canonical-key, and enqueue-position provenance', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-correlation-store-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const result = store.recordInboundAndEnqueue({
    channel: 'telegram', transportEventId: 'actual', payloadHash: `sha256:${'5'.repeat(64)}`,
    ownerResourceId: 'owner', threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4,
    intentKind: 'save_job', canonicalUrl: 'https://example.com/jobs/1', canonicalJobKey: 'url:https://example.com/jobs/1',
    commandId: 'actual-command', attemptId: 'actual-attempt', requestId: 'telegram:actual',
  });
  assert.equal(result.queuePosition, 1);
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.deepEqual({ ...database.prepare(`SELECT e.event_id eventId, e.channel, e.transport_event_id transportEventId,
    c.request_id requestId, c.canonical_job_key canonicalJobKey, e.enqueue_position enqueuePosition
    FROM career_commands c JOIN career_inbound_events e ON e.command_id = c.command_id`).get() },
  { eventId: 'telegram:actual', channel: 'telegram', transportEventId: 'actual', requestId: 'telegram:actual',
    canonicalJobKey: 'url:https://example.com/jobs/1', enqueuePosition: 1 });
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('normalized commands persist immutable issuance revision while hash-identical replay returns the original receipt', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-revision-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const input = {
    channel: 'telegram' as const, transportEventId: '1', payloadHash: `sha256:${'3'.repeat(64)}`,
    ownerResourceId: 'owner', threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 7,
    intentKind: 'save_job' as const, canonicalUrl: 'https://linkedin.com/jobs/1', canonicalJobKey: 'url:https://linkedin.com/jobs/1',
    commandId: 'command-revision', attemptId: 'attempt-revision', requestId: 'telegram:1',
  };
  const first = store.recordInboundAndEnqueue(input);
  assert.deepEqual(first.issuanceAuthorization, {
    channel: 'telegram', ownerResourceId: 'owner', threadId: 'telegram:2', destination: '2',
    principalKey: 'telegram:1:2', authorizationRevision: 7,
  });
  assert.deepEqual(store.recordInboundAndEnqueue({ ...input, authorizationRevision: 8 }), { ...first, duplicate: true });
  store.close();
  const database = new DatabaseSync(databasePath);
  assert.equal((database.prepare("SELECT authorization_revision FROM career_commands WHERE command_id = 'command-revision'").get() as { authorization_revision: number }).authorization_revision, 7);
  assert.equal((database.prepare("SELECT authorization_revision FROM career_inbound_events WHERE event_id = 'telegram:1'").get() as { authorization_revision: number }).authorization_revision, 7);
  assert.throws(() => database.exec("UPDATE career_commands SET authorization_revision = 8 WHERE command_id = 'command-revision'"), /immutable/i);
  database.close(); fs.rmSync(dir, { recursive: true, force: true });
});

test('atomic inbound dedupe and enqueue rolls back both records on command failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-intake-atomic-'));
  const databasePath = path.join(dir, 'state.db');
  const store = new CareerStore(`file:${databasePath}`);
  const base = {
    channel: 'telegram', transportEventId: '1', payloadHash: `sha256:${'1'.repeat(64)}`,
    ownerResourceId: 'owner', threadId: 'telegram:2', originDestination: '2', principalKey: 'telegram:1:2', authorizationRevision: 4,
    intentKind: 'save_job' as const, canonicalUrl: 'https://linkedin.com/jobs/1', canonicalJobKey: 'url:https://linkedin.com/jobs/1',
    commandId: 'command-1', attemptId: 'attempt-1', requestId: 'telegram:1',
  };
  store.recordInboundAndEnqueue(base);
  assert.throws(() => store.recordInboundAndEnqueue({ ...base, transportEventId: '2', commandId: 'command-1', attemptId: 'attempt-2', requestId: 'telegram:2' }));
  store.close();
  const database = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal(database.prepare('SELECT count(*) count FROM career_inbound_events').get()!.count, 1);
  assert.equal(database.prepare('SELECT count(*) count FROM career_commands').get()!.count, 1);
  database.close();
  fs.rmSync(dir, { recursive: true, force: true });
});
