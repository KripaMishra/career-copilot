import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerStore } from '../src/storage/career-store.ts';
import { acquireJobText, normalizeResponseStatus, validateJobUrl } from '../src/tools/web-fetch-tool.ts';
import { readProfile, writeAtomicReport } from '../src/integrations/local-files.ts';
import { parseCommand, createCareerCopilotRuntime } from '../src/services/career-runtime.ts';
import { assertOperationalDatabaseUrl, resolveDatabaseConfig, resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createTelegramPollingTransport } from '../src/channels/telegram-transport.ts';
import { analyzeJob, careerMemoryOptions } from '../src/agents/agent.ts';
import { AnalysisSchema, safeErrorMessage } from '../src/contracts/v0.ts';

test('one career_jobs table deduplicates transport events and has minimal statuses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const input = { jobId: 'job-1', userId: '1', ownerId: 'owner', chatId: 'chat', transportEventId: 'event-1', originalUrl: 'https://linkedin.com/jobs/view/1', canonicalUrl: 'https://linkedin.com/jobs/view/1' };
  assert.equal((await store.enqueue(input)).duplicate, false);
  assert.equal((await store.enqueue(input)).duplicate, true);
  const concurrentInput = { ...input, jobId: 'job-concurrent', transportEventId: 'event-concurrent' };
  const concurrent = await Promise.all([store.enqueue(concurrentInput), store.enqueue(concurrentInput)]);
  assert.deepEqual(concurrent.map((result) => result.duplicate).sort(), [false, true]);
  assert.equal((await store.list()).filter((job) => job.transportEventId === 'event-concurrent').length, 1);
  assert.deepEqual(store.statuses(), ['queued', 'running', 'succeeded', 'failed']);
  await store.close(); await rm(dir, { recursive: true, force: true });
});

test('reports and profile documents persist as owner-scoped text rows', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-docs-')); const url = `file:${path.join(dir, 'jobs.db')}`;
  const store = new CareerStore(url);
  await store.enqueue({ jobId: 'job-doc', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-doc', originalUrl: 'https://linkedin.com/jobs/view/doc', canonicalUrl: 'https://linkedin.com/jobs/view/doc' });
  await store.markRunning('job-doc', 'run-1');
  const report = await store.completeWithReport({ ownerId: 'owner', jobId: 'job-doc', content: '# Report', summary: 'saved' });
  assert.equal(report.reportId, 'job-doc');
  assert.equal((await store.getReport(report.reportId, 'owner'))?.content, '# Report');
  assert.equal(await store.getReport(report.reportId, 'other'), null);
  assert.match(report.hash, /^sha256:/);
  await assert.rejects(() => store.completeWithReport({ ownerId: 'other', jobId: 'job-doc', content: '# Other', summary: 'saved' }), /does not exist/);
  await assert.rejects(() => store.completeWithReport({ ownerId: 'owner', jobId: 'missing-job', content: '# Missing', summary: 'saved' }), /does not exist/);
  const profile = await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'GenAI engineer' });
  assert.match(profile.hash, /^sha256:/);
  assert.equal(await store.profileText('owner'), 'profile.md:\nGenAI engineer');
  await store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'Draft profile', active: false });
  assert.equal(await store.profileText('owner'), 'profile.md:\nGenAI engineer');
  await assert.rejects(() => store.saveProfileDocument({ ownerId: 'owner', name: 'secret.txt', content: 'safe' }), /unsafe profile document name/);
  await assert.rejects(() => store.saveProfileDocument({ ownerId: 'owner', name: 'profile.md', content: 'token=do-not-store' }), /unsafe profile content/);
  await store.close();
  const reopened = new CareerStore(url);
  assert.equal((await reopened.getReport(report.reportId, 'owner'))?.sha256, report.hash.replace('sha256:', ''));
  assert.equal(await reopened.profileText('owner'), 'profile.md:\nGenAI engineer');
  await reopened.close(); await rm(dir, { recursive: true, force: true });
});

