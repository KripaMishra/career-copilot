import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { CareerStore } from '../src/storage/career-store.ts';
import { createCareerCopilotRuntime, createOnboardingResponder, handleOnboardingTurn, injectCommand, parseCommand, type OnboardingResponder } from '../src/services/career-runtime.ts';
import { OnboardingDraftSchema, buildOnboardingProfileText, onboardingMissingFields } from '../src/contracts/onboarding.ts';
import { executeSaveJob } from '../src/tools/save-job-tool.ts';

const draft = {
  currentStatus: 'Senior backend engineer, currently employed.',
  experience: 'Eight years building TypeScript, Node, and data products.',
  education: 'B.Tech Computer Science.',
  skills: 'TypeScript, Node.js, SQL, LLM systems.',
  projects: 'Built retrieval and agentic workflow projects.',
  achievements: 'Led launches that improved activation by 20%.',
  targetRoles: 'Staff product engineer and AI platform roles.',
  locationPreferences: 'Bengaluru or remote; open to relocation for the right role.',
  workAuthorization: 'Authorized to work in India; sponsorship needed elsewhere.',
  employmentPreferences: 'Full-time, available after notice period.',
  compensation: 'Market compensation; flexible for mission fit.',
  motivators: 'Strengths: product sense. Growth: leadership. Likes autonomy; dislikes bureaucracy; deal-breaker unpaid overtime.',
  careerGoals: 'Grow into AI product/platform leadership.',
  exampleJob: 'AI platform staff engineer at a product company.',
};

function update(id: number, text?: string, extra: Record<string, unknown> = {}) {
  return { update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, ...(text === undefined ? {} : { text }), ...extra } };
}

async function withStore<T>(fn: (store: CareerStore, file: string) => Promise<T>) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-onboarding-')); const file = path.join(dir, 'jobs.db'); const store = new CareerStore(`file:${file}`);
  try { return await fn(store, file); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

function result(rows: Record<string, unknown>[] = [], rowsAffected = 0) {
  return { columns: [], columnTypes: [], rows, rowsAffected, lastInsertRowid: undefined, toJSON: () => ({ rows, rowsAffected }) };
}

function onboardingRow(version = 2, status = 'review') {
  return { owner_id: 'owner', conversation_id: 'telegram:2', status, draft_json: JSON.stringify(draft), version, created_at: 1, updated_at: 1 };
}

function sequentialOnboarder(): OnboardingResponder {
  return async ({ text, missingFields }) => ({ reply: `Saved. ${missingFields[1] ? `Next: ${missingFields[1]}` : 'Ready to review.'}`, draftPatch: missingFields[0] ? { [missingFields[0]]: text } : {}, readyForReview: missingFields.length <= 1 });
}

test('onboarding command parsing and channel-neutral handler use dedicated routing', async () => withStore(async (store) => {
  assert.deepEqual(parseCommand('/onboarding'), { kind: 'onboarding', action: 'start' });
  assert.deepEqual(parseCommand('/onboarding restart'), { kind: 'onboarding', action: 'restart' });
  assert.deepEqual(parseCommand('/onboarding cancel'), { kind: 'onboarding', action: 'cancel' });
  assert.throws(() => injectCommand('/onboarding'), /runtime routing/i);
  assert.equal(parseCommand('/save https://linkedin.com/jobs/1')?.kind, 'save');
  const reply = await handleOnboardingTurn({ store, ownerId: 'owner', conversationId: 'telegram:2', text: '/onboarding' });
  assert.match(reply ?? '', /current role/i);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'collecting');
}));

test('onboarding draft validation is strict structured career data without raw resume fields', () => {
  assert.deepEqual(OnboardingDraftSchema.parse(draft), draft);
  assert.deepEqual(onboardingMissingFields({ ...draft, skills: '' }), ['skills']);
  assert.throws(() => OnboardingDraftSchema.parse({ ...draft, legalName: 'Nope' }), /Unrecognized key|unrecognized/i);
  assert.throws(() => OnboardingDraftSchema.parse({ ...draft, rawResume: 'Nope' }), /Unrecognized key|unrecognized/i);
  assert.match(buildOnboardingProfileText(OnboardingDraftSchema.parse(draft)), /Target roles: Staff product engineer/);
});

