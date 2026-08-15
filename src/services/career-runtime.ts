import { createCareerToolContext } from '../tools/career-context.ts';
import { assertRawTelegramUpdate, deriveTelegramRequest, type PrincipalInput } from '../channels/telegram-auth.ts';
import { CareerStore } from '../storage/career-store.ts';
import type { Job } from '../contracts/v0.ts';
import { OnboardingDecisionSchema, assertSafeOnboardingDraft, isDirectIdentifierOnboardingInput, isUnavailableOnboardingInput, nextOnboardingQuestion, onboardingFieldFromLabel, onboardingFields, onboardingMissingFields, onboardingReviewText, requiredOnboardingComplete, type OnboardingDecision, type OnboardingDraft, type OnboardingStatus } from '../contracts/onboarding.ts';
import type { AppLogger } from '../observability.ts';

export type Command = { kind: 'save'; url: string } | { kind: 'job'; jobId?: string } | { kind: 'queue' } | { kind: 'onboarding'; action: 'start' | 'restart' | 'cancel' };
const unavailableOnboardingReply = 'Resume, URL, and file ingestion are unavailable in V1. Please answer the current structured question instead.';
const longOnboardingReply = 'That onboarding answer is too long (maximum 4000 characters). Please shorten it and try again.';
const onboardingModelRetryReply = 'I could not safely process that onboarding reply. Please try again with a short text answer.';
const directIdentifierOnboardingReply = 'That looks like direct personal identifier or credential information, which onboarding cannot accept. Please share only career-relevant facts.';
export function parseCommand(text: string | undefined): Command | null {
  if (!text) return null; const trimmed = text.trim();
  const onboarding = trimmed.match(/^\/onboarding(?:[ \t]+(restart|cancel|start))?$/i); if (onboarding) return { kind: 'onboarding', action: onboarding[1]?.toLowerCase() === 'restart' ? 'restart' : onboarding[1]?.toLowerCase() === 'cancel' ? 'cancel' : 'start' };
  const save = trimmed.match(/^\/save[ \t]+(\S+)$/); if (save) return { kind: 'save', url: save[1] }; const job = trimmed.match(/^\/job(?:[ \t]+(\S+))?$/); if (job) return { kind: 'job', ...(job[1] ? { jobId: job[1] } : {}) }; if (trimmed === '/queue') return { kind: 'queue' }; return null;
}
export function injectCommand(text: string) { const command = parseCommand(text); if (command?.kind === 'onboarding') throw new Error('Onboarding is handled by runtime routing, not normal memory injection.'); if (command?.kind === 'save') return `Save this job now: ${command.url}. Use the save-job tool after you have enough profile context; otherwise ask the owner for the missing context.`; if (command?.kind === 'job') return `Report the status of ${command.jobId ? `job ${command.jobId}` : 'the latest job'} using the job-status tool.`; if (command?.kind === 'queue') return 'List my saved jobs using the job-queue tool.'; return text; }

const onboardingReply = (state: Awaited<ReturnType<CareerStore['loadOnboarding']>>) => state?.status === 'review' ? onboardingReviewText(state.draft) : `Let's build your career profile. ${nextOnboardingQuestion(state?.draft ?? {}) ?? 'Share any final preference, or say ready to review.'}`;

export type OnboardingResponderInput = { ownerId: string; conversationId: string; draft: OnboardingDraft; fields: typeof onboardingFields; missingFields: string[]; status: Extract<OnboardingStatus, 'collecting' | 'review'>; text: string };
export type OnboardingResponder = (input: OnboardingResponderInput) => Promise<OnboardingDecision>;

function onboardingPrompt(input: OnboardingResponderInput) {
  return `You are collecting a private career onboarding profile. Return only the requested JSON object.\n\nRules:\n- Be conversational and helpful in reply.\n- Answer clarifying/off-topic questions naturally without changing draftPatch unless the user clearly provided profile facts.\n- Extract zero, one, or multiple clearly stated fields. Corrections should patch only the fields being corrected.\n- Ask one useful follow-up question for the most important missing required field.\n- Never invent facts.\n- Never request or accept resumes, files, uploads, URLs, legal name, exact birth date, street address, email, phone, government IDs, financial data, credentials, or tokens.\n- Set readyForReview true only when required fields are complete from the existing draft plus this patch and the user seems ready to review.\n- Do not include confirmation, authorization, activation, owner, chat, user, memory, or tool fields.\n\nCurrent structured draft JSON:\n${JSON.stringify(input.draft)}\n\nAllowed field definitions JSON:\n${JSON.stringify(input.fields.map(({ key, label, question, required }) => ({ key, label, question, required })))}\n\nMissing required fields JSON:\n${JSON.stringify(input.missingFields)}\n\nState JSON:\n${JSON.stringify({ status: input.status })}\n\nCurrent owner text:\n${input.text}`;
}

