import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { LayerUnavailableError } from '@kripamishra/mastra-pii';
import { LibSQLStore } from '@mastra/libsql';
import { resolveRuntimeConfig } from '../src/config/runtime.ts';
import { createPiiService } from '../src/services/pii.ts';
import { redactTextForIngestion } from '../src/services/career-runtime.ts';
import { createCareerAgentKit } from '../src/agents/agent.ts';
import { createScriptedModel, asModelConfig } from '../eval/fakes/model.ts';
import { CareerStore } from '../src/storage/career-store.ts';

const PAN = 'ABCDE1234F';
const EMAIL = 'resume-owner@example.test';
const PHONE = '98765 43210';
const AADHAAR = '7316 7253 5875';
const UPI = '9999999999@ybl';
const IFSC = 'SBIN0001234';

const piiConfig = () => ({ enabled: true, patterns: [], anonymizeFormat: 'type' as const, maxInputChars: 4000, readiness: true });

test('PII config: disabled by default, PII_* env parses, invalid config fails startup', () => {
  const defaults = resolveRuntimeConfig({ env: {} });
  assert.equal(defaults.pii.enabled, false);
  assert.equal(defaults.pii.anonymizeFormat, 'type');
  assert.equal(defaults.pii.maxInputChars, 200_000);
  assert.equal(defaults.pii.readiness, true);
  const enabled = resolveRuntimeConfig({ env: { PII_ENABLED: 'true', PII_ANONYMIZE_FORMAT: 'uniform', PII_MAX_INPUT_CHARS: '123', PII_READINESS: 'false' } });
  assert.deepEqual(enabled.pii, { enabled: true, patterns: [], anonymizeFormat: 'uniform', maxInputChars: 123, readiness: false });
  const patterned = resolveRuntimeConfig({ env: { PII_ENABLED: 'true', PII_PATTERNS: JSON.stringify([{ name: 'account-code', regex: 'ACCT-[0-9]{6}', entity: 'bank-account' }]) } });
  assert.equal(patterned.pii.patterns.length, 1);
  assert.ok(patterned.pii.patterns[0].regex instanceof RegExp);
  assert.equal(patterned.pii.patterns[0].entity, 'bank-account');
  assert.throws(() => resolveRuntimeConfig({ env: { PII_PATTERNS: 'not json' } }), /PII_PATTERNS must be a JSON array/);
  assert.throws(() => resolveRuntimeConfig({ env: { PII_ENABLED: 'true', PII_PATTERNS: JSON.stringify([{ name: 'x', regex: 'a', entity: 'not-an-entity' }]) } }), /Invalid PII configuration/);
  assert.throws(() => resolveRuntimeConfig({ env: { PII_ENABLED: 'true', PII_PATTERNS: JSON.stringify([{ name: 'x', regex: '(unclosed' }]) } }), /invalid regular expression/);
  assert.throws(() => resolveRuntimeConfig({ env: { PII_MAX_INPUT_CHARS: 'abc' } }), /Invalid PII configuration/);
});

test('PII env booleans are strict: invalid values fail startup instead of coercing', () => {
  assert.throws(() => resolveRuntimeConfig({ env: { PII_ENABLED: 'tru' } }), /PII_ENABLED must be true or false/);
  assert.throws(() => resolveRuntimeConfig({ env: { PII_ENABLED: '1' } }), /PII_ENABLED must be true or false/);
  assert.throws(() => resolveRuntimeConfig({ env: { PII_READINESS: 'yes' } }), /PII_READINESS must be true or false/);
  assert.equal(resolveRuntimeConfig({ env: { PII_ENABLED: 'TRUE', PII_READINESS: 'False' } }).pii.enabled, true);
  assert.equal(resolveRuntimeConfig({ env: { PII_ENABLED: 'TRUE', PII_READINESS: 'False' } }).pii.readiness, false);
});

