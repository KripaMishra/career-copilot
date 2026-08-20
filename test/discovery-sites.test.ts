import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserGuardError } from '../src/browser/driver.ts';
import { CareerStore } from '../src/storage/career-store.ts';
import { extractCandidateLinks, createDiscoverySiteStep, DISCOVERY_SITE_QUOTA } from '../src/discovery/site-step.ts';
import { DISCOVERY_SITES, stubDiscoverySiteStep, type DiscoverySiteStep } from '../src/discovery/sites.ts';
import { runDiscoveryAndDigest } from '../src/discovery/run.ts';
import type { JobInput } from '../src/contracts/v0.ts';

const linkedinListing = [
  'Staff AI Engineer at Acme',
  'https://www.linkedin.com/jobs/view/101',
  'Platform Engineer; Python, Kubernetes',
  'https://www.linkedin.com/jobs/view/102',
  'Sales Executive (non-AI)',
  'https://www.linkedin.com/jobs/view/103',
  'Senior Data Engineer',
  'https://www.linkedin.com/jobs/view/104',
  'https://www.linkedin.com/jobs/view/104', // intra-page duplicate
  'Off-site noise https://evil.example.com/x',
  'Wrong board https://www.indeed.com/viewjob?jk=99',
].join('\n');

const zero = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };

test('candidate extraction takes only current-site job links, deduped and labelled', () => {
  const candidates = extractCandidateLinks('linkedin.com', linkedinListing);
  assert.equal(candidates.length, 4);
  assert.deepEqual(candidates.map((candidate) => candidate.url), [
    'https://www.linkedin.com/jobs/view/101',
    'https://www.linkedin.com/jobs/view/102',
    'https://www.linkedin.com/jobs/view/103',
    'https://www.linkedin.com/jobs/view/104',
  ]);
  assert.equal(candidates[0].label, 'Staff AI Engineer at Acme');
  assert.equal(candidates[3].label, 'Senior Data Engineer');
  // capped
  assert.equal(extractCandidateLinks('linkedin.com', linkedinListing, 2).length, 2);
  // other boards are not extracted for this site
  assert.equal(extractCandidateLinks('indeed.com', linkedinListing).length, 1);
});

async function withStore<T>(fn: (store: CareerStore) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-discovery-sites-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  try { return await fn(store); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

function siteStep(store: CareerStore, overrides: Partial<Parameters<typeof createDiscoverySiteStep>[0]> = {}) {
  const savedInputs: JobInput[] = [];
  const step = createDiscoverySiteStep({
    store,
    browserRead: async (url) => ({ url, text: linkedinListing }),
    ownerId: 'owner',
    chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: !candidate.url.endsWith('/103') && !candidate.url.endsWith('/104'), reason: 'role matches' })),
    saveJob: async (input) => { savedInputs.push(input); },
    ...overrides,
  });
  return { step, savedInputs };
}

test('real site step qualifies, dedups, and saves through the synthetic context', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI platform engineer; Python; Bengaluru.' });
  const { step, savedInputs } = siteStep(store);
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.status, 'ok');
  // 101 + 102 qualified → added 2; 103 non-qualifying; 104 non-qualifying (qualified=false in fake); intra-page dup and off-site skipped
  assert.deepEqual(result.counts, { added: 2, duplicate: 0, nonQualifying: 2, blocked: 0, error: 0 });
  assert.equal(savedInputs.length, 2);
  assert.ok(savedInputs.every((input) => input.ownerId === 'owner' && input.userId === 'owner' && input.chatId === '2'));
  assert.ok(savedInputs.every((input) => input.transportEventId.startsWith(`disc-${started.run.runId}-linkedin.com-`)));
  assert.ok(savedInputs.every((input) => input.originalUrl === input.canonicalUrl));
}));

test('previously saved (any status) candidates are duplicates: no quota, not re-saved', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  // a queued row for one of the listing's links — previously seen
  await store.enqueue({ jobId: 'seen', userId: 'owner', ownerId: 'owner', chatId: '2', transportEventId: 'seen-event', originalUrl: 'https://www.linkedin.com/jobs/view/101', canonicalUrl: 'https://www.linkedin.com/jobs/view/101' });
  const { step, savedInputs } = siteStep(store);
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.counts.duplicate, 1);
  assert.equal(result.counts.added, 1);
  assert.ok(!savedInputs.some((input) => input.canonicalUrl === 'https://www.linkedin.com/jobs/view/101'));
}));

