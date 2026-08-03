import { createHmac, randomUUID } from 'node:crypto';

import {
  OwnerAuthorization,
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