export function createOnboardingResponder(agent: { generate: (text: string, options: Record<string, unknown>) => Promise<{ object?: unknown; text?: string }> }): OnboardingResponder {
  return async (input) => {
    const result = await agent.generate(onboardingPrompt(input), { memory: { resource: input.ownerId, thread: input.conversationId }, structuredOutput: { schema: OnboardingDecisionSchema, jsonPromptInjection: 'inline' }, toolChoice: 'none', maxSteps: 1 });
    return OnboardingDecisionSchema.parse((result as { object?: unknown }).object);
  };
}

async function runOnboardingResponder(input: { onboard?: OnboardingResponder; ownerId: string; conversationId: string; draft: OnboardingDraft; status: Extract<OnboardingStatus, 'collecting' | 'review'>; text: string; logger: AppLogger }) {
  if (!input.onboard) { input.logger('error', 'onboarding.model.failed', { errorName: 'MissingOnboardingResponder' }); return onboardingModelRetryReply; }
  try {
    input.logger('info', 'onboarding.model.started', { status: input.status, missingFields: onboardingMissingFields(input.draft) });
    const decision = await input.onboard({ ownerId: input.ownerId, conversationId: input.conversationId, draft: input.draft, fields: onboardingFields, missingFields: onboardingMissingFields(input.draft), status: input.status, text: input.text });
    input.logger('info', 'onboarding.model.succeeded', { status: input.status, fieldKeys: Object.keys(decision.draftPatch), readyForReview: decision.readyForReview });
    return decision;
  } catch (error) { input.logger('error', 'onboarding.model.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); return onboardingModelRetryReply; }
}

async function applyOnboardingDecision(input: { store: CareerStore; ownerId: string; conversationId: string; logger: AppLogger }, state: NonNullable<Awaited<ReturnType<CareerStore['loadOnboarding']>>>, decision: OnboardingDecision) {
  const parsed = OnboardingDecisionSchema.parse(decision);
  try { assertSafeOnboardingDraft(parsed.draftPatch); } catch { input.logger('warn', 'onboarding.input.blocked', { reason: 'direct_identifier', status: state.status }); return directIdentifierOnboardingReply; }
  const patch = parsed.draftPatch; const fieldKeys = Object.keys(patch); const merged = { ...state.draft, ...patch };
  const reviewReady = parsed.readyForReview && requiredOnboardingComplete(merged);
  if (state.status === 'review') {
    if (fieldKeys.length === 0) return parsed.reply;
    const saved = await input.store.saveOnboardingDraft({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version, draft: patch, status: 'review' });
    input.logger('info', 'onboarding.draft.saved', { status: saved.status, version: saved.version, fieldKeys, missingFields: onboardingMissingFields(saved.draft) });
    return `${parsed.reply}\n\n${onboardingReviewText(saved.draft)}`;
  }
  if (fieldKeys.length === 0) {
    if (!reviewReady) return parsed.reply;
    const saved = await input.store.saveOnboardingDraft({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version, draft: {}, status: 'review' });
    input.logger('info', 'onboarding.review.ready', { status: saved.status, version: saved.version, fieldKeys, missingFields: onboardingMissingFields(saved.draft) });
    return `${parsed.reply}\n\n${onboardingReviewText(saved.draft)}`;
  }
  const status = reviewReady ? 'review' : 'collecting';
  const saved = await input.store.saveOnboardingDraft({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version, draft: patch, status });
  input.logger('info', status === 'review' ? 'onboarding.review.ready' : 'onboarding.draft.saved', { status: saved.status, version: saved.version, fieldKeys, missingFields: onboardingMissingFields(saved.draft) });
  return status === 'review' ? `${parsed.reply}\n\n${onboardingReviewText(saved.draft)}` : parsed.reply;
}

export async function handleOnboardingTurn(input: { store: CareerStore; ownerId: string; conversationId: string; text?: string; nonTextInput?: boolean; onboard?: OnboardingResponder; logger?: AppLogger }) {
  const log: AppLogger = (level, event, data) => { try { input.logger?.(level, event, data); } catch { /* logging cannot break work */ } };
  const command = parseCommand(input.text);
  if (command?.kind === 'onboarding') {
    if (command.action === 'cancel') { const state = await input.store.loadOnboarding(input.ownerId, input.conversationId); if (!state || !['collecting', 'review'].includes(state.status)) return 'No active onboarding to cancel.'; await input.store.cancelOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version }); log('info', 'onboarding.cancelled', { status: 'cancelled', version: state.version + 1 }); return 'Onboarding cancelled and draft content cleared. Send /onboarding to start again.'; }
    const state = await input.store.startOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, restart: command.action === 'restart' }); log('info', 'onboarding.started', { status: state.status, version: state.version }); return onboardingReply(state);
  }
  const state = await input.store.loadOnboarding(input.ownerId, input.conversationId); if (!state || (state.status !== 'collecting' && state.status !== 'review')) return null;
  if (input.nonTextInput) { log('warn', 'onboarding.input.blocked', { reason: 'non_text', status: state.status }); return unavailableOnboardingReply; }
  const trimmed = input.text?.trim(); if (!trimmed) return null;
  if (/^\/?cancel$/i.test(trimmed)) { await input.store.cancelOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version }); log('info', 'onboarding.cancelled', { status: 'cancelled', version: state.version + 1 }); return 'Onboarding cancelled and draft content cleared. Send /onboarding to start again.'; }
  if (trimmed.startsWith('/')) { log('warn', 'onboarding.input.blocked', { reason: 'command', status: state.status }); return 'Please finish or cancel onboarding before using commands.'; }
  if (trimmed.length > 4000) { log('warn', 'onboarding.input.blocked', { reason: 'overlength', status: state.status }); return longOnboardingReply; }
  if (isUnavailableOnboardingInput(trimmed)) { log('warn', 'onboarding.input.blocked', { reason: 'unavailable_input', status: state.status }); return unavailableOnboardingReply; }
  if (isDirectIdentifierOnboardingInput(trimmed)) { log('warn', 'onboarding.input.blocked', { reason: 'direct_identifier', status: state.status }); return directIdentifierOnboardingReply; }
  if (state.status === 'review') {
    if (/^confirm$/i.test(trimmed)) { await input.store.completeOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version }); log('info', 'onboarding.completed', { status: 'completed', version: state.version }); return 'Onboarding complete. Your confirmed profile is active now.'; }
    const edit = trimmed.match(/^edit\s+([^:]+):\s*(.+)$/i); if (edit) { const key = onboardingFieldFromLabel(edit[1]); if (!key) return `Unknown field. Edit one of: ${onboardingFields.map((field) => field.key).join(', ')}.`; const saved = await input.store.saveOnboardingDraft({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version, draft: { [key]: edit[2].trim() }, status: 'review' }); log('info', 'onboarding.draft.saved', { status: saved.status, version: saved.version, fieldKeys: [key] }); return onboardingReviewText(saved.draft); }
  }
  const decision = await runOnboardingResponder({ onboard: input.onboard, ownerId: input.ownerId, conversationId: input.conversationId, draft: state.draft, status: state.status, text: trimmed, logger: (level, event, data) => log(level, event, { version: state.version, ...data }) });
  return typeof decision === 'string' ? decision : applyOnboardingDecision({ store: input.store, ownerId: input.ownerId, conversationId: input.conversationId, logger: log }, state, decision);
}

