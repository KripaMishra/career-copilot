import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BrowserGuardError } from '../src/browser/driver.ts';
import { CareerStore } from '../src/storage/career-store.ts';
import { runOnDemandDiscovery, buildSiteSearchUrl } from '../src/discovery/on-demand.ts';
import { qualifyDiscoveredCandidates, type DiscoveryQualifiedCandidate } from '../src/discovery/qualify.ts';
import { DISCOVERY_SITES } from '../src/discovery/sites.ts';
import { createCareerCopilotRuntime, injectCommand, parseCommand } from '../src/services/career-runtime.ts';
import type { JobInput } from '../src/contracts/v0.ts';

async function withStore<T>(fn: (store: CareerStore) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-on-demand-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  try { return await fn(store); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

function update(id: number, text?: string) {
  return { update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, ...(text === undefined ? {} : { text }) } };
}

function listingFor(site: string, count = 2) {
  const host = site === 'cutshort.io' ? 'cutshort.io' : `www.${site}`;
  return Array.from({ length: count }, (_, index) => `Role ${index} AI at ${site}\nhttps://${host}/job/${site.replace('.', '-')}-${index}`).join('\n');
}

test('parseCommand and route gating for /explore_jobs', async () => withStore(async (store) => {
  assert.deepEqual(parseCommand('/explore_jobs'), { kind: 'exploreJobs' });
  assert.deepEqual(parseCommand('/explore_jobs "LLM engineer"'), { kind: 'exploreJobs', query: 'LLM engineer' });
  assert.deepEqual(parseCommand('/explore_jobs LLM engineer'), { kind: 'exploreJobs', query: 'LLM engineer' });
  assert.deepEqual(parseCommand('/explore-jobs AI'), { kind: 'exploreJobs', query: 'AI' });
  assert.throws(() => injectCommand('/explore_jobs'), /runtime routing/i);
}));

test('qualification warns on model drop-out and threads an inline query into the prompt', async () => {
  const queries: string[] = []; const warns: string[] = [];
  const refs = [
    { url: 'https://www.indeed.com/viewjob?jk=1', label: 'AI Engineer' },
    { url: 'https://www.indeed.com/viewjob?jk=2', label: 'Data Engineer' },
    { url: 'https://www.indeed.com/viewjob?jk=3', label: 'Platform Engineer' },
  ];
  const agent = {
    generate: async (text: string) => { queries.push(text); return { object: { candidates: [{ url: refs[0].url, label: refs[0].label, qualified: true, reason: 'ok' }] } }; },
  };
  const verdicts = await qualifyDiscoveredCandidates(agent, refs, 'profile text', 'LLM engineer', (level, event) => { if (level === 'warn') warns.push(event); });
  assert.equal(verdicts.length, 1); // model dropped two verdicts
  assert.ok(warns.includes('discovery.qualification.verdicts_missing'));
  assert.ok(queries[0].includes('LLM engineer')); // query flows into the prompt
});

test('a full on-demand pass persists rows without a lease and returns a one-message summary', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI platform engineer.' });
  const savedInputs: JobInput[] = [];
  const seenQueries: (string | undefined)[] = [];
  const siteFromUrl = (url: string) => DISCOVERY_SITES.find((site) => url.includes(site)) ?? 'indeed.com';
  const result = await runOnDemandDiscovery({
    store,
    browserRead: async (url) => ({ url, text: listingFor(siteFromUrl(url), 2) }),
    ownerId: 'owner', chatId: '2',
    qualify: async (candidates, _profile, query) => { seenQueries.push(query); return candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: true, reason: 'matches' })); },
    saveJob: async (input) => { savedInputs.push(input); return { jobId: input.jobId, summary: `saved ${input.canonicalUrl}` }; },
  });
  assert.equal(result.outcome, 'succeeded');
  assert.ok(result.runId.startsWith('ondemand-'));
  assert.ok(result.summary.includes('On-demand job search'));
  assert.match(result.summary, /On-demand pass/);
  assert.match(result.summary, /Added: 10/); // 5 sites × 2 qualifying each
  // persisted non-lease: the pass row exists, nothing is left running
  const pass = await store.getDiscoveryRun(result.runId);
  assert.ok(pass && pass.status === 'succeeded');
  assert.equal(await store.activeDiscoveryRun(), null);
  assert.equal((await store.listDiscoverySites(result.runId)).length, 5);
  // no synthetic jobs are actually persisted by the fake saveJob, so no saved-role section
  assert.ok(!result.summary.includes('Saved roles:'));
  assert.deepEqual(seenQueries, [undefined, undefined, undefined, undefined, undefined]); // no inline query
  assert.ok(savedInputs.every((input) => input.transportEventId.startsWith(`disc-${result.runId}-`)));
}));