test('onboarding store is owner and conversation scoped with optimistic versions and cancellation clearing content', async () => withStore(async (store) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  assert.equal(started.status, 'collecting'); assert.equal(started.version, 1);
  const saved = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: draft.currentStatus } });
  assert.equal(saved.version, 2);
  await assert.rejects(() => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: 'stale' } }), /stale/i);
  assert.equal(await store.loadOnboarding('other', 'telegram:2'), null);
  const cancelled = await store.cancelOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: saved.version });
  assert.equal(cancelled.status, 'cancelled'); assert.deepEqual(cancelled.draft, {});
}));

test('stale cancel cannot erase a newer saved or completed onboarding state', async () => {
  const client = {
    state: onboardingRow(3, 'review'),
    async batch() { return [result()]; },
    async execute(stmt: unknown) {
      const sql = typeof stmt === 'string' ? stmt : String((stmt as { sql: string }).sql);
      if (sql.startsWith('PRAGMA')) return result([]);
      if (sql.startsWith('SELECT * FROM career_onboarding')) return result([onboardingRow(2, 'review')]);
      if (sql.startsWith('UPDATE career_onboarding')) {
        if (/version=\?/i.test(sql) && /status IN/i.test(sql)) return result([], 0);
        this.state = { ...this.state, status: 'cancelled', draft_json: '{}', version: 4 };
        return result([], 1);
      }
      return result([]);
    },
    close() {},
  };
  const store = new CareerStore(client as never);
  await assert.rejects(() => store.cancelOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: 2 }), /stale/i);
  assert.equal(client.state.status, 'review');
  assert.notEqual(client.state.draft_json, '{}');
});

test('stale completion does not deactivate or insert profile documents', async () => {
  const profileWrites: string[] = [];
  const tx = {
    closed: false,
    async execute(stmt: unknown) {
      const sql = typeof stmt === 'string' ? stmt : String((stmt as { sql: string }).sql);
      if (sql.startsWith('SELECT * FROM career_onboarding')) return result([onboardingRow(2, 'review')]);
      if (sql.startsWith('UPDATE career_onboarding')) return result([], 0);
      if (sql.startsWith('UPDATE career_profile_documents') || sql.startsWith('INSERT INTO career_profile_documents')) profileWrites.push(sql);
      if (sql.startsWith('SELECT COALESCE(MAX(version)')) return result([{ version: 3 }]);
      return result([]);
    },
    async batch(stmts: unknown[]) { profileWrites.push(...stmts.map((stmt) => String((stmt as { sql: string }).sql))); return [result(), result(), result([], 0)]; },
    async commit() {},
    async rollback() { this.closed = true; },
    close() { this.closed = true; },
  };
  const client = {
    async batch() { return [result()]; },
    async execute(stmt: unknown) { const sql = typeof stmt === 'string' ? stmt : String((stmt as { sql: string }).sql); return sql.startsWith('PRAGMA') ? result([]) : result([onboardingRow(2, 'review')]); },
    async transaction(mode: string) { assert.equal(mode, 'write'); return tx; },
    close() {},
  };
  const store = new CareerStore(client as never);
  await assert.rejects(() => store.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: 2 }), /stale/i);
  assert.deepEqual(profileWrites, []);
  assert.equal(tx.closed, true);
});

test('runtime starts, resumes, asks one question, and blocks save/file inputs while active', async () => withStore(async (store) => {
  const agentTurns: unknown[] = []; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: sequentialOnboarder(), respond: async (turn) => { agentTurns.push(turn); return 'agent'; } });
  await runtime.handleTelegramUpdate(update(1, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(2, draft.currentStatus), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(3, '/save https://linkedin.com/jobs/1'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(4, 'here is my resume.pdf'), async (text) => { replies.push(text); });
  assert.equal(agentTurns.length, 0);
  assert.match(replies[0], /current role/i);
  assert.match(replies[1], /experience/i);
  assert.match(replies[2], /finish or cancel onboarding/i);
  assert.match(replies[3], /resume.*unavailable|file.*unavailable/i);
  await runtime.handleTelegramUpdate(update(6, '/onboarding'), async (text) => { replies.push(text); });
  assert.match(replies[4], /experience/i);
  await runtime.close();
}));

