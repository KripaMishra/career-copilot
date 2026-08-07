import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerStore } from '../src/storage/career-store.ts';
import { acquireJobText, normalizeResponseStatus, validateJobUrl } from '../src/tools/web-fetch-tool.ts';
import { readProfile, writeAtomicReport } from '../src/integrations/local-files.ts';
import { GoogleOAuthRefreshProvider, GoogleSheetsBoundary, GoogleSheetsHttpApi, upsertSheetRow, type SheetAdapter } from '../src/integrations/google-sheets.ts';
import { parseCommand, createCareerCopilotRuntime } from '../src/services/career-runtime.ts';
import { assertOperationalDatabaseUrl, resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createTelegramPollingTransport } from '../src/channels/telegram-transport.ts';
import { analyzeJob } from '../src/agents/agent.ts';
import { AnalysisSchema } from '../src/contracts/v0.ts';

test('one career_jobs table deduplicates transport events and has minimal statuses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const input = { jobId: 'job-1', userId: '1', ownerId: 'owner', chatId: 'chat', transportEventId: 'event-1', originalUrl: 'https://linkedin.com/jobs/view/1', canonicalUrl: 'https://linkedin.com/jobs/view/1' };
  assert.equal(store.enqueue(input).duplicate, false);
  assert.equal(store.enqueue(input).duplicate, true);
  assert.deepEqual(store.statuses(), ['queued', 'running', 'needs_input', 'succeeded', 'failed']);
  store.close(); await rm(dir, { recursive: true, force: true });
});

test('one Career Copilot agent owns memory and all career tools', async () => {
  const module = await import('../src/agents/agent.ts');
  const create = (module as { createCareerAgent?: (options: Record<string, unknown>) => { getMemory: () => Promise<unknown>; listTools: () => Promise<Record<string, unknown>> | Record<string, unknown> } }).createCareerAgent;
  assert.equal(typeof create, 'function');
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const agent = create!({ store, reportsRoot: dir, profileText: '', sheet: { findByJobId: async () => null, write: async () => {} } });
  assert.ok(await agent.getMemory()); assert.deepEqual(Object.keys(await agent.listTools()).sort(), ['job-queue', 'job-status', 'save-job']);
  store.close(); await rm(dir, { recursive: true, force: true });
});

test('analysis avoids provider-native response_format', async () => {
  let options: unknown;
  const expected = { schemaVersion: 1 as const, title: 'title', company: 'company', location: 'remote', summary: 'summary', fitScore: 1, nextStep: 'next' };
  const result = await analyzeJob({ generate: async (_prompt: unknown, received: unknown) => { options = received; return { object: expected }; } } as never, 'job', 'profile');
  assert.equal((options as { structuredOutput?: { jsonPromptInjection?: unknown } }).structuredOutput?.jsonPromptInjection, 'inline');
  assert.deepEqual(result, expected);
});

test('bounded acquisition validates redirects, content type, and decoded size', async () => {
  assert.equal(normalizeResponseStatus(200), 200); assert.equal(normalizeResponseStatus(999), 502); assert.equal(normalizeResponseStatus(undefined), 502);
  assert.throws(() => validateJobUrl('http://linkedin.com/jobs/1'));
  assert.throws(() => validateJobUrl('https://localhost/jobs/1'));
  for (const address of ['0:0:0:0:0:0:0:1', '0:0:0:0:0:c0a8:0101', '0:0:0:0:0:ffff:c0a8:0101', '64:ff9b:1::1', '100::1', '2002:c0a8:1::1', '3fff::1', '5f00::1', 'fc00:0:0:0:0:0:0:1', 'fec0:0:0:0:0:0:0:1', '2001:db8:0:0:0:0:0:1']) {
    await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { fetch: async () => new Response('unreachable'), resolve: async () => [address] }));
  }
  const response = new Response('job text', { headers: { 'content-type': 'text/plain' } }); let userAgent: string | null = null; let acceptEncoding: string | null = null;
  const result = await acquireJobText('https://linkedin.com/jobs/1', { fetch: async (_url, init) => { const headers = new Headers(init?.headers); userAgent = headers.get('user-agent'); acceptEncoding = headers.get('accept-encoding'); return response; }, resolve: async () => ['93.184.216.34'] });
  assert.equal(result.text, 'job text'); assert.match(userAgent ?? '', /^CareerCopilot\//); assert.equal(acceptEncoding, 'identity');
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { fetch: async () => new Response('<html/>', { headers: { 'content-type': 'application/octet-stream' } }), resolve: async () => ['93.184.216.34'] }));
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { fetch: async () => new Response('x', { headers: { 'content-type': 'text/plain' } }), resolve: async () => ['127.0.0.1'] }));
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { fetch: async () => new Response(null, { status: 302, headers: { location: 'https://evil.com/job' } }), resolve: async () => ['93.184.216.34'] }));
  let bodyCancelled = false; const oversized = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new TextEncoder().encode('1234')); }, cancel() { bodyCancelled = true; } });
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { fetch: async () => new Response(oversized, { headers: { 'content-type': 'text/plain' } }), resolve: async () => ['93.184.216.34'], maxDecodedBytes: 3 })); assert.equal(bodyCancelled, true);
});

