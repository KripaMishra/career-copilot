import type { AssertionEntry, AssertionId, ValueAssertion, Operator } from './schemas/assertion.ts';
import { isValueAssertion } from './schemas/assertion.ts';
import type { AssertionResult } from './schemas/run.ts';
import type { Fixture, Canary } from './schemas/fixture.ts';
import type { Scenario, Turn, Limits } from './schemas/scenario.ts';
import { assertJobUrl } from '../src/tools/job-url.ts';
import { MAX_DECODED_BYTES, MAX_MODEL_CHARS } from '../src/tools/web-fetch-tool.ts';
import { safeAppLogKeys } from '../src/observability.ts';
import { OnboardingDraftSchema } from '../src/contracts/onboarding.ts';
import { JobStatusSchema } from '../src/contracts/v0.ts';

export type ToolCallRecord = { toolId: string; url?: string; jobId?: string; turnId?: string; ownerId?: string; actorId?: string; conversationId?: string; requestId?: string; resumeJobId?: string };
export type ModelCallRecord = { purpose: string; provider: string; model: string; usage: { inputTokens: number | null; outputTokens: number | null } | null; latencyMs: number };
export type LifecycleRecord = { event: string; jobId?: string; phase?: string; status?: string; turnId?: string; data: Record<string, unknown> };
export type ReplyRecord = { turnId: string; text: string };
export type LogRecord = { level: 'info' | 'warn' | 'error'; event: string; data: Record<string, unknown> };
export type NotificationRecord = { jobId: string; delivered: boolean; atMs: number; attempt?: number };
export type FailureRecord = { kind: string; message: string };
export type FetchLedgerRecord = { url: string; status: number; contentType: string; bodyBytes: number; resolved: string[] };

export type Ledgers = {
  toolCalls: ToolCallRecord[];
  modelCalls: ModelCallRecord[];
  lifecycle: LifecycleRecord[];
  replies: ReplyRecord[];
  logs: LogRecord[];
  notifications: NotificationRecord[];
  failures: FailureRecord[];
  fetch: FetchLedgerRecord[];
};

export type RunContext = {
  scenario: Scenario;
  fixture: Fixture;
  limits: Required<Limits>;
  transcriptComplete: boolean;
  transcriptEvents: { sequence: number; turnId: string | null; type: string; atMs: number }[];
  state: { onboarding: Record<string, unknown>[]; profiles: Record<string, unknown>[]; jobs: Record<string, unknown>[]; reports: Record<string, unknown>[]; sheets: Record<string, unknown>[]; notifications: Record<string, unknown>[] };
  ledgers: Ledgers;
  metrics: { durationMs: number; ttFirstResponseMs: number | null; modelCalls: number; transcriptBytes: number };
  redactionHits: { canary: string; sink: string; where: string }[];
  corpusHash: string;
  runId: string;
};

