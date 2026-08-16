import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPiiService } from '../src/services/pii.ts';
import { handleResumeDocument, type OnboardingResponderInput } from '../src/services/career-runtime.ts';
import { extractPdfText, type PdfExtraction } from '../src/integrations/pdf-text.ts';
import { CareerStore } from '../src/storage/career-store.ts';
import { makePdf, textPdf } from './helpers/pdf-fixtures.ts';

const PAN = 'ABCDE1234F';
const EMAIL = 'resume-owner@example.test';
const PHONE = '98765 43210';
const FILE_ID_CANARY = 'file_id_canary_42';
const FILE_UNIQUE_ID_CANARY = 'file_unique_id_canary_7';
const FILE_NAME_CANARY = 'canary_resume.pdf';

const resumeText = `Engineer. Email ${EMAIL}, phone ${PHONE}, PAN ${PAN}.`;
const canaries = [PAN, EMAIL, PHONE, FILE_ID_CANARY, FILE_UNIQUE_ID_CANARY, FILE_NAME_CANARY];

type Spy = { seen: OnboardingResponderInput[] };
const spyResponder = (spy: Spy) => async (input: OnboardingResponderInput) => { spy.seen.push(input); return { reply: 'Resume processed. What is your current role/status?', draftPatch: {}, readyForReview: false }; };

const documentUpdate = (file: Partial<{ mime: string; name: string; size: number; bytes: Uint8Array; caption: string; fileId: string; uniqueId: string }> = {}) => ({
  update_id: 7001,
  message: {
    message_id: 7001, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 },
    document: {
      file_id: file.fileId ?? FILE_ID_CANARY,
      file_unique_id: file.uniqueId ?? FILE_UNIQUE_ID_CANARY,
      file_name: file.name ?? 'resume.pdf',
      mime_type: file.mime ?? 'application/pdf',
      ...(file.size !== undefined ? { file_size: file.size } : {}),
    },
    ...(file.caption !== undefined ? { caption: file.caption } : {}),
  },
});

async function withStore(fn: (store: CareerStore) => Promise<void>, revalidator?: { redactText(text: string): Promise<string>; redactDocument(value: unknown): Promise<unknown> }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-resume-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, revalidator ? { piiRevalidator: revalidator } : {});
  await store.ready();
  try { await fn(store); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

async function piiService() {
  const pii = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 200_000, readiness: true });
  await pii.warmup();
  return pii;
}

function startOnboarding(store: CareerStore) {
  return store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
}

test('resume ingestion: valid PDF is redacted before the responder spy and carries page metadata', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    const downloads: string[] = [];
    const reply = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: FILE_ID_CANARY, file_unique_id: FILE_UNIQUE_ID_CANARY, file_name: FILE_NAME_CANARY, mime_type: 'application/pdf' },
      pii: await piiService(), onboard: spyResponder(spy),
      download: async (fileId) => { downloads.push(fileId); return { bytes: textPdf(resumeText), byteSize: textPdf(resumeText).byteLength }; },
    });
    assert.equal(downloads.length, 1);
    assert.equal(downloads[0], FILE_ID_CANARY);
    assert.equal(spy.seen.length, 1);
    const seen = spy.seen[0].text;
    assert.match(seen, /\[EMAIL_1\]/);
    assert.match(seen, /\[PHONE_1\]/);
    assert.match(seen, /\[PAN_1\]/);
    assert.match(seen, /Resume document processed safely: 1 page\(s\) extracted/);
    for (const canary of canaries) assert.ok(!seen.includes(canary), `raw canary ${canary} must not reach the responder`);
    assert.ok(!reply.includes(PAN) && !reply.includes(EMAIL) && !reply.includes(PHONE));
  });
});