test('profileText fails closed on unsafe active rows inserted outside CareerStore', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-unsafe-profile-')); const filename = path.join(dir, 'jobs.db'); const url = `file:${filename}`;
  const store = new CareerStore(url); await store.ready(); await store.close();
  const db = new DatabaseSync(filename); const now = Date.now();
  db.prepare('INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('unsafe-name', 'owner', 'secret.txt', 1, 1, 'safe', 'hash', 4, now, now);
  db.close();
  const reopened = new CareerStore(url); await assert.rejects(() => reopened.profileText('owner'), /unsafe profile document name/); await reopened.close();
  const db2 = new DatabaseSync(filename); db2.exec('DELETE FROM career_profile_documents'); db2.prepare('INSERT INTO career_profile_documents (document_id,owner_id,name,version,active,content,sha256,byte_size,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)').run('unsafe-content', 'owner', 'profile.md', 1, 1, 'token=do-not-store', 'hash', 18, now, now); db2.close();
  const reopenedAgain = new CareerStore(url); await assert.rejects(() => reopenedAgain.profileText('owner'), /unsafe profile content/); await reopenedAgain.close(); await rm(dir, { recursive: true, force: true });
});

test('completeWithReport commits once and re-entry returns the cached result without a second report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-complete-idempotent-')); const url = `file:${path.join(dir, 'jobs.db')}`;
  const store = new CareerStore(url);
  const input = { jobId: 'job-complete-idempotent', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-complete-idempotent', originalUrl: 'https://linkedin.com/jobs/view/idempotent', canonicalUrl: 'https://linkedin.com/jobs/view/idempotent' };
  await store.enqueue(input); await store.markRunning(input.jobId, 'run-1');
  const first = await store.completeWithReport({ ownerId: 'owner', jobId: input.jobId, content: '# One', summary: 'one' });
  assert.match(first.hash ?? '', /^sha256:/);
  const second = await store.completeWithReport({ ownerId: 'owner', jobId: input.jobId, content: '# Two', summary: 'two' });
  assert.equal(second.hash, null); assert.equal(second.reportId, input.jobId);
  assert.equal((await store.get(input.jobId))?.safeResult?.summary, 'one');
  assert.equal((await store.getReport(input.jobId, 'owner'))?.content, '# One');
  const db = new DatabaseSync(path.join(dir, 'jobs.db')); const rows = db.prepare('SELECT * FROM career_reports WHERE job_id = ?').all(input.jobId); db.close();
  assert.equal(rows.length, 1); assert.equal(String((rows[0] as { report_id: string }).report_id), input.jobId);
  await store.close(); await rm(dir, { recursive: true, force: true });
});

test('Career Copilot exposes protected tools only to authenticated ingress', async () => {
  const [{ createCareerAgent }, { createCareerToolContext }] = await Promise.all([import('../src/agents/agent.ts'), import('../src/tools/career-context.ts')]);
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const agent = createCareerAgent({ store });
  assert.ok(await agent.getMemory());
  assert.deepEqual(Object.keys(await agent.listTools()), []);
  const requestContext = createCareerToolContext({ ownerId: 'owner', actorId: 'telegram:1', conversationId: 'telegram:2', requestId: 'telegram:3' });
  assert.deepEqual(Object.keys(await agent.listTools({ requestContext })).sort(), ['career-profile', 'job-queue', 'job-status', 'save-job']);
  await store.close(); await rm(dir, { recursive: true, force: true });
});

test('job-status logs no caller-supplied job ID', async () => {
  const [{ createCareerAgentKit }, { createCareerToolContext }] = await Promise.all([import('../src/agents/agent.ts'), import('../src/tools/career-context.ts')]);
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-log-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const logs: unknown[] = [];
  const { tools } = createCareerAgentKit({ store, logger: (_level, _event, data) => { logs.push(data); } });
  const requestContext = createCareerToolContext({ ownerId: 'owner', actorId: 'telegram:1', conversationId: 'telegram:2', requestId: 'telegram:3' });
  await tools['job-status'].execute?.({ jobId: 'password=secret-value' }, { requestContext } as never);
  assert.doesNotMatch(JSON.stringify(logs), /password=secret-value/);
  await store.close(); await rm(dir, { recursive: true, force: true });
});

