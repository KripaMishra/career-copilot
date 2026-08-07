import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CareerStore } from '../src/storage/career-store.ts';
import { acquireJobText, normalizeResponseStatus, validateJobUrl } from '../src/tools/web-fetch-tool.ts';
import { readProfile, writeAtomicReport } from '../src/integrations/local-files.ts';
import { GoogleSheetsBoundary, upsertSheetRow, type SheetAdapter } from '../src/integrations/google-sheets.ts';
import { createSaveJobWorkflow } from '../src/workflows/save-job.ts';
import { isRestartableWorkflowSnapshot } from '../src/workflows/run-selection.ts';
import { parseCommand, createCareerCopilotRuntime } from '../src/services/career-runtime.ts';
import { assertOperationalDatabaseUrl, resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createTelegramPollingTransport } from '../src/channels/telegram-transport.ts';

test('one career_jobs table deduplicates transport events and has minimal statuses', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const input = { jobId: 'job-1', userId: '1', ownerId: 'owner', chatId: 'chat', transportEventId: 'event-1', originalUrl: 'https://linkedin.com/jobs/view/1', canonicalUrl: 'https://linkedin.com/jobs/view/1' };
  assert.equal(store.enqueue(input).duplicate, false);
  assert.equal(store.enqueue(input).duplicate, true);
  assert.deepEqual(store.statuses(), ['queued', 'running', 'needs_input', 'succeeded', 'failed']);
  store.close(); await rm(dir, { recursive: true, force: true });
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
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']) });
  const replies: string[] = [];
  const rejected = await runtime.handleTelegramUpdate({ update_id: 1, message: { message_id: 1, date: 1, chat: { id: 2, type: 'private' }, from: { id: 9 }, text: '/queue' } }, (text) => { replies.push(text); return Promise.resolve(); });
  assert.equal(rejected.outcome, 'rejected');
  assert.equal(replies.length, 0);
});

