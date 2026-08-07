import { createCareerToolContext } from '../tools/career-context.ts';
import { assertRawTelegramUpdate, deriveTelegramRequest, type PrincipalInput } from '../channels/telegram-auth.ts';
import { CareerStore } from '../storage/career-store.ts';
import type { Job } from '../contracts/v0.ts';

type Command = { kind: 'save'; url: string } | { kind: 'job'; jobId?: string } | { kind: 'queue' };
export function parseCommand(text: string | undefined): Command | null { if (!text) return null; const save = text.match(/^\/save[ \t]+(\S+)$/); if (save) return { kind: 'save', url: save[1] }; const job = text.match(/^\/job(?:[ \t]+(\S+))?$/); if (job) return { kind: 'job', ...(job[1] ? { jobId: job[1] } : {}) }; if (text === '/queue') return { kind: 'queue' }; return null; }
export function injectCommand(text: string) { const command = parseCommand(text); if (command?.kind === 'save') return `Save this job now: ${command.url}. Use the save-job tool after you have enough profile context; otherwise ask the owner for the missing context.`; if (command?.kind === 'job') return `Report the status of ${command.jobId ? `job ${command.jobId}` : 'the latest job'} using the job-status tool.`; if (command?.kind === 'queue') return 'List my saved jobs using the job-queue tool.'; return text; }

export type AgentTurn = { text: string; channel: PrincipalInput['channel']; actorId: string; conversationId: string; requestId: string; resumeJobId?: string };
export function createAgentResponder(agent: { generate: (text: string, options: Record<string, unknown>) => Promise<{ text?: string }> }, ownerId: string) {
  return async (turn: AgentTurn) => {
    const scope = (id: string) => `${turn.channel}:${id}`;
    const requestContext = createCareerToolContext({ ownerId, actorId: scope(turn.actorId), conversationId: scope(turn.conversationId), requestId: scope(turn.requestId), ...(turn.resumeJobId ? { resumeJobId: turn.resumeJobId } : {}) });
    const result = await agent.generate(turn.text, { memory: { resource: ownerId, thread: scope(turn.conversationId) }, requestContext, maxSteps: 8 });
    return result.text?.trim() || 'Done.';
  };
}

export type RuntimeOptions = { ownerId: string; ownerEnabled?: boolean; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string>; databaseUrl?: string; store?: CareerStore; respond: (turn: AgentTurn) => Promise<string>; observe?: (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => void };
export type TelegramResult = { outcome: 'rejected'; reason: string } | { outcome: 'accepted'; command: string };
type RecoveryReply = (text: string, chatId?: string) => Promise<void>;

export function createCareerCopilotRuntime(options: RuntimeOptions) {
  const store = options.store ?? new CareerStore(options.databaseUrl ?? `file:/tmp/career-copilot-${process.pid}.db`);
  const seenUpdates = new Set<number>(); let recoveryPromise: Promise<void> | null = null; let turnQueue = Promise.resolve(); let active = false;
  const authorized = (userId: string, chatId: string, privateChat: boolean) => (options.ownerEnabled ?? true) && privateChat && options.allowedUserIds.has(userId) && options.privateChatIds.has(chatId);
  const telegramId = (id: string) => id.startsWith('telegram:') ? id.slice(9) : id;
  const reauthorized = (job: Job) => (options.ownerEnabled ?? true) && job.ownerId === options.ownerId && job.userId !== null && options.allowedUserIds.has(telegramId(job.userId)) && options.privateChatIds.has(telegramId(job.chatId));
  const observe = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => { try { options.observe?.(level, event, data); } catch { /* observability cannot break work */ } };
  const respond = (turn: AgentTurn) => { const result = turnQueue.then(async () => { active = true; try { return await options.respond(turn); } finally { active = false; } }); turnQueue = result.then(() => undefined, () => undefined); return result; };

  const handleTelegramUpdate = async (raw: unknown, reply: (text: string) => Promise<void> = async () => {}): Promise<TelegramResult> => {
    try { assertRawTelegramUpdate(raw); } catch { return { outcome: 'rejected', reason: 'invalid_update' }; }
    const message = raw.message ?? raw.edited_message ?? raw.channel_post ?? raw.edited_channel_post; const request = deriveTelegramRequest(raw); const command = parseCommand(message?.text);
    if (!authorized(request.userId, request.chatId, request.isPrivateChat) || request.isBot || request.isEdited || request.isForwarded) return { outcome: 'rejected', reason: 'unauthorized' };
    if (seenUpdates.has(raw.update_id)) return { outcome: 'rejected', reason: 'replayed_update' };
    if (!message?.text?.trim()) return { outcome: 'rejected', reason: 'invalid_message' };
    const transportEventId = String(raw.update_id); const response = await respond({ text: injectCommand(message.text), channel: 'telegram', actorId: request.userId, conversationId: request.chatId, requestId: transportEventId });
    const scoped = (id: string) => `telegram:${id}`;
    await reply(response); const completed = store.getByTransportEventId(scoped(transportEventId)) ?? store.getByTransportEventId(transportEventId); if (completed?.status === 'succeeded' && completed.ownerId === options.ownerId && completed.userId !== null && telegramId(completed.userId) === request.userId && telegramId(completed.chatId) === request.chatId) store.markNotified(completed.jobId); seenUpdates.add(raw.update_id);
    return { outcome: 'accepted', command: command?.kind ?? 'chat' };
  };

  const recoverUnfinished = async (reply: RecoveryReply, settings: { notify?: boolean } = {}) => {
    if (recoveryPromise) return recoveryPromise;
    const notify = settings.notify ?? true;
    recoveryPromise = (async () => {
      const unfinished = store.unfinished(); observe('info', 'recovery.started', { unfinishedJobs: unfinished.length });
      for (const job of unfinished) if (reauthorized(job)) {
        try {
          const response = await respond({ text: `Resume saving the previously persisted job ${job.originalUrl}. Use the save-job tool with the profile context already in memory.`, channel: 'telegram', actorId: telegramId(job.userId!), conversationId: telegramId(job.chatId), requestId: telegramId(job.transportEventId), resumeJobId: job.jobId });
          if (notify) { const current = store.get(job.jobId); await reply(current?.safeResult?.summary ?? response, telegramId(job.chatId)); if (current?.status === 'succeeded') store.markNotified(job.jobId); }
        } catch (error) { if (store.get(job.jobId)?.status !== 'succeeded') store.fail(job.jobId, error); observe('error', 'job.failed', { jobId: job.jobId, errorName: error instanceof Error ? error.name : 'UnknownError' }); }
      }
      observe('info', 'recovery.completed', { unfinishedJobs: unfinished.length });
      if (!notify) return;
      for (const job of store.list('succeeded')) if (!job.notifiedAt && reauthorized(job)) {
        try { await reply(job.safeResult?.summary ?? 'Job completed.', telegramId(job.chatId)); store.markNotified(job.jobId); } catch { observe('warn', 'job.notification.failed', { jobId: job.jobId, recovery: true }); }
      }
    })().finally(() => { recoveryPromise = null; });
    return recoveryPromise;
  };
  return { store, handleTelegramUpdate, recoverUnfinished, health: () => ({ configurationValid: Boolean(options.ownerId) && (options.ownerEnabled ?? true), databaseOpen: true, processorRunning: active }), close: () => { if (!options.store) store.close(); } };
}
