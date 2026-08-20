import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerStore } from '../src/storage/career-store.ts';
import { runDiscoveryAndDigest } from '../src/discovery/run.ts';
import { buildDiscoveryDigest } from '../src/discovery/digest.ts';
import { DISCOVERY_SITES, stubDiscoverySiteStep, type DiscoverySiteStep, type DiscoverySiteStepResult } from '../src/discovery/sites.ts';
import { ensureJobDiscoverySchedule, resolveDiscoveryTimezone, isValidIanaTimezone, DEFAULT_DISCOVERY_TIMEZONE, JOB_DISCOVERY_SCHEDULE_ID, JOB_DISCOVERY_CRON } from '../src/discovery/schedule.ts';
import { createDiscoveryCommandHandler } from '../src/discovery/commands.ts';
import { createCareerCopilotRuntime, injectCommand, parseCommand } from '../src/services/career-runtime.ts';
import { buildOnboardingProfileText } from '../src/contracts/onboarding.ts';

const zeroCounts = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };

async function withStore<T>(fn: (store: CareerStore) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-discovery-run-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  try { return await fn(store); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

function update(id: number, text?: string) {
  return { update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, ...(text === undefined ? {} : { text }) } };
}

type FakeSchedule = { id: string; workflowId: string; cron: string; timezone?: string; status: 'active' | 'paused'; nextFireAt: number };
function fakeSchedules(initial: FakeSchedule | null = null) {
  let row: FakeSchedule | null = initial;
  const calls: string[] = [];
  return {
    calls,
    get: async (id: string) => { calls.push(`get:${id}`); return row; },
    create: async (input: { id: string; workflowId: string; cron: string; timezone: string; status: 'active' | 'paused' }) => { calls.push(`create:${input.id}`); row = { id: input.id, workflowId: input.workflowId, cron: input.cron, timezone: input.timezone, status: input.status, nextFireAt: 1789977600000 }; return row; },
    update: async (id: string, patch: { cron?: string; timezone?: string; status?: 'active' | 'paused' }) => { calls.push(`update:${id}`); if (row) row = { ...row, ...patch, id }; return row!; },
    pause: async (id: string) => { calls.push(`pause:${id}`); if (row) row = { ...row, status: 'paused' }; return row!; },
    resume: async (id: string) => { calls.push(`resume:${id}`); if (row) row = { ...row, status: 'active' }; return row!; },
  };
}

const orderedResults: Record<string, DiscoverySiteStepResult> = {
  'linkedin.com': { status: 'ok', counts: { added: 2, duplicate: 1, nonQualifying: 0, blocked: 0, error: 0 } },
  'foundit.in': { status: 'blocked', counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 1, error: 0 }, blockedReason: 'navigation_failed', blockedEvidence: 'failed at https://secret.example/authorization=abc' },
  'cutshort.io': { status: 'ok', counts: { added: 1, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 } },
  'naukri.com': { status: 'error', counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 1 } },
  'indeed.com': { status: 'ok', counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 } },
};

test('run walks all five sites in strict order, persists per-site rows, and sends one digest', async () => withStore(async (store) => {
  const order: string[] = [];
  const step: DiscoverySiteStep = async ({ site }) => { order.push(site); return orderedResults[site]; };
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: step, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.equal(outcome.digestSent, true);
  assert.deepEqual(order, DISCOVERY_SITES);
  const sites = await store.listDiscoverySites(outcome.runId);
  assert.equal(sites.length, 5);
  assert.equal((await store.getDiscoverySite(outcome.runId, 'foundit.in'))?.status, 'blocked');
  assert.equal((await store.getDiscoverySite(outcome.runId, 'foundit.in'))?.counts.blocked, 1);
  assert.equal((await store.getDiscoverySite(outcome.runId, 'naukri.com'))?.status, 'error');
  assert.equal(sent.length, 1); // exactly one digest
  assert.equal(outcome.digest, sent[0]);
  // aggregate counts summed across per-site rows onto the run row
  const run = (await store.latestDiscoveryRun())!;
  assert.deepEqual(run.counts, { added: 3, duplicate: 1, nonQualifying: 0, blocked: 1, error: 1 });
  // redacted evidence only ever reaches the row
  assert.doesNotMatch((await store.getDiscoverySite(outcome.runId, 'foundit.in'))?.blockedEvidence ?? '', /secret\.example|authorization=abc/);
}));