test('report uses job-derived atomic path and Sheets upsert reads back before ambiguous retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-report-'));
  const report = await writeAtomicReport(dir, 'job-1', '# report');
  assert.equal(await readFile(report.path, 'utf8'), '# report');
  let writes = 0;
  const rows = new Map<string, Record<string, unknown>>();
  const sheet: SheetAdapter = {
    async findByJobId(id) { return rows.get(id) ?? null; },
    async write(row) { writes++; rows.set(String(row.jobId), row); throw new Error('ambiguous'); },
  };
  const result = await upsertSheetRow(sheet, { jobId: 'job-1', status: 'succeeded' });
  assert.equal(result.jobId, 'job-1'); assert.equal(writes, 1);
  await assert.rejects(() => upsertSheetRow({
    async findByJobId() { return { jobId: 'job-stale', status: 'queued' }; },
    async write() { throw new Error('write failed'); },
  }, { jobId: 'job-stale', status: 'succeeded' }), /write failed/);
  await rm(dir, { recursive: true, force: true });
});

test('commands are deterministic and owner-only', async () => {
  assert.deepEqual(parseCommand('/save https://linkedin.com/jobs/1'), { kind: 'save', url: 'https://linkedin.com/jobs/1' });
  assert.deepEqual(parseCommand('/job job-1'), { kind: 'job', jobId: 'job-1' });
  assert.deepEqual(parseCommand('/queue'), { kind: 'queue' });
  assert.equal(parseCommand('save this job'), null);
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), respond: async () => 'unused' });
  const replies: string[] = [];
  const rejected = await runtime.handleTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 2, type: 'private' }, from: { id: 9 }, text: '/queue' } }, (text) => { replies.push(text); return Promise.resolve(); });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(replies.length, 0);
});

test('agent responder namespaces transport identities before memory and tools', async () => {
  const module = await import('../src/services/career-runtime.ts');
  const create = (module as { createAgentResponder?: (agent: unknown, ownerId: string) => (turn: Record<string, string>) => Promise<string> }).createAgentResponder;
  assert.equal(typeof create, 'function'); const received: Record<string, unknown>[] = [];
  const respond = create!({ generate: async (_text: string, options: Record<string, unknown>) => { received.push(options); return { text: 'remembered' }; } }, 'owner');
  await respond({ text: 'Telegram profile', channel: 'telegram', actorId: '1', conversationId: '2', requestId: '70' });
  await respond({ text: 'API profile', channel: 'api', actorId: '1', conversationId: '2', requestId: '70' });
  assert.deepEqual(received.map(({ memory }) => memory), [{ resource: 'owner', thread: 'telegram:2' }, { resource: 'owner', thread: 'api:2' }]);
  const contexts = received.map(({ requestContext }) => requestContext as { get: (key: string) => unknown });
  assert.deepEqual(contexts.map((context) => [context.get('actorId'), context.get('conversationId'), context.get('requestId')]), [['telegram:1', 'telegram:2', 'telegram:70'], ['api:1', 'api:2', 'api:70']]);
});

