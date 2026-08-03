import { createHmac, randomUUID } from 'node:crypto';

import {
  OwnerAuthorization,
  assertCurrentlyValidPrincipalAuthorizationCapability,
  assertRawTelegramUpdate,
  authorizeTelegramUpdate,
  parseIntakeCommand,
  type AuthorizationBinding,
  type IntakeIntent,
  type PrincipalInput,
} from '../channels/telegram-auth.ts';
import {
  CareerStore,
  buildJobIdempotencyKey,
  type AtomicIntakeResult,
  type IntakeRejectionReason,
  type SuspensionAcceptanceResult,
  type SuspensionAnswerInput,
} from '../storage/career-store.ts';
import { assertJobUrl } from '../tools/job-url.ts';

// Retained for existing filesystem boundary types; transport intake never creates or consumes jobs.
export type CareerJob = { url: string; company?: string; title?: string; location?: string; description?: string; sourceHash?: string };

export type CareerCopilotDependencies = {
  authorization: OwnerAuthorization;
  store: Pick<CareerStore, 'recordInboundAndEnqueue'>;
  intakeHashKey: string;
};
type TransportIntake = {
  principal: PrincipalInput;
  eventId: string;
  messageId: string;
  eventTimestamp: string;
  text?: string;
  flags: { bot: boolean; edited: boolean; forwarded: boolean };
  // Caller/model identity overrides are intentionally not represented or read.
  resourceId?: unknown;
  threadId?: unknown;
};
export type IntakeResult =
  | { outcome: 'rejected'; reason: string }
  | { outcome: 'parked'; command: 'job'; duplicate: boolean }
  | { outcome: 'enqueued'; commandId: string; queueSequence: number; queuePosition: number; duplicate: boolean };

function canonicalJobUrl(value: string): string {
  const url = assertJobUrl(value);
  if (url.username || url.password || url.port) throw new Error('Job URL cannot contain credentials or a non-default port.');
  url.hash = '';
  return buildJobIdempotencyKey({ url: url.href }).slice('url:'.length);
}

export type SuspendedRunEvidence = {
  runId: string; workflowName: string; resourceId?: string; status: 'pending' | 'running' | 'waiting' | 'suspended' | 'success' | 'failed';
  suspendedSteps: readonly string[];
};
export type PreparedExactResume = { invoke(beforeInvoke: () => void): Promise<{ runId: string }> };
export type ExactSuspendedResumeAdapter = {
  inspectExactRun(runId: string, token: import('../contracts/v0.ts').SuspensionTokenV1): Promise<SuspendedRunEvidence | null>;
  /** Completes all awaited evidence/handle preparation before returning a no-await boundary invocation. */
  prepareExactResume(input: { token: import('../contracts/v0.ts').SuspensionTokenV1; resumeData: unknown }): Promise<PreparedExactResume>;
};
export type ResumeFailpoint = 'afterAccepted' | 'afterApplying' | 'afterCallMarked' | 'duringResumeCall' | 'afterResumeReturned' | 'beforeAppliedProjection';

export function createInstalledMastraResumeAdapter(dependencies: {
  workflow: {
    id: string;
    getWorkflowRunById(runId: string): Promise<{ runId: string; workflowName: string; resourceId?: string; status: SuspendedRunEvidence['status'] } | null>;
    createRun(options: { runId: string; resourceId: string }): Promise<{ resumeAsync(input: { step: string; resumeData: unknown }): Promise<{ runId: string }> }>;
  };
  loadSnapshot(runId: string): Promise<{ status: string; context?: Record<string, { status?: string; suspendPayload?: unknown }> } | null>;
}): ExactSuspendedResumeAdapter {
  const inspectExactRun = async (runId: string, token: import('../contracts/v0.ts').SuspensionTokenV1): Promise<SuspendedRunEvidence | null> => {
    const [run, snapshot] = await Promise.all([dependencies.workflow.getWorkflowRunById(runId), dependencies.loadSnapshot(runId)]);
    const step = snapshot?.context?.[token.suspendedStep];
    if (!run || !snapshot || run.runId !== runId || run.workflowName !== dependencies.workflow.id || run.status !== snapshot.status
      || run.resourceId !== token.resourceId || JSON.stringify(step?.suspendPayload) !== JSON.stringify(token)) return null;
    const suspendedSteps = Object.entries(snapshot.context ?? {}).filter(([, value]) => value?.status === 'suspended').map(([stepId]) => stepId);
    return { ...run, suspendedSteps };
  };
  return {
    inspectExactRun,
    async prepareExactResume({ token, resumeData }) {
      const evidence = await inspectExactRun(token.runId, token);
      if (!evidence || evidence.status !== 'suspended' || !evidence.suspendedSteps.includes(token.suspendedStep)) {
        throw new Error('Exact persisted blocker-bound suspended run evidence is required before reconstruction.');
      }
      const handle = await dependencies.workflow.createRun({ runId: token.runId, resourceId: token.resourceId });
      return { invoke(beforeInvoke) { beforeInvoke(); return handle.resumeAsync({ step: token.suspendedStep, resumeData }); } };
    },
  };
}