test('resume ingestion: unauthorized envelopes are rejected before any download or parse', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    let downloads = 0;
    const run = async (file: Parameters<typeof handleResumeDocument>[0]['document'] & { caption?: string; size?: number }) => handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', ...file, ...(file.size !== undefined ? { file_size: file.size } : {}) },
      ...(file.caption !== undefined ? { caption: file.caption } : {}),
      pii: await piiService(), onboard: spyResponder(spy),
      download: async () => { downloads++; return { bytes: textPdf('x'), byteSize: 1 }; },
    });
    assert.match(await run({ mime_type: 'image/png', file_name: 'x.png' }), /Only text-based PDF documents are accepted/);
    assert.match(await run({ mime_type: 'application/pdf', file_name: 'x.docx' }), /Only \.pdf documents are accepted/);
    assert.match(await run({ mime_type: 'application/pdf', file_name: 'x.pdf', size: 6 * 1024 * 1024 }), /too large \(maximum 5 MiB\)/);
    assert.match(await run({ mime_type: 'application/pdf', file_name: 'x.pdf', caption: 'here is my resume' }), /without a caption/);
    assert.equal(downloads, 0, 'no download may happen for rejected envelopes');
    assert.equal(spy.seen.length, 0, 'no responder call for rejected envelopes');
  });
});

test('resume ingestion: missing MIME type or filename is rejected before any download', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    let downloads = 0;
    const run = async (file: Record<string, unknown>) => handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', ...file } as Parameters<typeof handleResumeDocument>[0]['document'],
      pii: await piiService(), onboard: spyResponder(spy),
      download: async () => { downloads++; return { bytes: textPdf('x'), byteSize: 1 }; },
    });
    assert.match(await run({ file_name: 'resume.pdf' }), /Only text-based PDF documents are accepted/, 'missing mime_type must be rejected');
    assert.match(await run({ mime_type: 'application/pdf' }), /Only \.pdf documents are accepted/, 'missing file_name must be rejected');
    assert.equal(downloads, 0, 'no download may happen for missing envelope fields');
    assert.equal(spy.seen.length, 0);
  });
});

test('resume ingestion: signature mismatch, malformed, encrypted, no-text, timeout, overlong, and page-cap are safe rejections', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    const rejections: Array<{ bytes: Uint8Array; extract?: (b: Uint8Array) => Promise<PdfExtraction>; expected: RegExp }> = [
      { bytes: new TextEncoder().encode('PK\x03\x04 not a pdf'), expected: /not a valid PDF/ },
      { bytes: new TextEncoder().encode('%PDF-1.4\nbroken'), expected: /malformed/ },
      { bytes: makePdf(['secret'], { encrypt: true }), expected: /Encrypted PDFs/ },
      { bytes: makePdf(['']), expected: /no extractable text/ },
      { bytes: textPdf('x'), extract: async () => ({ ok: false, reason: 'timeout' }), expected: /could not be processed in time/ },
      { bytes: textPdf('x'), extract: async () => ({ ok: false, reason: 'overlong' }), expected: /too much text/ },
      { bytes: textPdf('x'), extract: async () => ({ ok: false, reason: 'too_many_pages' }), expected: /too many pages/ },
    ];
    for (const { bytes, extract, expected } of rejections) {
      const reply = await handleResumeDocument({
        store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
        document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
        pii: await piiService(), onboard: spyResponder(spy),
        download: async () => ({ bytes, byteSize: bytes.byteLength }),
        ...(extract ? { extract: extract as typeof extractPdfText } : {}),
      });
      assert.match(reply, expected);
    }
    assert.equal(spy.seen.length, 0, 'no responder call on any rejection path');
  });
});

test('resume ingestion: readiness gate down disables ingestion with a safe message', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    const disabled = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 200_000, readiness: true });
    const unready = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
      pii: disabled, onboard: spyResponder(spy),
      download: async () => { throw new Error('must not download'); },
    });
    assert.match(unready, /currently unavailable/);
    const offConfig = createPiiService({ enabled: false, patterns: [], anonymizeFormat: 'type', maxInputChars: 200_000, readiness: true });
    await offConfig.warmup();
    const off = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
      pii: offConfig, onboard: spyResponder(spy),
      download: async () => { throw new Error('must not download'); },
    });
    assert.match(off, /currently unavailable/);
    assert.equal(spy.seen.length, 0);
  });
});

test('resume ingestion: without active onboarding the document is refused safely', async () => {
  await withStore(async (store) => {
    const spy: Spy = { seen: [] };
    const reply = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
      pii: await piiService(), onboard: spyResponder(spy),
      download: async () => { throw new Error('must not download'); },
    });
    assert.match(reply, /Start \/onboarding first/);
    assert.equal(spy.seen.length, 0);
  });
});