test('redactText returns the redacted string only with stable type placeholders', async () => {
  const pii = createPiiService(piiConfig());
  await pii.warmup();
  assert.equal(pii.ready, true);
  const text = `PAN ${PAN}, email ${EMAIL}, phone ${PHONE}, Aadhaar ${AADHAAR}, UPI ${UPI}, IFSC ${IFSC}`;
  const result = await pii.redactText(text);
  assert.equal(typeof result, 'string', 'shipped signature: Promise<string>, no detections/counts map');
  assert.match(result, /\[PAN_1\]/);
  assert.match(result, /\[EMAIL_1\]/);
  assert.match(result, /\[PHONE_1\]/);
  assert.match(result, /\[AADHAAR_1\]/);
  assert.match(result, /\[UPI_1\]/);
  assert.match(result, /\[IFSC_1\]/);
  assert.ok(!result.includes(PAN) && !result.includes(EMAIL) && !result.includes(PHONE) && !result.includes(AADHAAR) && !result.includes(UPI) && !result.includes(IFSC));
  const second = await pii.redactText(text);
  assert.equal(second, result, 'placeholders stable across calls within one result');
});

test('custom patterns from config redact via their entity', async () => {
  const pii = createPiiService({ ...piiConfig(), patterns: [{ name: 'account-code', regex: /ACCT-[0-9]{6}/g, entity: 'bank-account' }] });
  await pii.warmup();
  assert.equal(await pii.redactText('ACCT-123456 is mine'), '[BANK-ACCOUNT_1] is mine');
});

test('names/addresses are NER-only: local engine leaves plain names unchanged (documented limitation)', async () => {
  const pii = createPiiService(piiConfig());
  await pii.warmup();
  assert.equal(await pii.redactText('Name is Kripa Shankar Mishra living at 221B Baker Street'), 'Name is Kripa Shankar Mishra living at 221B Baker Street');
});

test('requesting ner/model layers throws LayerUnavailableError (PII_LAYER_UNAVAILABLE)', async () => {
  const pii = createPiiService(piiConfig());
  await pii.warmup();
  for (const layer of ['ner', 'model'] as const) {
    await assert.rejects(() => pii.redactText('PAN ABCDE1234F', { layers: [layer] }), (error: unknown) => error instanceof LayerUnavailableError && error.code === 'PII_LAYER_UNAVAILABLE');
  }
  assert.equal(await pii.redactText('PAN ABCDE1234F', { layers: ['deterministic'] }), 'PAN [PAN_1]');
});

test('readiness gate: disabled or un-warmed PII fails closed; ingestion boundary throws safe errors', async () => {
  const unWarmed = createPiiService(piiConfig());
  assert.equal(unWarmed.ready, false);
  await assert.rejects(() => unWarmed.redactText('PAN ABCDE1234F'), /PII redaction is unavailable/);
  const disabled = createPiiService({ ...piiConfig(), enabled: false });
  await disabled.warmup();
  assert.equal(disabled.ready, false);
  await assert.rejects(() => disabled.redactText('PAN ABCDE1234F'), /PII redaction is unavailable/);
  await assert.rejects(() => redactTextForIngestion(disabled, 'PAN ABCDE1234F'), /could not be processed safely/);
  await assert.rejects(() => redactTextForIngestion(unWarmed, 'PAN ABCDE1234F'), /could not be processed safely/);
  const warmed = createPiiService(piiConfig());
  await warmed.warmup();
  assert.equal(await redactTextForIngestion(warmed, `PAN ${PAN}`), 'PAN [PAN_1]');
});

test('readiness flag holds the gate down even after a successful warmup', async () => {
  const gated = createPiiService({ ...piiConfig(), readiness: false });
  await gated.warmup();
  assert.equal(gated.ready, false, 'PII_READINESS=false must keep ingestion disabled');
  await assert.rejects(() => gated.redactText('PAN ABCDE1234F'), /PII redaction is unavailable/);
  await assert.rejects(() => redactTextForIngestion(gated, 'PAN ABCDE1234F'), /could not be processed safely/);
  const open = createPiiService({ ...piiConfig(), readiness: true });
  await open.warmup();
  assert.equal(open.ready, true);
});