test('career tools reject caller-forged request context', async () => {
  const module = await import('../src/tools/career-context.ts').catch(() => ({})); const schema = (module as { careerToolContextSchema?: { safeParse: (value: unknown) => { success: boolean } }; careerToolCapability?: unknown }).careerToolContextSchema; const capability = (module as { careerToolCapability?: unknown }).careerToolCapability;
  assert.ok(schema); assert.equal(schema!.safeParse({ ownerId: 'owner', actorId: '1', conversationId: '2', requestId: '3', capability: {} }).success, false); assert.equal(schema!.safeParse({ ownerId: 'owner', actorId: '1', conversationId: '2', requestId: '3', capability }).success, true);
});

test('runtime routes save prompts and profile replies through one conversational agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-conversation-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const turns: Array<{ text: string; actorId: string; conversationId: string; requestId: string }> = []; const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { turns.push(turn); return turns.length === 1 ? 'Please share your profile.' : 'Thanks, I will continue.'; } });
  const update = (id: number, text: string) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text } });
  assert.equal((await runtime.handleTelegramUpdate(update(70, '/save https://linkedin.com/jobs/70'), async (text) => { replies.push(text); })).outcome, 'accepted');
  assert.equal((await runtime.handleTelegramUpdate(update(71, 'I am a GenAI engineer with five years of experience.'), async (text) => { replies.push(text); })).outcome, 'accepted');
  assert.match(turns[0].text, /save this job/i); assert.match(turns[0].text, /https:\/\/linkedin\.com\/jobs\/70/); assert.equal(turns[1].text, 'I am a GenAI engineer with five years of experience.');
  assert.deepEqual(turns.map(({ actorId, conversationId, requestId }) => ({ actorId, conversationId, requestId })), [{ actorId: '1', conversationId: '2', requestId: '70' }, { actorId: '1', conversationId: '2', requestId: '71' }]);
  assert.deepEqual(replies, ['Please share your profile.', 'Thanks, I will continue.']); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('durable agent work remains stored when its Telegram reply fails', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-ack-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { const job = store.enqueue({ jobId: 'job-ack', userId: turn.actorId, ownerId: 'owner', chatId: turn.conversationId, transportEventId: turn.requestId, originalUrl: 'https://linkedin.com/jobs/30', canonicalUrl: 'https://linkedin.com/jobs/30' }).job; store.markRunning(job.jobId, 'agent-run'); store.complete(job.jobId, { summary: 'stored', reportPath: null, sheetReference: job.jobId }, '', job.jobId); return 'stored'; } });
  await assert.rejects(() => runtime.handleTelegramUpdate({ update_id: 30, message: { message_id: 30, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/30' } }, async () => { throw new Error('telegram unavailable'); }));
  assert.equal(store.get('job-ack')?.status, 'succeeded'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('successful Telegram reply marks the completed agent job notified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-notified-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { const job = store.enqueue({ jobId: 'job-notified', userId: turn.actorId, ownerId: 'owner', chatId: turn.conversationId, transportEventId: turn.requestId, originalUrl: 'https://linkedin.com/jobs/notified', canonicalUrl: 'https://linkedin.com/jobs/notified' }).job; store.markRunning(job.jobId, 'agent-run'); store.complete(job.jobId, { summary: 'stored', reportPath: null, sheetReference: job.jobId }, '', job.jobId); return 'stored'; } });
  await runtime.handleTelegramUpdate({ update_id: 32, message: { message_id: 32, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: 'save my job' } }, async () => {});
  assert.ok(store.get('job-notified')?.notifiedAt); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('notification failure leaves stored success for one restart retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-notify-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const queued = store.enqueue({ jobId: 'job-notify', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-notify', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  store.markRunning(queued.job.jobId, 'run-1'); store.complete(queued.job.jobId, { summary: 'stored', reportPath: null, sheetReference: null }, '', 'job-notify');
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'unused' }); let attempts = 0;
  await runtime.recoverUnfinished(async () => { attempts++; throw new Error('telegram unavailable'); });
  assert.equal(store.get('job-notify')?.status, 'succeeded'); assert.equal(store.get('job-notify')?.notifiedAt, null);
  await runtime.recoverUnfinished(async () => { attempts++; }); assert.equal(attempts, 2); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('recovery resumes unfinished work through the same conversational agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-recovery-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'agent-recovery', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'recovery-event', originalUrl: 'https://linkedin.com/jobs/recovery', canonicalUrl: 'https://linkedin.com/jobs/recovery' });
  const turns: Array<Record<string, unknown>> = []; const replies: Array<[string, string | undefined]> = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { turns.push(turn); store.markRunning('agent-recovery', 'agent-run'); store.complete('agent-recovery', { summary: 'Recovered.', reportPath: null, sheetReference: 'agent-recovery' }, '', 'agent-recovery'); return 'Recovered.'; } });
  await runtime.recoverUnfinished(async (text, chatId) => { replies.push([text, chatId]); });
  assert.equal(turns[0].resumeJobId, 'agent-recovery'); assert.match(String(turns[0].text), /resume saving/i); assert.deepEqual(replies, [['Recovered.', '2']]);
  runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('recovery delivers completion to the job chat', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-recovery-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-recovery', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-recovery', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  store.markRunning('job-recovery', 'run-1'); store.complete('job-recovery', { summary: 'recovered', reportPath: null, sheetReference: null }, '', 'job-recovery');
  const delivered: Array<[string, string]> = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'unused' });
  await runtime.recoverUnfinished((text, chatId) => { delivered.push([chatId ?? '', text]); return Promise.resolve(); });
  assert.deepEqual(delivered, [['2', 'recovered']]); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save operation persists before completing the full pipeline', async () => {
  const module = await import('../src/tools/save-job-tool.ts').catch(() => ({}));
  const execute = (module as { executeSaveJob?: (options: Record<string, unknown>) => Promise<{ jobId: string; summary: string }> }).executeSaveJob;
  assert.equal(typeof execute, 'function');
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-save-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const rows = new Map<string, Record<string, unknown>>(); const events: string[] = []; let persistedBeforeAcquire = false;
  const input = { jobId: 'agent-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'agent-event', originalUrl: 'https://linkedin.com/jobs/agent', canonicalUrl: 'https://linkedin.com/jobs/agent' };
  const result = await execute!({ input, profileContext: 'GenAI engineer with five years of experience.', store, reportsRoot: dir, acquire: async () => { persistedBeforeAcquire = store.get(input.jobId)?.status === 'running'; return { contentType: 'text/plain', text: 'GenAI role' }; }, analyze: async () => ({ schemaVersion: 1, title: 'GenAI Engineer', company: 'Example', location: 'Remote', summary: 'Good fit.', fitScore: 90, nextStep: 'Apply.' }), sheet: { async findByJobId(id: string) { return rows.get(id) ?? null; }, async write(row: Record<string, unknown>) { rows.set(String(row.jobId), row); } }, observe: (_level: string, event: string) => { events.push(event); } });
  assert.equal(persistedBeforeAcquire, true); assert.equal(result.jobId, input.jobId); assert.match(result.summary, /GenAI Engineer/); assert.equal(store.get(input.jobId)?.status, 'succeeded'); assert.equal(rows.get(input.jobId)?.status, 'succeeded'); assert.deepEqual(events, ['job.queued', 'job.started', 'job.succeeded']);
  store.close(); await rm(dir, { recursive: true, force: true });
});

test('duplicate transport events continue with the persisted job identity', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-duplicate-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const rows = new Map<string, Record<string, unknown>>();
  store.enqueue({ jobId: 'persisted-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'duplicate-event', originalUrl: 'https://linkedin.com/jobs/duplicate', canonicalUrl: 'https://linkedin.com/jobs/duplicate' });
  const result = await executeSaveJob({ input: { jobId: 'new-random-id', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'duplicate-event', originalUrl: 'https://linkedin.com/jobs/duplicate', canonicalUrl: 'https://linkedin.com/jobs/duplicate' }, profileContext: 'profile', store, reportsRoot: dir, acquire: async () => ({ contentType: 'text/plain', text: 'job' }), analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: 'Remote', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }), sheet: { findByJobId: async (id) => rows.get(id) ?? null, write: async (row) => { rows.set(String(row.jobId), row); } } });
  assert.equal(result.jobId, 'persisted-job'); assert.equal(store.get('persisted-job')?.status, 'succeeded'); assert.equal(store.get('new-random-id'), null); store.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save persists only a redacted failure', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-failure-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let sheeted = false;
  const input = { jobId: 'failed-agent-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'failed-agent-event', originalUrl: 'https://linkedin.com/jobs/fail', canonicalUrl: 'https://linkedin.com/jobs/fail' };
  await assert.rejects(() => executeSaveJob({ input, profileContext: 'profile', store, reportsRoot: dir, acquire: async () => { throw new Error('provider secret=do-not-store'); }, analyze: async () => { throw new Error('unreachable'); }, sheet: { findByJobId: async () => null, write: async () => { sheeted = true; } } }), /Job processing failed/);
  assert.equal(store.get(input.jobId)?.status, 'failed'); assert.doesNotMatch(store.get(input.jobId)?.safeError ?? '', /secret|do-not-store/); assert.equal(sheeted, false); store.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save is not broken by observability failures', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-observe-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const rows = new Map<string, Record<string, unknown>>(); const input = { jobId: 'observed-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'observed-event', originalUrl: 'https://linkedin.com/jobs/observe', canonicalUrl: 'https://linkedin.com/jobs/observe' };
  const result = await executeSaveJob({ input, profileContext: 'profile', store, reportsRoot: dir, acquire: async () => ({ contentType: 'text/plain', text: 'job' }), analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: 'Remote', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }), sheet: { findByJobId: async (id) => rows.get(id) ?? null, write: async (row) => { rows.set(String(row.jobId), row); } }, observe: () => { throw new Error('logger unavailable'); } });
  assert.equal(result.jobId, input.jobId); assert.equal(store.get(input.jobId)?.status, 'succeeded'); store.close(); await rm(dir, { recursive: true, force: true });
});