test('resume ingestion: draft rows and logs never carry file metadata or raw canaries', async () => {
  const pii = await piiService();
  await withStore(async (store) => {
    const state = await startOnboarding(store);
    const events: Array<Record<string, unknown>> = [];
    const logger = (_level: string, event: string, data: Record<string, unknown> = {}) => { events.push({ event, ...data }); };
    const spy: Spy = { seen: [] };
    const responder = async (input: OnboardingResponderInput) => { spy.seen.push(input); return { reply: 'ok', draftPatch: { currentStatus: 'Senior backend engineer.' }, readyForReview: false }; };
    await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: FILE_ID_CANARY, file_unique_id: FILE_UNIQUE_ID_CANARY, file_name: FILE_NAME_CANARY, mime_type: 'application/pdf' },
      pii, onboard: responder, logger,
      download: async () => ({ bytes: textPdf(resumeText), byteSize: textPdf(resumeText).byteLength }),
    });
    const draft = await store.loadOnboarding('owner', 'telegram:2');
    assert.equal(draft?.version, state.version + 1);
    for (const canary of [...canaries, FILE_NAME_CANARY]) {
      assert.ok(!JSON.stringify(draft?.draft).includes(canary), `draft must not contain ${canary}`);
    }
    const serializedLogs = JSON.stringify(events);
    for (const canary of [FILE_ID_CANARY, FILE_UNIQUE_ID_CANARY, FILE_NAME_CANARY, PAN, EMAIL, PHONE]) {
      assert.ok(!serializedLogs.includes(canary), `logs must not contain ${canary}`);
    }
    assert.ok(events.some((event) => event.event === 'telegram.update.accepted' || event.event === 'onboarding.draft.saved' || event.event === 'onboarding.model.succeeded'));
  }, { redactText: (text: string) => pii.redactText(text), redactDocument: (value: unknown) => pii.redactDocument(value) });
});

test('resume ingestion: redaction failure delivers exactly one safe terminal reply, no model call, no write', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    let modelCalls = 0;
    const capped = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 20, readiness: true });
    await capped.warmup();
    const reply = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
      pii: capped,
      onboard: async (input) => { modelCalls++; spy.seen.push(input); return { reply: 'never', draftPatch: {}, readyForReview: false }; },
      download: async () => ({ bytes: textPdf('Engineer with more than twenty characters of resume text.'), byteSize: 1 }),
    });
    assert.match(reply, /could not be processed safely/);
    assert.equal(modelCalls, 0, 'no responder call on redaction failure');
    assert.equal(spy.seen.length, 0);
    const row = await store.loadOnboarding('owner', 'telegram:2');
    assert.equal(row?.version, 1, 'no write on redaction failure');
  });
});

test('resume ingestion: resumes above 4000 characters process normally with the aligned default cap', async () => {
  await withStore(async (store) => {
    await startOnboarding(store);
    const spy: Spy = { seen: [] };
    const longText = `Engineer. Email resume-owner@example.test, phone 98765 43210, PAN ABCDE1234F.\n${'x'.repeat(4200)}`;
    const reply = await handleResumeDocument({
      store, ownerId: 'owner', conversationId: 'telegram:2', requestId: 'req-1',
      document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'x.pdf', mime_type: 'application/pdf' },
      pii: await piiService(), onboard: spyResponder(spy),
      download: async () => ({ bytes: textPdf('Engineer.'), byteSize: 1 }),
      extract: async () => ({ ok: true, text: longText, pageCount: 1 }),
    });
    assert.match(reply, /Resume processed/);
    assert.equal(spy.seen.length, 1);
    assert.ok(!spy.seen[0].text.includes('ABCDE1234F'), 'long resume canaries still redacted');
  });
});

