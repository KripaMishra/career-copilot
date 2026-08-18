import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createPiiService } from '../src/services/pii.ts';
import { CareerStore, ResumeRevalidationError } from '../src/storage/career-store.ts';
import { textPdf } from './helpers/pdf-fixtures.ts';

async function withStore(fn: (store: CareerStore) => Promise<void>, revalidator?: { redactText(text: string): Promise<string>; redactDocument(value: unknown): Promise<unknown> }) {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-revalidate-'));
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, revalidator ? { piiRevalidator: revalidator } : {});
  await store.ready();
  try { await fn(store); } finally { await store.close(); await rm(dir, { recursive: true, force: true }); }
}

async function piiRevalidator() {
  const pii = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 0, readiness: true });
  await pii.warmup();
  return { redactText: (text: string) => pii.redactText(text), redactDocument: (value: unknown) => pii.redactDocument(value) };
}

const cleanDraft = { currentStatus: 'Senior backend engineer in Bengaluru.' };
const fullDraft = {
  currentStatus: 'Senior backend engineer in Bengaluru.',
  experience: 'Eight years building distributed systems.',
  education: 'BTech Computer Science.',
  skills: 'TypeScript, Python, Kubernetes',
  projects: 'Led a platform migration.',
  achievements: 'Cut p95 latency by 40%.',
  targetRoles: 'Staff engineer at a product company.',
  locationPreferences: 'Remote or Bengaluru.',
  workAuthorization: 'Authorized to work in India.',
  employmentPreferences: 'Full-time.',
  motivators: 'Deep technical problems.',
  careerGoals: 'Grow into an architecture role.',
};

test('resume-derived draft that survives redaction unchanged persists normally', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version });
    const saved = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: cleanDraft.currentStatus } });
    assert.equal(saved.draft.currentStatus, cleanDraft.currentStatus);
  }, await piiRevalidator());
});

test('resume-derived draft that changes under redaction is rejected with a safe error', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version });
    await assert.rejects(
      () => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: 'Contact me at IFSC SBIN0001234 for transfers.' } }),
      (error: unknown) => error instanceof ResumeRevalidationError,
    );
    const row = await store.loadOnboarding('owner', 'telegram:2');
    assert.equal(row?.version, started.version, 'no write may happen for a rejected candidate');
    assert.ok(!JSON.stringify(row?.draft).includes('SBIN0001234'));
  }, await piiRevalidator());
});

test('resume-derived token canary is rejected at the draft boundary', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version });
    await assert.rejects(
      () => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { skills: 'sk-51H8abc12345678901234567890 token' } }),
      (error: unknown) => error instanceof ResumeRevalidationError,
    );
  }, await piiRevalidator());
});

test('lineage is durable: an ordinary review edit after a resume turn is revalidated', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: fullDraft, status: 'review' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
    await assert.rejects(
      () => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version, draft: { skills: 'sk-51H8abc12345678901234567890' }, status: 'review' }),
      (error: unknown) => error instanceof ResumeRevalidationError,
    );
    const cleanEdit = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version, draft: { skills: 'TypeScript, Go' }, status: 'review' });
    assert.equal(cleanEdit.draft.skills, 'TypeScript, Go');
  }, await piiRevalidator());
});

test('resume-derived draft without a revalidator fails closed', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version });
    await assert.rejects(
      () => store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: cleanDraft }),
      (error: unknown) => error instanceof ResumeRevalidationError,
    );
  });
});

test('non-resume writes keep the current path with no revalidation', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const saved = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: { currentStatus: 'Contact me at IFSC SBIN0001234 for transfers.' } });
    assert.equal(saved.draft.currentStatus, 'Contact me at IFSC SBIN0001234 for transfers.');
  }, await piiRevalidator());
});