test('Sheets updates existing rows using their declared header order', async () => {
  let current: Record<string, unknown> = { Company: 'Old Co', 'Report Path': '/old', 'Job ID': 'job-sheet', Title: 'Old', Status: 'queued' }; let update: { headers?: string[]; row: Record<string, unknown> } | undefined;
  const boundary = new GoogleSheetsBoundary({ target: { spreadsheetId: 'sheet', trackerTab: 'Applications', auditTab: 'Audit', topicsTab: 'Topics' }, authorize: async () => 'token', api: {
    verifyTarget: async () => {}, readHeaders: async () => ['Company', 'Report Path', 'Job ID', 'Title', 'Status'], readRows: async () => [current], appendRow: async () => {},
    updateRow: async (input) => { update = input; current = input.row; },
  } });
  const result = await boundary.upsert({ jobId: 'job-sheet', status: 'succeeded', title: 'New', company: 'New Co', reportPath: '/new' });
  assert.deepEqual(update?.headers, ['Company', 'Report Path', 'Job ID', 'Title', 'Status']); assert.equal(update?.row.Status, 'succeeded'); assert.equal(update?.row['Report Path'], 'new'); assert.equal(result.Title, 'New');
});

test('database URLs reject non-local file hosts', () => {
  assert.throws(() => assertOperationalDatabaseUrl('file://remote/path/to/db'), /local file URL/);
  assert.equal(assertOperationalDatabaseUrl('file:///tmp/career.db'), 'file:///tmp/career.db');
});