export class CareerResumeCoordinator {
  private readonly store: CareerStore;
  private readonly adapter: ExactSuspendedResumeAdapter;
  private readonly acceptanceHashKey: string;
  constructor(store: CareerStore, adapter: ExactSuspendedResumeAdapter, acceptanceHashKey: string) {
    this.store = store; this.adapter = adapter; this.acceptanceHashKey = acceptanceHashKey;
  }

  async acceptAndResume(
    capability: import('../channels/telegram-auth.ts').OwnerAuthorizationCapability,
    input: SuspensionAnswerInput,
    leaseOwner: string,
    onFailpoint: (point: ResumeFailpoint) => void | Promise<void> = async () => {},
  ): Promise<SuspensionAcceptanceResult | { outcome: 'applied' | 'resume_unknown' | 'authorization_blocked' }> {
    const accepted = this.store.acceptSuspension(capability, input, leaseOwner, this.acceptanceHashKey);
    if (accepted.outcome !== 'accepted') return accepted;
    await onFailpoint('afterAccepted');
    return this.recoverAcceptedResume(capability, accepted.suspensionId, onFailpoint);
  }

  async recoverAcceptedResume(
    capability: import('../channels/telegram-auth.ts').OwnerAuthorizationCapability,
    suspensionId: string,
    onFailpoint: (point: ResumeFailpoint) => void | Promise<void> = async () => {},
    reclaimLeaseOwner = 'resume-recovery',
  ): Promise<{ outcome: 'applied' | 'resume_unknown' | 'authorization_blocked' }> {
    this.store.reclaimAcceptedResume(capability,suspensionId,reclaimLeaseOwner);
    let work = this.store.loadAcceptedResume(capability, suspensionId, this.acceptanceHashKey);
    if (!work) throw new Error('No current authorized accepted resume work exists.');
    if (work.blockerState === 'applied') return { outcome: 'applied' };
    let evidence = await this.adapter.inspectExactRun(work.fence.runId, work.token);
    if (!evidence) throw new Error('Persisted workflow suspension token does not match durable blocker authority.');
    if (evidence.status !== 'suspended') {
      await onFailpoint('beforeAppliedProjection');
      const reconciled = this.store.reconcileResume(work.fence, suspensionId, evidence.status === 'pending' ? 'waiting' : evidence.status);
      return { outcome: reconciled.outcome === 'applied' ? 'applied' : 'resume_unknown' };
    }
    if (work.callState === 'resume_unknown') return { outcome: 'resume_unknown' };
    if (work.callState === 'calling' || work.callState === 'called') {
      this.store.markResumeUnknown(work.fence, suspensionId);
      return { outcome: 'resume_unknown' };
    }
    if (work.blockerState === 'accepted') {
      if (!this.store.markResumeApplying(work.fence, suspensionId).applied) throw new Error('Resume application fence was lost.');
      work = { ...work, blockerState: 'applying' };
      await onFailpoint('afterApplying');
    }
    if (work.callState !== 'not_called') return { outcome: 'resume_unknown' };
    evidence = await this.adapter.inspectExactRun(work.fence.runId, work.token);
    if (!evidence || evidence.status !== 'suspended') throw new Error('Exact suspended snapshot disappeared before resume call.');
    const prepared = await this.adapter.prepareExactResume({ token:work.token,resumeData:JSON.parse(work.responseBytes) });
    let resumePromise: Promise<{ runId:string }>;
    let boundaryCrossed = false;
    try {
      resumePromise = prepared.invoke(() => {
        assertCurrentlyValidPrincipalAuthorizationCapability(capability);
        if (!this.store.markResumeCallStarted(work.fence,suspensionId).applied) throw new Error('Resume call fence was lost.');
        boundaryCrossed = true;
        onFailpoint('afterCallMarked');
      });
    } catch (error) {
      if (boundaryCrossed && /^crash:/.test((error as Error)?.message ?? '')) throw error;
      if (boundaryCrossed) { this.store.markResumeUnknown(work.fence,suspensionId); return { outcome:'resume_unknown' }; }
      return { outcome:'authorization_blocked' };
    }
    await onFailpoint('duringResumeCall');
    try {
      const result = await resumePromise;
      if (result.runId !== work.fence.runId) throw new Error('Resume returned mismatched run correlation.');
    } catch {
      this.store.markResumeUnknown(work.fence, suspensionId);
      return { outcome: 'resume_unknown' };
    }
    if (!this.store.markResumeCallReturned(work.fence, suspensionId).applied) return { outcome: 'resume_unknown' };
    await onFailpoint('afterResumeReturned');
    const after = await this.adapter.inspectExactRun(work.fence.runId, work.token);
    if (!after) return { outcome: 'resume_unknown' };
    if (after.status === 'suspended') {
      this.store.markResumeUnknown(work.fence, suspensionId);
      return { outcome: 'resume_unknown' };
    }
    await onFailpoint('beforeAppliedProjection');
    const reconciled = this.store.reconcileResume(work.fence, suspensionId, after.status === 'pending' ? 'waiting' : after.status);
    return { outcome: reconciled.outcome === 'applied' ? 'applied' : 'resume_unknown' };
  }
}