test('a throwing site step is contained as an error row and does not stop the others', async () => withStore(async (store) => {
  const order: string[] = [];
  const step: DiscoverySiteStep = async ({ site }) => { order.push(site); if (site === 'naukri.com') throw new Error('boom'); return { status: 'ok', counts: { ...zeroCounts, added: 1 } }; };
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: step, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'succeeded');
  assert.deepEqual(order, DISCOVERY_SITES);
  const sites = await store.listDiscoverySites(outcome.runId);
  assert.equal(sites.length, 5);
  assert.equal((await store.getDiscoverySite(outcome.runId, 'naukri.com'))?.status, 'error');
  assert.equal((await store.getDiscoverySite(outcome.runId, 'naukri.com'))?.counts.error, 1);
  assert.equal((await store.getDiscoverySite(outcome.runId, 'indeed.com'))?.status, 'ok');
  assert.equal(sent.length, 1);
}));

test('stub site step records an error/not-implemented outcome per site and the run still finishes', async () => withStore(async (store) => {
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: stubDiscoverySiteStep, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'succeeded');
  const sites = await store.listDiscoverySites(outcome.runId);
  assert.equal(sites.length, 5);
  assert.ok(sites.every((site) => site.status === 'error' && site.counts.error === 1));
  assert.equal(sent.length, 1);
  assert.match(sent[0], /Errors: 5/);
}));

test('overlapping fire is skipped via the lease and sends no digest', async () => withStore(async (store) => {
  await store.createDiscoveryRun(); // a previous fire still owns the lease
  const sent: string[] = [];
  const outcome = await runDiscoveryAndDigest({ store, siteStep: stubDiscoverySiteStep, send: async (text) => { sent.push(text); } });
  assert.equal(outcome.outcome, 'skipped_overlap');
  assert.equal(sent.length, 0); // no digest on skip
  const runs = (await store.latestDiscoveryRun())!;
  assert.equal(runs.status, 'running'); // the first fire's lease is untouched
  assert.equal((await store.listDiscoverySites(runs.runId)).length, 0); // no site writes
}));

test('digest builder formats per-site counts and the run outcome from persisted rows', async () => withStore(async (store) => {
  const outcome = await runDiscoveryAndDigest({ store, siteStep: async ({ site }) => orderedResults[site], send: async () => {} });
  const run = (await store.latestDiscoveryRun())!;
  const sites = await store.listDiscoverySites(run.runId);
  const digest = buildDiscoveryDigest({ run, sites });
  assert.match(digest, /^Daily discovery run/);
  assert.match(digest, /Outcome: succeeded · Sites: 5 · Added: 3 · Duplicates: 1 · Non-qualifying: 0 · Blocked: 1 · Errors: 1/);
  assert.match(digest, /linkedin\.com: added 2 · dup 1 · non-qual 0 · blocked 0 · error 0/);
  assert.match(digest, /foundit\.in: added 0 · dup 0 · non-qual 0 · blocked 1 · error 0/);
  assert.ok(outcome.outcome !== 'skipped_overlap');
}));

test('schedule registration is idempotent and re-registers when the timezone changes', async () => withStore(async (store) => {
  const schedules = fakeSchedules();
  const first = await ensureJobDiscoverySchedule({ schedules, store, ownerId: 'owner' });
  assert.equal(first.timezone, DEFAULT_DISCOVERY_TIMEZONE); // no captured timezone yet
  assert.equal(first.reRegistered, false);
  assert.ok(schedules.calls.includes(`create:${JOB_DISCOVERY_SCHEDULE_ID}`));
  const afterCreate = schedules.calls.filter((call) => call.startsWith('create') || call.startsWith('update')).length;
  const second = await ensureJobDiscoverySchedule({ schedules, store, ownerId: 'owner' });
  assert.equal(second.reRegistered, false);
  assert.equal(schedules.calls.filter((call) => call.startsWith('create') || call.startsWith('update')).length, afterCreate); // idempotent — no create/update
  // captured timezone drives re-registration on the next boot
  await store.saveProfileDocument({ ownerId: 'owner', name: 'onboarding.md', content: 'Timezone: America/New_York' });
  const third = await ensureJobDiscoverySchedule({ schedules, store, ownerId: 'owner' });
  assert.equal(third.timezone, 'America/New_York');
  assert.equal(third.reRegistered, true);
  assert.ok(schedules.calls.includes(`update:${JOB_DISCOVERY_SCHEDULE_ID}`));
  // a changed cron also re-registers in place
  const before = schedules.calls.length;
  const fourth = await ensureJobDiscoverySchedule({ schedules, store, ownerId: 'owner', cron: '0 6 * * *' });
  assert.equal(fourth.reRegistered, true);
  assert.ok(schedules.calls.length > before);
}));