test('onboarding accepts 1001 to 4000 character structured answers and gives length-specific over-limit response', async () => withStore(async (store) => {
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: sequentialOnboarder(), respond: async () => 'agent' });
  await runtime.handleTelegramUpdate(update(100, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(101, 'a'.repeat(1001)), async (text) => { replies.push(text); });
  assert.match(replies.at(-1) ?? '', /experience/i);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.draft.currentStatus?.length, 1001);
  await runtime.handleTelegramUpdate(update(102, 'b'.repeat(4001)), async (text) => { replies.push(text); });
  assert.match(replies.at(-1) ?? '', /4000|too long/i);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.draft.experience, undefined);
  await runtime.close();
}));

test('onboarding turns are serialized with normal turns so concurrent answers do not race', async () => withStore(async (store) => {
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: sequentialOnboarder(), respond: async () => 'agent' });
  await runtime.handleTelegramUpdate(update(200, '/onboarding'), async (text) => { replies.push(text); });
  await Promise.all([
    runtime.handleTelegramUpdate(update(201, draft.currentStatus), async (text) => { replies.push(text); }),
    runtime.handleTelegramUpdate(update(202, draft.experience), async (text) => { replies.push(text); }),
  ]);
  const state = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(state?.draft.currentStatus, draft.currentStatus);
  assert.equal(state?.draft.experience, draft.experience);
  assert.equal(replies.filter((reply) => /stale|internal|error/i.test(reply)).length, 0);
  await runtime.close();
}));

test('a normal turn finishes before a concurrently received onboarding command starts', async () => withStore(async (store) => {
  let releaseAgent!: () => void;
  let markAgentStarted!: () => void;
  const agentStarted = new Promise<void>((resolve) => { markAgentStarted = resolve; });
  const agentReleased = new Promise<void>((resolve) => { releaseAgent = resolve; });
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => { markAgentStarted(); await agentReleased; return 'normal reply'; } });
  const normal = runtime.handleTelegramUpdate(update(210, 'hello'), async (text) => { replies.push(text); });
  const onboarding = runtime.handleTelegramUpdate(update(211, '/onboarding'), async (text) => { replies.push(text); });
  await agentStarted;
  assert.equal(await store.loadOnboarding('owner', 'telegram:2'), null);
  releaseAgent();
  await Promise.all([normal, onboarding]);
  assert.match(replies[0], /normal reply/);
  assert.match(replies[1], /current role/i);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'collecting');
  await runtime.close();
}));

test('runtime supports review, edit, explicit confirmation, cancellation, and clean restart', async () => withStore(async (store) => {
  const replies: string[] = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: sequentialOnboarder(), respond: async () => 'agent' });
  let id = 10; const send = (text: string) => runtime.handleTelegramUpdate(update(id++, text), async (reply) => { replies.push(reply); });
  await send('/onboarding restart');
  for (const value of Object.values(draft)) await send(value);
  assert.match(replies.at(-1) ?? '', /review/i);
  await send('edit skills: TypeScript, Mastra, libSQL');
  assert.match(replies.at(-1) ?? '', /Mastra/);
  await send('looks good');
  assert.match(replies.at(-1) ?? '', /Ready to review/i);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'review');
  await send('confirm');
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'completed');
  assert.match(await store.profileText('owner'), /TypeScript, Mastra, libSQL/);
  await send('/onboarding restart');
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'collecting');
  await send('cancel');
  const cancelled = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(cancelled?.status, 'cancelled'); assert.deepEqual(cancelled?.draft, {});
  await send('/onboarding');
  assert.match(replies.at(-1) ?? '', /current role/i);
  await runtime.close();
}));

test('onboarding completion atomically activates one profile version and rejects stale confirmation', async () => withStore(async (store, file) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft, status: 'review' });
  await assert.rejects(() => store.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version - 1 }), /stale/i);
  const completed = await store.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
  assert.equal(completed.status, 'completed'); assert.match(await store.profileText('owner'), /Career onboarding profile/);
  const db = new DatabaseSync(file); const rows = db.prepare("SELECT name, version, active FROM career_profile_documents WHERE owner_id='owner' AND name='onboarding.md'").all(); db.close();
  assert.deepEqual(rows.map((row) => Number(row.active)), [1]);
}));

