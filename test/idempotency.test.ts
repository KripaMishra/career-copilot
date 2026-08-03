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
  assert.equal(store.releaseForRetry({ ...starting, sourceState: 'running' }, 0).applied, true);
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