test('career memory keeps message history and thread-scoped observations without working memory', () => {
  const options = careerMemoryOptions('test-memory-model');
  assert.equal(options.lastMessages, 20);
  assert.equal(options.workingMemory, undefined, 'working memory is disabled (D5 option a); the canonical profile lives in the store');
  assert.deepEqual(options.observationalMemory, { model: 'test-memory-model', scope: 'thread' });
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

test('report writes to a job-derived atomic path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-report-'));
  const report = await writeAtomicReport(dir, 'job-1', '# report');
  assert.equal(await readFile(report.path, 'utf8'), '# report');
  await rm(dir, { recursive: true, force: true });
});

test('commands are deterministic and owner-only', async () => {
  assert.deepEqual(parseCommand('/save https://linkedin.com/jobs/1'), { kind: 'save', url: 'https://linkedin.com/jobs/1' });
  assert.deepEqual(parseCommand('/job job-1'), { kind: 'job', jobId: 'job-1' });
  assert.deepEqual(parseCommand('/queue'), { kind: 'queue' });
  assert.equal(parseCommand('save this job'), null);
  assert.throws(() => createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), respond: async () => 'unused' }), /explicit store or databaseUrl/);
  const dir = await mkdtemp(path.join(tmpdir(), 'career-command-runtime-')); const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), databaseUrl: `file:${path.join(dir, 'jobs.db')}`, respond: async () => 'unused' });
  const replies: string[] = [];
  const rejected = await runtime.handleTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 2, type: 'private' }, from: { id: 9 }, text: '/queue' } }, (text) => { replies.push(text); return Promise.resolve(); });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(replies.length, 0); await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('agent responder namespaces transport identities before memory and tools', async () => {
  const module = await import('../src/services/career-runtime.ts');
  const create = (module as { createAgentResponder?: (agent: unknown, ownerId: string, logger?: (level: string, event: string, data?: Record<string, unknown>) => void) => (turn: Record<string, string>) => Promise<string> }).createAgentResponder;
  assert.equal(typeof create, 'function'); const received: Record<string, unknown>[] = []; const events: Array<{ event: string; data?: Record<string, unknown> }> = [];
  const respond = create!({ generate: async (_text: string, options: Record<string, unknown>) => { received.push(options); return { text: 'remembered' }; } }, 'owner', (_level, event, data) => { events.push({ event, data }); });
  await respond({ text: 'Telegram profile', channel: 'telegram', actorId: '1', conversationId: '2', requestId: '70' });
  await respond({ text: 'API profile', channel: 'api', actorId: '1', conversationId: '2', requestId: '70' });
  assert.deepEqual(received.map(({ memory }) => memory), [{ resource: 'owner', thread: 'telegram:2' }, { resource: 'owner', thread: 'api:2' }]);
  const contexts = received.map(({ requestContext }) => requestContext as { get: (key: string) => unknown });
  assert.deepEqual(contexts.map((context) => [context.get('actorId'), context.get('conversationId'), context.get('requestId')]), [['telegram:1', 'telegram:2', 'telegram:70'], ['api:1', 'api:2', 'api:70']]);
  assert.deepEqual(events.map(({ event }) => event), ['agent.turn.started', 'agent.turn.succeeded', 'agent.turn.started', 'agent.turn.succeeded']);
  assert.deepEqual(events.map(({ data }) => data?.requestId), ['70', '70', '70', '70']);
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
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { const job = (await store.enqueue({ jobId: 'job-ack', userId: turn.actorId, ownerId: 'owner', chatId: turn.conversationId, transportEventId: turn.requestId, originalUrl: 'https://linkedin.com/jobs/30', canonicalUrl: 'https://linkedin.com/jobs/30' })).job; await store.markRunning(job.jobId, 'agent-run'); await store.completeWithReport({ jobId: job.jobId, ownerId: 'owner', content: '# stored', summary: 'stored' }); return 'stored'; } });
  await assert.rejects(() => runtime.handleTelegramUpdate({ update_id: 30, message: { message_id: 30, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/30' } }, async () => { throw new Error('telegram unavailable'); }));
  assert.equal((await store.get('job-ack'))?.status, 'succeeded'); await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('successful Telegram reply delivers the exact persisted report and marks notified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-notified-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const delivered: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { const job = (await store.enqueue({ jobId: 'job-notified', userId: turn.actorId, ownerId: 'owner', chatId: turn.conversationId, transportEventId: turn.requestId, originalUrl: 'https://linkedin.com/jobs/notified', canonicalUrl: 'https://linkedin.com/jobs/notified' })).job; await store.markRunning(job.jobId, 'agent-run'); await store.completeWithReport({ jobId: job.jobId, ownerId: 'owner', content: '# stored', summary: 'stored' }); return 'agent paraphrase'; } });
  await runtime.handleTelegramUpdate({ update_id: 32, message: { message_id: 32, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: 'save my job' } }, async (text) => { delivered.push(text); });
  assert.deepEqual(delivered, ['# stored']); assert.equal(delivered[0], (await store.getReport('job-notified', 'owner'))?.content); assert.ok((await store.get('job-notified'))?.notifiedAt); await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('notification failure leaves stored success for one restart retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-notify-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const queued = await store.enqueue({ jobId: 'job-notify', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-notify', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  await store.markRunning(queued.job.jobId, 'run-1'); await store.completeWithReport({ jobId: queued.job.jobId, ownerId: 'owner', content: '# stored', summary: 'stored' });
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'unused' }); let attempts = 0;
  await runtime.recoverUnfinished(async () => { attempts++; throw new Error('telegram unavailable'); });
  assert.equal((await store.get('job-notify'))?.status, 'succeeded'); assert.equal((await store.get('job-notify'))?.notifiedAt, null);
  await runtime.recoverUnfinished(async () => { attempts++; }); assert.equal(attempts, 2); await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('recovery resumes unfinished work through the same conversational agent', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-recovery-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.enqueue({ jobId: 'agent-recovery', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'recovery-event', originalUrl: 'https://linkedin.com/jobs/recovery', canonicalUrl: 'https://linkedin.com/jobs/recovery' });
  const turns: Array<Record<string, unknown>> = []; const replies: Array<[string, string | undefined]> = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async (turn) => { turns.push(turn); await store.markRunning('agent-recovery', 'agent-run'); await store.completeWithReport({ jobId: 'agent-recovery', ownerId: 'owner', content: '# Recovered.', summary: 'Recovered.' }); return 'Recovered.'; } });
  await runtime.recoverUnfinished(async (text, chatId) => { replies.push([text, chatId]); });
  assert.equal(turns[0].resumeJobId, 'agent-recovery'); assert.match(String(turns[0].text), /resume saving/i); assert.deepEqual(replies, [['# Recovered.', '2']]);
  runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('recovery delivers completion to the job chat', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-recovery-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.enqueue({ jobId: 'job-recovery', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-recovery', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  await store.markRunning('job-recovery', 'run-1'); await store.completeWithReport({ jobId: 'job-recovery', ownerId: 'owner', content: '# recovered', summary: 'recovered' });
  const delivered: Array<[string, string]> = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'unused' });
  await runtime.recoverUnfinished((text, chatId) => { delivered.push([chatId ?? '', text]); return Promise.resolve(); });
  assert.deepEqual(delivered, [['2', '# recovered']]); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('succeeded job without a report row falls back and still marks notified', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-report-missing-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const seedLegacy = (transportEventId: string, jobId: string) => { const db = new DatabaseSync(path.join(dir, 'jobs.db')); db.prepare('INSERT INTO career_jobs (job_id,user_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,attempts,report_id,safe_result,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)').run(jobId, '1', 'owner', '2', transportEventId, 'https://linkedin.com/jobs/legacy', 'https://linkedin.com/jobs/legacy', 'succeeded', 0, null, JSON.stringify({ summary: 'legacy done', reportId: null }), 1, 1); db.close(); };
  seedLegacy('42', 'legacy-normal'); seedLegacy('legacy-sweep-event', 'legacy-sweep');
  const delivered: string[] = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'agent paraphrase' });
  await runtime.handleTelegramUpdate({ update_id: 42, message: { message_id: 42, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: 'what happened to my job?' } }, async (text) => { delivered.push(text); });
  assert.deepEqual(delivered, ['agent paraphrase']); assert.ok((await store.get('legacy-normal'))?.notifiedAt);
  const swept: string[] = []; await runtime.recoverUnfinished(async (text) => { swept.push(text); });
  assert.deepEqual(swept, ['legacy done']); assert.ok((await store.get('legacy-sweep'))?.notifiedAt);
  await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save operation persists before completing the full pipeline', async () => {
  const module = await import('../src/tools/save-job-tool.ts').catch(() => ({}));
  const execute = (module as { executeSaveJob?: (options: Record<string, unknown>) => Promise<{ jobId: string; summary: string }> }).executeSaveJob;
  assert.equal(typeof execute, 'function');
  const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-save-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const events: string[] = []; let persistedBeforeAcquire = false;
  const input = { jobId: 'agent-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'agent-event', originalUrl: 'https://linkedin.com/jobs/agent', canonicalUrl: 'https://linkedin.com/jobs/agent' };
  const result = await execute!({ input, profileContext: 'GenAI engineer with five years of experience.', store, acquire: async () => { persistedBeforeAcquire = (await store.get(input.jobId))?.status === 'running'; return { contentType: 'text/plain', text: 'GenAI role' }; }, analyze: async () => ({ schemaVersion: 1, title: 'GenAI Engineer', company: 'Example', location: 'Remote', summary: 'Good fit.', fitScore: 90, nextStep: 'Apply.' }), logger: (_level: string, event: string) => { events.push(event); } });
  assert.equal(persistedBeforeAcquire, true); assert.equal(result.jobId, input.jobId); assert.match(result.summary, /GenAI Engineer/); assert.equal((await store.get(input.jobId))?.status, 'succeeded'); assert.equal((await store.get(input.jobId))?.reportId, result.reportId);
  assert.deepEqual(events, ['job.queued', 'job.started', 'job.phase.started', 'job.phase.succeeded', 'job.phase.started', 'job.phase.succeeded', 'job.phase.started', 'job.phase.succeeded', 'job.succeeded']);
  await store.close(); await rm(dir, { recursive: true, force: true });
});

test('duplicate transport events continue with the persisted job identity', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-duplicate-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.enqueue({ jobId: 'persisted-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'duplicate-event', originalUrl: 'https://linkedin.com/jobs/duplicate', canonicalUrl: 'https://linkedin.com/jobs/duplicate' });
  const result = await executeSaveJob({ input: { jobId: 'new-random-id', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'duplicate-event', originalUrl: 'https://linkedin.com/jobs/duplicate', canonicalUrl: 'https://linkedin.com/jobs/duplicate' }, profileContext: 'profile', store, acquire: async () => ({ contentType: 'text/plain', text: 'job' }), analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: 'Remote', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }) });
  assert.equal(result.jobId, 'persisted-job'); assert.equal((await store.get('persisted-job'))?.status, 'succeeded'); assert.equal(await store.get('new-random-id'), null); await store.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save persists only a redacted failure', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-failure-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const input = { jobId: 'failed-agent-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'failed-agent-event', originalUrl: 'https://linkedin.com/jobs/fail', canonicalUrl: 'https://linkedin.com/jobs/fail' };
  await assert.rejects(() => executeSaveJob({ input, profileContext: 'profile', store, acquire: async () => { throw new Error('provider secret=do-not-store'); }, analyze: async () => { throw new Error('unreachable'); } }), /Job processing failed/);
  assert.equal((await store.get(input.jobId))?.status, 'failed'); assert.doesNotMatch((await store.get(input.jobId))?.safeError ?? '', /secret|do-not-store/); await store.close(); await rm(dir, { recursive: true, force: true });
});