test('timezone resolution validates IANA names, maps cities, and falls back to Asia/Kolkata', () => {
  assert.equal(isValidIanaTimezone('Asia/Kolkata'), true);
  assert.equal(isValidIanaTimezone('America/New_York'), true);
  assert.equal(isValidIanaTimezone('Not/AZone'), false);
  assert.equal(resolveDiscoveryTimezone(null), 'Asia/Kolkata');
  assert.equal(resolveDiscoveryTimezone('Not/AZone'), 'Asia/Kolkata');
  assert.equal(resolveDiscoveryTimezone('Asia/Calcutta'), 'Asia/Calcutta');
  // city answers (onboarding accepts a city, spec D9) normalize to IANA zones
  assert.equal(resolveDiscoveryTimezone('New York'), 'America/New_York');
  assert.equal(resolveDiscoveryTimezone('Bengaluru'), 'Asia/Kolkata');
  assert.equal(resolveDiscoveryTimezone('london'), 'Europe/London'); // case-insensitive
  assert.equal(resolveDiscoveryTimezone('San Francisco, USA'), 'America/Los_Angeles'); // comma suffix stripped
  assert.equal(resolveDiscoveryTimezone('Asia/Kolkata, India'), 'Asia/Kolkata'); // zone + country suffix
});

test('unusable captured timezone logs a fallback warning, valid zones and mapped cities do not', async () => withStore(async (store) => {
  const events: Array<{ level: string; event: string; data?: unknown }> = [];
  const logger = (level: string, event: string, data?: unknown) => { events.push({ level, event, data }); };
  const schedules = fakeSchedules();
  await store.saveProfileDocument({ ownerId: 'owner', name: 'onboarding.md', content: 'Timezone: Not/AZone' });
  await ensureJobDiscoverySchedule({ schedules, store, ownerId: 'owner', logger });
  const warn = events.filter((e) => e.level === 'warn');
  assert.equal(warn.length, 1);
  assert.equal(warn[0]!.event, 'discovery.schedule.timezone_fallback');
  // a valid IANA zone and a mapped city resolve without warning
  await store.saveProfileDocument({ ownerId: 'owner', name: 'onboarding.md', content: 'Timezone: America/New_York' });
  const schedules2 = fakeSchedules(); const events2: typeof events = [];
  await ensureJobDiscoverySchedule({ schedules: schedules2, store, ownerId: 'owner', logger: (l, e, d) => { events2.push({ level: l, event: e, data: d }); } });
  assert.equal(events2.filter((e) => e.level === 'warn').length, 0);
  await store.saveProfileDocument({ ownerId: 'owner', name: 'onboarding.md', content: 'Timezone: Bengaluru' });
  const schedules3 = fakeSchedules(); const events3: typeof events = [];
  const reg = await ensureJobDiscoverySchedule({ schedules: schedules3, store, ownerId: 'owner', logger: (l, e, d) => { events3.push({ level: l, event: e, data: d }); } });
  assert.equal(reg.timezone, 'Asia/Kolkata');
  assert.equal(events3.filter((e) => e.level === 'warn').length, 0);
}));

test('captured timezone is read from the canonical onboarding profile document only', async () => withStore(async (store) => {
  assert.equal(await store.capturedTimezone('owner'), null);
  assert.match(buildOnboardingProfileText({ currentStatus: 'x', timezone: 'Asia/Kolkata' }), /Timezone: Asia\/Kolkata/);
  await store.saveProfileDocument({ ownerId: 'owner', name: 'onboarding.md', content: '# Profile\nTimezone: America/New_York\n' });
  assert.equal(await store.capturedTimezone('owner'), 'America/New_York');
  assert.equal(await store.capturedTimezone('nobody'), null);
}));

