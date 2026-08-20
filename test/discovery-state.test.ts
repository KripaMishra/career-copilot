import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerStore, type DiscoveryCounts } from '../src/storage/career-store.ts';

const zeroCounts: DiscoveryCounts = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };

test('discovery run lease refuses overlap and is freed by finish', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-discovery-lease-')); const url = `file:${path.join(dir, 'jobs.db')}`; let now = 100;
  const firstStore = new CareerStore(url, { clock: () => now }); const secondStore = new CareerStore(url, { clock: () => now });
  try {
    const attempts = await Promise.all([firstStore.createDiscoveryRun(), secondStore.createDiscoveryRun()]);
    assert.deepEqual(attempts.map((result) => result.outcome).sort(), ['skipped_overlap', 'started']);
    const started = attempts.find((result) => result.outcome === 'started');
    assert.ok(started && /^[0-9a-f-]{36}$/.test(started.run.runId));
    assert.equal((await firstStore.activeDiscoveryRun())?.runId, started.run.runId);
    now = 200;
    const finished = await firstStore.finishDiscoveryRun({ runId: started.run.runId, status: 'succeeded', counts: { added: 3, duplicate: 2, nonQualifying: 1, blocked: 0, error: 0 } });
    assert.deepEqual(finished, { runId: started.run.runId, startedAt: 100, status: 'succeeded', finishedAt: 200, counts: { added: 3, duplicate: 2, nonQualifying: 1, blocked: 0, error: 0 } });
    assert.equal(await secondStore.activeDiscoveryRun(), null);
    assert.equal((await secondStore.createDiscoveryRun()).outcome, 'started');
  } finally { await firstStore.close(); await secondStore.close(); await rm(dir, { recursive: true, force: true }); }
});

test('discovery site cursor, counts, and redacted blocked state survive restart', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-discovery-site-')); const url = `file:${path.join(dir, 'jobs.db')}`; const clock = () => 1234;
  const store = new CareerStore(url, { clock });
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const runId = started.run.runId;
  const rawUrl = 'https://linkedin.com/jobs/view/secret?authorization=abcdefghijklmnopqrstuvwxyz';
  const saved = await store.upsertDiscoverySite({ runId, site: 'linkedin.com', status: 'blocked', cursor: 'page:2', counts: { added: 2, duplicate: 3, nonQualifying: 4, blocked: 1, error: 0 }, blockedReason: 'navigation_failed', blockedEvidence: `failed at ${rawUrl}` });
  assert.equal(saved.blockedEvidence, 'failed at [redacted]');
  assert.equal(await store.discoverySiteAddedCount(runId, 'linkedin.com'), 2);
  await store.finishDiscoveryRun({ runId, status: 'succeeded', counts: saved.counts });
  await store.close();

  const reopened = new CareerStore(url, { clock });
  try {
    const persisted = await reopened.getDiscoverySite(runId, 'linkedin.com');
    assert.equal(persisted?.cursor, 'page:2');
    assert.deepEqual(persisted?.counts, { added: 2, duplicate: 3, nonQualifying: 4, blocked: 1, error: 0 });
    assert.equal(persisted?.blockedReason, 'navigation_failed');
    assert.equal(persisted?.blockedSince, 1234);
    assert.doesNotMatch(persisted?.blockedEvidence ?? '', /linkedin|authorization|abcdefghijklmnopqrstuvwxyz/);
    assert.equal((await reopened.latestDiscoverySite('linkedin.com'))?.runId, runId);
    await assert.rejects(() => reopened.upsertDiscoverySite({ runId: 'missing', site: 'indeed.com', status: 'pending', counts: zeroCounts }), /active run/);
  } finally { await reopened.close(); await rm(dir, { recursive: true, force: true }); }
});

test('byCanonicalUrl finds jobs in any status', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-discovery-dedup-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  try {
    const queuedUrl = 'https://linkedin.com/jobs/view/queued'; const succeededUrl = 'https://indeed.com/viewjob?jk=old';
    await store.enqueue({ jobId: 'queued-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'queued-event', originalUrl: queuedUrl, canonicalUrl: queuedUrl });
    await store.enqueue({ jobId: 'old-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'old-event', originalUrl: succeededUrl, canonicalUrl: succeededUrl });
    await store.markRunning('old-job', 'save-run');
    await store.completeWithReport({ jobId: 'old-job', ownerId: 'owner', content: '# Old', summary: 'saved' });
    assert.equal((await store.byCanonicalUrl(queuedUrl))?.status, 'queued');
    assert.equal((await store.byCanonicalUrl(succeededUrl))?.status, 'succeeded');
    assert.equal(await store.byCanonicalUrl('https://naukri.com/job-listings/missing'), null);
  } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
});