test('single-agent save is not broken by logger failures', async () => {
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-agent-log-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const input = { jobId: 'logged-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'logged-event', originalUrl: 'https://linkedin.com/jobs/logged', canonicalUrl: 'https://linkedin.com/jobs/logged' };
  const result = await executeSaveJob({ input, profileContext: 'profile', store, acquire: async () => ({ contentType: 'text/plain', text: 'job' }), analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: 'Remote', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }), logger: () => { throw new Error('logger unavailable'); } });
  assert.equal(result.jobId, input.jobId); assert.equal((await store.get(input.jobId))?.status, 'succeeded'); await store.close(); await rm(dir, { recursive: true, force: true });
});

test('database config supports local files and Turso remotes safely', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-db-url-'));
  assert.throws(() => assertOperationalDatabaseUrl('file://remote/path/to/db'), /local file URL|Database/);
  assert.equal(resolveDatabaseConfig(`file:${path.join(dir, 'jobs.db')}`, undefined, dir).url, `file:${path.join(dir, 'jobs.db')}`);
  assert.deepEqual(resolveDatabaseConfig('libsql://career-example.turso.io', 'token', dir), { url: 'libsql://career-example.turso.io', authToken: 'token' });
  assert.deepEqual(resolveDatabaseConfig('https://career-example.turso.io', 'token', dir), { url: 'https://career-example.turso.io', authToken: 'token' });
  for (const value of [`file:${path.join(dir, 'jobs.db')}?mode=rw`, `file:${path.join(dir, 'jobs.db')}#fragment`, 'ftp://example.test/db']) assert.throws(() => resolveDatabaseConfig(value, undefined, dir), /Database URL|query|fragment|file/);
  for (const value of ['https://localhost:8080/db', 'https://127.0.0.1/db', 'https://example.com/db', 'libsql://career-example.turso.io.evil.com']) assert.throws(() => resolveDatabaseConfig(value, 'token', dir), /Turso host/);
  assert.throws(() => resolveDatabaseConfig(`file:${path.join(dir, 'jobs.db')}`, undefined, dir, { requireRemote: true }), /remote Turso/);
  assert.throws(() => resolveDatabaseConfig(`file:${path.join(dir, 'jobs.db')}`, 'token', dir), /must not be set/);
  assert.throws(() => resolveDatabaseConfig('libsql://career-example.turso.io', undefined, dir), /TURSO_AUTH_TOKEN/);
  assert.throws(() => resolveDatabaseConfig('libsql://user:pass@career-example.turso.io', 'token', dir), /credentials/);
  assert.throws(() => new CareerStore('libsql://career-example.turso.io'), /TURSO_AUTH_TOKEN/);
  assert.throws(() => new CareerStore({ url: 'https://localhost/db', authToken: 'token' }), /Turso host/);
  assert.throws(() => new CareerStore({ url: `file:${path.join(dir, 'jobs.db')}`, authToken: 'token' }), /must not be set/);
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); await store.ready(); await store.close(); await rm(dir, { recursive: true, force: true });
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

