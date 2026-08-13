import { mkdtemp, chmod, rm, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createCareerAgentKit } from '../src/agents/agent.ts';
import { createAgentResponder, createCareerCopilotRuntime, createOnboardingResponder } from '../src/services/career-runtime.ts';
import { CareerStore } from '../src/storage/career-store.ts';
import { LibSQLStore } from '@mastra/libsql';
import { acquireJobText } from '../src/tools/web-fetch-tool.ts';
import { evaluateAssertions, type RunContext, type ToolCallRecord, type LifecycleRecord, type LogRecord } from './assertions.ts';
import type { Fixture, Scenario, Turn } from './schemas/index.ts';
import { resolveLimits } from './schemas/index.ts';
import type { RunResult, TranscriptEvent, AssertionResult } from './schemas/run.ts';
import { parseRunResult } from './schemas/run.ts';
import { createScriptedModel, asModelConfig, type ScriptedModelLedger } from './fakes/model.ts';
import { createFetchFake, type FetchLedger } from './fakes/fetch.ts';
import { createSheetsFake, type SheetsLedger } from './fakes/sheets.ts';
import { createCollectingLogger } from './fakes/logger.ts';
import { scanTargets, type ScanTarget } from './redaction.ts';

export type RunnerManifest = {
  sourceRevision: string;
  runnerVersion: string;
  nodeVersion: string;
  lockfileHash: string;
  clock: string;
  model: string | null;
};

export type RunOptions = {
  scenario: Scenario;
  fixture: Fixture;
  stubs: Fixture[];
  manifest: RunnerManifest;
  keepArtifacts: boolean;
  corpusHash: string;
  runId: string;
};

const FALLBACK_CLOCK_MS = Date.parse('2026-01-01T00:00:00Z');
/** bounded wait for an aborted turn to settle before the runner snapshots state and cleans the sandbox */
const TURN_SETTLE_GRACE_MS = 2000;

async function listFiles(dir: string): Promise<string[]> {
  const all = await readdir(dir, { recursive: true }).catch(() => []);
  return all
    .filter((entry) => !all.some((other) => other !== entry && other.startsWith(entry + '/')))
    .map((entry) => path.join(dir, entry))
    .sort();
}

function isSimulatedDeliveryFailure(error: unknown): boolean {
  return error instanceof Error && (error as { evalDeliveryFailure?: boolean }).evalDeliveryFailure === true;
}

/** Fixture-declared delivery plan for the job a reply carries, if any. */
function deliveryPlanFor(plans: Fixture['notifications'], jobId: string) {
  return plans.find((plan) => plan.jobId === jobId);
}

function epochMs(iso: string): number {
  const parsed = Date.parse(iso);
  return Number.isFinite(parsed) ? parsed : FALLBACK_CLOCK_MS;
}