test('telegram downloader aborts at the byte cap on chunked responses without content-length', async () => {
  const { createTelegramFileDownloader, DownloadLimitExceededError } = await import('../src/channels/telegram-transport.ts');
  const originalFetch = globalThis.fetch;
  let served = 0;
  try {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/resume.pdf' } }), { headers: { 'content-type': 'application/json' } });
      }
      served++;
      // chunked stream, no content-length header: must abort as soon as the cap passes
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 20; i++) controller.enqueue(encoder.encode('x'.repeat(1024 * 1024)));
          controller.close();
        },
      });
      return new Response(body);
    };
    const downloader = createTelegramFileDownloader('token');
    await assert.rejects(() => downloader('file-1', { maxBytes: 5 * 1024 * 1024 }), (error: unknown) => error instanceof DownloadLimitExceededError && error.byteSize > 5 * 1024 * 1024);
    assert.equal(served, 1, 'the file stream must be served once and aborted at the cap');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('telegram downloader accepts a bounded chunked response at or under the cap', async () => {
  const { createTelegramFileDownloader } = await import('../src/channels/telegram-transport.ts');
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).includes('/getFile')) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: 'docs/resume.pdf' } }), { headers: { 'content-type': 'application/json' } });
      }
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode('a'.repeat(1024)));
          controller.enqueue(encoder.encode('b'.repeat(1024)));
          controller.close();
        },
      });
      return new Response(body);
    };
    const downloader = createTelegramFileDownloader('token');
    const result = await downloader('file-2', { maxBytes: 5 * 1024 * 1024 });
    assert.equal(result.byteSize, 2048);
    assert.equal(new TextDecoder().decode(result.bytes.subarray(0, 1)), 'a');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('runtime telegram document update routes through ingestion and caches the safe reply', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-resume-runtime-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.ready();
  try {
    const { createCareerCopilotRuntime } = await import('../src/services/career-runtime.ts');
    await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const spy: Spy = { seen: [] };
    const pii = await piiService();
    const runtime = createCareerCopilotRuntime({
      ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store,
      respond: async () => { throw new Error('document turns must not hit the agent responder'); },
      onboard: spyResponder(spy), pii,
      downloadFile: async () => ({ bytes: textPdf(resumeText), byteSize: textPdf(resumeText).byteLength }),
    });
    assert.equal(runtime.ingestionAvailable(), true);
    const replies: string[] = [];
    const result = await runtime.handleTelegramUpdate(documentUpdate(), async (text) => { replies.push(text); });
    assert.equal(result.outcome, 'accepted');
    assert.equal(result.command, 'resume');
    assert.equal(replies.length, 1);
    assert.match(replies[0], /Resume processed/);
    assert.equal(spy.seen.length, 1);
    assert.ok(!spy.seen[0].text.includes(PAN) && !spy.seen[0].text.includes(EMAIL) && !spy.seen[0].text.includes(PHONE));
    assert.ok(!replies[0].includes(PAN));
  } finally {
    await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('runtime without PII keeps the legacy document rejection behavior', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-resume-legacy-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
  await store.ready();
  try {
    const { createCareerCopilotRuntime } = await import('../src/services/career-runtime.ts');
    const runtime = createCareerCopilotRuntime({
      ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store,
      respond: async () => { throw new Error('must not respond'); },
      downloadFile: async () => { throw new Error('must not download'); },
    });
    const result = await runtime.handleTelegramUpdate(documentUpdate());
    assert.equal(result.outcome, 'rejected');
    assert.equal(result.reason, 'invalid_message');
  } finally {
    await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('telegram envelope validation accepts safe document messages and rejects malformed ones', async () => {
  const { assertRawTelegramUpdate } = await import('../src/channels/telegram-auth.ts');
  assertRawTelegramUpdate(documentUpdate({ mime: 'application/pdf', name: 'r.pdf', size: 100 }));
  assert.throws(() => assertRawTelegramUpdate(documentUpdate({ name: 'r.pdf', size: 100, fileId: '' })), /Invalid Telegram update/);
  assert.throws(() => assertRawTelegramUpdate(documentUpdate({ mime: 'application/pdf', name: 'r.pdf', size: -1 })), /Invalid Telegram update/);
  assert.throws(() => assertRawTelegramUpdate(documentUpdate({ mime: 'application/pdf', name: 'r.pdf', caption: 'x'.repeat(2000) })), /Invalid Telegram update/);
});