test('an on-demand pass never holds the running lease, so a scheduled fire can still start', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  const pass = await runOnDemandDiscovery({
    store, browserRead: async (url) => ({ url, text: listingFor('indeed.com', 1) }), ownerId: 'owner', chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: true, reason: 'ok' })),
    saveJob: async (input) => {
      await store.enqueue({ jobId: input.jobId, userId: input.userId, ownerId: input.ownerId, chatId: input.chatId, transportEventId: input.transportEventId, originalUrl: input.originalUrl, canonicalUrl: input.canonicalUrl });
      await store.markRunning(input.jobId, 'ondemand');
      await store.completeWithReport({ jobId: input.jobId, ownerId: input.ownerId, content: `# ${input.canonicalUrl}\n`, summary: `Saved ${input.canonicalUrl}` });
      return { jobId: input.jobId };
    },
  });
  // the pass persisted jobs (real enqueue + completion) and recorded rows; the saved-role section lists them
  assert.ok(pass.summary.includes('Saved roles:'));
  // ...but the daily lease is free: a scheduled fire can still start
  const next = await store.createDiscoveryRun();
  assert.equal(next.outcome, 'started');
  await store.finishDiscoveryRun({ runId: next.run.runId, status: 'succeeded', counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 } });
}));

test('Saved roles lists only roles that actually succeeded, never a failed sibling', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  const pass = await runOnDemandDiscovery({
    store, browserRead: async (url) => ({ url, text: listingFor('indeed.com', 1) }), ownerId: 'owner', chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: true, reason: 'ok' })),
    saveJob: async (input) => {
      await store.enqueue({ jobId: input.jobId, userId: input.userId, ownerId: input.ownerId, chatId: input.chatId, transportEventId: input.transportEventId, originalUrl: input.originalUrl, canonicalUrl: input.canonicalUrl });
      await store.markRunning(input.jobId, 'ondemand');
      await store.completeWithReport({ jobId: input.jobId, ownerId: input.ownerId, content: `# ${input.canonicalUrl}\n`, summary: `Saved ${input.canonicalUrl}` });
      // a same-site sibling that enqueued but then failed — present during the pass
      await store.enqueue({ jobId: 'failed-role', userId: input.userId, ownerId: input.ownerId, chatId: input.chatId, transportEventId: input.transportEventId.replace(/-0$/, '-555'), originalUrl: 'https://www.indeed.com/viewjob?jk=failed', canonicalUrl: 'https://www.indeed.com/viewjob?jk=failed' });
      await store.markRunning('failed-role', 'ondemand');
      await store.fail('failed-role', new Error('analysis failed'));
    },
  });
  assert.ok(pass.summary.includes('Saved roles:'));
  assert.match(pass.summary, /Saved https:\/\/www\.indeed\.com\/job\/indeed-com-0/);
  assert.ok(!pass.summary.includes('jk=failed')); // the failed sibling is not reported as saved
}));