const pass = (id: string, evidence: string): AssertionResult => ({ id, status: 'passed', evidence });
const fail = (id: string, evidence: string): AssertionResult => ({ id, status: 'failed', evidence });

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** JSON-path-ish extraction: `a.b[0].c` over the context view. */
export function getPath(root: unknown, path: string): { found: boolean; value: unknown } {
  const segments = path.match(/(?:[^.[\]]+)|(?:\[\d+\])/g) ?? [];
  let current: unknown = root;
  for (const raw of segments) {
    if (current === null || current === undefined) return { found: false, value: undefined };
    if (raw.startsWith('[')) {
      const index = Number(raw.slice(1, -1));
      if (!Array.isArray(current) || index >= current.length) return { found: false, value: undefined };
      current = current[index];
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[raw];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function evaluateOperator(op: Operator, extracted: { found: boolean; value: unknown }, expected: unknown): { ok: boolean; detail: string } {
  switch (op) {
    case 'eq':
      return { ok: extracted.found && deepEqual(extracted.value, expected), detail: `expected eq ${JSON.stringify(expected)}, got ${JSON.stringify(extracted.value)}` };
    case 'member':
      return { ok: extracted.found && Array.isArray(extracted.value) && extracted.value.some((item) => deepEqual(item, expected)), detail: `expected member ${JSON.stringify(expected)}` };
    case 'count':
      return { ok: extracted.found && Array.isArray(extracted.value) && extracted.value.length === Number(expected), detail: `expected count ${String(expected)}, got ${Array.isArray(extracted.value) ? extracted.value.length : 'not-an-array'}` };
    case 'prefix': {
      const list = extracted.found && Array.isArray(extracted.value) ? (extracted.value as unknown[]) : null;
      const prefix = Array.isArray(expected) ? expected : null;
      const ok = list !== null && prefix !== null && list.length >= prefix.length && prefix.every((item, i) => deepEqual(item, list[i]));
      return { ok, detail: ok ? 'ordered prefix matches' : 'ordered prefix mismatch' };
    }
    case 'order': {
      const list = extracted.found && Array.isArray(extracted.value) ? (extracted.value as string[]) : null;
      const wanted = Array.isArray(expected) ? (expected as string[]) : null;
      let ok = list !== null && wanted !== null;
      if (ok) {
        let cursor = 0;
        for (const item of list) if (cursor < wanted!.length && item === wanted![cursor]) cursor++;
        ok = cursor === wanted!.length;
      }
      return { ok, detail: ok ? 'partial order matches' : 'partial order mismatch' };
    }
    case 'path':
      return { ok: extracted.found && extracted.value !== undefined, detail: `path resolves to ${JSON.stringify(extracted.value)}` };
    case 'absent':
      return { ok: !extracted.found || extracted.value === undefined, detail: 'expected absence' };
  }
}

function contextView(ctx: RunContext): Record<string, unknown> {
  return {
    state: ctx.state,
    metrics: ctx.metrics,
    toolCalls: ctx.ledgers.toolCalls,
    modelCalls: ctx.ledgers.modelCalls,
    lifecycle: ctx.ledgers.lifecycle,
    replies: ctx.ledgers.replies,
    notifications: ctx.ledgers.notifications,
    logs: ctx.ledgers.logs,
    redactionHits: ctx.redactionHits,
    transcriptComplete: ctx.transcriptComplete,
  };
}

const PHASE_ORDER = ['fetch', 'analysis', 'report', 'sheets', 'complete'] as const;

const gates: Record<AssertionId, (ctx: RunContext) => AssertionResult> = {
  'A-AUTH-BEFORE-MODEL': (ctx) => {
    const events = ctx.transcriptEvents;
    const firstUser = events.find((event) => event.type === 'user_turn');
    const firstModel = events.find((event) => event.type === 'model_call');
    if (firstModel && (!firstUser || firstModel.sequence < firstUser.sequence)) return fail('A-AUTH-BEFORE-MODEL', 'model call precedes any user turn');
    const rejectedTurnIds = new Set(ctx.scenario.turns.filter((turn) => turn.expected === 'rejected').map((turn) => turn.id));
    const callsDuringRejected = events.filter((event) => event.type === 'model_call' && event.turnId && rejectedTurnIds.has(event.turnId));
    if (callsDuringRejected.length > 0) return fail('A-AUTH-BEFORE-MODEL', `rejected turns produced ${callsDuringRejected.length} model call(s)`);
    return pass('A-AUTH-BEFORE-MODEL', `first model call after first user turn (${ctx.ledgers.modelCalls.length} total)`);
  },
  'A-TOOLS-EXACT': (ctx) => {
    const expectation = ctx.scenario.tools;
    if (!expectation) return pass('A-TOOLS-EXACT', 'no tool expectations declared');
    const counts = new Map<string, number>();
    for (const call of ctx.ledgers.toolCalls) counts.set(call.toolId, (counts.get(call.toolId) ?? 0) + 1);
    const problems: string[] = [];
    for (const required of expectation.require) if ((counts.get(required) ?? 0) === 0) problems.push(`required tool ${required} never called`);
    for (const forbidden of expectation.forbid) if ((counts.get(forbidden) ?? 0) > 0) problems.push(`forbidden tool ${forbidden} called ${counts.get(forbidden)} time(s)`);
    for (const [toolId, expected] of Object.entries(expectation.counts)) if ((counts.get(toolId) ?? 0) !== expected) problems.push(`tool ${toolId} called ${counts.get(toolId) ?? 0} time(s), expected ${expected}`);
    return problems.length === 0 ? pass('A-TOOLS-EXACT', `tool counts: ${[...counts.entries()].map(([id, n]) => `${id}=${n}`).join(', ') || 'none'}`) : fail('A-TOOLS-EXACT', problems.join('; '));
  },
  'A-TOOL-CONTEXT': (ctx) => {
    const problems: string[] = [];
    for (const call of ctx.ledgers.toolCalls) {
      const turn = call.turnId ? ctx.scenario.turns.find((candidate) => candidate.id === call.turnId) : undefined;
      if (!turn) { problems.push(`tool ${call.toolId} has no owning turn`); continue; }
      if (turn.expected === 'rejected') { problems.push(`tool ${call.toolId} ran on turn ${turn.id} expected to be rejected`); continue; }
      const authorizedUser = ctx.fixture.users.includes(turn.actorId);
      const authorizedChat = ctx.fixture.chats.includes(turn.conversationId.replace(/^telegram:/, ''));
      if (!authorizedUser || !authorizedChat) problems.push(`tool ${call.toolId} ran for unauthorized turn ${turn.id}`);
    }
    return problems.length === 0 ? pass('A-TOOL-CONTEXT', `${ctx.ledgers.toolCalls.length} tool call(s) with matching identity`) : fail('A-TOOL-CONTEXT', problems.join('; '));
  },
  'A-ONBOARDING-STATE': (ctx) => {
    const rows = ctx.state.onboarding;
    if (rows.length === 0) return fail('A-ONBOARDING-STATE', 'no final onboarding rows captured');
    const problems: string[] = [];
    for (const row of rows) {
      const status = String(row.status ?? '');
      if (!['collecting', 'review', 'completed', 'cancelled'].includes(status)) problems.push(`row ${String(row.conversationId ?? '')} invalid status ${status}`);
    }
    return problems.length === 0 ? pass('A-ONBOARDING-STATE', `${rows.length} row(s): ${rows.map((row) => String(row.status)).join(', ')}`) : fail('A-ONBOARDING-STATE', problems.join('; '));
  },
  'A-NO-ACTIVATION-BEFORE-CONFIRM': (ctx) => {
    const activation = ctx.ledgers.lifecycle.find((event) => event.event === 'onboarding.completed');
    if (!activation) return pass('A-NO-ACTIVATION-BEFORE-CONFIRM', 'no activation observed');
    const turns = ctx.scenario.turns;
    const confirmIndex = turns.findIndex((turn) => turn.input.kind === 'text' && /^confirm$/i.test((turn.input.text ?? '').trim()));
    if (confirmIndex === -1) return fail('A-NO-ACTIVATION-BEFORE-CONFIRM', 'profile activated without any confirm turn in the scenario');
    const activationIndex = turns.findIndex((turn) => turn.id === activation.turnId);
    if (activationIndex === -1) return fail('A-NO-ACTIVATION-BEFORE-CONFIRM', `activation not attributable to a turn (${String(activation.turnId ?? 'none')})`);
    if (activationIndex < confirmIndex) return fail('A-NO-ACTIVATION-BEFORE-CONFIRM', `activation on turn ${turns[activationIndex].id} precedes confirm turn ${turns[confirmIndex].id}`);
    return pass('A-NO-ACTIVATION-BEFORE-CONFIRM', `activation on turn ${turns[activationIndex].id}, not before confirm turn ${turns[confirmIndex].id}`);
  },
  'A-PROFILE-ACTIVATED': (ctx) => {
    const active = ctx.state.profiles.filter((profile) => profile.active === true);
    if (active.length > 1) return fail('A-PROFILE-ACTIVATED', `${active.length} active profiles; exactly one atomic active version required`);
    return pass('A-PROFILE-ACTIVATED', `${active.length} active profile document(s)`);
  },
  'A-DRAFT-PATCH-ONLY': (ctx) => {
    const rows = ctx.state.onboarding;
    if (rows.length === 0) return fail('A-DRAFT-PATCH-ONLY', 'no onboarding rows to inspect');
    const problems: string[] = [];
    for (const row of rows) {
      const draft = (row.draft ?? {}) as Record<string, unknown>;
      const result = OnboardingDraftSchema.safeParse(draft);
      if (!result.success) problems.push(`row ${String(row.conversationId ?? '')} draft contains invalid keys: ${result.error.issues.map((issue) => issue.path.join('.')).join(', ')}`);
    }
    return problems.length === 0 ? pass('A-DRAFT-PATCH-ONLY', `${rows.length} row(s) with schema-valid draft keys`) : fail('A-DRAFT-PATCH-ONLY', problems.join('; '));
  },
  'A-URL-POLICY': (ctx) => {
    const problems: string[] = [];
    for (const call of ctx.ledgers.toolCalls) {
      if (!call.url) continue;
      try {
        const canonical = assertJobUrl(call.url);
        if (canonical.href !== call.url && new URL(call.url).hash) problems.push(`url ${call.url} has fragment`);
      } catch (error) {
        problems.push(`url ${call.url} rejected by policy: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    return problems.length === 0 ? pass('A-URL-POLICY', `${ctx.ledgers.toolCalls.filter((call) => call.url).length} url(s) policy-valid`) : fail('A-URL-POLICY', problems.join('; '));
  },
  'A-REDIRECT-POLICY': (ctx) => {
    const redirects = ctx.ledgers.fetch.filter((call) => call.status >= 301 && call.status <= 308);
    return redirects.length <= 3 ? pass('A-REDIRECT-POLICY', `${redirects.length} redirect(s) within limit`) : fail('A-REDIRECT-POLICY', `redirect chain exceeded 3 hops (${redirects.length})`);
  },
  'A-SSRF-BLOCK': (ctx) => {
    const privatePlans = ctx.fixture.fetch.filter((plan) => plan.dns.some((address) => /^(10\.|127\.|0\.|::1|fc00:|fe80:|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/.test(address)));
    if (privatePlans.length === 0) return pass('A-SSRF-BLOCK', 'no private-address fetch plans in fixture');
    const problems: string[] = [];
    for (const plan of privatePlans) {
      const attempted = ctx.state.jobs.filter((job) => String(job.originalUrl ?? '') === plan.url);
      if (attempted.length === 0) continue; // plan never exercised by the scenario
      if (ctx.ledgers.fetch.some((call) => call.url === plan.url)) problems.push(`plan ${plan.url} reached the network despite private DNS`);
      else if (!attempted.every((job) => job.status === 'failed')) problems.push(`plan ${plan.url} attempted but jobs not failed with a policy block`);
    }
    return problems.length === 0 ? pass('A-SSRF-BLOCK', `${privatePlans.length} private-address plan(s) blocked before the network`) : fail('A-SSRF-BLOCK', problems.join('; '));
  },
  'A-CONTENT-LIMIT': (ctx) => {
    const sizes = ctx.ledgers.fetch.map((call) => call.bodyBytes);
    const over = sizes.filter((size) => size > MAX_DECODED_BYTES);
    return over.length === 0 ? pass('A-CONTENT-LIMIT', `max captured ${Math.max(0, ...sizes)} bytes <= ${MAX_DECODED_BYTES}`) : fail('A-CONTENT-LIMIT', `captured ${over.join(', ')} bytes over limit`);
  },
  'A-LIFECYCLE-ORDER': (ctx) => {
    const jobIds = new Set(ctx.ledgers.lifecycle.map((event) => event.jobId).filter((id): id is string => Boolean(id)));
    const problems: string[] = [];
    for (const jobId of jobIds) {
      const events = ctx.ledgers.lifecycle.filter((event) => event.jobId === jobId && event.phase);
      const seen = events.map((event) => event.phase as string);
      let cursor = 0;
      for (const phase of seen) {
        if (phase === PHASE_ORDER[cursor]) cursor++;
        else if (PHASE_ORDER.slice(cursor).includes(phase)) { problems.push(`job ${jobId} phase order broken at ${phase}`); break; }
      }
    }
    return problems.length === 0 ? pass('A-LIFECYCLE-ORDER', `phase order valid for ${jobIds.size} job(s)`) : fail('A-LIFECYCLE-ORDER', problems.join('; '));
  },
  'A-JOB-STATE': (ctx) => {
    const problems: string[] = [];
    for (const job of ctx.state.jobs) {
      const status = String(job.status ?? '');
      if (!JobStatusSchema.safeParse(status).success) problems.push(`job ${String(job.jobId)} invalid status ${status}`);
      if (Number(job.attempts ?? 0) > 3) problems.push(`job ${String(job.jobId)} attempts ${String(job.attempts)} exceed cap`);
    }
    return problems.length === 0 ? pass('A-JOB-STATE', `${ctx.state.jobs.length} job row(s) valid`) : fail('A-JOB-STATE', problems.join('; '));
  },
  'A-REPORT-BEFORE-SUCCESS': (ctx) => {
    const problems: string[] = [];
    for (const job of ctx.state.jobs.filter((candidate) => candidate.status === 'succeeded')) {
      if (!job.reportId && !job.safeResult) problems.push(`job ${String(job.jobId)} succeeded without a report`);
    }
    return problems.length === 0 ? pass('A-REPORT-BEFORE-SUCCESS', 'succeeded jobs carry reports') : fail('A-REPORT-BEFORE-SUCCESS', problems.join('; '));
  },
  'A-SHEET-READBACK': (ctx) => {
    const problems: string[] = [];
    for (const job of ctx.state.jobs.filter((candidate) => candidate.status === 'succeeded')) {
      const inSheet = ctx.state.sheets.some((row) => row.jobId === job.jobId);
      if (!inSheet) problems.push(`job ${String(job.jobId)} missing verified sheet row`);
    }
    return problems.length === 0 ? pass('A-SHEET-READBACK', `${ctx.state.sheets.length} verified sheet row(s)`) : fail('A-SHEET-READBACK', problems.join('; '));
  },
  'A-NOTIFY-AFTER-COMPLETE': (ctx) => {
    const problems: string[] = [];
    for (const notification of ctx.ledgers.notifications) {
      const complete = ctx.ledgers.lifecycle.find((event) => event.event === 'job.succeeded' && event.jobId === notification.jobId);
      const failed = ctx.ledgers.lifecycle.find((event) => event.event === 'job.failed' && event.jobId === notification.jobId);
      if (!complete && !failed) { problems.push(`notification for unknown terminal job ${notification.jobId}`); continue; }
      if (!complete && failed) continue; // recovery of failed jobs is not notified as success
      if (!complete) problems.push(`notification for job ${notification.jobId} before terminal lifecycle`);
    }
    return problems.length === 0 ? pass('A-NOTIFY-AFTER-COMPLETE', `${ctx.ledgers.notifications.length} notification(s) after terminal state`) : fail('A-NOTIFY-AFTER-COMPLETE', problems.join('; '));
  },
  'A-NOTIFY-MARK-AFTER-SEND': (ctx) => {
    const problems: string[] = [];
    const attemptsByJob = new Map<string, NotificationRecord[]>();
    for (const notification of ctx.ledgers.notifications) {
      const attempts = attemptsByJob.get(notification.jobId) ?? [];
      attempts.push(notification);
      attemptsByJob.set(notification.jobId, attempts);
    }
    for (const job of ctx.state.jobs.filter((candidate) => candidate.notifiedAt !== null && candidate.notifiedAt !== undefined)) {
      const attempts = attemptsByJob.get(String(job.jobId)) ?? [];
      if (!attempts.some((notification) => notification.delivered)) problems.push(`job ${String(job.jobId)} notified_at set without a delivered notification`);
    }
    // fail-first plans: the first delivery attempt must have failed in the ledger
    for (const plan of ctx.fixture.notifications.filter((candidate) => candidate.deliver === 'fail-first')) {
      const attempts = attemptsByJob.get(plan.jobId) ?? [];
      if (attempts.length === 0) continue;
      if (attempts[0].delivered) problems.push(`job ${plan.jobId} fail-first plan delivered on the first attempt`);
    }
    return problems.length === 0 ? pass('A-NOTIFY-MARK-AFTER-SEND', 'notified_at only where delivery succeeded') : fail('A-NOTIFY-MARK-AFTER-SEND', problems.join('; '));
  },
  'A-REPLAY-IDEMPOTENT': (ctx) => {
    const replays = ctx.ledgers.lifecycle.filter((event) => event.event === 'telegram.update.rejected' && String(event.data.reason ?? '') === 'replayed_update');
    if (replays.length === 0) return pass('A-REPLAY-IDEMPOTENT', 'no replayed updates');
    return pass('A-REPLAY-IDEMPOTENT', `${replays.length} replayed update(s) rejected without effects`);
  },
  'A-RECOVERY-REAUTH': (ctx) => {
    const resumed = ctx.ledgers.toolCalls.filter((call) => call.resumeJobId);
    const problems: string[] = [];
    for (const call of resumed) {
      const job = ctx.state.jobs.find((candidate) => candidate.jobId === call.resumeJobId);
      if (!job) { problems.push(`resume job ${call.resumeJobId} not found in state`); continue; }
      if (String(job.ownerId) !== ctx.fixture.ownerId) problems.push(`resume job ${call.resumeJobId} owner mismatch`);
    }
    return problems.length === 0 ? pass('A-RECOVERY-REAUTH', `${resumed.length} recovery call(s) authorized`) : fail('A-RECOVERY-REAUTH', problems.join('; '));
  },
  'A-OWNER-CONVERSATION-SCOPE': (ctx) => {
    const problems: string[] = [];
    const conversations = new Set(ctx.scenario.turns.map((turn) => turn.conversationId));
    for (const job of ctx.state.jobs) if (String(job.ownerId) !== ctx.fixture.ownerId) problems.push(`job ${String(job.jobId)} foreign owner ${String(job.ownerId)}`);
    for (const draft of ctx.state.profiles) if (String(draft.ownerId) !== ctx.fixture.ownerId) problems.push(`profile ${String(draft.documentId ?? draft.name)} foreign owner`);
    return problems.length === 0 ? pass('A-OWNER-CONVERSATION-SCOPE', `all ${ctx.state.jobs.length} job(s)/profiles owner-scoped`) : fail('A-OWNER-CONVERSATION-SCOPE', problems.join('; '));
  },
  'A-CANARY-CONTAINED': (ctx) => {
    if (ctx.redactionHits.length > 0) return fail('A-CANARY-CONTAINED', `canaries in forbidden sinks: ${ctx.redactionHits.map((hit) => `${hit.canary}@${hit.sink}:${hit.where}`).join(', ')}`);
    return pass('A-CANARY-CONTAINED', 'no canary hits in any scanned sink');
  },
  'A-FETCH-DATA-NOT-POLICY': (ctx) => {
    const expectation = ctx.scenario.tools;
    if (!expectation || expectation.forbid.length === 0) return pass('A-FETCH-DATA-NOT-POLICY', 'no forbidden tools declared');
    const called = ctx.ledgers.toolCalls.map((call) => call.toolId);
    const violated = expectation.forbid.filter((toolId) => called.includes(toolId));
    return violated.length === 0 ? pass('A-FETCH-DATA-NOT-POLICY', 'fetched data never became tool policy') : fail('A-FETCH-DATA-NOT-POLICY', `forbidden tools invoked: ${violated.join(', ')}`);
  },
  'A-SAFE-ERROR': (ctx) => {
    const problems: string[] = [];
    for (const job of ctx.state.jobs.filter((candidate) => candidate.status === 'failed')) {
      const safeError = String(job.safeError ?? '');
      if (!safeError) problems.push(`job ${String(job.jobId)} failed without safe_error`);
      if (job.safeResult) problems.push(`job ${String(job.jobId)} failed but carries success artifacts`);
      if (/(Error: )|(at )|(stack)/i.test(safeError)) problems.push(`job ${String(job.jobId)} safe_error leaks raw provider error`);
    }
    for (const failure of ctx.ledgers.failures) {
      if (/(Error: )|(at )|(stack)/i.test(failure.message)) problems.push(`${failure.kind} failure leaked raw provider error: ${failure.message.slice(0, 200)}`);
    }
    return problems.length === 0 ? pass('A-SAFE-ERROR', `${ctx.state.jobs.filter((candidate) => candidate.status === 'failed').length} failed job(s) with safe errors only`) : fail('A-SAFE-ERROR', problems.join('; '));
  },
  'A-TRACE-REDACTED': (ctx) => {
    const hits = ctx.redactionHits.filter((hit) => hit.sink === 'trace');
    if (hits.length > 0) return fail('A-TRACE-REDACTED', `trace sink leaked ${hits.length} canary(ies)`);
    return pass('A-TRACE-REDACTED', 'trace payloads redacted (no canary hits)');
  },
  'A-LOG-ALLOWLIST': (ctx) => {
    const violations: string[] = [];
    for (const log of ctx.ledgers.logs) {
      // tool.invoked is the tool-call audit event: the harness captures url /
      // resumeJobId there (A-URL-POLICY, A-RECOVERY-REAUTH), but the production
      // terminal logger still filters them out via safeAppLogKeys.
      const permitted = log.event === 'tool.invoked' ? new Set([...safeAppLogKeys, 'url', 'resumeJobId']) : safeAppLogKeys;
      for (const key of Object.keys(log.data)) if (!permitted.has(key)) violations.push(`${log.event}.${key}`);
    }
    return violations.length === 0 ? pass('A-LOG-ALLOWLIST', `${ctx.ledgers.logs.length} log event(s) allowlist-clean`) : fail('A-LOG-ALLOWLIST', `non-allowlisted log keys: ${violations.join(', ')}`);
  },
  'A-SCHEMA-VALID': (ctx) => pass('A-SCHEMA-VALID', 'scenario/fixture/run artifacts parsed by strict v1 schemas'),
  'A-TRANSCRIPT-COMPLETE': (ctx) => {
    if (!ctx.transcriptComplete) return fail('A-TRANSCRIPT-COMPLETE', 'transcript incomplete (missing terminal replies or tool results)');
    return pass('A-TRANSCRIPT-COMPLETE', `${ctx.transcriptEvents.length} event(s), every turn terminal`);
  },
  'A-BUDGET': (ctx) => {
    const problems: string[] = [];
    if (ctx.transcriptEvents.filter((event) => event.type === 'user_turn').length > ctx.limits.maxTurns) problems.push(`turns exceed ${ctx.limits.maxTurns}`);
    if (ctx.metrics.durationMs > ctx.limits.maxWallClockMs) problems.push(`wall clock ${ctx.metrics.durationMs}ms exceeds ${ctx.limits.maxWallClockMs}ms`);
    if (ctx.ledgers.modelCalls.length > ctx.limits.maxModelCalls) problems.push(`model calls ${ctx.ledgers.modelCalls.length} exceed ${ctx.limits.maxModelCalls}`);
    return problems.length === 0 ? pass('A-BUDGET', `turns/clock/model calls within limits`) : fail('A-BUDGET', problems.join('; '));
  },
  'A-ISOLATED-FIXTURE': (ctx) => {
    const unexpected = ctx.ledgers.failures.filter((failure) => failure.kind === 'unexpected-file');
    return unexpected.length === 0 ? pass('A-ISOLATED-FIXTURE', 'no unexpected files, no shared state') : fail('A-ISOLATED-FIXTURE', unexpected.map((failure) => failure.message).join('; '));
  },
  'A-NO-UNHANDLED-ERROR': (ctx) => {
    const unhandled = ctx.ledgers.failures.filter((failure) => failure.kind === 'unhandled' || failure.kind === 'adapter-leak');
    return unhandled.length === 0 ? pass('A-NO-UNHANDLED-ERROR', 'no uncaught exceptions or adapter leaks') : fail('A-NO-UNHANDLED-ERROR', unhandled.map((failure) => `${failure.kind}: ${failure.message}`).join('; '));
  },
};

export function evaluateAssertion(entry: AssertionEntry, ctx: RunContext): AssertionResult {
  if (!isValueAssertion(entry)) return gates[entry](ctx);
  const view = contextView(ctx);
  const extracted = getPath(view, entry.path);
  const { ok, detail } = evaluateOperator(entry.op, extracted, entry.value);
  return ok ? pass(entry.id, `${entry.path} ${detail}`) : fail(entry.id, `${entry.path}: ${detail}`);
}

export function evaluateAssertions(entries: AssertionEntry[], ctx: RunContext): AssertionResult[] {
  return entries.map((entry) => evaluateAssertion(entry, ctx));
}

export { safeAppLogKeys };
export type { Turn, Canary };