test('discovery status shows next fire in the schedule timezone, not the host timezone', async () => withStore(async (store) => {
  const schedules = fakeSchedules({ id: JOB_DISCOVERY_SCHEDULE_ID, workflowId: 'jobDiscovery', cron: JOB_DISCOVERY_CRON, timezone: 'America/New_York', status: 'active', nextFireAt: 1789977600000 });
  const handler = createDiscoveryCommandHandler({ schedules, store, ownerId: 'owner' });
  const reply = await handler({ kind: 'discovery', action: 'status' });
  assert.match(reply, /Discovery schedule: active · next fire/);
  assert.match(reply, /America\/New_York/);
  assert.match(reply, /04:00 am/);   // the NY wall-clock time of the fire
  assert.doesNotMatch(reply, /01:30 pm/); // and not the host-IST interpretation
  assert.match(reply, /No discovery runs yet/);
  // a paused schedule reports paused
  const pausedSchedules = fakeSchedules({ id: JOB_DISCOVERY_SCHEDULE_ID, workflowId: 'jobDiscovery', cron: JOB_DISCOVERY_CRON, timezone: 'America/New_York', status: 'paused', nextFireAt: 1789977600000 });
  const replyPaused = await createDiscoveryCommandHandler({ schedules: pausedSchedules, store, ownerId: 'owner' })({ kind: 'discovery', action: 'status' });
  assert.match(replyPaused, /paused/);
}));

test('discovery status includes the last run summary with per-site counts', async () => withStore(async (store) => {
  await runDiscoveryAndDigest({ store, siteStep: async ({ site }) => orderedResults[site], send: async () => {} });
  const schedules = fakeSchedules({ id: JOB_DISCOVERY_SCHEDULE_ID, workflowId: 'jobDiscovery', cron: JOB_DISCOVERY_CRON, timezone: 'Asia/Kolkata', status: 'active', nextFireAt: 1789977600000 });
  const reply = await createDiscoveryCommandHandler({ schedules, store, ownerId: 'owner' })({ kind: 'discovery', action: 'status' });
  assert.match(reply, /Daily discovery run/);
  assert.match(reply, /linkedin\.com: added 2 · dup 1/);
  assert.match(reply, /Errors: 1/);
}));

test('discovery on/off resume and pause the schedule with confirmations', async () => withStore(async (store) => {
  const schedules = fakeSchedules({ id: JOB_DISCOVERY_SCHEDULE_ID, workflowId: 'jobDiscovery', cron: JOB_DISCOVERY_CRON, timezone: 'Asia/Kolkata', status: 'active', nextFireAt: 1789977600000 });
  const handler = createDiscoveryCommandHandler({ schedules, store, ownerId: 'owner' });
  const on = await handler({ kind: 'discovery', action: 'on' });
  assert.match(on, /enabled/i);
  assert.match(on, /Asia\/Kolkata/);
  assert.ok(schedules.calls.includes(`resume:${JOB_DISCOVERY_SCHEDULE_ID}`));
  const off = await handler({ kind: 'discovery', action: 'off' });
  assert.match(off, /disabled/i);
  assert.ok(schedules.calls.includes(`pause:${JOB_DISCOVERY_SCHEDULE_ID}`));
  // without a registered schedule, commands refuse without touching pause/resume
  const empty = fakeSchedules(null);
  const unregistered = createDiscoveryCommandHandler({ schedules: empty, store, ownerId: 'owner' });
  assert.match(await unregistered({ kind: 'discovery', action: 'status' }), /not registered/i);
  assert.match(await unregistered({ kind: 'discovery', action: 'on' }), /not registered/i);
  assert.equal(empty.calls.includes(`resume:${JOB_DISCOVERY_SCHEDULE_ID}`), false);
}));

test('runtime routes /discovery to the handler without invoking the agent', async () => withStore(async (store) => {
  assert.deepEqual(parseCommand('/discovery'), { kind: 'discovery', action: 'status' });
  assert.deepEqual(parseCommand('/discovery on'), { kind: 'discovery', action: 'on' });
  assert.deepEqual(parseCommand('/discovery off'), { kind: 'discovery', action: 'off' });
  assert.throws(() => injectCommand('/discovery status'), /runtime routing/i);
  let agentCalls = 0;
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({
    ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store,
    discovery: async (command) => `discovery:${command.action}`,
    respond: async () => { agentCalls++; return 'agent'; },
  });
  await runtime.handleTelegramUpdate(update(900, '/discovery status'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(901, '/discovery bogus'), async (text) => { replies.push(text); });
  assert.equal(agentCalls, 0);
  assert.equal(replies[0], 'discovery:status');
  assert.match(replies[1], /usage/i);
  await runtime.close();
}));