test('confirmed onboarding profile context is available to save-job immediately without restart', async () => withStore(async (store) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft, status: 'review' });
  await store.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
  let profileSeen = ''; const rows = new Map<string, Record<string, unknown>>();
  await executeSaveJob({ input: { jobId: 'job-onboarded', userId: 'telegram:1', ownerId: 'owner', chatId: 'telegram:2', transportEventId: 'telegram:job-onboarded', originalUrl: 'https://linkedin.com/jobs/onboarded', canonicalUrl: 'https://linkedin.com/jobs/onboarded' }, store, profileText: 'STALE STARTUP PROFILE', sheet: { findByJobId: async (id) => rows.get(id) ?? null, write: async (row) => { rows.set(String(row.jobId), row); } }, acquire: async () => ({ contentType: 'text/plain', text: 'AI platform role' }), analyze: async (_job, profile) => { profileSeen = profile; return { schemaVersion: 1, title: 'AI Engineer', company: 'Example', location: 'Remote', summary: 'fit', fitScore: 90, nextStep: 'Apply' }; } });
  assert.match(profileSeen, /Staff product engineer/);
  assert.doesNotMatch(profileSeen, /STALE STARTUP PROFILE/);
  assert.equal((await store.get('job-onboarded'))?.status, 'succeeded');
}));

test('conversational onboarding clarification causes no draft mutation and one answer may populate multiple fields', async () => withStore(async (store) => {
  const replies: string[] = [];
  const decisions = [
    { reply: 'I mean your current role/status and level. What should I put there?', draftPatch: {}, readyForReview: false },
    { reply: 'Great, I captured your role and skills. What experience should I highlight next?', draftPatch: { currentStatus: draft.currentStatus, skills: draft.skills }, readyForReview: false },
  ];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => decisions.shift()!, respond: async () => 'normal agent' });
  await runtime.handleTelegramUpdate(update(400, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(401, 'meaning?'), async (text) => { replies.push(text); });
  assert.deepEqual((await store.loadOnboarding('owner', 'telegram:2'))?.draft, {});
  assert.match(replies.at(-1) ?? '', /current role\/status/i);
  await runtime.handleTelegramUpdate(update(402, 'I am senior and use TypeScript'), async (text) => { replies.push(text); });
  const state = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(state?.draft.currentStatus, draft.currentStatus);
  assert.equal(state?.draft.skills, draft.skills);
  assert.equal(state?.draft.experience, undefined);
  await runtime.close();
}));

test('conversational onboarding corrections update only returned fields', async () => withStore(async (store) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: 'Old status', skills: 'Old skills' } });
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => ({ reply: 'Updated skills only.', draftPatch: { skills: 'TypeScript and Mastra' }, readyForReview: false }), respond: async () => 'normal agent' });
  await runtime.handleTelegramUpdate(update(410, 'actually skills are TypeScript and Mastra'));
  const state = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(state?.draft.currentStatus, 'Old status');
  assert.equal(state?.draft.skills, 'TypeScript and Mastra');
  await runtime.close();
}));

test('prohibited active onboarding inputs are blocked before the onboarding model and normal responder', async () => withStore(async (store) => {
  let onboardCalls = 0; let normalCalls = 0; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => { onboardCalls++; return { reply: 'unexpected', draftPatch: {}, readyForReview: false }; }, respond: async () => { normalCalls++; return 'normal'; } });
  await runtime.handleTelegramUpdate(update(420, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(421, 'https://example.test/resume.pdf'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(422, '/queue'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(423, 'x'.repeat(4001)), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(424, 'Resume\nExperience\n- AI Engineer building healthcare agents\nProjects\n- Citation-first RAG system\nSkills\n- TypeScript, Python, SQL'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(425, 'Built image recognition for distributed file systems as a CV engineer'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(426, '/help'), async (text) => { replies.push(text); });
  assert.equal(onboardCalls, 2);
  assert.equal(normalCalls, 0);
  assert.match(replies[1], /unavailable/i);
  assert.match(replies[2], /finish or cancel/i);
  assert.match(replies[3], /4000|too long/i);
  assert.match(replies[6], /finish or cancel/i);
  await runtime.close();
}));

test('dedicated onboarding responder uses owner and conversation memory without tools', async () => {
  let prompt = ''; let options: Record<string, unknown> = {};
  const responder = createOnboardingResponder({ generate: async (text, received) => { prompt = text; options = received; return { object: { reply: 'Captured both.', draftPatch: { currentStatus: draft.currentStatus, skills: draft.skills }, readyForReview: false } }; } });
  const decision = await responder({ ownerId: 'owner', conversationId: 'telegram:2', draft: {}, fields: [], missingFields: ['currentStatus'], status: 'collecting', text: 'I am senior and know TS' });
  assert.equal(decision.draftPatch.currentStatus, draft.currentStatus);
  assert.deepEqual(options.memory, { resource: 'owner', thread: 'telegram:2' });
  assert.equal('requestContext' in options, false);
  assert.equal(options.toolChoice, 'none');
  assert.equal(options.maxSteps, 1);
  assert.equal((options.structuredOutput as { jsonPromptInjection?: unknown }).jsonPromptInjection, 'inline');
  assert.match(prompt, /Current owner text/);
});

test('runtime-only confirm keeps atomic activation path', async () => withStore(async (store) => {
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => ({ reply: 'Ready.', draftPatch: draft, readyForReview: true }), respond: async () => 'normal' });
  await runtime.handleTelegramUpdate(update(430, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(431, 'all my details'), async (text) => { replies.push(text); });
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'review');
  await runtime.handleTelegramUpdate(update(432, 'yes confirm'), async (text) => { replies.push(text); });
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'review');
  await runtime.handleTelegramUpdate(update(433, 'confirm'), async (text) => { replies.push(text); });
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'completed');
  assert.match(await store.profileText('owner'), /Career onboarding profile/);
  await runtime.close();
}));