test('runtime catches an exploreJobs handler throw and replies instead of rejecting', async () => withStore(async (store) => {
  let agentCalls = 0;
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({
    ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store,
    exploreJobs: async () => { throw new Error('boom'); },
    respond: async () => { agentCalls++; return 'agent'; },
  });
  const result = await runtime.handleTelegramUpdate(update(920, '/explore_jobs'), async (text) => { replies.push(text); });
  assert.equal(result.outcome, 'accepted'); // never rejects through the poll loop
  assert.equal(agentCalls, 0);
  assert.match(replies[0], /failed/i);
  await runtime.close();
}));

test('blocked sites are reported for that site only and never retried in the pass', async () => withStore(async (store) => {
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Staff AI engineer.' });
  const blockedSites = new Set(['cutshort.io']);
  const navigated: string[] = [];
  const result = await runOnDemandDiscovery({
    store,
    browserRead: async (url) => { navigated.push(url); if (blockedSites.has('cutshort.io') && url.includes('cutshort.io')) throw new BrowserGuardError('blocked', 'captcha_challenge', 'evidence with a long token 123456789012345678901234567890', 'CAPTCHA'); return { url, text: listingFor('indeed.com', 1) }; },
    ownerId: 'owner', chatId: '2',
    qualify: async (candidates) => candidates.map((candidate) => ({ url: candidate.url, label: candidate.label, qualified: false, reason: 'nope' })),
    saveJob: async () => {},
  });
  const sites = await store.listDiscoverySites(result.runId);
  const blockedRow = sites.find((site) => site.site === 'cutshort.io');
  assert.equal(blockedRow?.status, 'blocked');
  assert.equal(blockedRow?.counts.blocked, 1);
  assert.match(result.summary, /Blocked: 1/);
  // every site still got exactly one attempt (no in-pass retry)
  assert.equal(navigated.length, DISCOVERY_SITES.length);
}));

test('without a browser every site fails closed and nothing is invented as saved', async () => withStore(async (store) => {
  const forbidden = new BrowserGuardError('forbidden', 'browser_not_configured', '', 'BROWSER_CDP_URL is not configured.');
  const result = await runOnDemandDiscovery({
    store, browserRead: async () => { throw forbidden; }, ownerId: 'owner', chatId: '2',
    qualify: async () => { throw new Error('should not be called'); },
    saveJob: async () => { throw new Error('should not be called'); },
  });
  assert.match(result.summary, /Errors: 5/);
  assert.match(result.summary, /Added: 0/);
  assert.ok(!result.summary.includes('Saved roles:'));
  const sites = await store.listDiscoverySites(result.runId);
  assert.ok(sites.every((site) => site.status === 'error'));
}));

test('site search URLs stay on authorized HTTPS hosts', () => {
  for (const site of DISCOVERY_SITES) {
    const url = buildSiteSearchUrl(site, 'LLM engineer');
    assert.match(url, /^https:\/\/(?:www\.)?/);
    assert.ok(url.includes(site));
  }
});

test('runtime routes /explore_jobs to the handler without invoking the agent', async () => withStore(async (store) => {
  let agentCalls = 0;
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({
    ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store,
    exploreJobs: async (command) => `explored:${command.query ?? 'none'}`,
    respond: async () => { agentCalls++; return 'agent'; },
  });
  await runtime.handleTelegramUpdate(update(910, '/explore_jobs "LLM engineer"'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(911, '/explore_jobs'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(912, '/explore'), async (text) => { replies.push(text); });
  assert.equal(agentCalls, 0);
  assert.equal(replies[0], 'explored:LLM engineer');
  assert.equal(replies[1], 'explored:none');
  assert.match(replies[2], /usage/i);
  await runtime.close();
}));

test('qualification verdict types are the shared DiscoveryQualifiedCandidate shape', () => {
  const verdict: DiscoveryQualifiedCandidate = { url: 'https://www.indeed.com/viewjob?jk=1', label: 'AI Engineer', qualified: true, reason: 'matches' };
  assert.equal(verdict.qualified, true);
});