test('CareerStore accepts only local absolute file URLs without query or hash', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-db-url-'));
  for (const value of [`file://${dir}/jobs.db?mode=rw`, `file://${dir}/jobs.db#fragment`, 'file:relative.db', 'file://remote/jobs.db']) {
    assert.throws(() => new CareerStore(value), /local file URL/);
  }
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); store.close(); await rm(dir, { recursive: true, force: true });
});

test('readProfile ingests only visible markdown and text files and rejects unsafe entries', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-profile-'));
  await (await import('node:fs/promises')).writeFile(path.join(dir, 'profile.md'), 'safe');
  await (await import('node:fs/promises')).writeFile(path.join(dir, 'secret.pem'), 'credential');
  assert.throws(() => readProfile(dir), /unsupported profile file/);
  await rm(path.join(dir, 'secret.pem'));
  await (await import('node:fs/promises')).symlink(path.join(dir, 'profile.md'), path.join(dir, 'linked.txt'));
  assert.throws(() => readProfile(dir), /symlink/);
  await rm(dir, { recursive: true, force: true });
});

test('runtime data directory is owner-only because memory stores personal context', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-memory-permissions-')); await (await import('node:fs/promises')).chmod(dir, 0o755);
  resolveRuntimeConfig({ env: {}, dataDir: dir }); const mode = (await (await import('node:fs/promises')).stat(dir)).mode & 0o777;
  assert.equal(mode, 0o700); await rm(dir, { recursive: true, force: true });
});