export class CareerCopilotService {
  readonly #hashKey: Buffer;
  readonly #dependencies: CareerCopilotDependencies;
  constructor(dependencies: CareerCopilotDependencies) {
    this.#dependencies = dependencies;
    this.#hashKey = Buffer.from(dependencies.intakeHashKey, 'utf8');
    if (this.#hashKey.byteLength < 32) throw new Error('CAREER_COPILOT_INTAKE_HASH_KEY must contain at least 32 bytes.');
  }

  #payloadHash(event: TransportIntake): string {
    const principal = event.principal.channel === 'telegram'
      ? { channel: 'telegram', userId: event.principal.userId, chatId: event.principal.chatId, privateChat: event.principal.privateChat }
      : event.principal;
    const normalized = JSON.stringify({
      channel: event.principal.channel, eventId: event.eventId, messageId: event.messageId,
      eventTimestamp: event.eventTimestamp, principal, text: event.text ?? null, flags: event.flags,
    });
    return `sha256:${createHmac('sha256', this.#hashKey).update(normalized).digest('hex')}`;
  }

  #reject(event: TransportIntake, reason: IntakeRejectionReason): IntakeResult {
    const owner = this.#dependencies.authorization.configuredOwnerContext();
    const result = this.#dependencies.store.recordInboundAndEnqueue({
      channel: event.principal.channel,
      transportEventId: event.eventId,
      payloadHash: this.#payloadHash(event),
      ownerResourceId: owner.resourceId,
      threadId: 'intake:rejected',
      originDestination: 'intake:rejected',
      principalKey: 'intake:rejected',
      authorizationRevision: owner.authorizationRevision,
      intentKind: 'rejected',
      rejectionReason: reason,
    });
    return result.intentKind === 'rejected'
      ? { outcome: 'rejected', reason: result.rejectionReason }
      : { outcome: 'rejected', reason };
  }

  #store(binding: AuthorizationBinding, principal: PrincipalInput, event: TransportIntake, intent: IntakeIntent): AtomicIntakeResult {
    const fresh = this.#dependencies.authorization.reauthorize(binding, 'enqueue', principal);
    if (intent.kind === 'parked_job') {
      return this.#dependencies.store.recordInboundAndEnqueue({
        channel: fresh.channel,
        transportEventId: event.eventId,
        payloadHash: this.#payloadHash(event),
        ownerResourceId: fresh.resourceId,
        threadId: fresh.threadId,
        originDestination: fresh.destination,
        principalKey: fresh.principalKey,
        authorizationRevision: fresh.authorizationRevision,
        intentKind: 'parked_job',
        requestId: `${fresh.channel}:${event.eventId}`,
      });
    }
    const canonicalUrl = canonicalJobUrl(intent.url);
    return this.#dependencies.store.recordInboundAndEnqueue({
      channel: fresh.channel,
      transportEventId: event.eventId,
      payloadHash: this.#payloadHash(event),
      ownerResourceId: fresh.resourceId,
      threadId: fresh.threadId,
      originDestination: fresh.destination,
      principalKey: fresh.principalKey,
      authorizationRevision: fresh.authorizationRevision,
      intentKind: 'save_job',
      canonicalUrl,
      canonicalJobKey: buildJobIdempotencyKey({ url: canonicalUrl }),
      commandId: randomUUID(),
      attemptId: randomUUID(),
      requestId: `${fresh.channel}:${event.eventId}`,
    });
  }

  async #processTrustedTransport(
    event: TransportIntake,
    rawDestination: string,
    reply: (text: string) => Promise<void>,
  ): Promise<IntakeResult> {
    const intent = parseIntakeCommand(event.text);
    if (!intent) return this.#reject(event, 'invalid_command');
    let binding: AuthorizationBinding;
    try { binding = this.#dependencies.authorization.authorize(event.principal); }
    catch { return this.#reject(event, 'unauthorized'); }
    if (intent.kind === 'save_job') {
      try { intent.url = canonicalJobUrl(intent.url); }
      catch { return this.#reject(event, 'unsupported_job_url'); }
    }
    const stored = this.#store(binding, event.principal, event, intent);
    if (stored.intentKind === 'rejected') return { outcome: 'rejected', reason: stored.rejectionReason };
    const issuanceBinding: AuthorizationBinding = {
      channel: stored.issuanceAuthorization.channel,
      resourceId: stored.issuanceAuthorization.ownerResourceId,
      threadId: stored.issuanceAuthorization.threadId,
      destination: stored.issuanceAuthorization.destination,
      principalKey: stored.issuanceAuthorization.principalKey,
      authorizationRevision: stored.issuanceAuthorization.authorizationRevision,
    };
    try {
      const fresh = this.#dependencies.authorization.reauthorize(issuanceBinding, 'delivery');
      if (fresh.channel !== 'telegram' || fresh.destination !== rawDestination) {
        return { outcome: 'rejected', reason: 'unauthorized' };
      }
    } catch { return { outcome: 'rejected', reason: 'unauthorized' }; }
    const result: IntakeResult = stored.intentKind === 'parked_job'
      ? { outcome: 'parked', command: 'job', duplicate: stored.duplicate }
      : {
          outcome: 'enqueued', commandId: stored.commandId, queueSequence: stored.queueSequence,
          queuePosition: stored.queuePosition, duplicate: stored.duplicate,
        };
    await reply(result.outcome === 'enqueued'
      ? `Saved command ${result.commandId}; queue position ${result.queuePosition}.`
      : '/job is reserved and does not queue or apply. Use /save <URL>.');
    return result;
  }

  async process(update: unknown, reply: (text: string) => Promise<void> = async () => {}): Promise<IntakeResult> {
    try { assertRawTelegramUpdate(update); }
    catch { return { outcome: 'rejected', reason: 'invalid_update' }; }
    const request = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
    if (!request) return { outcome: 'rejected', reason: 'invalid_update' };
    // OwnerAuthorization is authoritative; this structural pass rejects edited/forwarded/bot updates before normalization.
    const preflight = await authorizeTelegramUpdate(update, {
      userIds: new Set([String(request.from?.id ?? '')]),
      privateChatIds: new Set([String(request.chat.id)]),
    });
    const event: TransportIntake = {
      principal: { channel: 'telegram', userId: preflight.request.userId, chatId: preflight.request.chatId, privateChat: preflight.request.isPrivateChat },
      eventId: String(update.update_id),
      messageId: String(request.message_id),
      eventTimestamp: String(request.date),
      text: request.text,
      flags: { bot: preflight.request.isBot === true, edited: preflight.request.isEdited === true, forwarded: preflight.request.isForwarded },
    };
    if (!preflight.accepted && preflight.reason !== 'invalid_command' && preflight.reason !== 'unsupported_job_url') {
      return this.#reject(event, preflight.reason as IntakeRejectionReason);
    }
    return this.#processTrustedTransport(event, String(request.chat.id), reply);
  }
}