test('no browser profile means nothing can qualify: all candidates reported non-qualifying, nothing saved', async () => withStore(async (store) => {
  const { step, savedInputs } = siteStep(store); // no profile document
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.status, 'ok');
  assert.equal(result.counts.nonQualifying, 4);
  assert.equal(savedInputs.length, 0);
}));

test('a blocked site read stops only that site with redacted evidence', async () => withStore(async (store) => {
  const blocked = new BrowserGuardError('blocked', 'captcha_challenge', 'url?authorization=abcdefghijklmnopqrstuvwxyz0123456789', 'CAPTCHA challenge');
  const { step } = siteStep(store, { browserRead: async () => { throw blocked; } });
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(result.counts, { added: 0, duplicate: 0, nonQualifying: 0, blocked: 1, error: 0 });
  assert.equal(result.blockedReason, 'captcha_challenge');
  assert.ok(typeof result.blockedEvidence === 'string'); // redacted at the store write boundary
}));

test('no browser (forbidden) fails the site closed as an error', async () => withStore(async (store) => {
  const forbidden = new BrowserGuardError('forbidden', 'browser_not_configured', '', 'BROWSER_CDP_URL is not configured.');
  const { step, savedInputs } = siteStep(store, { browserRead: async () => { throw forbidden; } });
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.status, 'error');
  assert.deepEqual(result.counts, { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 1 });
  assert.equal(savedInputs.length, 0); // no invented saves
}));

test('a failing save is counted as an error and does not stop the remaining saves', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  let calls = 0;
  const { step, savedInputs } = siteStep(store, { saveJob: async (input) => { calls += 1; if (input.canonicalUrl.endsWith('/102')) throw new Error('boom'); savedInputs.push(input); } });
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.counts.added, 1); // 101 saved
  assert.equal(result.counts.error, 1); // 102 failed
  assert.equal(calls, 2);
}));

test('quota bounds saves at 4 qualifying roles per site per run', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  const listing = Array.from({ length: 6 }, (_, index) => `AI Engineer ${index}\nhttps://www.linkedin.com/jobs/view/${200 + index}`).join('\n');
  const saved: string[] = [];
  const step = createDiscoverySiteStep({
    store,
    browserRead: async (url) => ({ url, text: listing }),
    ownerId: 'owner', chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: true, reason: 'matches' })),
    saveJob: async (input) => { saved.push(input.canonicalUrl); },
  });
  const started = await store.createDiscoveryRun(); assert.equal(started.outcome, 'started');
  const result = await step({ runId: started.run.runId, site: 'linkedin.com', cursor: null, addedCount: 0 });
  assert.equal(result.counts.added, DISCOVERY_SITE_QUOTA);
  assert.equal(saved.length, DISCOVERY_SITE_QUOTA);
  assert.equal(result.counts.error, 0);
}));

test('the real site step drives the run shell: per-site rows, dedup across sites, one digest', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  const readings: Record<string, string> = { ...DISCOVERY_SITES.reduce((acc, site) => ({ ...acc, [site]: `Engineer at ${site}\nhttps://${site === 'cutshort.io' ? 'cutshort.io' : `www.${site}`}/job/distinct-${site}` }), {}) };
  const fed: string[] = [];
  const step: DiscoverySiteStep = createDiscoverySiteStep({
    store,
    browserRead: async (url) => { fed.push(url); for (const site of Object.keys(readings)) if (url.includes(site)) return { url, text: readings[site] }; return { url, text: '' }; },
    ownerId: 'owner', chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: true, reason: 'matches' })),
    saveJob: async () => {},
  });
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: step, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(sent.length, 1);
  const sites = await store.listDiscoverySites(outcome.runId);
  assert.equal(sites.length, 5);
  assert.match(sent[0], /Added: 5/);
}));

test('stub step still records error/not-implemented rows without a browser', async () => withStore(async (store) => {
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: stubDiscoverySiteStep, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Errors: 5/);
}));