export type AgentTurn = { text: string; channel: PrincipalInput['channel']; actorId: string; conversationId: string; requestId: string; resumeJobId?: string };
export function createAgentResponder(agent: { generate: (text: string, options: Record<string, unknown>) => Promise<{ text?: string }> }, ownerId: string, logger?: AppLogger) {
  const log: AppLogger = (level, event, data) => { try { logger?.(level, event, data); } catch { /* logging cannot break agent turns */ } };
  return async (turn: AgentTurn) => {
    const started = Date.now(); const scope = (id: string) => `${turn.channel}:${id}`;
    const requestContext = createCareerToolContext({ ownerId, actorId: scope(turn.actorId), conversationId: scope(turn.conversationId), requestId: scope(turn.requestId), ...(turn.resumeJobId ? { resumeJobId: turn.resumeJobId } : {}) });
    log('info', 'agent.turn.started', { requestId: turn.requestId, phase: turn.resumeJobId ? 'recovery' : 'normal' });
    try {
      const result = await agent.generate(turn.text, { memory: { resource: ownerId, thread: scope(turn.conversationId) }, requestContext, maxSteps: 8 });
      log('info', 'agent.turn.succeeded', { requestId: turn.requestId, phase: turn.resumeJobId ? 'recovery' : 'normal', durationMs: Date.now() - started });
      return result.text?.trim() || 'Done.';
    } catch (error) { log('error', 'agent.turn.failed', { requestId: turn.requestId, phase: turn.resumeJobId ? 'recovery' : 'normal', durationMs: Date.now() - started, errorName: error instanceof Error ? error.name : 'UnknownError' }); throw error; }
  };
}