test('deployment config requires one Telegram principal and Sheets credentials', () => {
  const env = { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner', TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_ALLOWED_USER_IDS: '1,2', CAREER_COPILOT_PRIVATE_CHAT_IDS: '2', GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh' };
  assert.throws(() => resolveRuntimeConfig({ env, requireDeployment: true }), /exactly one/);
  const config = resolveRuntimeConfig({ env: { ...env, TELEGRAM_ALLOWED_USER_IDS: '1' }, requireDeployment: true });
  assert.equal(config.sheetsOAuth.scope, 'https://www.googleapis.com/auth/spreadsheets');
});

test('recovery rejects revoked persisted Telegram users before effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-revoke-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-revoke', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-revoke', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' }); let processed = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['9']), privateChatIds: new Set(['2']), store, respond: async () => { processed++; return 'unexpected'; } }); await runtime.recoverUnfinished(async () => {});
  assert.equal(processed, 0); assert.equal(store.get('job-revoke')?.status, 'queued'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('legacy jobs migrate with null user IDs and fail closed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-legacy-')); const filename = path.join(dir, 'jobs.db'); const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE career_jobs (job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL, transport_event_id TEXT NOT NULL UNIQUE, original_url TEXT NOT NULL, canonical_url TEXT NOT NULL, status TEXT NOT NULL, mastra_run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, report_path TEXT, sheet_reference TEXT, safe_result TEXT, safe_error TEXT, notified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT; INSERT INTO career_jobs (job_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,created_at,updated_at) VALUES ('legacy','owner','2','legacy-event','https://linkedin.com/jobs/1','https://linkedin.com/jobs/1','queued',1,1);`); db.close();
  const store = new CareerStore(`file:${filename}`); assert.equal(store.get('legacy')?.userId, null); let processed = 0; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => { processed++; return 'unexpected'; } }); await runtime.recoverUnfinished(async () => {});
  assert.equal(processed, 0); assert.equal(store.get('legacy')?.status, 'queued'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('conversational turns are serialized for one memory thread', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-turns-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let active = 0; let maximum = 0; let calls = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => { calls++; active++; maximum = Math.max(maximum, active); if (calls === 1) await gate; active--; return 'done'; } });
  const update = (id: number) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: `turn ${id}` } });
  const first = runtime.handleTelegramUpdate(update(40)); const second = runtime.handleTelegramUpdate(update(41)); await new Promise((resolve) => setImmediate(resolve)); assert.equal(calls, 1); release(); await Promise.all([first, second]);
  assert.equal(calls, 2); assert.equal(maximum, 1); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('injected acquisition aborts on the overall timeout', async () => {
  let signal!: AbortSignal; await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { timeoutMs: 10, resolve: async () => ['93.184.216.34'], fetch: async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } })); assert.equal(signal.aborted, true);
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { timeoutMs: 10, resolve: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return ['93.184.216.34']; }, fetch: async () => new Response('late', { headers: { 'content-type': 'text/plain' } }) }));
});

test('Sheets update verification rejects when the stale row remains', async () => {
  const boundary = new GoogleSheetsBoundary({ target: { spreadsheetId: 'sheet', trackerTab: 'Applications', auditTab: 'Audit', topicsTab: 'Topics' }, authorize: async () => 'token', api: { verifyTarget: async () => {}, readHeaders: async () => ['Job ID', 'Status', 'Title', 'Company', 'Report Path'], readRows: async () => [{ 'Job ID': 'stale-job', Status: 'queued', Title: 'Old', Company: 'Old Co', 'Report Path': 'old.md' }], appendRow: async () => {}, updateRow: async () => {} } });
  await assert.rejects(() => boundary.upsert({ jobId: 'stale-job', status: 'succeeded', title: 'New', company: 'New Co', reportPath: '/safe/new.md' }), /could not be verified/);
});

test('transient agent failure does not poison runtime replay state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-retry-update-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let calls = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => { calls++; if (calls === 1) throw new Error('database busy'); return 'recovered'; } }); const update = { update_id: 50, message: { message_id: 50, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: 'remember this profile' } };
  await assert.rejects(() => runtime.handleTelegramUpdate(update)); const retried = await runtime.handleTelegramUpdate(update); assert.equal(retried.outcome, 'accepted'); assert.equal(calls, 2); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('Telegram polling advances offset only after durable handling', async () => {
  const originalFetch = globalThis.fetch; const offsets: number[] = []; let handled = 0; let transport!: ReturnType<typeof createTelegramPollingTransport>;
  globalThis.fetch = async (_input, init) => { const body = JSON.parse(String(init?.body)); offsets.push(body.offset); return new Response(JSON.stringify({ ok: true, result: [{ update_id: 60, message: { message_id: 60, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/queue' } }] }), { headers: { 'content-type': 'application/json' } }); };
  try { transport = createTelegramPollingTransport('bot-token', async () => { handled++; if (handled === 1) throw new Error('database busy'); transport.stop(); }); await transport.start(); assert.deepEqual(offsets.slice(0, 2), [0, 0]); } finally { transport?.stop(); globalThis.fetch = originalFetch; }
});

test('Telegram polling reports transport failures', async () => {
  const originalFetch = globalThis.fetch; const events: string[] = [];
  globalThis.fetch = async () => new Response('conflict', { status: 409 });
  try {
    const transport = createTelegramPollingTransport('bot-token', async () => {}, (_level: string, event: string) => { events.push(event); });
    setTimeout(() => transport.stop(), 20); await transport.start();
    assert.deepEqual(events, ['telegram.poll.started', 'telegram.poll.failed', 'telegram.poll.stopped']);
  } finally { globalThis.fetch = originalFetch; }
});

test('Telegram stop aborts an in-flight long poll', async () => {
  const originalFetch = globalThis.fetch; let signal: AbortSignal | undefined;
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }); setTimeout(() => reject(new Error('late timeout')), 30); });
  try { const transport = createTelegramPollingTransport('bot-token', async () => {}); const started = transport.start(); await new Promise((resolve) => setImmediate(resolve)); transport.stop(); await started; assert.equal(signal?.aborted, true); } finally { globalThis.fetch = originalFetch; }
});

test('Telegram transport can deliver a recovery message before polling', async () => {
  const originalFetch = globalThis.fetch; const calls: unknown[] = [];
  globalThis.fetch = async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } }); };
  try { const transport = createTelegramPollingTransport('bot-token', async () => {}); await transport.sendMessage('chat-1', 'recovered'); assert.deepEqual(calls, [{ chat_id: 'chat-1', text: 'recovered' }]); transport.stop(); } finally { globalThis.fetch = originalFetch; }
});

test('local observability exporter only accepts trace events', async () => {
  const module = await import('../src/observability.ts').catch(() => ({}));
  const factory = (module as { createTraceStorageExporter?: () => Record<string, unknown> }).createTraceStorageExporter;
  assert.equal(typeof factory, 'function');
  const exporter = factory!();
  assert.equal(typeof exporter.onTracingEvent, 'function'); assert.equal('onMetricEvent' in exporter, false); assert.equal('onLogEvent' in exporter, false);
});

test('runtime rejects a Mastra database outside its protected data directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-db-root-'));
  assert.throws(() => resolveRuntimeConfig({ env: {}, dataDir: path.join(dir, 'data'), databaseUrl: `file:${path.join(dir, 'outside.db')}` }), /protected data directory/);
  assert.equal(resolveRuntimeConfig({ env: {}, dataDir: path.join(dir, 'data'), databaseUrl: `file:${path.join(dir, 'data', 'inside.db')}` }).databaseUrl, `file:${path.join(dir, 'data', 'inside.db')}`);
  await writeFile(path.join(dir, 'outside.db'), ''); await symlink(path.join(dir, 'outside.db'), path.join(dir, 'data', 'linked.db'));
  assert.throws(() => resolveRuntimeConfig({ env: {}, dataDir: path.join(dir, 'data'), databaseUrl: `file:${path.join(dir, 'data', 'linked.db')}` }), /protected data directory/);
  await rm(dir, { recursive: true, force: true });
});

test('transient HTTP responses retain their status for save retries', async () => {
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/retry', { fetch: async () => new Response('', { status: 429 }), resolve: async () => ['93.184.216.34'] }), (error: unknown) => (error as { status?: number }).status === 429);
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-http-retry-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let attempts = 0; const rows = new Map<string, Record<string, unknown>>();
  await executeSaveJob({ input: { jobId: 'retry-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'retry-event', originalUrl: 'https://linkedin.com/jobs/retry', canonicalUrl: 'https://linkedin.com/jobs/retry' }, profileContext: 'profile', store, reportsRoot: dir, acquire: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('Job fetch failed (429).'), { status: 429 }); return { contentType: 'text/plain', text: 'job' }; }, analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: '', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }), sheet: { findByJobId: async (id) => rows.get(id) ?? null, write: async (row) => { rows.set(String(row.jobId), row); } } });
  assert.equal(attempts, 2); store.close(); await rm(dir, { recursive: true, force: true });
});

test('Google HTTP requests have bounded abort signals', async () => {
  const originalFetch = globalThis.fetch; const signals: AbortSignal[] = [];
  globalThis.fetch = async (_input, init) => { signals.push(init?.signal as AbortSignal); return new Response(JSON.stringify(signals.length === 1 ? { access_token: 'token', scope: 'https://www.googleapis.com/auth/spreadsheets' } : {}), { headers: { 'content-type': 'application/json' } }); };
  try { await new GoogleOAuthRefreshProvider({ clientId: 'id', clientSecret: 'secret', refreshToken: 'refresh' }).getAccessToken(); await new GoogleSheetsHttpApi('https://example.test').verifyTarget({ spreadsheetId: 'sheet', tab: 'tab', accessToken: 'token' }).catch(() => undefined); assert.equal(signals.length, 2); assert.ok(signals.every(Boolean)); } finally { globalThis.fetch = originalFetch; }
});

test('Telegram splits messages at its 4096-character limit', async () => {
  const originalFetch = globalThis.fetch; const texts: string[] = [];
  globalThis.fetch = async (_input, init) => { texts.push(JSON.parse(String(init?.body)).text); return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } }); };
  try { await createTelegramPollingTransport('token', async () => {}).sendMessage('chat', 'x'.repeat(4097)); assert.deepEqual(texts.map((text) => text.length), [4096, 1]); } finally { globalThis.fetch = originalFetch; }
});

test('profile reads at most 100000 bytes per file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-profile-limit-')); await writeFile(path.join(dir, 'profile.txt'), 'x'.repeat(100_001));
  assert.equal(readProfile(dir)['profile.txt'].length, 100_000); await rm(dir, { recursive: true, force: true });
});

test('analysis rejects blank title and company fields', () => {
  const base = { schemaVersion: 1, title: 'Title', company: 'Company', location: '', summary: 'Summary', fitScore: 1, nextStep: 'Apply' };
  assert.equal(AnalysisSchema.safeParse({ ...base, title: '   ' }).success, false); assert.equal(AnalysisSchema.safeParse({ ...base, company: '' }).success, false);
});

test('Mastra registrations live in the mandated entrypoint', async () => {
  const source = await readFile(new URL('../src/mastra/index.ts', import.meta.url), 'utf8'); assert.match(source, /new Mastra\s*\(/);
});