test('oversized input fails closed with a safe error', async () => {
  const pii = createPiiService({ ...piiConfig(), maxInputChars: 20 });
  await pii.warmup();
  await assert.rejects(() => pii.redactText('PAN ABCDE1234F and more text beyond the cap'), /too large/);
  const unlimited = createPiiService({ ...piiConfig(), maxInputChars: 0 });
  await unlimited.warmup();
  assert.equal((await unlimited.redactText('PAN ABCDE1234F')).includes(PAN), false);
});

test('redactDocument redacts bounded plain JSON and fails closed on unsupported payloads', async () => {
  const pii = createPiiService(piiConfig());
  await pii.warmup();
  const doc = { name: 'Recruiter', email: EMAIL, nested: { phone: PHONE }, list: [`PAN ${PAN}`], number: 42, flag: true };
  const redacted = await pii.redactDocument(doc) as Record<string, unknown>;
  assert.equal(redacted.email, '[EMAIL_1]');
  assert.equal((redacted.nested as Record<string, unknown>).phone, '[PHONE_1]');
  assert.deepEqual(redacted.list, ['PAN [PAN_1]']);
  assert.equal(redacted.number, 42);
  await assert.rejects(() => pii.redactDocument(new Date()), /unsupported payload/);
  const sparse = [1, 2, 3]; sparse.length = 5;
  await assert.rejects(() => pii.redactDocument({ sparse }), /sparse/);
  await assert.rejects(() => pii.redactDocument({ symbol: Symbol('x') }), /unsupported payload/);
});

test('processor defense-in-depth: agent turn redacts canaries in prompt and assistant output', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-pii-processor-'));
  const clock = () => 0;
  try {
    const ledger = { calls: [] as Array<{ promptText: string }> };
    const scripted = createScriptedModel({ responses: [{ purpose: 'chat', text: `received PAN ${PAN}` }] }, clock, ledger as never);
    const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
    await store.ready();
    const memoryStorage = new LibSQLStore({ id: 'pii-memory', url: `file:${path.join(dir, 'memory.db')}` });
    await memoryStorage.init();
    const pii = createPiiService(piiConfig());
    await pii.warmup();
    const { agent } = createCareerAgentKit({ store, model: asModelConfig(scripted), memoryModel: asModelConfig(scripted), storage: memoryStorage, processors: { input: [pii.processor], output: [pii.processor] } });
    const result = await agent.generate(`contact ${EMAIL} re my PAN ${PAN}`, { memory: { resource: 'owner', thread: 'telegram:1' } });
    const prompt = (ledger.calls[0] as { promptText?: string }).promptText ?? '';
    assert.ok(prompt.includes('[EMAIL_1]'), 'input canary must be redacted in the model prompt');
    assert.ok(prompt.includes('[PAN_1]'), 'input canary must be redacted in the model prompt');
    assert.ok(!prompt.includes(EMAIL) && !prompt.includes(PAN), 'raw canaries must not reach the model prompt');
    const output = result.text ?? '';
    assert.ok(!output.includes(PAN), 'assistant output canary must be redacted by outputProcessors');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runtime ingestionAvailable reflects the readiness gate', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'career-pii-runtime-'));
  try {
    const store = new CareerStore(`file:${path.join(dir, 'jobs.db')}`);
    await store.ready();
    const { createCareerCopilotRuntime } = await import('../src/services/career-runtime.ts');
    const base = { ownerId: 'owner', allowedUserIds: new Set(['1']), privateChatIds: new Set(['2']), store, respond: async () => 'ok' };
    const withoutPii = createCareerCopilotRuntime(base);
    assert.equal(withoutPii.ingestionAvailable(), false);
    const unWarmed = createCareerCopilotRuntime({ ...base, pii: createPiiService(piiConfig()) });
    assert.equal(unWarmed.ingestionAvailable(), false);
    const warmed = createPiiService(piiConfig());
    await warmed.warmup();
    const withPii = createCareerCopilotRuntime({ ...base, pii: warmed });
    assert.equal(withPii.ingestionAvailable(), true);
    const gated = createPiiService({ ...piiConfig(), readiness: false });
    await gated.warmup();
    assert.equal(gated.ready, false);
    assert.equal(createCareerCopilotRuntime({ ...base, pii: gated }).ingestionAvailable(), false, 'PII_READINESS=false must keep ingestion disabled');
    await store.close();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