export type RuntimeOptions = { ownerId: string; ownerEnabled?: boolean; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string>; databaseUrl?: string; store?: CareerStore; respond: (turn: AgentTurn) => Promise<string>; onboard?: OnboardingResponder; logger?: AppLogger };
export type TelegramResult = { outcome: 'rejected'; reason: string } | { outcome: 'accepted'; command: string };
type RecoveryReply = (text: string, chatId?: string) => Promise<void>;
type CachedTelegramReply = { text: string; result: TelegramResult; updateId: number; requestId: string; notifyJobId?: string };

export function createCareerCopilotRuntime(options: RuntimeOptions) {
  if (!options.store && !options.databaseUrl) throw new Error('Career runtime requires an explicit store or databaseUrl.');
  const store = options.store ?? new CareerStore(options.databaseUrl!);
  const seenUpdates = new Set<number>(); const cachedReplies = new Map<number, CachedTelegramReply>(); let recoveryPromise: Promise<void> | null = null; let turnQueue = Promise.resolve(); let active = false;
  const authorized = (userId: string, chatId: string, privateChat: boolean) => (options.ownerEnabled ?? true) && privateChat && options.allowedUserIds.has(userId) && options.privateChatIds.has(chatId);
  const telegramId = (id: string) => id.startsWith('telegram:') ? id.slice(9) : id;
  const reauthorized = (job: Job) => (options.ownerEnabled ?? true) && job.ownerId === options.ownerId && job.userId !== null && options.allowedUserIds.has(telegramId(job.userId)) && options.privateChatIds.has(telegramId(job.chatId));
  const log: AppLogger = (level, event, data) => { try { options.logger?.(level, event, data); } catch { /* logging cannot break work */ } };
  const enqueueTurn = <T>(fn: () => Promise<T>) => { const result = turnQueue.then(async () => { active = true; try { return await fn(); } finally { active = false; } }); turnQueue = result.then(() => undefined, () => undefined); return result; };
  const respond = (turn: AgentTurn) => enqueueTurn(() => options.respond(turn));
  const sendCachedReply = async (cached: CachedTelegramReply, reply: (text: string) => Promise<void>) => {
    await reply(cached.text);
    if (cached.notifyJobId) await store.markNotified(cached.notifyJobId);
    seenUpdates.add(cached.updateId); cachedReplies.delete(cached.updateId);
    log('info', 'telegram.update.accepted', { updateId: cached.updateId, requestId: cached.requestId, command: cached.result.outcome === 'accepted' ? cached.result.command : undefined, phase: 'cached' });
    return cached.result;
  };

  const handleTelegramUpdate = async (raw: unknown, reply: (text: string) => Promise<void> = async () => {}): Promise<TelegramResult> => {
    await store.ready();
    try { assertRawTelegramUpdate(raw); } catch { log('warn', 'telegram.update.rejected', { reason: 'invalid_update' }); return { outcome: 'rejected', reason: 'invalid_update' }; }
    const message = raw.message ?? raw.edited_message ?? raw.channel_post ?? raw.edited_channel_post; const request = deriveTelegramRequest(raw); const command = parseCommand(message?.text);
    if (!authorized(request.userId, request.chatId, request.isPrivateChat) || request.isBot || request.isEdited || request.isForwarded) { log('warn', 'telegram.update.rejected', { updateId: raw.update_id, reason: 'unauthorized' }); return { outcome: 'rejected', reason: 'unauthorized' }; }
    const transportEventId = String(raw.update_id); const scoped = (id: string) => `telegram:${id}`; const conversationId = scoped(request.chatId); const hasText = Boolean(message?.text?.trim());
    const nonTextInput = Boolean(message && !hasText);
    return enqueueTurn(async () => {
      const cached = cachedReplies.get(raw.update_id); if (cached) return sendCachedReply(cached, reply);
      if (seenUpdates.has(raw.update_id)) { log('warn', 'telegram.update.rejected', { updateId: raw.update_id, reason: 'replayed_update' }); return { outcome: 'rejected', reason: 'replayed_update' }; }
      const onboardingResponse = await handleOnboardingTurn({ store, ownerId: options.ownerId, conversationId, text: message?.text, nonTextInput, onboard: options.onboard, logger: log });
      if (onboardingResponse) { const result: TelegramResult = { outcome: 'accepted', command: 'onboarding' }; cachedReplies.set(raw.update_id, { text: onboardingResponse, result, updateId: raw.update_id, requestId: transportEventId }); await reply(onboardingResponse); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id); log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: 'onboarding' }); return result; }
      if (!hasText) { log('warn', 'telegram.update.rejected', { updateId: raw.update_id, reason: 'invalid_message' }); return { outcome: 'rejected', reason: 'invalid_message' }; }
      const appCommand = command?.kind ?? 'chat'; log('info', 'command.received', { updateId: raw.update_id, requestId: transportEventId, command: appCommand });
      const response = await options.respond({ text: injectCommand(message!.text!), channel: 'telegram', actorId: request.userId, conversationId: request.chatId, requestId: transportEventId });
      const completed = await store.getByTransportEventId(scoped(transportEventId)) ?? await store.getByTransportEventId(transportEventId);
      const notifyJobId = completed?.status === 'succeeded' && completed.ownerId === options.ownerId && completed.userId !== null && telegramId(completed.userId) === request.userId && telegramId(completed.chatId) === request.chatId ? completed.jobId : undefined;
      let text = response;
      if (notifyJobId && completed && completed.reportId) { const report = await store.getReport(completed.reportId, options.ownerId); if (report) text = report.content; } // deliver the exact persisted report; agent response only when the report row is missing (pre-report legacy data)
      const result: TelegramResult = { outcome: 'accepted', command: appCommand };
      cachedReplies.set(raw.update_id, { text, result, updateId: raw.update_id, requestId: transportEventId, ...(notifyJobId ? { notifyJobId } : {}) });
      await reply(text); if (notifyJobId) await store.markNotified(notifyJobId); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id);
      log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: appCommand });
      return result;
    });
  };

  const recoverUnfinished = async (reply: RecoveryReply, settings: { notify?: boolean } = {}) => {
    if (recoveryPromise) return recoveryPromise;
    const notify = settings.notify ?? true;
    recoveryPromise = (async () => {
      await store.ready();
      const unfinished = await store.unfinished(); log('info', 'recovery.started', { unfinishedJobs: unfinished.length });
      for (const job of unfinished) if (reauthorized(job)) {
        try {
          const response = await respond({ text: `Resume saving the previously persisted job ${job.originalUrl}. Use the save-job tool with the profile context already in memory.`, channel: 'telegram', actorId: telegramId(job.userId!), conversationId: telegramId(job.chatId), requestId: telegramId(job.transportEventId), resumeJobId: job.jobId });
          if (notify) { const current = await store.get(job.jobId); let text = current?.safeResult?.summary ?? response; if (current?.status === 'succeeded' && current.reportId) { const report = await store.getReport(current.reportId, options.ownerId); if (report) text = report.content; } await reply(text, telegramId(job.chatId)); if (current?.status === 'succeeded') await store.markNotified(job.jobId); }
        } catch (error) { if ((await store.get(job.jobId))?.status !== 'succeeded') await store.fail(job.jobId, error); log('error', 'job.failed', { jobId: job.jobId, phase: 'recovery', errorName: error instanceof Error ? error.name : 'UnknownError' }); }
      }
      log('info', 'recovery.completed', { unfinishedJobs: unfinished.length });
      if (!notify) return;
      for (const job of await store.list('succeeded')) if (!job.notifiedAt && reauthorized(job)) {
        try { let text = job.safeResult?.summary ?? 'Job completed.'; if (job.reportId) { const report = await store.getReport(job.reportId, options.ownerId); if (report) text = report.content; } await reply(text, telegramId(job.chatId)); await store.markNotified(job.jobId); log('info', 'job.notification.sent', { jobId: job.jobId, recovery: true }); } catch { log('warn', 'job.notification.failed', { jobId: job.jobId, recovery: true }); }
      }
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  };
  return { store, handleTelegramUpdate, recoverUnfinished, health: () => ({ configurationValid: Boolean(options.ownerId) && (options.ownerEnabled ?? true), databaseOpen: true, processorRunning: active }), close: async () => { if (!options.store) await store.close(); } };
}