function rawUpdateFor(turn: Turn, sequence: number): unknown {
  const chatId = turn.conversationId.replace(/^telegram:/, '');
  const userId = turn.actorId;
  const text = turn.input.kind === 'text' ? turn.input.text : undefined;
  const updateId = turn.updateId ?? 1000 + sequence;
  // numeric ids: assertRawTelegramUpdate requires safe-integer chat/from ids;
  // envelope variants only change the chat type or bot flag
  const chat = { id: Number(chatId), type: 'private' as string };
  const from = { id: Number(userId) };
  const message: Record<string, unknown> = {
    message_id: 1 + sequence,
    date: 1,
    chat,
    from,
    ...(text !== undefined ? { text } : {}),
    ...(turn.input.kind === 'non_text' ? { document: { file_name: 'resume.pdf' } } : {}),
  };
  switch (turn.envelope) {
    case 'malformed':
      return {};
    case 'forwarded':
      return { update_id: updateId, message: { ...message, forward_date: 1 } };
    case 'edited':
      return { update_id: updateId, edited_message: message };
    case 'group':
      return { update_id: updateId, message: { ...message, chat: { ...chat, type: 'group' } } };
    case 'bot':
      return { update_id: updateId, message: { ...message, from: { ...from, is_bot: true } } };
    default:
      return { update_id: updateId, message };
  }
}

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { scenario, fixture, manifest, keepArtifacts, corpusHash, runId } = options;
  const limits = resolveLimits(scenario.limits);
  const startedAt = Date.now();
  const clockMs = epochMs(fixture.clock);
  const clock = () => clockMs;
  let uuidCounter = 0;
  const uuid = () => `fixture-${String(++uuidCounter).padStart(4, '0')}`;

  const dir = await mkdtemp(path.join(tmpdir(), 'career-eval-'));
  await chmod(dir, 0o700);
  const dbFile = path.join(dir, 'jobs.db');
  let store: CareerStore | null = null;
  let memoryStorage: LibSQLStore | null = null;
  const failures: { kind: string; message: string }[] = [];
  const turnOutcomes: { turnId: string; expected: Turn['expected']; actual: 'accepted' | 'rejected'; deliveryFailed?: boolean; error: Error | null; durationMs: number }[] = [];
  const events: TranscriptEvent[] = [];
  let sequence = 0;
  const atMs = () => Math.max(0, Date.now() - startedAt);
  const emit = (type: TranscriptEvent['type'], turnId: string | null, payload: Record<string, unknown> = {}) => {
    events.push({ sequence: ++sequence, turnId, type, atMs: atMs(), payload });
  };
  const logLedger: LogRecord[] = [];
  const allLogs: LogRecord[] = [];
  const modelLedger: ScriptedModelLedger = { calls: [] };
  const fetchLedger: FetchLedger = { calls: [] };
  const sheetsLedger: SheetsLedger = { calls: [] };
  const replyLedger: { text: string; delivered: boolean; turnId: string | null; atMs: number }[] = [];
  const notifications: { jobId: string; delivered: boolean; atMs: number; attempt: number }[] = [];
  const toolLedger: ToolCallRecord[] = [];
  const openToolCalls = new Set<number>();
  const lifecycle: LifecycleRecord[] = [];
  const logger = createCollectingLogger(logLedger);

  const mergedFixture: Fixture = {
    ...fixture,
    // scalar overrides follow the sheets.failure rule: base wins, stubs fill gaps
    profileText: fixture.profileText ?? options.stubs.map((stub) => stub.profileText).find((text) => text !== undefined),
    db: {
      onboarding: [...fixture.db.onboarding, ...options.stubs.flatMap((stub) => stub.db.onboarding)],
      profiles: [...fixture.db.profiles, ...options.stubs.flatMap((stub) => stub.db.profiles)],
      jobs: [...fixture.db.jobs, ...options.stubs.flatMap((stub) => stub.db.jobs)],
      reports: [...fixture.db.reports, ...options.stubs.flatMap((stub) => stub.db.reports)],
    },
    fetch: [...fixture.fetch, ...options.stubs.flatMap((stub) => stub.fetch)],
    users: [...fixture.users, ...options.stubs.flatMap((stub) => stub.users)],
    chats: [...fixture.chats, ...options.stubs.flatMap((stub) => stub.chats)],
    sheets: {
      headers: [...fixture.sheets.headers, ...options.stubs.flatMap((stub) => stub.sheets.headers)],
      rows: [...fixture.sheets.rows, ...options.stubs.flatMap((stub) => stub.sheets.rows)],
      failure: fixture.sheets.failure ?? options.stubs.map((stub) => stub.sheets.failure).find((failure) => failure !== undefined),
    },
    notifications: [...fixture.notifications, ...options.stubs.flatMap((stub) => stub.notifications)],
    model: { responses: [...fixture.model.responses, ...options.stubs.flatMap((stub) => stub.model.responses)] },
  };
  const canaries = [...fixture.canaries, ...options.stubs.flatMap((stub) => stub.canaries)];

  let status: RunResult['status'] = 'passed';
  let incompleteReason: string | null = null;
  const markIncomplete = (reason: string) => { if (!incompleteReason) { incompleteReason = reason; status = 'incomplete'; } };

  let currentTurnId: string | null = null;
  let currentUpdateId: string | null = null;
  let modelCallsAtTurnStart = 0;

  try {
    store = new CareerStore(`file:${dbFile}`, { clock });
    await store.ready();
    for (const row of mergedFixture.db.jobs) {
      await store.importJob({ ...row, userId: row.userId ?? null, safeResult: row.safeResult ?? null, mastraRunId: row.mastraRunId ?? null, reportId: row.reportId ?? null, reportPath: row.reportPath ?? null, sheetReference: row.sheetReference ?? null, safeError: row.safeError ?? null, notifiedAt: row.notifiedAt ?? null, createdAt: row.createdAt ?? clockMs, updatedAt: row.updatedAt ?? clockMs });
    }
    for (const row of mergedFixture.db.reports) {
      await store.importReport({ reportId: row.reportId, ownerId: row.ownerId, jobId: row.jobId, content: row.content, createdAt: clockMs });
    }
    for (const row of mergedFixture.db.profiles) {
      await store.importProfileDocument({ ownerId: row.ownerId, name: row.name, content: row.content, active: row.active, createdAt: clockMs });
    }
    for (const row of mergedFixture.db.onboarding) {
      await store.importOnboarding({ ownerId: row.ownerId, conversationId: row.conversationId, status: row.status, draft: row.draft, version: row.version, createdAt: clockMs, updatedAt: clockMs });
    }

    const profileText = mergedFixture.profileText ?? (await store.profileText(fixture.ownerId));
    const sheetsFake = createSheetsFake(mergedFixture.sheets, sheetsLedger);
    const scripted = createScriptedModel(mergedFixture.model, clock, modelLedger);
    const fetchFake = createFetchFake(mergedFixture.fetch, fetchLedger);
    // cancellation seam: the active turn's AbortSignal propagates into the SUT's
    // fetch (acquireJobText), so a timed-out turn is aborted, not just abandoned
    let activeTurnSignal: AbortSignal | null = null;
    const acquire = (url: string) => acquireJobText(url, { fetch: fetchFake.fetch, resolve: fetchFake.resolve, timeoutMs: 5000, ...(activeTurnSignal ? { signal: activeTurnSignal } : {}) });
    memoryStorage = new LibSQLStore({ id: 'eval-memory', url: `file:${path.join(dir, 'memory.db')}` });
    await memoryStorage.init();
    const baselineFiles = new Set(await listFiles(dir));

    // Real delivery seam: the runtime's `reply` callback is the transport. The
    // wrapper attributes each delivery to the job it notifies (a succeeded,
    // not-yet-notified job for the current update) and honors the fixture's
    // notifications plan: `fail-first` throws on attempt 1 (a simulated
    // transport failure), so the SUT must not mark notified_at — only a later
    // successful delivery may. Every attempt is recorded with its real outcome.
    const deliveryAttempts = new Map<string, number>();
    const deliver = async (text: string, _chatId?: string) => {
      const unnotified = (await store.list()).filter((job) => job.status === 'succeeded' && job.notifiedAt === null);
      const candidate =
        unnotified.filter((job) => currentUpdateId !== null && (job.transportEventId === `telegram:${currentUpdateId}` || job.transportEventId === currentUpdateId)).at(0) ??
        (unnotified.length === 1 ? unnotified[0] : null);
      if (candidate) {
        const attempt = (deliveryAttempts.get(candidate.jobId) ?? 0) + 1;
        deliveryAttempts.set(candidate.jobId, attempt);
        const plan = deliveryPlanFor(mergedFixture.notifications, candidate.jobId);
        if (plan?.deliver === 'fail-first' && attempt === 1) {
          notifications.push({ jobId: candidate.jobId, delivered: false, atMs: atMs(), attempt });
          emit('notification', currentTurnId, { jobId: candidate.jobId, delivered: false, attempt });
          throw Object.assign(new Error(`simulated delivery failure for job ${candidate.jobId} (fail-first plan, attempt ${attempt})`), { evalDeliveryFailure: true });
        }
        notifications.push({ jobId: candidate.jobId, delivered: true, atMs: atMs(), attempt });
        emit('notification', currentTurnId, { jobId: candidate.jobId, delivered: true, attempt });
      }
      replyLedger.push({ text, delivered: true, turnId: currentTurnId, atMs: atMs() });
      emit('assistant_reply', currentTurnId, { length: text.length });
    };
    const kit = createCareerAgentKit({
      store,
      profileText,
      sheet: sheetsFake.adapter,
      model: asModelConfig(scripted),
      memoryModel: asModelConfig(scripted),
      storage: memoryStorage,
      uuid,
      acquire,
      logger,
    });
    const runtime = createCareerCopilotRuntime({
      ownerId: fixture.ownerId,
      allowedUserIds: new Set(mergedFixture.users),
      privateChatIds: new Set(mergedFixture.chats),
      store,
      logger,
      respond: createAgentResponder(kit.agent, fixture.ownerId, logger),
      onboard: createOnboardingResponder(kit.agent),
    });

    const isLifecycleEvent = (event: string) => event.startsWith('job.') || event.startsWith('onboarding.') || event.startsWith('recovery.') || event.startsWith('telegram.update.') || event === 'command.received' || event === 'agent.turn.started' || event === 'agent.turn.succeeded' || event === 'agent.turn.failed';

    // issue #13c (S18): production recovery seam. Fixture rows in queued/running
    // state are resumed at startup exactly like the production index boots
    // recoverUnfinished; recovery tool calls carry the persisted job identity
    // (no owning turn) and close when the recovery turn's final model call
    // observed their results.
    const unfinished = mergedFixture.db.jobs.filter((job) => job.status === 'queued' || job.status === 'running');
    if (unfinished.length > 0) {
      await runtime.recoverUnfinished(deliver, { notify: true });
      const logs = logLedger.splice(0);
      allLogs.push(...logs);
      for (const log of logs) {
        if (log.event === 'tool.invoked') {
          const record: ToolCallRecord = {
            toolId: String(log.data.toolId ?? ''),
            ...(typeof log.data.url === 'string' ? { url: log.data.url } : {}),
            ...(typeof log.data.resumeJobId === 'string' ? { resumeJobId: log.data.resumeJobId } : {}),
            ownerId: fixture.ownerId,
          };
          openToolCalls.add(toolLedger.length);
          toolLedger.push(record);
          emit('tool_call', null, { toolId: record.toolId });
        } else if (isLifecycleEvent(log.event)) {
          const record: LifecycleRecord = { event: log.event, data: { ...log.data }, turnId: null };
          if (log.data.jobId) record.jobId = String(log.data.jobId);
          if (log.data.phase) record.phase = String(log.data.phase);
          if (log.data.status) record.status = String(log.data.status);
          lifecycle.push(record);
          emit('lifecycle', null, { event: log.event, ...log.data });
        }
      }
      // pair recovery tool calls with their recovered job identity
      for (const record of toolLedger) {
        if (record.turnId !== undefined) continue;
        // exact identity first: the save-job tool already logged the persisted
        // resumeJobId, so multi-job recovery never falls through to the fuzzy
        // first-lifecycle-event match (review round 1 finding)
        if (!record.jobId && record.resumeJobId) record.jobId = record.resumeJobId;
        if (!record.jobId) {
          const match = lifecycle.find((event) => event.turnId === null && event.jobId && (event.event === 'job.resumed' || event.event === 'job.started'));
          if (match?.jobId) record.jobId = match.jobId;
        }
        if (record.jobId) {
          const job = await store.get(record.jobId);
          if (job) {
            // production rows persist scoped identities (telegram:…)
            record.actorId = job.userId ?? undefined;
            record.conversationId = job.chatId;
          }
        }
      }
      // close recovery tool calls when the recovery turn observed their results
      const recoveryCalls = modelLedger.calls.filter((call) => call.purpose !== 'memory');
      const lastRecovery = recoveryCalls.at(-1);
      if (openToolCalls.size > 0 && lastRecovery && !lastRecovery.issuedToolCalls && recoveryCalls.some((call) => call.toolResultSeen)) {
        const closed = [...openToolCalls];
        emit('tool_result', null, { tools: closed.map((index) => toolLedger[index].toolId) });
        for (const index of closed) openToolCalls.delete(index);
      }
      // recovery model calls precede every user turn and stay unattributed
      modelCallsAtTurnStart = modelLedger.calls.length;
    }

    if (scenario.turns.length > limits.maxTurns) markIncomplete(`scenario declares ${scenario.turns.length} turns, exceeds maxTurns ${limits.maxTurns}`);

    for (const turn of scenario.turns) {
      if (status === 'incomplete') break;
      currentTurnId = turn.id;
      emit('user_turn', turn.id, { channel: turn.channel, inputKind: turn.input.kind, actorId: turn.actorId, conversationId: turn.conversationId });
      const turnStarted = Date.now();
      let outcome: { turnId: string; expected: Turn['expected']; actual: 'accepted' | 'rejected'; deliveryFailed?: boolean; error: Error | null; durationMs: number };
      try {
        const raw = rawUpdateFor(turn, sequence);
        const rawUpdateId = (raw as { update_id?: unknown }).update_id;
        currentUpdateId = typeof rawUpdateId === 'number' ? String(rawUpdateId) : null;
        const turnPromise = runtime.handleTelegramUpdate(raw, deliver);
        // per-turn timeout (issue #13): a hung turn is incomplete, never stalls the scenario
        let result: Awaited<ReturnType<typeof runtime.handleTelegramUpdate>>;
        if (turn.timeoutMs) {
          const controller = new AbortController();
          activeTurnSignal = controller.signal;
          let timer: NodeJS.Timeout | undefined;
          try {
            result = await Promise.race([
              turnPromise,
              new Promise<never>((_resolve, reject) => {
                timer = setTimeout(() => {
                  controller.abort();
                  reject(Object.assign(new Error(`turn ${turn.id} exceeded per-turn timeoutMs ${turn.timeoutMs}`), { evalTurnTimeout: true }));
                }, turn.timeoutMs);
              }),
            ]);
          } finally {
            clearTimeout(timer);
            // the aborted turn settles (fetch rejects, job fails, agent unwinds)
            // BEFORE the runner snapshots state and cleans the sandbox — bounded,
            // so a signal-ignoring SUT still cannot stall the scenario
            let settleTimer: NodeJS.Timeout | undefined;
            await Promise.race([
              turnPromise.catch(() => undefined),
              new Promise<void>((resolve) => { settleTimer = setTimeout(resolve, TURN_SETTLE_GRACE_MS); }),
            ]);
            clearTimeout(settleTimer);
            activeTurnSignal = null;
          }
        } else {
          result = await turnPromise;
        }
        outcome = { turnId: turn.id, expected: turn.expected, actual: result.outcome, error: null, durationMs: Date.now() - turnStarted };
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        if (isSimulatedDeliveryFailure(err)) {
          // the SUT processed the update; only the (simulated) transport failed
          outcome = { turnId: turn.id, expected: turn.expected, actual: 'accepted', deliveryFailed: true, error: null, durationMs: Date.now() - turnStarted };
        } else {
          outcome = { turnId: turn.id, expected: turn.expected, actual: 'rejected', error: err, durationMs: Date.now() - turnStarted };
          emit('error', turn.id, { message: err.message });
          markIncomplete(`turn ${turn.id} raised: ${err.message}`);
        }
      }
      turnOutcomes.push(outcome);

      // drain log-derived events (consumed once); this turn's tool calls land at
      // indexes >= turnToolLedgerStart (stale open calls from earlier turns stay)
      const turnToolLedgerStart = toolLedger.length;
      const logs = logLedger.splice(0);
      allLogs.push(...logs);
      for (const log of logs) {
        if (log.event === 'tool.invoked') {
          const record: ToolCallRecord = {
            toolId: String(log.data.toolId ?? ''),
            turnId: turn.id,
            ...(typeof log.data.url === 'string' ? { url: log.data.url } : {}),
            ...(typeof log.data.resumeJobId === 'string' ? { resumeJobId: log.data.resumeJobId } : {}),
            ownerId: fixture.ownerId,
            actorId: `telegram:${turn.actorId}`,
            conversationId: turn.conversationId,
            ...(currentUpdateId !== null ? { requestId: `telegram:${currentUpdateId}` } : {}),
          };
          openToolCalls.add(toolLedger.length);
          toolLedger.push(record);
          emit('tool_call', turn.id, { toolId: record.toolId });
        } else if (isLifecycleEvent(log.event)) {
          const record: LifecycleRecord = { event: log.event, data: { ...log.data }, turnId: turn.id };
          if (log.data.jobId) record.jobId = String(log.data.jobId);
          if (log.data.phase) record.phase = String(log.data.phase);
          if (log.data.status) record.status = String(log.data.status);
          lifecycle.push(record);
          emit('lifecycle', turn.id, { event: log.event, ...log.data });
        }
      }

      // attribute jobId to tool calls via the job lifecycle event of the same turn/request
      for (const record of toolLedger) {
        if (record.jobId) continue;
        const match = lifecycle.find((event) => event.turnId === turn.id && event.jobId && (event.event === 'job.queued' || event.event === 'job.started' || event.event === 'job.resumed') && (record.requestId === undefined || event.data.requestId === record.requestId));
        if (match?.jobId) record.jobId = match.jobId;
      }

      // model calls made during this turn (attributed for A-AUTH-BEFORE-MODEL and budgets)
      const calls = modelLedger.calls;
      const newCalls = calls.slice(modelCallsAtTurnStart);
      modelCallsAtTurnStart = calls.length;

      // tool results: a tool call closes only when a later model call observed its
      // result. If the turn's FINAL agent call itself issued tool calls (e.g. cut
      // off by the maxSteps cap), that tool call was never observed — it must stay
      // open so A-TRANSCRIPT-COMPLETE fails. Stale calls from earlier turns are
      // never closed by this turn's observations.
      const agentCalls = newCalls.filter((call) => call.purpose !== 'memory');
      const lastAgentCall = agentCalls.at(-1);
      const closing = [...openToolCalls].filter((index) => index >= turnToolLedgerStart);
      if (closing.length > 0 && lastAgentCall && !lastAgentCall.issuedToolCalls && newCalls.some((call) => call.toolResultSeen)) {
        emit('tool_result', turn.id, { tools: closing.map((index) => toolLedger[index].toolId) });
        for (const index of closing) openToolCalls.delete(index);
      }

      for (const call of newCalls) {
        emit('model_call', turn.id, { purpose: call.purpose, provider: call.provider, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens });
      }

      emit('state_snapshot', turn.id, { at: 'post-turn' });
      currentUpdateId = null;
      if (modelLedger.calls.length > limits.maxModelCalls) markIncomplete(`model calls ${modelLedger.calls.length} exceed maxModelCalls ${limits.maxModelCalls}`);
      if (Date.now() - startedAt > limits.maxWallClockMs) markIncomplete(`wall clock ${Date.now() - startedAt}ms exceeds maxWallClockMs ${limits.maxWallClockMs}`);
    }
    currentTurnId = null;

    // final state projection
    const conversations = [...new Set(scenario.turns.map((turn) => turn.conversationId))];
    const onboardingRows = [];
    for (const conversationId of conversations) {
      const row = await store.loadOnboarding(fixture.ownerId, conversationId);
      if (row) onboardingRows.push({ ownerId: row.ownerId, conversationId: row.conversationId, status: row.status, version: row.version, draft: row.draft });
    }
    const profiles = await store.listProfileDocuments(fixture.ownerId);
    const jobs = await store.list();
    const reports: Record<string, unknown>[] = [];
    const reportContents: string[] = [];
    for (const job of jobs) {
      if (job.reportId) {
        const report = await store.getReport(job.reportId, fixture.ownerId);
        if (report) {
          reports.push({ reportId: report.reportId, ownerId: report.ownerId, jobId: report.jobId, version: report.version, byteSize: report.byteSize, createdAt: report.createdAt });
          reportContents.push(report.content);
        }
      }
    }
    const state = {
      onboarding: onboardingRows,
      profiles: profiles.map((profile) => ({ documentId: profile.documentId, ownerId: profile.ownerId, name: profile.name, version: profile.version, active: profile.active, byteSize: profile.byteSize })),
      jobs,
      reports,
      sheets: sheetsFake.rows,
      notifications,
    };

    // isolation seam (issue #13): any file the SUT creates in the sandbox beyond
    // the harness's own db/memory artifacts fails the run
    for (const file of await listFiles(dir)) {
      if (!baselineFiles.has(file)) failures.push({ kind: 'unexpected-file', message: `unexpected file created in sandbox: ${path.relative(dir, file)}` });
    }

    const everyTurnTerminal = turnOutcomes.every((outcome) => outcome.error === null);
    const everyToolClosed = openToolCalls.size === 0;
    const transcriptComplete = !incompleteReason && everyTurnTerminal && everyToolClosed;

    // scenario-level turn expectations (not catalog gates); an accepted turn is
    // terminal only when it produced a delivered reply or a (simulated) delivery
    // failure record — a turn that merely ran without replying is not complete
    const outcomeChecks: AssertionResult[] = turnOutcomes.map((outcome) => {
      const replied = replyLedger.some((reply) => reply.turnId === outcome.turnId && reply.delivered);
      const terminal = outcome.actual === 'rejected' || replied || outcome.deliveryFailed === true;
      const passed = outcome.actual === outcome.expected && terminal;
      return { id: `turn.${outcome.turnId}.outcome`, status: passed ? 'passed' : 'failed', evidence: `expected ${outcome.expected}, got ${outcome.actual}${terminal ? '' : ', no terminal reply'}` };
    });

    // sink-aware redaction scan
    const targets: ScanTarget[] = [
      { name: 'replies', sink: 'reply', value: replyLedger.map((reply) => reply.text) },
      { name: 'logs', sink: 'log', value: allLogs },
      { name: 'database', sink: 'database', value: { onboarding: onboardingRows, profiles, jobs, reports } },
      { name: 'reports', sink: 'report', value: reportContents },
      { name: 'sheets', sink: 'sheet', value: sheetsFake.rows },
      { name: 'model-calls', sink: 'model', value: modelLedger.calls },
      { name: 'notifications', sink: 'reply', value: notifications },
    ];
    const { hits, scanned } = scanTargets(targets, canaries);

    const modelCalls = modelLedger.calls;
    const metrics = {
      durationMs: Date.now() - startedAt,
      ttFirstResponseMs: events.find((event) => event.type === 'assistant_reply')?.atMs ?? null,
      modelCalls: modelCalls.length,
      inputTokens: modelCalls.length > 0 && modelCalls.every((call) => call.inputTokens !== null) ? modelCalls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0) : null,
      outputTokens: modelCalls.length > 0 && modelCalls.every((call) => call.outputTokens !== null) ? modelCalls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0) : null,
      peakRssBytes: Math.round(process.memoryUsage().rss / 1024) * 1024,
      transcriptBytes: Buffer.byteLength(JSON.stringify(events), 'utf8'),
    };

    const ctx: RunContext = {
      scenario,
      // assertions judge what actually ran: the runtime is configured from the
      // stub-merged fixture (identities, fetch plans, notification plans)
      fixture: mergedFixture,
      limits,
      transcriptComplete,
      transcriptEvents: events,
      state,
      ledgers: {
        toolCalls: toolLedger,
        modelCalls,
        lifecycle,
        replies: replyLedger.map((reply) => ({ turnId: reply.turnId ?? 'unknown', text: reply.text })),
        logs: allLogs,
        notifications,
        failures,
        fetch: fetchLedger.calls,
      },
      metrics,
      redactionHits: hits,
      corpusHash,
      runId,
    };

    const assertionResults = [...evaluateAssertions(scenario.assertions, ctx), ...outcomeChecks];

    if (!transcriptComplete) markIncomplete('transcript incomplete: a turn lacked a terminal reply or a tool call lacks a result');
    if (hits.length > 0) markIncomplete(`redaction scan failed closed: ${hits.length} canary hit(s)`);
    if (failures.length > 0) markIncomplete(failures.map((failure) => `${failure.kind}: ${failure.message}`).join('; '));

    if (status === 'passed' && assertionResults.some((result) => result.status === 'failed')) status = 'failed';

    // final completion event: after every incomplete condition is resolved, with
    // the true final status and the reason (consumers need the transcript alone)
    emit('lifecycle', null, { event: 'run.completed', status, ...(incompleteReason ? { reason: incompleteReason } : {}) });

    return parseRunResult({
      runSchemaVersion: 1,
      runId,
      scenarioId: scenario.id,
      fixtureId: fixture.id,
      status,
      corpusHash,
      manifest,
      transcript: { complete: transcriptComplete, events },
      state,
      assertions: assertionResults,
      metrics,
      redaction: { canariesFound: hits.map((hit) => hit.canary), sinksScanned: [...new Set(scanned)], rawArtifactPath: keepArtifacts ? dir : null },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push({ kind: 'unhandled', message });
    events.push({ sequence: ++sequence, turnId: null, type: 'error', atMs: atMs(), payload: { message } });
    return parseRunResult({
      runSchemaVersion: 1,
      runId,
      scenarioId: scenario.id,
      fixtureId: fixture.id,
      status: 'incomplete',
      corpusHash,
      manifest,
      transcript: { complete: false, events },
      state: { onboarding: [], profiles: [], jobs: [], reports: [], sheets: [], notifications: [] },
      assertions: [],
      metrics: { durationMs: Date.now() - startedAt, ttFirstResponseMs: null, modelCalls: modelLedger.calls.length, inputTokens: null, outputTokens: null, peakRssBytes: null, transcriptBytes: Buffer.byteLength(JSON.stringify(events), 'utf8') },
      redaction: { canariesFound: [], sinksScanned: [], rawArtifactPath: keepArtifacts ? dir : null },
    });
  } finally {
    if (store) {
      try { await store.close(); } catch { /* best effort */ }
    }
    try { await memoryStorage?.close(); } catch { /* best effort */ }
    if (!keepArtifacts) {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }
}