test('failed onboarding reply retry resends cached response without rerunning model or state effects', async () => withStore(async (store) => {
  let onboardCalls = 0; let fail = true; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => { onboardCalls++; return { reply: 'Captured status.', draftPatch: { currentStatus: draft.currentStatus }, readyForReview: false }; }, respond: async () => 'normal' });
  await runtime.handleTelegramUpdate(update(500, '/onboarding'), async () => {});
  await assert.rejects(() => runtime.handleTelegramUpdate(update(501, draft.currentStatus), async (text) => { if (fail) { fail = false; throw new Error('telegram unavailable'); } replies.push(text); }), /telegram unavailable/);
  assert.equal(onboardCalls, 1);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.draft.currentStatus, draft.currentStatus);
  const retried = await runtime.handleTelegramUpdate(update(501, draft.currentStatus), async (text) => { replies.push(text); });
  assert.deepEqual(retried, { outcome: 'accepted', command: 'onboarding' });
  assert.equal(onboardCalls, 1);
  assert.deepEqual(replies, ['Captured status.']);
  await runtime.close();
}));

test('failed normal reply retry resends cached response without rerunning side effects and marks notification', async () => withStore(async (store) => {
  let calls = 0; let fail = true; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => {
    calls++;
    const job = (await store.enqueue({ jobId: 'cached-normal-job', userId: turn.actorId, ownerId: 'owner', chatId: turn.conversationId, transportEventId: turn.requestId, originalUrl: 'https://linkedin.com/jobs/cached', canonicalUrl: 'https://linkedin.com/jobs/cached' })).job;
    await store.markRunning(job.jobId, 'run-cached');
    await store.complete(job.jobId, { summary: 'cached summary', reportId: null, reportPath: null, sheetReference: job.jobId }, null, job.jobId);
    return 'cached normal reply';
  } });
  await assert.rejects(() => runtime.handleTelegramUpdate(update(510, 'save my cached job'), async (text) => { if (fail) { fail = false; throw new Error('telegram unavailable'); } replies.push(text); }), /telegram unavailable/);
  assert.equal(calls, 1);
  assert.equal((await store.get('cached-normal-job'))?.notifiedAt, null);
  const retried = await runtime.handleTelegramUpdate(update(510, 'save my cached job'), async (text) => { replies.push(text); });
  assert.deepEqual(retried, { outcome: 'accepted', command: 'chat' });
  assert.equal(calls, 1);
  assert.deepEqual(replies, ['cached normal reply']);
  assert.ok((await store.get('cached-normal-job'))?.notifiedAt);
  await runtime.close();
}));

test('readyForReview with complete draft and empty patch transitions to review', async () => withStore(async (store) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft });
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => ({ reply: 'Ready for review.', draftPatch: {}, readyForReview: true }), respond: async () => 'normal' });
  await runtime.handleTelegramUpdate(update(520, 'ready to review'), async (text) => { replies.push(text); });
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.status, 'review');
  assert.match(replies.at(-1) ?? '', /Review your onboarding profile/);
  await runtime.close();
}));

