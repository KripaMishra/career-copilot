import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  SqliteIdempotencyStore,
  buildJobIdempotencyKey,
  normalizeJobIdentity,
} from '../src/storage/idempotency.ts';

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
  const first = new SqliteIdempotencyStore(`file:${db}`);
  const second = new SqliteIdempotencyStore(`file:${db}`);

  const results = await Promise.all([
    first.claim('url:https://linkedin.com/jobs/1', 'request-a'),
    second.claim('url:https://linkedin.com/jobs/1', 'request-b'),
  ]);
  assert.equal(results.filter((result) => result.claimed).length, 1);

  first.close();
  second.close();
  const reopened = new SqliteIdempotencyStore(`file:${db}`);
  assert.equal((await reopened.claim('url:https://linkedin.com/jobs/1', 'request-c')).claimed, false);
  reopened.close();
  fs.rmSync(dir, { recursive: true });
});

test('tracks pending, failed, and succeeded states with lease recovery', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-state-'));
  const store = new SqliteIdempotencyStore(`file:${path.join(dir, 'state.db')}`, { leaseMs: 10 });
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

test('duplicates record a sighting without replacing the original request', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'career-idempotency-'));
  const store = new SqliteIdempotencyStore(`file:${path.join(dir, 'state.db')}`);
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