test('resume-derived completion write rejects a profile that changes under redaction', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-revalidate-sql-'));
  const revalidator = await piiRevalidator();
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, { piiRevalidator: revalidator });
  await store.ready();
  try {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: fullDraft, status: 'review' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
    await store.close();
    // simulate a token that entered the draft outside the validated write path
    const db = new DatabaseSync(path.join(dir, 'jobs.db'));
    db.exec("UPDATE career_onboarding SET draft_json = json_set(draft_json, '$.skills', 'sk-51H8abc12345678901234567890') WHERE owner_id='owner' AND conversation_id='telegram:2';");
    db.close();
    const reopened = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, { piiRevalidator: revalidator });
    await reopened.ready();
    await assert.rejects(
      () => reopened.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version }),
      (error: unknown) => error instanceof ResumeRevalidationError,
    );
    assert.equal((await reopened.listProfileDocuments('owner')).length, 0, 'no profile document may be written for a rejected completion');
    await reopened.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('resume-derived completion write persists when the profile survives redaction unchanged', async () => {
  await withStore(async (store) => {
    const started = await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const review = await store.saveOnboardingDraft({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: started.version, draft: fullDraft, status: 'review' });
    await store.markOnboardingResumeDerived({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
    await store.completeOnboarding({ ownerId: 'owner', conversationId: 'telegram:2', expectedVersion: review.version });
    const docs = await store.listProfileDocuments('owner');
    assert.equal(docs.length, 1);
    assert.ok(docs[0].content.includes('TypeScript'));
  }, await piiRevalidator());
});

test('runtime resume → edit → confirm regression: profile write rejects a changed candidate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-revalidate-runtime-'));
  const pii = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 0, readiness: true });
  await pii.warmup();
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, { piiRevalidator: { redactText: (text) => pii.redactText(text), redactDocument: (value) => pii.redactDocument(value) } });
  await store.ready();
  try {
    const { createCareerCopilotRuntime } = await import('../src/services/career-runtime.ts');
    const update = (id: number, text?: string, document?: Record<string, unknown>) => ({ update_id: id, message: { message_id: id, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, ...(text !== undefined ? { text } : {}), ...(document ? { document } : {}) } });
    const fullPatch = { ...fullDraft, skills: 'TypeScript, Python' };
    const runtime = createCareerCopilotRuntime({
      ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, pii,
      respond: async () => { throw new Error('must not respond'); },
      onboard: async () => ({ reply: 'resume parsed', draftPatch: fullPatch, readyForReview: true }),
      downloadFile: async () => ({ bytes: textPdf('Engineer with eight years of experience.'), byteSize: 1 }),
    });
    const replies: string[] = [];
    await runtime.handleTelegramUpdate(update(800, '/onboarding'), async (text) => { replies.push(text); });
    await runtime.handleTelegramUpdate(update(801, undefined, { file_id: 'f1', file_unique_id: 'u1', file_name: 'r.pdf', mime_type: 'application/pdf', file_size: 100 }), async (text) => { replies.push(text); });
    // an ordinary review edit tries to smuggle a token in — the durable lineage must reject it
    const edited = await runtime.handleTelegramUpdate(update(802, 'edit skills: sk-51H8abc12345678901234567890'), async (text) => { replies.push(text); });
    assert.equal(edited.outcome, 'accepted');
    assert.match(replies.at(-1) ?? '', /could not be saved safely/);
    const rowAfterEdit = await store.loadOnboarding('owner', 'telegram:2');
    assert.ok(!JSON.stringify(rowAfterEdit?.draft).includes('sk-51H8'), 'the token edit must not persist');
    // a clean edit and confirmation complete the flow
    await runtime.handleTelegramUpdate(update(803, 'edit skills: TypeScript, Python, Go'), async (text) => { replies.push(text); });
    await runtime.handleTelegramUpdate(update(804, 'confirm'), async (text) => { replies.push(text); });
    const docs = await store.listProfileDocuments('owner');
    assert.equal(docs.length, 1);
    assert.ok(docs[0].content.includes('TypeScript, Python, Go'));
    assert.ok(!docs[0].content.includes('sk-51H8'), 'the active profile must never carry the token');
    assert.equal(await store.loadOnboarding('owner', 'telegram:2'), null);
  } finally {
    await store.close(); await rm(dir, { recursive: true, force: true });
  }
});

test('runtime document turn with a draft-changing model response surfaces a safe reply and writes nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-revalidate-runtime-'));
  const pii = createPiiService({ enabled: true, patterns: [], anonymizeFormat: 'type', maxInputChars: 0, readiness: true });
  await pii.warmup();
  const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`, { piiRevalidator: { redactText: (text) => pii.redactText(text), redactDocument: (value) => pii.redactDocument(value) } });
  await store.ready();
  try {
    const { createCareerCopilotRuntime } = await import('../src/services/career-runtime.ts');
    await store.startOnboarding({ ownerId: 'owner', conversationId: 'telegram:2' });
    const runtime = createCareerCopilotRuntime({
      ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, pii,
      respond: async () => { throw new Error('must not respond'); },
      onboard: async () => ({ reply: 'parsed', draftPatch: { currentStatus: 'Engineer at IFSC SBIN0001234' }, readyForReview: false }),
      downloadFile: async () => ({ bytes: textPdf('Engineer with eight years of experience.'), byteSize: 1 }),
    });
    const replies: string[] = [];
    const result = await runtime.handleTelegramUpdate({ update_id: 900, message: { message_id: 900, date: 1, chat: { id: 2, type: 'private' }, from: { id: 1 }, document: { file_id: 'f1', file_unique_id: 'u1', file_name: 'r.pdf', mime_type: 'application/pdf', file_size: 100 } } }, async (text) => { replies.push(text); });
    assert.equal(result.outcome, 'accepted');
    assert.match(replies[0], /could not be saved safely/);
    const row = await store.loadOnboarding('owner', 'telegram:2');
    assert.ok(!JSON.stringify(row?.draft).includes('SBIN0001234'));
    assert.equal(row?.version, 1, 'rejected candidate must not advance the draft version');
  } finally {
    await store.close(); await rm(dir, { recursive: true, force: true });
  }
});