test('deployment config requires one Telegram principal and a remote Turso database', () => {
  const env = { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner', TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_ALLOWED_USER_IDS: '1,2', CAREER_COPILOT_PRIVATE_CHAT_IDS: '2', MASTRA_DATABASE_URL: 'libsql://career-example.turso.io', TURSO_AUTH_TOKEN: 'token' };
  assert.throws(() => resolveRuntimeConfig({ env: { ...env, MASTRA_DATABASE_URL: undefined }, requireDeployment: true }), /MASTRA_DATABASE_URL/);
  assert.throws(() => resolveRuntimeConfig({ env: { ...env, MASTRA_DATABASE_URL: `file:${path.join(tmpdir(), 'jobs.db')}`, TURSO_AUTH_TOKEN: undefined }, requireDeployment: true }), /remote Turso/);
  assert.throws(() => resolveRuntimeConfig({ env, requireDeployment: true }), /exactly one/);
  const config = resolveRuntimeConfig({ env: { ...env, TELEGRAM_ALLOWED_USER_IDS: '1', CAREER_COPILOT_MODEL: ' main-model ', CAREER_COPILOT_MEMORY_MODEL: ' memory-model ' }, requireDeployment: true });
  assert.equal(config.databaseAuthToken, 'token');
  assert.equal(config.memoryModel, 'memory-model');
  assert.equal(resolveRuntimeConfig({ env: { ...env, TELEGRAM_ALLOWED_USER_IDS: '1', CAREER_COPILOT_MODEL: ' main-model ', CAREER_COPILOT_MEMORY_MODEL: '   ' }, requireDeployment: true }).memoryModel, 'main-model');
  assert.equal(resolveRuntimeConfig({ env: { ...env, TELEGRAM_ALLOWED_USER_IDS: '1', CAREER_COPILOT_MODEL: '   ', CAREER_COPILOT_MEMORY_MODEL: '   ' }, requireDeployment: true }).memoryModel, 'opencode-go/deepseek-v4-flash');
});

test('recovery rejects revoked persisted Telegram users before effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-revoke-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.enqueue({ jobId: 'job-revoke', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-revoke', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' }); let processed = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['9']), privateChatIds: new Set(['2']), store, respond: async () => { processed++; return 'unexpected'; } }); await runtime.recoverUnfinished(async () => {});
  assert.equal(processed, 0); assert.equal((await store.get('job-revoke'))?.status, 'queued'); await runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('legacy safe_result rows normalize missing reportId from persisted columns', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-legacy-result-')); const filename = path.join(dir, 'jobs.db'); const url = `file:${filename}`;
  const store = new CareerStore(url);
  await store.enqueue({ jobId: 'legacy-result', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'legacy-result-event', originalUrl: 'https://linkedin.com/jobs/legacy-result', canonicalUrl: 'https://linkedin.com/jobs/legacy-result' });
  await store.close();
  const db = new DatabaseSync(filename);
  db.exec(`UPDATE career_jobs SET status='succeeded', report_id='legacy-report', safe_result='{"summary":"done","reportId":null}' WHERE job_id='legacy-result';`); db.close();
  const reopened = new CareerStore(url); const job = await reopened.get('legacy-result');
  assert.equal(job?.safeResult?.reportId, 'legacy-report');
  assert.equal(job?.safeResult?.summary, 'done');
  await reopened.close(); await rm(dir, { recursive: true, force: true });
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

test('Telegram stop aborts an in-flight long poll without false failure log', async () => {
  const originalFetch = globalThis.fetch; let signal: AbortSignal | undefined; const events: string[] = [];
  globalThis.fetch = async (_input, init) => new Promise<Response>((_resolve, reject) => { signal = init?.signal ?? undefined; signal?.addEventListener('abort', () => reject(signal?.reason), { once: true }); setTimeout(() => reject(new Error('late timeout')), 30); });
  try { const transport = createTelegramPollingTransport('bot-token', async () => {}, (_level, event) => { events.push(event); }); const started = transport.start(); await new Promise((resolve) => setImmediate(resolve)); transport.stop(); await started; assert.equal(signal?.aborted, true); assert.deepEqual(events, ['telegram.poll.started', 'telegram.poll.stopped']); } finally { globalThis.fetch = originalFetch; }
});

test('Telegram transport can deliver a recovery message before polling', async () => {
  const originalFetch = globalThis.fetch; const calls: unknown[] = []; const events: string[] = [];
  globalThis.fetch = async (_input, init) => { calls.push(JSON.parse(String(init?.body))); return new Response(JSON.stringify({ ok: true, result: true }), { headers: { 'content-type': 'application/json' } }); };
  try { const transport = createTelegramPollingTransport('bot-token', async () => {}, (_level, event) => { events.push(event); }); await transport.sendMessage('chat-1', 'recovered'); assert.deepEqual(calls, [{ chat_id: 'chat-1', text: 'recovered' }]); assert.deepEqual(events, ['telegram.reply.started', 'telegram.reply.sent']); transport.stop(); } finally { globalThis.fetch = originalFetch; }
});

test('local observability exporter only accepts trace events', async () => {
  const module = await import('../src/observability.ts').catch(() => ({}));
  const factory = (module as { createTraceStorageExporter?: () => Record<string, unknown> }).createTraceStorageExporter;
  assert.equal(typeof factory, 'function');
  const exporter = factory!();
  assert.equal(typeof exporter.onTracingEvent, 'function'); assert.equal('onMetricEvent' in exporter, false); assert.equal('onLogEvent' in exporter, false);
});

test('terminal app logger emits safe events without raw answer leakage', async () => {
  const module = await import('../src/observability.ts');
  const lines: string[] = [];
  const logger = module.createTerminalAppLogger(() => 'now', { log: (line: string) => { lines.push(line); }, warn: (line: string) => { lines.push(line); }, error: (line: string) => { lines.push(line); } });
  logger('info', 'onboarding.model.succeeded', { status: 'collecting', version: 2, fieldKeys: ['skills', `x${'y'.repeat(200)}\nnext`], updateId: 10, requestId: `req-${'z'.repeat(200)}`, rawAnswer: 'secret synthetic answer', url: 'https://example.test', ownerId: 'owner' });
  assert.equal(lines.length, 1);
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.requestId.length, 120);
  assert.equal(parsed.fieldKeys[1].length, 120);
  assert.doesNotMatch(parsed.fieldKeys[1], /\n/);
  assert.deepEqual({ ts: parsed.ts, level: parsed.level, event: parsed.event, status: parsed.status, version: parsed.version, firstField: parsed.fieldKeys[0], updateId: parsed.updateId }, { ts: 'now', level: 'info', event: 'onboarding.model.succeeded', status: 'collecting', version: 2, firstField: 'skills', updateId: 10 });
  assert.doesNotMatch(lines[0], /secret synthetic answer|example\.test|rawAnswer|url|owner/);
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
  const { executeSaveJob } = await import('../src/tools/save-job-tool.ts'); const dir = await mkdtemp(path.join(tmpdir(), 'career-http-retry-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let attempts = 0;
  await executeSaveJob({ input: { jobId: 'retry-job', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'retry-event', originalUrl: 'https://linkedin.com/jobs/retry', canonicalUrl: 'https://linkedin.com/jobs/retry' }, profileContext: 'profile', store, acquire: async () => { attempts++; if (attempts === 1) throw Object.assign(new Error('Job fetch failed (429).'), { status: 429 }); return { contentType: 'text/plain', text: 'job' }; }, analyze: async () => ({ schemaVersion: 1, title: 'Title', company: 'Company', location: '', summary: 'Summary', fitScore: 1, nextStep: 'Apply' }) });
  assert.equal(attempts, 2); await store.close(); await rm(dir, { recursive: true, force: true });
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

test('safeErrorMessage classifies every fetch failure without leaking internals', () => {
  // regression: HTTP-status fetch failures and the host-policy message used to
  // fall through to the generic category (the regexes said "unsupported" and had
  // no "fetch" alternative) — surfaced by eval scenarios S17b/S17g
  const fetchSafe = 'Job content could not be fetched safely.';
  assert.equal(safeErrorMessage(new Error('Job fetch failed (500).')), fetchSafe);
  assert.equal(safeErrorMessage(new Error('Job fetch failed (429).')), fetchSafe);
  assert.equal(safeErrorMessage(new Error('Job URL host is not supported.')), fetchSafe);
  assert.equal(safeErrorMessage(new Error('Job URL redirected to another site.')), fetchSafe);
  assert.equal(safeErrorMessage(new Error('Job URL resolves to a private or reserved address.')), fetchSafe);
  assert.equal(safeErrorMessage(new Error('something else')), 'Job processing failed; use /job for recovery.');
});

test('Mastra registrations live in the mandated entrypoint', async () => {
  const source = await readFile(new URL('../src/mastra/index.ts', import.meta.url), 'utf8'); assert.match(source, /new Mastra\s*\(/);
});