test('review state stays conversational for natural corrections and clarification', async () => withStore(async (store) => {
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', restart: true });
  const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft, status: 'review' });
  const decisions = [
    { reply: 'Updated skills naturally.', draftPatch: { skills: 'TypeScript, Mastra, libSQL' }, readyForReview: true },
    { reply: 'Confirm means I activate only when you send exactly confirm.', draftPatch: {}, readyForReview: false },
  ];
  const statuses: string[] = []; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async ({ status }) => { statuses.push(status); return decisions.shift()!; }, respond: async () => 'normal' });
  await runtime.handleTelegramUpdate(update(530, 'Actually make skills Mastra too'), async (text) => { replies.push(text); });
  let state = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(state?.status, 'review');
  assert.equal(state?.draft.skills, 'TypeScript, Mastra, libSQL');
  assert.match(replies.at(-1) ?? '', /Review your onboarding profile/);
  await runtime.handleTelegramUpdate(update(531, 'what does confirm do?'), async (text) => { replies.push(text); });
  state = await store.loadOnboarding('owner', 'telegram:2');
  assert.equal(state?.version, review.version + 1);
  assert.equal(state?.draft.skills, 'TypeScript, Mastra, libSQL');
  assert.match(replies.at(-1) ?? '', /exactly confirm/i);
  assert.deepEqual(statuses, ['review', 'review']);
  await runtime.close();
}));

test('direct identifier canaries are blocked before onboarding model and before draft persistence', async () => withStore(async (store) => {
  let onboardCalls = 0; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: async () => { onboardCalls++; return { reply: 'unsafe model patch', draftPatch: { skills: 'email owner@example.test' }, readyForReview: false }; }, respond: async () => 'normal' });
  await runtime.handleTelegramUpdate(update(540, '/onboarding'), async (text) => { replies.push(text); });
  await runtime.handleTelegramUpdate(update(541, 'my email is owner@example.test'), async (text) => { replies.push(text); });
  assert.equal(onboardCalls, 0);
  assert.match(replies.at(-1) ?? '', /cannot accept/i);
  assert.doesNotMatch(replies.at(-1) ?? '', /owner@example/);
  await runtime.handleTelegramUpdate(update(542, 'safe career facts'), async (text) => { replies.push(text); });
  assert.equal(onboardCalls, 1);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.draft.skills, undefined);
  assert.match(replies.at(-1) ?? '', /cannot accept/i);
  const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:blocked', restart: true });
  await assert.rejects(() => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:blocked', expectedVersion: started.version, draft: { currentStatus: 'My legal name is Canary Person' } }), /direct personal identifiers/i);
  const safe = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:blocked', expectedVersion: started.version, draft: { currentStatus: 'Engineer in Bengaluru, open to pan-India roles, holds an Indian passport, and is authorized to work in India with eight years experience.' } });
  assert.match(safe.draft.currentStatus ?? '', /pan-India/);
  await runtime.close();
}));

test('telegram non-text files are rejected outside onboarding and get a generic unavailable reply while active', async () => withStore(async (store) => {
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, onboard: sequentialOnboarder(), respond: async () => 'agent' });
  assert.equal((await runtime.handleTelegramUpdate(update(99, undefined, { document: { file_id: 'file', file_name: 'resume.pdf' } }), async () => {})).outcome, 'rejected');
  assert.equal(await store.loadOnboarding('owner', 'telegram:2'), null);
  await runtime.handleTelegramUpdate(update(300, '/onboarding'), async (text) => { replies.push(text); });
  const active = await runtime.handleTelegramUpdate(update(301, undefined, { document: { file_id: 'secret-file', file_name: 'private-resume.pdf', file_size: 12345 } }), async (text) => { replies.push(text); });
  assert.equal(active.outcome, 'accepted');
  assert.match(replies.at(-1) ?? '', /^Resume, URL, and file ingestion are unavailable in V1\./);
  const location = await runtime.handleTelegramUpdate(update(302, undefined, { location: { latitude: 12.3, longitude: 45.6 } }), async (text) => { replies.push(text); });
  assert.equal(location.outcome, 'accepted');
  assert.match(replies.at(-1) ?? '', /^Resume, URL, and file ingestion are unavailable in V1\./);
  assert.doesNotMatch(replies.at(-1) ?? '', /private-resume|secret-file|12345/);
  assert.equal((await store.loadOnboarding('owner', 'telegram:2'))?.draft.currentStatus, undefined);
  await runtime.close();
}));
