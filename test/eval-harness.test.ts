import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { loadCorpus, filterCorpus } from '../eval/corpus.ts';
import { runScenario } from '../eval/runner.ts';
import { createScriptedModel } from '../eval/fakes/model.ts';
import { parseScenario } from '../eval/schemas/scenario.ts';
import { parseFixture } from '../eval/schemas/fixture.ts';

const MANIFEST = {
  sourceRevision: 'test',
  runnerVersion: 'test',
  nodeVersion: process.version,
  lockfileHash: 'test',
  clock: '2026-01-01T00:00:00Z',
  model: 'scripted/contract-model',
};

const NEW_OWNER_FIXTURE = `schemaVersion: 1
id: new-owner
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
model:
  responses:
    - purpose: memory
      text: "{}"
    - purpose: onboarding
      match: "Senior backend engineer"
      object:
        reply: "Saved. Next: experience."
        draftPatch:
          currentStatus: "Senior backend engineer."
        readyForReview: false
    - purpose: onboarding
      match: "Eight years"
      object:
        reply: "Saved. Next: education."
        draftPatch:
          experience: "Eight years of backend work."
        readyForReview: false
`;

const ONBOARDING_SCENARIO = `schemaVersion: 1
id: onboarding-minimal
kind: contract
persona: P01
fixture: new-owner
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
  - id: t2
    channel: telegram
    input: { kind: text, text: "I am a Senior backend engineer with 8 years of experience." }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
  - id: t3
    channel: telegram
    input: { kind: text, text: "Eight years of backend work." }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-ONBOARDING-STATE, A-NO-ACTIVATION-BEFORE-CONFIRM, A-DRAFT-PATCH-ONLY, A-TOOLS-EXACT, A-TRANSCRIPT-COMPLETE, A-BUDGET, A-CANARY-CONTAINED, A-AUTH-BEFORE-MODEL, A-LOG-ALLOWLIST]
tools:
  counts:
    save-job: 0
limits:
  maxTurns: 5
  maxWallClockMs: 30000
  maxModelCalls: 20
`;

async function writeCorpus(dir: string, fixtures: Record<string, string>, scenarios: Record<string, string>) {
  const fixtureDir = path.join(dir, 'eval', 'fixtures');
  const scenarioDir = path.join(dir, 'eval', 'scenarios');
  await mkdir(fixtureDir, { recursive: true });
  await mkdir(scenarioDir, { recursive: true });
  for (const [id, yaml] of Object.entries(fixtures)) await writeFile(path.join(fixtureDir, `${id}.yaml`), yaml);
  for (const [id, yaml] of Object.entries(scenarios)) await writeFile(path.join(scenarioDir, `${id}.yaml`), yaml);
}

async function runOnboarding(dir: string, keepArtifacts = false) {
  const corpus = await loadCorpus(dir);
  assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
  const { scenario } = corpus.scenarios.find((entry) => entry.scenario.id === 'onboarding-minimal')!;
  const fixture = corpus.fixtures.get('new-owner')!.fixture;
  return runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts, corpusHash: corpus.hash, runId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
}