test('authorized save completes through a fake adapter and stores before notification', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-e2e-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const replies: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async (job) => { store.complete(job.jobId, { summary: 'done', reportPath: '/safe/report.md', sheetReference: job.jobId }, '/safe/report.md', job.jobId); } });
  const result = await runtime.handleTelegramUpdate({ update_id: 2, message: { message_id: 2, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/1' } }, (text) => { replies.push(text); return Promise.resolve(); });
  assert.equal(result.outcome, 'accepted'); assert.equal(runtime.store.get((result as { jobId: string }).jobId)?.userId, '1');
  for (let i = 0; i < 20 && replies.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.deepEqual(replies, [`Accepted job ${(result as { jobId: string }).jobId}.`, 'done']);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.ok(store.get((result as { jobId: string }).jobId)?.notifiedAt);
  runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('save schedules processing before an acknowledgement can fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-ack-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async (job) => { store.complete(job.jobId, { summary: 'stored', reportPath: null, sheetReference: null }, '', job.jobId); } });
  await assert.rejects(() => runtime.handleTelegramUpdate({ update_id: 30, message: { message_id: 30, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/30' } }, async () => { throw new Error('telegram unavailable'); }));
  for (let i = 0; i < 20 && store.list('succeeded').length === 0; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.list('succeeded').length, 1); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('job lookup includes the stored safe completion summary', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-job-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-summary', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-summary', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' }); store.complete('job-summary', { summary: 'safe summary', reportPath: '/safe/report.md', sheetReference: 'job-summary' }, '/safe/report.md', 'job-summary');
  const replies: string[] = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store });
  await runtime.handleTelegramUpdate({ update_id: 31, message: { message_id: 31, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/job job-summary' } }, (text) => { replies.push(text); return Promise.resolve(); });
  assert.match(replies[0], /safe summary/); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('failed processors persist a safe failure and queued jobs continue after the active job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-runtime-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const updates = (id: number, url: string) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: `/save ${url}` } });
  let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); const processed: string[] = [];
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async (job) => { processed.push(job.jobId); if (processed.length === 1) { await gate; throw new Error('provider secret=do-not-store'); } store.complete(job.jobId, { summary: 'done', reportPath: null, sheetReference: null }, '', job.jobId); } });
  const first = await runtime.handleTelegramUpdate(updates(3, 'https://linkedin.com/jobs/1')); const second = await runtime.handleTelegramUpdate(updates(4, 'https://linkedin.com/jobs/2'));
  release();
  for (let i = 0; i < 50 && processed.length < 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(store.get((first as { jobId: string }).jobId)?.status, 'failed'); assert.match(store.get((first as { jobId: string }).jobId)?.safeError ?? '', /processing failed/i); assert.doesNotMatch(store.get((first as { jobId: string }).jobId)?.safeError ?? '', /secret|do-not-store/);
  assert.equal(store.get((second as { jobId: string }).jobId)?.status, 'succeeded'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('notification failure leaves stored success for one restart retry', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-notify-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  const queued = store.enqueue({ jobId: 'job-notify', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-notify', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  store.markRunning(queued.job.jobId, 'run-1'); store.complete(queued.job.jobId, { summary: 'stored', reportPath: null, sheetReference: null }, '', 'job-notify');
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store }); let attempts = 0;
  await runtime.recoverUnfinished(async () => { attempts++; throw new Error('telegram unavailable'); });
  assert.equal(store.get('job-notify')?.status, 'succeeded'); assert.equal(store.get('job-notify')?.notifiedAt, null);
  await runtime.recoverUnfinished(async () => { attempts++; }); assert.equal(attempts, 2); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('recovery delivers completion to the job chat', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-recovery-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-recovery', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-recovery', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  store.markRunning('job-recovery', 'run-1'); store.complete('job-recovery', { summary: 'recovered', reportPath: null, sheetReference: null }, '', 'job-recovery');
  const delivered: Array<[string, string]> = []; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store });
  await runtime.recoverUnfinished((text, chatId) => { delivered.push([chatId ?? '', text]); return Promise.resolve(); });
  assert.deepEqual(delivered, [['2', 'recovered']]); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('workflow rejects an unbound input before acquisition and Sheets effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-workflow-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let acquired = false; let sheeted = false;
  const workflow = createSaveJobWorkflow({ store, reportsRoot: dir, profileText: 'profile', acquire: async () => { acquired = true; return { contentType: 'text/plain', text: 'job' }; }, analyze: async () => ({ schemaVersion: 1, title: 'title', company: 'company', location: 'remote', summary: 'summary', fitScore: 1, nextStep: 'next' }), report: async () => ({ path: '/tmp/report.md', hash: 'sha256:x' }), sheet: { async findByJobId() { return null; }, async write() { sheeted = true; } } });
  const run = await workflow.createRun(); const originalError = console.error; console.error = () => {};
  let result; try { result = await run.start({ inputData: { jobId: 'unbound', userId: '1', ownerId: 'owner', chatId: 'chat', transportEventId: 'event', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' } }); } finally { console.error = originalError; }
  assert.equal(result.status, 'failed'); assert.equal(acquired, false); assert.equal(sheeted, false); store.close(); await rm(dir, { recursive: true, force: true });
});

test('any non-success workflow result fails the durable job', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-workflow-status-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-status', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-status', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' });
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async () => ({ status: 'suspended' }) });
  await runtime.recoverUnfinished(async () => {}); assert.equal(store.get('job-status')?.status, 'failed'); runtime.close(); await rm(dir, { recursive: true, force: true });
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

test('deployment config requires one Telegram principal and Sheets credentials', () => {
  const env = { CAREER_COPILOT_OWNER_RESOURCE_ID: 'owner', TELEGRAM_BOT_TOKEN: 'token', TELEGRAM_ALLOWED_USER_IDS: '1,2', CAREER_COPILOT_PRIVATE_CHAT_IDS: '2', GOOGLE_SHEETS_SPREADSHEET_ID: 'sheet', GOOGLE_OAUTH_CLIENT_ID: 'id', GOOGLE_OAUTH_CLIENT_SECRET: 'secret', GOOGLE_OAUTH_REFRESH_TOKEN: 'refresh' };
  assert.throws(() => resolveRuntimeConfig({ env, requireDeployment: true }), /exactly one/);
  const config = resolveRuntimeConfig({ env: { ...env, TELEGRAM_ALLOWED_USER_IDS: '1' }, requireDeployment: true });
  assert.equal(config.sheetsOAuth.scope, 'https://www.googleapis.com/auth/spreadsheets');
});

test('recovery rejects revoked persisted Telegram users before effects', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-revoke-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  store.enqueue({ jobId: 'job-revoke', userId: '1', ownerId: 'owner', chatId: '2', transportEventId: 'event-revoke', originalUrl: 'https://linkedin.com/jobs/1', canonicalUrl: 'https://linkedin.com/jobs/1' }); let processed = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['9']), privateChatIds: new Set(['2']), store, processor: async () => { processed++; } }); await runtime.recoverUnfinished(async () => {});
  assert.equal(processed, 0); assert.equal(store.get('job-revoke')?.status, 'queued'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('legacy jobs migrate with null user IDs and fail closed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-legacy-')); const filename = path.join(dir, 'jobs.db'); const db = new DatabaseSync(filename);
  db.exec(`CREATE TABLE career_jobs (job_id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, chat_id TEXT NOT NULL, transport_event_id TEXT NOT NULL UNIQUE, original_url TEXT NOT NULL, canonical_url TEXT NOT NULL, status TEXT NOT NULL, mastra_run_id TEXT, attempts INTEGER NOT NULL DEFAULT 0, report_path TEXT, sheet_reference TEXT, safe_result TEXT, safe_error TEXT, notified_at INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT; INSERT INTO career_jobs (job_id,owner_id,chat_id,transport_event_id,original_url,canonical_url,status,created_at,updated_at) VALUES ('legacy','owner','2','legacy-event','https://linkedin.com/jobs/1','https://linkedin.com/jobs/1','queued',1,1);`); db.close();
  const store = new CareerStore(`file:${filename}`); assert.equal(store.get('legacy')?.userId, null); let processed = 0; const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async () => { processed++; } }); await runtime.recoverUnfinished(async () => {});
  assert.equal(processed, 0); assert.equal(store.get('legacy')?.status, 'queued'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('live and recovery drains serialize one job without duplication', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-drain-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; }); let active = 0; let maximum = 0; let calls = 0;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, processor: async (job) => { calls++; active++; maximum = Math.max(maximum, active); await gate; store.complete(job.jobId, { summary: 'done', reportPath: null, sheetReference: null }, '', job.jobId); active--; } });
  const live = runtime.handleTelegramUpdate({ update_id: 40, message: { message_id: 40, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/40' } }); const recovery = runtime.recoverUnfinished(async () => {}); await new Promise((resolve) => setImmediate(resolve)); release(); await Promise.all([live, recovery]);
  assert.equal(calls, 1); assert.equal(maximum, 1); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('workflow snapshot restartability requires persisted active state', () => {
  assert.equal(isRestartableWorkflowSnapshot(null), false); assert.equal(isRestartableWorkflowSnapshot({ status: 'running', isFromInMemory: true }), false); assert.equal(isRestartableWorkflowSnapshot({ status: 'running' }), true); assert.equal(isRestartableWorkflowSnapshot({ status: 'pending' }), false); assert.equal(isRestartableWorkflowSnapshot({ status: 'pending', payload: {} }), true); assert.equal(isRestartableWorkflowSnapshot({ status: 'failed' }), false);
});

test('injected acquisition aborts on the overall timeout', async () => {
  let signal!: AbortSignal; await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { timeoutMs: 10, resolve: async () => ['93.184.216.34'], fetch: async (_url, init) => { signal = init?.signal as AbortSignal; return new Promise<Response>((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))); } })); assert.equal(signal.aborted, true);
  await assert.rejects(() => acquireJobText('https://linkedin.com/jobs/1', { timeoutMs: 10, resolve: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return ['93.184.216.34']; }, fetch: async () => new Response('late', { headers: { 'content-type': 'text/plain' } }) }));
});

test('Sheets update verification rejects when the stale row remains', async () => {
  const boundary = new GoogleSheetsBoundary({ target: { spreadsheetId: 'sheet', trackerTab: 'Applications', auditTab: 'Audit', topicsTab: 'Topics' }, authorize: async () => 'token', api: { verifyTarget: async () => {}, readHeaders: async () => ['Job ID', 'Status', 'Title', 'Company', 'Report Path'], readRows: async () => [{ 'Job ID': 'stale-job', Status: 'queued', Title: 'Old', Company: 'Old Co', 'Report Path': 'old.md' }], appendRow: async () => {}, updateRow: async () => {} } });
  await assert.rejects(() => boundary.upsert({ jobId: 'stale-job', status: 'succeeded', title: 'New', company: 'New Co', reportPath: '/safe/new.md' }), /could not be verified/);
});

test('transient enqueue failure does not poison runtime replay state', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-v0-retry-update-')); const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`); const enqueue = store.enqueue.bind(store); let first = true;
  store.enqueue = ((input) => { if (first) { first = false; throw new Error('database busy'); } return enqueue(input); }) as typeof store.enqueue;
  const runtime = createCareerCopilotRuntime({ ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store }); const update = { update_id: 50, message: { message_id: 50, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/save https://linkedin.com/jobs/50' } };
  await assert.rejects(() => runtime.handleTelegramUpdate(update)); const retried = await runtime.handleTelegramUpdate(update); assert.equal(retried.outcome, 'accepted'); runtime.close(); await rm(dir, { recursive: true, force: true });
});

test('Telegram polling advances offset only after durable handling', async () => {
  const originalFetch = globalThis.fetch; const offsets: number[] = []; let handled = 0; let transport!: ReturnType<typeof createTelegramPollingTransport>;
  globalThis.fetch = async (_input, init) => { const body = JSON.parse(String(init?.body)); offsets.push(body.offset); return new Response(JSON.stringify({ ok: true, result: [{ update_id: 60, message: { message_id: 60, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, text: '/queue' } }] }), { headers: { 'content-type': 'application/json' } }); };
  try { transport = createTelegramPollingTransport('bot-token', async () => { handled++; if (handled === 1) throw new Error('database busy'); transport.stop(); }); await transport.start(); assert.deepEqual(offsets.slice(0, 2), [0, 0]); } finally { transport?.stop(); globalThis.fetch = originalFetch; }
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