test('strict schemas: unknown keys, unknown assertion IDs, and malformed YAML fail validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-schema-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, {});
    await writeFile(path.join(dir, 'eval', 'scenarios', 'bad-key.yaml'), `${ONBOARDING_SCENARIO}\nunknownField: true\n`);
    let corpus = await loadCorpus(dir);
    assert.ok(corpus.errors.some((error) => /unknownField/.test(error.message)), 'unknown scenario key must fail');

    await rm(path.join(dir, 'eval', 'scenarios', 'bad-key.yaml'));
    await writeFile(path.join(dir, 'eval', 'scenarios', 'bad-assertion.yaml'), ONBOARDING_SCENARIO.replace('A-BUDGET', 'A-NO-SUCH-GATE'));
    corpus = await loadCorpus(dir);
    assert.ok(corpus.errors.some((error) => /unknown assertion ID/.test(error.message)), 'unknown assertion ID must fail');

    await rm(path.join(dir, 'eval', 'scenarios', 'bad-assertion.yaml'));
    await writeFile(path.join(dir, 'eval', 'fixtures', 'bad-key.yaml'), `${NEW_OWNER_FIXTURE}\nmystery: 1\n`);
    corpus = await loadCorpus(dir);
    assert.ok(corpus.errors.some((error) => /mystery/.test(error.message)), 'unknown fixture key must fail');

    await rm(path.join(dir, 'eval', 'fixtures', 'bad-key.yaml'));
    await writeFile(path.join(dir, 'eval', 'scenarios', 'bad-yaml.yaml'), 'schemaVersion: 1\n  broken: [unclosed\n');
    corpus = await loadCorpus(dir);
    assert.ok(corpus.errors.some((error) => /bad-yaml/.test(error.message) || error.message.length > 0), 'malformed YAML must fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('discovery: duplicate IDs and filename/ID mismatch fail', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-discover-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    // duplicate ID requires the same filename in a different directory
    await mkdir(path.join(dir, 'eval', 'scenarios', 'nested'), { recursive: true });
    await writeFile(path.join(dir, 'eval', 'scenarios', 'nested', 'onboarding-minimal.yaml'), ONBOARDING_SCENARIO);
    const corpus = await loadCorpus(dir);
    assert.ok(corpus.errors.some((error) => /duplicate scenario id/.test(error.message)), 'duplicate scenario id must fail');

    await rm(path.join(dir, 'eval', 'scenarios', 'nested'), { recursive: true, force: true });
    await writeFile(path.join(dir, 'eval', 'scenarios', 'mismatch.yaml'), ONBOARDING_SCENARIO);
    const corpus2 = await loadCorpus(dir);
    assert.ok(corpus2.errors.some((error) => /does not match filename/.test(error.message)), 'filename/ID mismatch must fail');

    await rm(path.join(dir, 'eval', 'scenarios', 'mismatch.yaml'));
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml.staged'), ONBOARDING_SCENARIO);
    const corpus3 = await loadCorpus(dir);
    assert.equal(corpus3.errors.length, 0);
    assert.equal(corpus3.scenarios.length, 1, 'staged files are excluded from the live corpus');
    assert.equal(corpus3.staged.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('corpus hash is content-sensitive and stable across reloads', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-hash-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const first = await loadCorpus(dir);
    const second = await loadCorpus(dir);
    assert.equal(first.hash, second.hash, 'hash must be stable across reloads');
    assert.match(first.hash, /^[0-9a-f]{64}$/);
    const changed = ONBOARDING_SCENARIO.replace('Eight years of backend work.', 'Eight years of backend work in fintech.');
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml'), changed);
    const third = await loadCorpus(dir);
    assert.notEqual(first.hash, third.hash, 'changing turn content must change the hash');

    // fixture content is part of run semantics (scripted responses, DB rows,
    // fetch plans, notification plans) — it must invalidate the hash too
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml'), ONBOARDING_SCENARIO);
    const fixtureChanged = NEW_OWNER_FIXTURE.replace('Senior backend engineer.', 'Senior staff backend engineer.');
    await writeFile(path.join(dir, 'eval', 'fixtures', 'new-owner.yaml'), fixtureChanged);
    const fourth = await loadCorpus(dir);
    assert.notEqual(third.hash, fourth.hash, 'changing fixture content must change the hash');

    // fixtures NOT referenced by any scenario stay out of the hash
    await writeFile(path.join(dir, 'eval', 'fixtures', 'unreferenced.yaml'), NEW_OWNER_FIXTURE.replace('id: new-owner', 'id: unreferenced'));
    const fifth = await loadCorpus(dir);
    assert.equal(fourth.hash, fifth.hash, 'unreferenced fixture content must not change the hash');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('hermetic runner: onboarding contract passes end to end with a scripted model', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-run-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const result = await runOnboarding(dir);
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    assert.equal(result.transcript.complete, true);
    assert.equal(result.state.onboarding?.[0]?.status, 'collecting');
    assert.equal(result.state.onboarding?.[0]?.version, 3);
    assert.ok((result.state.onboarding?.[0]?.draft as Record<string, unknown>).currentStatus);
    assert.ok((result.state.onboarding?.[0]?.draft as Record<string, unknown>).experience);
    assert.equal(result.metrics.modelCalls, 2, 'one onboarding model call per answered turn; commands and memory extraction do not consume calls');
    assert.equal(result.redaction.canariesFound.length, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runner isolation: repeated runs share no state and temp dirs are cleaned up', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-isolate-'));
  const before = await readdir(tmpdir());
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const first = await runOnboarding(dir);
    const second = await runOnboarding(dir);
    assert.equal(first.status, 'passed');
    assert.equal(second.status, 'passed');
    assert.notEqual(first.runId, second.runId);
    assert.deepEqual(first.state.jobs, [], 'fresh DB per run');
    assert.deepEqual(second.state.jobs, []);
    assert.equal(first.state.onboarding?.[0]?.version, second.state.onboarding?.[0]?.version, 'independent stores reach identical state');
    const after = await readdir(tmpdir());
    const leaked = after.filter((entry) => entry.startsWith('career-eval-') && !before.includes(entry));
    assert.deepEqual(leaked, [], 'temp dirs must be removed after runs');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('keep-artifacts retains the temp directory and raw artifact path is reported', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-keep-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const result = await runOnboarding(dir, true);
    assert.equal(result.status, 'passed');
    assert.ok(result.redaction.rawArtifactPath, 'raw artifact path must be reported');
    const entries = await readdir(result.redaction.rawArtifactPath!);
    assert.ok(entries.some((entry) => entry.endsWith('.db')), 'database artifact retained');
    await rm(result.redaction.rawArtifactPath!, { recursive: true, force: true });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redaction fails closed: canary in a forbidden sink blocks the run', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-canary-'));
  try {
    const leakyFixture = NEW_OWNER_FIXTURE.replace(
      'model:\n  responses:\n    - purpose: memory',
      'canaries:\n  - { value: "CANARY_SECRET", sinks: [model] }\nmodel:\n  responses:\n    - purpose: memory',
    ).replace(
      'reply: "Saved. Next: experience."',
      'reply: "Saved with CANARY_SECRET. Next: experience."',
    );
    await writeCorpus(dir, { 'new-owner': leakyFixture }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0);
    const { scenario } = corpus.scenarios[0];
    const fixture = corpus.fixtures.get('new-owner')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete');
    assert.ok(result.redaction.canariesFound.includes('CANARY_SECRET'), 'canary must be reported');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('incomplete: uncaught model throw and budget breach are incomplete, never failed', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-incomplete-'));
  try {
    // production catches onboarding model errors (safe retry reply); an uncaught
    // chat-path throw must make the run incomplete
    const chatThrowFixture = `schemaVersion: 1
id: chat-throw
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
model:
  responses:
    - purpose: chat
      throws: "provider exploded"
`;
    const chatScenario = `schemaVersion: 1
id: chat-throw-scenario
kind: contract
persona: P05
fixture: chat-throw
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "hello" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-TRANSCRIPT-COMPLETE, A-BUDGET]
limits:
  maxModelCalls: 10
`;
    await writeCorpus(dir, { 'chat-throw': chatThrowFixture }, { 'chat-throw-scenario': chatScenario });
    const corpus = await loadCorpus(dir);
    const { scenario } = corpus.scenarios[0];
    const fixture = corpus.fixtures.get('chat-throw')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'uncaught model throw must be incomplete');

    const budgeted = ONBOARDING_SCENARIO.replace('maxModelCalls: 20', 'maxModelCalls: 1');
    await writeFile(path.join(dir, 'eval', 'fixtures', 'new-owner.yaml'), NEW_OWNER_FIXTURE);
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml'), budgeted);
    const corpus2 = await loadCorpus(dir);
    const result2 = await runScenario({ scenario: corpus2.scenarios[0].scenario, fixture: corpus2.fixtures.get('new-owner')!.fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus2.hash, runId: `test-${Date.now()}` });
    assert.equal(result2.status, 'incomplete', 'budget breach must be incomplete');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('value assertions: path operators evaluate against the run context', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-value-'));
  try {
    const passing = ONBOARDING_SCENARIO.replace(
      'assertions: [A-ONBOARDING-STATE, A-NO-ACTIVATION-BEFORE-CONFIRM, A-DRAFT-PATCH-ONLY, A-TOOLS-EXACT, A-TRANSCRIPT-COMPLETE, A-BUDGET, A-CANARY-CONTAINED, A-AUTH-BEFORE-MODEL, A-LOG-ALLOWLIST]',
      'assertions:\n  - A-ONBOARDING-STATE\n  - { id: A-JOB-STATE, path: "state.jobs", op: count, value: 0 }\n  - { id: A-JOB-STATE, path: "state.onboarding[0].status", op: eq, value: collecting }\n  - { id: A-JOB-STATE, path: "state.onboarding[0].version", op: eq, value: 3 }\n  - { id: A-JOB-STATE, path: "state.profiles", op: count, value: 0 }\n  - { id: A-JOB-STATE, path: "state.nonexistent", op: absent }\n  - { id: A-JOB-STATE, path: "state.onboarding[0].draft.currentStatus", op: eq, value: "Senior backend engineer." }',
    );
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': passing });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios[0];
    const fixture = corpus.fixtures.get('new-owner')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));

    // a member assertion against an empty array must fail the run
    const failing = passing.replace('{ id: A-JOB-STATE, path: "state.nonexistent", op: absent }', '{ id: A-JOB-STATE, path: "state.jobs", op: member, value: {} }');
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml'), failing);
    const corpus2 = await loadCorpus(dir);
    const result2 = await runScenario({ scenario: corpus2.scenarios[0].scenario, fixture: corpus2.fixtures.get('new-owner')!.fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus2.hash, runId: `test-${Date.now()}` });
    assert.equal(result2.status, 'failed');
    const member = result2.assertions.find((a) => a.id === 'A-JOB-STATE' && /member/.test(a.evidence));
    assert.equal(member?.status, 'failed', 'member operator on an empty array must fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('turn outcomes: unauthorized turns fail closed on expected outcomes', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-auth-'));
  try {
    const unauthorized = `schemaVersion: 1
id: onboarding-minimal
kind: contract
persona: P11
fixture: new-owner
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:9999"
    expected: rejected
  - id: t2
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
  - id: t3
    channel: telegram
    input: { kind: text, text: "I am a Senior backend engineer with 8 years." }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-ONBOARDING-STATE, A-AUTH-BEFORE-MODEL]
tools:
  counts:
    save-job: 0
limits:
  maxTurns: 5
  maxWallClockMs: 30000
  maxModelCalls: 20
`;
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': unauthorized });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios[0];
    const fixture = corpus.fixtures.get('new-owner')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    const turnCheck = result.assertions.find((a) => a.id === 'turn.t1.outcome');
    assert.equal(turnCheck?.status, 'passed');
    assert.equal(result.state.onboarding?.[0]?.status, 'collecting', 'the authorized /onboarding still started the flow');

    const wronglyExpected = unauthorized.replace('conversationId: "telegram:9999"\n    expected: rejected', 'conversationId: "telegram:9999"\n    expected: accepted');
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml'), wronglyExpected);
    const corpus2 = await loadCorpus(dir);
    const result2 = await runScenario({ scenario: corpus2.scenarios[0].scenario, fixture: corpus2.fixtures.get('new-owner')!.fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus2.hash, runId: `test-${Date.now()}` });
    assert.equal(result2.status, 'failed', 'expected-accepted on an unauthorized turn must fail');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scenario and fixture schemas parse with strict unknown-key rejection', () => {
  assert.throws(() => parseScenario({ schemaVersion: 1, id: 'x', kind: 'contract', persona: 'P01', fixture: 'f', turns: [], assertions: ['A-BUDGET'], extra: true }));
  assert.throws(() => parseFixture({ schemaVersion: 1, id: 'f', ownerId: 'o', extra: 1 }));
  assert.throws(() => parseScenario({ ...parseScenario({ schemaVersion: 1, id: 'x', kind: 'contract', persona: 'P01', fixture: 'f', turns: [{ id: 't1', channel: 'telegram', input: { kind: 'text', text: 'hi' }, actorId: '1', conversationId: 'telegram:1', expected: 'accepted' }], assertions: ['A-BUDGET'] }), persona: 'P99' }));
});

const SAVE_FLOW_FIXTURE = `schemaVersion: 1
id: save-flow
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada\\nExperience: 8 years backend\\nSkills: TypeScript"
      active: true
      version: 2
fetch:
  - url: "https://linkedin.com/jobs/view/42"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Senior Platform Engineer at Example Corp</body></html>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
notifications:
  - jobId: "fixture-0001"
    deliver: fail-first
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/42"
            profileContext: ""
    - purpose: analysis
      object:
        schemaVersion: 1
        title: "Senior Platform Engineer"
        company: "Example Corp"
        location: "Remote"
        summary: "Platform tooling for the core product."
        fitScore: 82
        nextStep: "Apply with the confirmed profile."
    - purpose: chat
      text: "Saved: Senior Platform Engineer at Example Corp."
`;

const SAVE_REPLAY_SCENARIO = `schemaVersion: 1
id: save-replay
kind: contract
persona: P03
fixture: save-flow
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/42" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
    updateId: 9001
  - id: t2
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/42" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
    updateId: 9001
assertions:
  - A-TOOLS-EXACT
  - A-TOOL-CONTEXT
  - A-URL-POLICY
  - A-FETCH-DATA-NOT-POLICY
  - A-SSRF-BLOCK
  - A-NOTIFY-AFTER-COMPLETE
  - A-NOTIFY-MARK-AFTER-SEND
  - A-JOB-STATE
  - A-REPORT-BEFORE-SUCCESS
  - A-SHEET-READBACK
  - A-SAFE-ERROR
  - A-TRANSCRIPT-COMPLETE
  - A-BUDGET
  - A-CANARY-CONTAINED
  - A-AUTH-BEFORE-MODEL
  - A-LOG-ALLOWLIST
tools:
  require: [save-job]
  forbid: [web_fetch]
  counts:
    save-job: 1
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 20
`;

test('full save replay: analyzeJob runs inside the harness, tool ledger is exact, fail-first delivery is real', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-save-'));
  try {
    await writeCorpus(dir, { 'save-flow': SAVE_FLOW_FIXTURE }, { 'save-replay': SAVE_REPLAY_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios.find((entry) => entry.scenario.id === 'save-replay')!;
    const fixture = corpus.fixtures.get('save-flow')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));

    // the save path ran end to end through the real agent + save-job tool
    assert.equal(result.state.jobs.length, 1);
    const job = result.state.jobs[0];
    assert.equal(job.status, 'succeeded');
    assert.ok(job.safeResult, 'job must carry a safe result');
    assert.ok(job.reportId, 'job must carry a report');
    assert.equal(result.state.sheets.length, 1, 'sheet row must be verified');
    assert.equal(result.state.sheets[0].jobId, 'fixture-0001');
    assert.ok(job.notifiedAt, 'notification must be marked only after the successful delivery');

    // tool ledger is non-destructive and exact: 1 call, identity + url captured
    const toolCalls = result.assertions.find((a) => a.id === 'A-TOOLS-EXACT')!;
    assert.equal(toolCalls.status, 'passed', toolCalls.evidence);
    const urlPolicy = result.assertions.find((a) => a.id === 'A-URL-POLICY')!;
    assert.equal(urlPolicy.status, 'passed', urlPolicy.evidence);

    // notification delivery is a real ledger: attempt 1 failed (fail-first),
    // attempt 2 (the same-update replay) delivered
    assert.deepEqual(result.state.notifications.map((n) => ({ delivered: n.delivered, attempt: n.attempt })), [
      { delivered: false, attempt: 1 },
      { delivered: true, attempt: 2 },
    ]);
    assert.equal(result.transcript.events.filter((e) => e.type === 'tool_call').length, 1);
    assert.equal(result.transcript.events.filter((e) => e.type === 'notification').length, 2);

    // the first turn is terminal via the delivery-failure record, not a reply
    const t1 = result.assertions.find((a) => a.id === 'turn.t1.outcome')!;
    assert.equal(t1.status, 'passed', t1.evidence);
    const t2 = result.assertions.find((a) => a.id === 'turn.t2.outcome')!;
    assert.equal(t2.status, 'passed', t2.evidence);
    assert.equal(result.transcript.complete, true);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const SSRF_FIXTURE = `schemaVersion: 1
id: ssrf-flow
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada"
      active: true
fetch:
  - url: "https://linkedin.com/jobs/view/99"
    dns: ["10.0.0.5"]
    status: 200
    contentType: "text/html"
    body: "<p>internal</p>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
notifications: []
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/99"
            profileContext: ""
    - purpose: chat
      text: "The job could not be saved safely."
`;

const SSRF_SCENARIO = `schemaVersion: 1
id: ssrf-block
kind: contract
persona: P03
fixture: ssrf-flow
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/99" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions:
  - A-TOOLS-EXACT
  - A-URL-POLICY
  - A-SSRF-BLOCK
  - A-SAFE-ERROR
  - A-JOB-STATE
  - A-TRANSCRIPT-COMPLETE
  - A-BUDGET
  - A-CANARY-CONTAINED
  - A-LOG-ALLOWLIST
tools:
  counts:
    save-job: 1
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 20
`;

test('SSRF: private-DNS fetch plans are blocked by the real policy and recorded', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-ssrf-'));
  try {
    await writeCorpus(dir, { 'ssrf-flow': SSRF_FIXTURE }, { 'ssrf-block': SSRF_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios.find((entry) => entry.scenario.id === 'ssrf-block')!;
    const fixture = corpus.fixtures.get('ssrf-flow')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    const job = result.state.jobs[0];
    assert.equal(job.status, 'failed', 'private-address fetch must fail the job');
    assert.ok(String(job.safeError).length > 0, 'failed job carries a safe error');
    assert.equal(result.transcript.events.filter((e) => e.type === 'tool_call').length, 1);
    assert.equal(result.transcript.events.filter((e) => e.type === 'tool_result').length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('per-turn timeoutMs: a hung turn makes the run incomplete, never stalls', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-timeout-'));
  try {
    // the fetch plan hangs until the policy abort signal fires; the turn's
    // timeoutMs must expire first and mark the run incomplete
    const hangFixture = `schemaVersion: 1
id: hang-flow
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada"
      active: true
fetch:
  - url: "https://linkedin.com/jobs/view/77"
    dns: ["93.184.216.34"]
    timeout: true
sheets:
  headers: []
  rows: []
notifications: []
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/77"
            profileContext: ""
    - purpose: chat
      text: "Saved."
`;
    const hangScenario = `schemaVersion: 1
id: hang-turn
kind: contract
persona: P03
fixture: hang-flow
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/77" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
    timeoutMs: 150
assertions: [A-TRANSCRIPT-COMPLETE, A-BUDGET]
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 20
`;
    await writeCorpus(dir, { 'hang-flow': hangFixture }, { 'hang-turn': hangScenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const started = Date.now();
    const result = await runScenario({ scenario: corpus.scenarios[0].scenario, fixture: corpus.fixtures.get('hang-flow')!.fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'a hung turn past timeoutMs must be incomplete');
    assert.ok(Date.now() - started < 5000, 'run must return at the per-turn timeout, not the global wall clock');
    assert.ok(result.transcript.events.some((e) => e.type === 'error'), 'timeout must be recorded in the transcript');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('filterCorpus rejects unknown scenario ids instead of silently selecting nothing', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-filter-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, { 'onboarding-minimal': ONBOARDING_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.throws(() => filterCorpus(corpus, ['typo']), /unknown scenario id/, 'unknown --scenario value must throw, not no-op');
    assert.throws(() => filterCorpus(corpus, ['onboarding-minimal', 'typo']), /unknown scenario id/, 'mixed known/unknown ids must throw');
    const selected = filterCorpus(corpus, ['onboarding-minimal']);
    assert.equal(selected.corpus.scenarios.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redaction: canary in profile text that reaches the model prompt is caught at the model sink', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-canary-model-'));
  try {
    const leaky = SAVE_FLOW_FIXTURE.replace('Skills: TypeScript', 'Skills: CANARY_PROFILE').replace('model:\n  responses:', 'canaries:\n  - { value: "CANARY_PROFILE", sinks: [database] }\nmodel:\n  responses:');
    await writeCorpus(dir, { 'save-flow': leaky }, { 'save-replay': SAVE_REPLAY_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios.find((entry) => entry.scenario.id === 'save-replay')!;
    const fixture = corpus.fixtures.get('save-flow')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'a database-only canary that reaches the model prompt must fail the run');
    assert.ok(result.redaction.canariesFound.includes('CANARY_PROFILE'), 'canary must be reported');
    const gate = result.assertions.find((a) => a.id === 'A-CANARY-CONTAINED')!;
    assert.match(gate.evidence, /@model:/, 'hit must be attributed to the model sink');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('redaction: canary in persisted report content is caught at the report sink', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-canary-report-'));
  try {
    const fixture = `schemaVersion: 1
id: report-leak
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  jobs:
    - jobId: "job-9"
      userId: "1001"
      ownerId: career-owner-v0
      chatId: "2001"
      transportEventId: "telegram:1"
      originalUrl: "https://linkedin.com/jobs/view/9"
      canonicalUrl: "https://linkedin.com/jobs/view/9"
      status: succeeded
      reportId: "r-9"
  reports:
    - reportId: "r-9"
      ownerId: career-owner-v0
      jobId: "job-9"
      content: "Executive summary CANARY_REPORT"
canaries:
  - { value: "CANARY_REPORT", sinks: [database] }
model:
  responses:
    - purpose: chat
      text: "ok"
`;
    const scenario = `schemaVersion: 1
id: report-leak-scenario
kind: contract
persona: P03
fixture: report-leak
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "hello" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-CANARY-CONTAINED, A-TRANSCRIPT-COMPLETE, A-BUDGET]
limits:
  maxTurns: 5
  maxWallClockMs: 30000
  maxModelCalls: 10
`;
    await writeCorpus(dir, { 'report-leak': fixture }, { 'report-leak-scenario': scenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario: sc } = corpus.scenarios[0];
    const fixtureEntry = corpus.fixtures.get('report-leak')!.fixture;
    const result = await runScenario({ scenario: sc, fixture: fixtureEntry, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'a canary in persisted report content must fail the run');
    assert.ok(result.redaction.canariesFound.includes('CANARY_REPORT'), 'canary must be reported');
    const gate = result.assertions.find((a) => a.id === 'A-CANARY-CONTAINED')!;
    assert.match(gate.evidence, /@report:/, 'hit must be attributed to the report sink');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('assertion context sees stub-merged identities, plans, and fetch (mergedFixture semantics)', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-stubmerge-'));
  try {
    const base = `schemaVersion: 1
id: save-base
ownerId: career-owner-v0
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada\\nExperience: 8 years backend\\nSkills: TypeScript"
      active: true
      version: 2
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/42"
            profileContext: ""
`;
    const stub = `schemaVersion: 1
id: save-stub
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
fetch:
  - url: "https://linkedin.com/jobs/view/42"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Senior Platform Engineer at Example Corp</body></html>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
notifications:
  - jobId: "fixture-0001"
    deliver: fail-first
model:
  responses:
    - purpose: analysis
      object:
        schemaVersion: 1
        title: "Senior Platform Engineer"
        company: "Example Corp"
        location: "Remote"
        summary: "Platform tooling for the core product."
        fitScore: 82
        nextStep: "Apply with the confirmed profile."
    - purpose: chat
      text: "Saved: Senior Platform Engineer at Example Corp."
`;
    const scenario = SAVE_REPLAY_SCENARIO.replace('fixture: save-flow', 'fixture: save-base\nstubs: [save-stub]');
    await writeCorpus(dir, { 'save-base': base, 'save-stub': stub }, { 'save-replay': scenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario: sc } = corpus.scenarios.find((entry) => entry.scenario.id === 'save-replay')!;
    const fixture = corpus.fixtures.get('save-base')!.fixture;
    const stubFixture = corpus.fixtures.get('save-stub')!.fixture;
    const result = await runScenario({ scenario: sc, fixture, stubs: [stubFixture], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    const toolContext = result.assertions.find((a) => a.id === 'A-TOOL-CONTEXT')!;
    assert.equal(toolContext.status, 'passed', 'stub-provided identity must be authorized in assertion context');
    assert.deepEqual(result.state.notifications.map((n) => ({ delivered: n.delivered, attempt: n.attempt })), [
      { delivered: false, attempt: 1 },
      { delivered: true, attempt: 2 },
    ], 'stub-provided fail-first plan must drive the delivery ledger');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('envelope fixtures: group and bot turns keep numeric ids and reach the authorization path', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-envelope-'));
  try {
    const fixture = `schemaVersion: 1
id: envelope-flow
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
model:
  responses:
    - purpose: chat
      text: "ok"
`;
    const scenario = `schemaVersion: 1
id: envelope-scenario
kind: contract
persona: P11
fixture: envelope-flow
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:2001"
    envelope: group
    expected: rejected
  - id: t2
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:2001"
    envelope: bot
    expected: rejected
assertions: [A-AUTH-BEFORE-MODEL, A-TRANSCRIPT-COMPLETE, A-BUDGET]
limits:
  maxTurns: 5
  maxWallClockMs: 30000
  maxModelCalls: 10
`;
    await writeCorpus(dir, { 'envelope-flow': fixture }, { 'envelope-scenario': scenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario: sc } = corpus.scenarios[0];
    const fixtureEntry = corpus.fixtures.get('envelope-flow')!.fixture;
    const result = await runScenario({ scenario: sc, fixture: fixtureEntry, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    const rejections = result.transcript.events.filter((e) => e.type === 'lifecycle' && e.payload.event === 'telegram.update.rejected');
    assert.deepEqual(rejections.map((e) => e.payload.reason), ['unauthorized', 'unauthorized'], 'group/bot turns must reach envelope authorization, not be rejected as malformed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

const REDIRECT_PAIR_FIXTURE = `schemaVersion: 1
id: redirect-pair
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada\\nExperience: 8 years backend\\nSkills: TypeScript"
      active: true
      version: 2
fetch:
  - url: "https://linkedin.com/jobs/view/1"
    dns: ["93.184.216.34"]
    redirect: { status: 301, location: "https://linkedin.com/jobs/view/11" }
  - url: "https://linkedin.com/jobs/view/11"
    dns: ["93.184.216.34"]
    redirect: { status: 302, location: "https://linkedin.com/jobs/view/111" }
  - url: "https://linkedin.com/jobs/view/111"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Platform Engineer Alpha at Example Corp</body></html>"
  - url: "https://linkedin.com/jobs/view/2"
    dns: ["93.184.216.34"]
    redirect: { status: 301, location: "https://linkedin.com/jobs/view/22" }
  - url: "https://linkedin.com/jobs/view/22"
    dns: ["93.184.216.34"]
    redirect: { status: 302, location: "https://linkedin.com/jobs/view/222" }
  - url: "https://linkedin.com/jobs/view/222"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Platform Engineer Beta at Example Corp</body></html>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
notifications: []
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/1"
            profileContext: ""
    - purpose: chat
      match: "jobs/view/2"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/2"
            profileContext: ""
    - purpose: analysis
      match: "Alpha"
      object:
        schemaVersion: 1
        title: "Platform Engineer Alpha"
        company: "Example Corp"
        location: "Remote"
        summary: "Alpha platform tooling."
        fitScore: 81
        nextStep: "Apply with the confirmed profile."
    - purpose: analysis
      match: "Beta"
      object:
        schemaVersion: 1
        title: "Platform Engineer Beta"
        company: "Example Corp"
        location: "Remote"
        summary: "Beta platform tooling."
        fitScore: 83
        nextStep: "Apply with the confirmed profile."
    - purpose: chat
      text: "Saved."
    - purpose: chat
      match: "view/2"
      text: "Saved second job."
`;

const REDIRECT_PAIR_SCENARIO = `schemaVersion: 1
id: redirect-pair-scenario
kind: contract
persona: P03
fixture: redirect-pair
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/1" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
    updateId: 9101
  - id: t2
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/2" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
    updateId: 9102
assertions:
  - A-REDIRECT-POLICY
  - A-TOOLS-EXACT
  - A-TOOL-CONTEXT
  - A-URL-POLICY
  - A-SSRF-BLOCK
  - A-NOTIFY-AFTER-COMPLETE
  - A-JOB-STATE
  - A-REPORT-BEFORE-SUCCESS
  - A-SHEET-READBACK
  - A-TRANSCRIPT-COMPLETE
  - A-BUDGET
  - A-CANARY-CONTAINED
tools:
  counts:
    save-job: 2
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 20
`;

test('redirect policy is per acquisition chain: two jobs with two redirects each stay within the 3-hop limit', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-redirect-'));
  try {
    await writeCorpus(dir, { 'redirect-pair': REDIRECT_PAIR_FIXTURE }, { 'redirect-pair-scenario': REDIRECT_PAIR_SCENARIO });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario } = corpus.scenarios.find((entry) => entry.scenario.id === 'redirect-pair-scenario')!;
    const fixture = corpus.fixtures.get('redirect-pair')!.fixture;
    const result = await runScenario({ scenario, fixture, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'passed', JSON.stringify(result.assertions, null, 2));
    const gate = result.assertions.find((a) => a.id === 'A-REDIRECT-POLICY')!;
    assert.equal(gate.status, 'passed', gate.evidence);
    assert.equal(result.state.jobs.length, 2);
    assert.equal(result.state.jobs.filter((job) => job.status === 'succeeded').length, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stub-provided profileText reaches the agent: a database-only canary in it is caught at the model sink', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-stubprofile-'));
  try {
    const base = `schemaVersion: 1
id: profile-base
ownerId: career-owner-v0
clock: "2026-01-01T00:00:00Z"
model:
  responses:
    - purpose: chat
      match: "Save this job now"
      toolCalls:
        - toolName: save-job
          args:
            url: "https://linkedin.com/jobs/view/42"
            profileContext: ""
`;
    const stub = `schemaVersion: 1
id: profile-stub
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
profileText: "Name: Ada\\nSkills: CANARY_PROFILE"
fetch:
  - url: "https://linkedin.com/jobs/view/42"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Senior Platform Engineer at Example Corp</body></html>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
canaries:
  - { value: "CANARY_PROFILE", sinks: [database] }
model:
  responses:
    - purpose: analysis
      object:
        schemaVersion: 1
        title: "Senior Platform Engineer"
        company: "Example Corp"
        location: "Remote"
        summary: "Platform tooling for the core product."
        fitScore: 82
        nextStep: "Apply with the confirmed profile."
    - purpose: chat
      text: "Saved: Senior Platform Engineer at Example Corp."
`;
    const scenario = `schemaVersion: 1
id: stub-profile-scenario
kind: contract
persona: P03
fixture: profile-base
stubs: [profile-stub]
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/42" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-TOOLS-EXACT, A-TOOL-CONTEXT, A-TRANSCRIPT-COMPLETE, A-BUDGET, A-CANARY-CONTAINED]
tools:
  counts:
    save-job: 1
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 20
`;
    await writeCorpus(dir, { 'profile-base': base, 'profile-stub': stub }, { 'stub-profile-scenario': scenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario: sc } = corpus.scenarios[0];
    const fixture = corpus.fixtures.get('profile-base')!.fixture;
    const stubFixture = corpus.fixtures.get('profile-stub')!.fixture;
    const result = await runScenario({ scenario: sc, fixture, stubs: [stubFixture], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'stub profileText must reach the agent; its database-only canary must trip the model sink');
    assert.ok(result.redaction.canariesFound.includes('CANARY_PROFILE'), 'canary must be reported');
    const gate = result.assertions.find((a) => a.id === 'A-CANARY-CONTAINED')!;
    assert.match(gate.evidence, /@model:/, 'hit must be attributed to the model sink');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('scripted model: memory extraction consumes no fixture chat responses', async () => {
  const clock = () => 0;
  const model = createScriptedModel({ responses: [{ purpose: 'chat', text: 'first chat' }, { purpose: 'chat', text: 'second chat' }] }, clock, { calls: [] });
  const textOf = (output: Record<string, unknown>) => String((output.content as { text: string }[])[0]?.text ?? '');
  const memory = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'Update working memory with observations you made during the previous conversation.' }] }] });
  assert.equal(textOf(memory), '{}', 'memory extraction must take the {} default, not consume a chat response');
  const first = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }] });
  assert.equal(textOf(first), 'first chat', 'first real chat call must receive the first scripted response');
  const second = await model.doGenerate({ prompt: [{ role: 'user', content: [{ type: 'text', text: 'hello again' }] }] });
  assert.equal(textOf(second), 'second chat', 'second real chat call must receive the second scripted response');
});

test('tool calls are closed only by the current turn: an unobserved final tool call leaves the run incomplete', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-maxsteps-'));
  try {
    // maxSteps:8 — the 8th agent call is a toolCalls response; the agent executes
    // the tool and stops at the step cap without a model call observing the result
    let responses = '';
    for (let round = 0; round < 8; round++) {
      responses += `    - purpose: chat\n      match: "Save this job now"\n      toolCalls:\n        - toolName: save-job\n          args:\n            url: "https://linkedin.com/jobs/view/42"\n            profileContext: ""\n`;
    }
    responses += `    - purpose: analysis\n      object:\n        schemaVersion: 1\n        title: "Platform Engineer Alpha"\n        company: "Example Corp"\n        location: "Remote"\n        summary: "Alpha platform tooling."\n        fitScore: 81\n        nextStep: "Apply with the confirmed profile."\n`;
    const fixture = `schemaVersion: 1
id: maxsteps-flow
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
clock: "2026-01-01T00:00:00Z"
db:
  profiles:
    - ownerId: career-owner-v0
      name: Ada
      content: "Name: Ada"
      active: true
fetch:
  - url: "https://linkedin.com/jobs/view/42"
    dns: ["93.184.216.34"]
    status: 200
    contentType: "text/html"
    body: "<html><body>Platform Engineer Alpha at Example Corp</body></html>"
sheets:
  headers: [jobId, status, title, company]
  rows: []
model:
  responses:\n${responses}`;
    const scenario = `schemaVersion: 1
id: maxsteps-scenario
kind: contract
persona: P03
fixture: maxsteps-flow
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/save https://linkedin.com/jobs/view/42" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-TRANSCRIPT-COMPLETE, A-TOOLS-EXACT, A-BUDGET]
tools:
  counts:
    save-job: 8
limits:
  maxTurns: 5
  maxWallClockMs: 60000
  maxModelCalls: 30
`;
    await writeCorpus(dir, { 'maxsteps-flow': fixture }, { 'maxsteps-scenario': scenario });
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0, corpus.errors.map((e) => e.message).join('; '));
    const { scenario: sc } = corpus.scenarios[0];
    const fixtureEntry = corpus.fixtures.get('maxsteps-flow')!.fixture;
    const result = await runScenario({ scenario: sc, fixture: fixtureEntry, stubs: [], manifest: MANIFEST, keepArtifacts: false, corpusHash: corpus.hash, runId: `test-${Date.now()}` });
    assert.equal(result.status, 'incomplete', 'an agent transaction ending on an unobserved tool call must be incomplete');
    const gate = result.assertions.find((a) => a.id === 'A-TRANSCRIPT-COMPLETE')!;
    assert.equal(gate.status, 'failed', gate.evidence);
    assert.ok(result.assertions.find((a) => a.id === 'A-TOOLS-EXACT')?.evidence.includes('save-job=8'), 'all eight tool calls still executed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('explicitly selected staged scenarios run through filterCorpus', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-staged-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE }, {});
    await writeFile(path.join(dir, 'eval', 'scenarios', 'onboarding-minimal.yaml.staged'), ONBOARDING_SCENARIO);
    const corpus = await loadCorpus(dir);
    assert.equal(corpus.errors.length, 0);
    assert.equal(corpus.staged.length, 1);
    assert.equal(filterCorpus(corpus, []).corpus.scenarios.length, 0, 'unfiltered runs must not include staged scenarios');
    const selected = filterCorpus(corpus, ['onboarding-minimal']);
    assert.equal(selected.corpus.scenarios.length, 1, 'explicitly selected staged scenario must be selectable');
    assert.equal(selected.corpus.scenarios[0].staged, true);
    assert.throws(() => filterCorpus(corpus, ['typo']), /unknown scenario id/, 'unknown ids must still throw');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('stub merge conflicts: sheets failure modes and notification plans fail validation', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'eval-stubconflict-'));
  try {
    await writeCorpus(dir, { 'new-owner': NEW_OWNER_FIXTURE, 'stub-sheets': `schemaVersion: 1
id: stub-sheets
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
sheets:
  failure: auth
model:
  responses:
    - purpose: chat
      text: "stub"
`, 'stub-notify': `schemaVersion: 1
id: stub-notify
ownerId: career-owner-v0
users: ["1001"]
chats: ["2001"]
notifications:
  - { jobId: "job-1", deliver: "ok" }
model:
  responses:
    - purpose: chat
      text: "stub"
` }, {});
    const baseFixture = NEW_OWNER_FIXTURE.replace('id: new-owner', 'id: new-owner-conflict').replace('clock: "2026-01-01T00:00:00Z"\n', 'clock: "2026-01-01T00:00:00Z"\nsheets:\n  failure: write\nnotifications:\n  - { jobId: "job-1", deliver: "fail-first" }\n');
    await writeFile(path.join(dir, 'eval', 'fixtures', 'new-owner-conflict.yaml'), baseFixture);
    await writeFile(path.join(dir, 'eval', 'scenarios', 'conflict.yaml'), `schemaVersion: 1
id: conflict
kind: contract
persona: P01
fixture: new-owner-conflict
stubs: [stub-sheets, stub-notify]
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "/onboarding" }
    actorId: "1001"
    conversationId: "telegram:2001"
    expected: accepted
assertions: [A-BUDGET]
`);
    const corpus = await loadCorpus(dir);
    const messages = corpus.errors.map((e) => e.message).join('; ');
    assert.ok(/sheets failure modes write, auth/.test(messages), `sheets conflict must fail validation: ${messages}`);
    assert.ok(/conflicting delivery modes fail-first\/ok/.test(messages), `notification conflict must fail validation: ${messages}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
