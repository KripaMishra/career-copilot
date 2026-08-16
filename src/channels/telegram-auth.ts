import { isIP } from 'node:net';
import { assertJobUrl } from '../tools/job-url.ts';

export type TelegramAllowlist = { userIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string> };
export type TelegramRequest = {
  userId: string; chatId: string; isPrivateChat: boolean; isForwarded: boolean; isReplay: boolean;
  isEdited?: boolean; isBot?: boolean; requestId?: string; updateId?: number; messageId?: number;
};
type TelegramUser = { id: number; is_bot?: boolean };
export type TelegramDocument = { file_id: string; file_unique_id: string; file_name?: string; mime_type?: string; file_size?: number };
type TelegramMessage = {
  message_id: number; date: number; chat: { id: number; type: string }; from?: TelegramUser; text?: string;
  edit_date?: number; forward_origin?: unknown; forward_from?: unknown; forward_from_chat?: unknown;
  forward_date?: number; via_bot?: unknown; sender_chat?: unknown;
  document?: TelegramDocument; caption?: string;
};
export type TelegramUpdate = {
  update_id: number; message?: TelegramMessage; edited_message?: TelegramMessage;
  channel_post?: TelegramMessage; edited_channel_post?: TelegramMessage;
};
export type TelegramAuditWriter = { append(entry: Record<string, unknown>): Promise<void> };

function isSafeNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function isSafeDocument(value: unknown): value is TelegramDocument {
  if (!value || typeof value !== 'object') return false;
  const document = value as Record<string, unknown>;
  return typeof document.file_id === 'string' && document.file_id.length > 0 && document.file_id.length <= 1024
    && typeof document.file_unique_id === 'string' && document.file_unique_id.length > 0 && document.file_unique_id.length <= 1024
    && (document.file_name === undefined || (typeof document.file_name === 'string' && document.file_name.length <= 1024))
    && (document.mime_type === undefined || (typeof document.mime_type === 'string' && document.mime_type.length <= 200))
    && (document.file_size === undefined || isSafeNonNegativeInteger(document.file_size));
}

/** Complete raw-envelope validation shared by every public Telegram intake path. */
export function assertRawTelegramUpdate(value: unknown): asserts value is TelegramUpdate {
  if (!value || typeof value !== 'object') throw new Error('Invalid Telegram update.');
  const update = value as Record<string, unknown>;
  if (!isSafeNonNegativeInteger(update.update_id)) throw new Error('Invalid Telegram update.');
  const candidates = ['message', 'edited_message', 'channel_post', 'edited_channel_post']
    .filter((key) => update[key] !== undefined);
  if (candidates.length !== 1) throw new Error('Invalid Telegram update.');
  const message = update[candidates[0]];
  if (!message || typeof message !== 'object') throw new Error('Invalid Telegram update.');
  const row = message as Record<string, unknown>;
  const chat = row.chat;
  const from = row.from;
  if (!isSafeNonNegativeInteger(row.message_id) || !isSafeNonNegativeInteger(row.date)
    || (row.edit_date !== undefined && !isSafeNonNegativeInteger(row.edit_date))
    || !chat || typeof chat !== 'object'
    || !Number.isSafeInteger((chat as Record<string, unknown>).id) || (chat as Record<string, unknown>).id === 0
    || !['private', 'group', 'supergroup', 'channel'].includes((chat as Record<string, unknown>).type as string)
    || (from !== undefined && (!from || typeof from !== 'object'
      || !isSafeNonNegativeInteger((from as Record<string, unknown>).id) || (from as Record<string, unknown>).id === 0
      || ((from as Record<string, unknown>).is_bot !== undefined && typeof (from as Record<string, unknown>).is_bot !== 'boolean')))
    || (row.text !== undefined && (typeof row.text !== 'string' || row.text.length > 4096
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(row.text)))
    || (row.document !== undefined && !isSafeDocument(row.document))
    || (row.caption !== undefined && (typeof row.caption !== 'string' || row.caption.length > 1024))) {
    throw new Error('Invalid Telegram update.');
  }
}

export type OwnerAuthorizationConfig = {
  resourceId: string;
  enabled: boolean;
  authorizationRevision: number;
  telegram: TelegramAllowlist;
  studioEnabled: boolean;
  stdioEnabled: boolean;
  apiIdentity?: string;
};
export type PrincipalInput =
  | { channel: 'telegram'; userId: string; chatId: string; privateChat: boolean }
  | { channel: 'studio'; remoteAddress: string; conversationId: string }
  | { channel: 'stdio' }
  | { channel: 'api'; authenticatedIdentity?: string; conversationId: string };
export type AuthorizationBinding = Readonly<{
  resourceId: string;
  threadId: string;
  destination: string;
  channel: PrincipalInput['channel'];
  principalKey: string;
  authorizationRevision: number;
}>;

type AuthorizationCapabilityMetadata = Readonly<{
  scope: 'principal' | 'destination';
  validate: () => AuthorizationBinding;
}>;
const authorizationCapabilities = new WeakMap<object, AuthorizationCapabilityMetadata>();
export type OwnerAuthorizationCapability = AuthorizationBinding;
export function isOwnerAuthorizationCapability(value: unknown): value is OwnerAuthorizationCapability {
  return typeof value === 'object' && value !== null && authorizationCapabilities.has(value);
}
function sameAuthorization(left: AuthorizationBinding, right: AuthorizationBinding): boolean {
  return left.resourceId === right.resourceId && left.threadId === right.threadId && left.destination === right.destination
    && left.channel === right.channel && left.principalKey === right.principalKey
    && left.authorizationRevision === right.authorizationRevision;
}
export function isCurrentlyValidPrincipalAuthorizationCapability(value: unknown): value is OwnerAuthorizationCapability {
  if (!isOwnerAuthorizationCapability(value)) return false;
  const metadata = authorizationCapabilities.get(value)!;
  if (metadata.scope !== 'principal') return false;
  try { return sameAuthorization(value, metadata.validate()); } catch { return false; }
}
export function assertCurrentlyValidPrincipalAuthorizationCapability(value: unknown): asserts value is OwnerAuthorizationCapability {
  if (!isCurrentlyValidPrincipalAuthorizationCapability(value)) throw new Error('Current principal authorization is revoked or unavailable.');
}
function issueAuthorizationCapability(binding: AuthorizationBinding, metadata: AuthorizationCapabilityMetadata): OwnerAuthorizationCapability {
  const capability = Object.freeze({ ...binding });
  authorizationCapabilities.set(capability, metadata);
  return capability;
}

function unauthorized(message = 'Unauthorized principal.'): never { throw new Error(message); }
function safeCorrelation(value: string): string {
  if (!/^[A-Za-z0-9_.:-]{1,200}$/.test(value)) unauthorized();
  return value;
}
function safePrincipal(value: string): string {
  if (!/^[A-Za-z0-9_.:@-]{1,200}$/.test(value)) unauthorized();
  return value;
}
function isLoopback(address: string): boolean {
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

/** Reusable live authorization for enqueue and later operational boundaries. */
export class OwnerAuthorization {
  private readonly load: () => OwnerAuthorizationConfig;
  constructor(load: () => OwnerAuthorizationConfig) { this.load = load; }

  configuredOwnerContext(): { resourceId: string; authorizationRevision: number } {
    const owner = this.load();
    if (!owner.resourceId || !Number.isInteger(owner.authorizationRevision) || owner.authorizationRevision < 0) unauthorized('Owner authorization configuration is invalid.');
    return { resourceId: owner.resourceId, authorizationRevision: owner.authorizationRevision };
  }

  authorize(principal: PrincipalInput): AuthorizationBinding {
    const owner = this.load();
    if (!owner.resourceId || !Number.isInteger(owner.authorizationRevision) || owner.authorizationRevision < 0) unauthorized('Owner authorization configuration is invalid.');
    if (!owner.enabled) unauthorized('Owner authorization is revoked.');
    let threadId: string;
    let destination: string;
    let principalKey: string;
    switch (principal.channel) {
      case 'telegram':
        if (!principal.privateChat || !owner.telegram.userIds.has(principal.userId) || !owner.telegram.privateChatIds.has(principal.chatId)) unauthorized();
        threadId = `telegram:${safeCorrelation(principal.chatId)}`;
        destination = principal.chatId;
        principalKey = `telegram:${principal.userId}:${principal.chatId}`;
        break;
      case 'studio':
        if (!owner.studioEnabled || !isLoopback(principal.remoteAddress)) unauthorized();
        threadId = `studio:${safeCorrelation(principal.conversationId)}`;
        destination = 'studio:loopback';
        principalKey = `${destination}:${safeCorrelation(principal.conversationId)}`;
        break;
      case 'stdio':
        if (!owner.stdioEnabled) unauthorized();
        threadId = 'stdio:local';
        destination = 'stdio:local';
        principalKey = 'stdio:local';
        break;
      case 'api':
        if (!owner.apiIdentity || principal.authenticatedIdentity !== owner.apiIdentity) unauthorized('API intake is disabled until an authenticated identity is configured.');
        threadId = `api:${safeCorrelation(principal.conversationId)}`;
        destination = `api:${safePrincipal(principal.authenticatedIdentity)}`;
        principalKey = `${destination}:${safeCorrelation(principal.conversationId)}`;
        break;
    }
    const binding = { resourceId: owner.resourceId, threadId, destination, channel: principal.channel, principalKey, authorizationRevision: owner.authorizationRevision } as const;
    return issueAuthorizationCapability(binding, { scope: 'principal', validate: () => this.authorize(principal) });
  }

  reauthorize(
    binding: AuthorizationBinding,
    boundary: 'enqueue' | 'read' | 'resume' | 'delivery' | 'effect',
    currentPrincipal?: PrincipalInput,
  ): AuthorizationBinding {
    const owner = this.load();
    if (!owner.enabled || binding.resourceId !== owner.resourceId || binding.authorizationRevision !== owner.authorizationRevision) unauthorized('Owner authorization is revoked or unauthorized.');
    if (boundary === 'delivery' || boundary === 'effect') {
      let destinationAllowed = false;
      switch (binding.channel) {
        case 'telegram': {
          const principal = /^telegram:(\d+):(\d+)$/.exec(binding.principalKey);
          const userId = principal?.[1];
          const chatId = principal?.[2];
          destinationAllowed = Boolean(userId && chatId
            && binding.destination === chatId && binding.threadId === `telegram:${chatId}`
            && owner.telegram.userIds.has(userId) && owner.telegram.privateChatIds.has(chatId));
          break;
        }
        case 'studio': {
          const conversation = /^studio:([A-Za-z0-9_.:-]{1,200})$/.exec(binding.threadId)?.[1];
          destinationAllowed = Boolean(owner.studioEnabled && conversation && binding.destination === 'studio:loopback'
            && binding.principalKey === `studio:loopback:${conversation}`);
          break;
        }
        case 'stdio':
          destinationAllowed = owner.stdioEnabled && binding.destination === 'stdio:local'
            && binding.principalKey === 'stdio:local' && binding.threadId === 'stdio:local';
          break;
        case 'api': {
          const conversation = /^api:([A-Za-z0-9_.:-]{1,200})$/.exec(binding.threadId)?.[1];
          destinationAllowed = Boolean(owner.apiIdentity && conversation && binding.destination === `api:${owner.apiIdentity}`
            && binding.principalKey === `api:${owner.apiIdentity}:${conversation}`);
          break;
        }
        default:
          destinationAllowed = false;
      }
      if (!destinationAllowed) unauthorized('Destination authorization is revoked.');
      if (!currentPrincipal) return issueAuthorizationCapability(binding, { scope: 'destination', validate: () => this.reauthorize(binding, boundary) });
      const current = this.authorize(currentPrincipal);
      if (!sameAuthorization(current, binding)) unauthorized();
      return current;
    }
    if (!currentPrincipal) unauthorized('Trusted current principal context is required.');
    const current = this.authorize(currentPrincipal);
    if (current.channel !== binding.channel || current.resourceId !== binding.resourceId || current.threadId !== binding.threadId
      || current.destination !== binding.destination || current.principalKey !== binding.principalKey
      || current.authorizationRevision !== binding.authorizationRevision) unauthorized();
    return current;
  }
}

export function parseNumericIdList(value: string | undefined) {
  if (!value?.trim()) return new Set<string>();
  return new Set(value.split(',').map((id) => {
    const normalized = id.trim();
    if (!/^\d+$/.test(normalized)) throw new Error('Telegram allowlist IDs must be numeric.');
    return normalized;
  }));
}

export function isAllowedTelegramRequest(request: TelegramRequest, allowlist: TelegramAllowlist) {
  return allowlist.userIds.size > 0 && allowlist.privateChatIds.size > 0
    && allowlist.userIds.has(request.userId) && allowlist.privateChatIds.has(request.chatId)
    && request.isPrivateChat && !request.isBot && !request.isEdited && !request.isForwarded && !request.isReplay;
}

export type IntakeIntent = { kind: 'save_job'; url: string } | { kind: 'parked_job' };
export function parseIntakeCommand(text: string | undefined): IntakeIntent | null {
  const save = text?.match(/^\/save[ \t]+(\S+)$/);
  if (save) return { kind: 'save_job', url: save[1] };
  if (text && /^\/job(?:[ \t]+\S+)?$/.test(text)) return { kind: 'parked_job' };
  return null;
}

export const RESUME_MAX_DOWNLOAD_BYTES = 5 * 1024 * 1024;

/**
 * Bounded PDF document-envelope authorization (spec rule 1–3): runs before any
 * getFile/download. Accepts only Telegram document messages that declare PDF
 * MIME type (`application/pdf`) AND a `.pdf` filename AND fit the download
 * cap; anything else — including missing MIME/name fields — is rejected here.
 * The `%PDF-` signature is verified on the downloaded bytes, not the envelope.
 */
export function authorizeResumeDocument(message: { document?: TelegramDocument; caption?: string }): { accepted: true; document: TelegramDocument } | { accepted: false; reason: 'not_a_document' | 'unsupported_mime' | 'unsupported_extension' | 'oversized' | 'caption_unsupported' } {
  if (!message.document) return { accepted: false, reason: 'not_a_document' };
  if (message.caption !== undefined) return { accepted: false, reason: 'caption_unsupported' };
  const { document } = message;
  if (document.mime_type !== 'application/pdf') return { accepted: false, reason: 'unsupported_mime' };
  if (!document.file_name || !document.file_name.toLowerCase().endsWith('.pdf')) return { accepted: false, reason: 'unsupported_extension' };
  if (document.file_size !== undefined && document.file_size > RESUME_MAX_DOWNLOAD_BYTES) return { accepted: false, reason: 'oversized' };
  return { accepted: true, document };
}
export function deriveTelegramRequest(update: TelegramUpdate, options: { seenUpdateIds?: ReadonlySet<number> } = {}): TelegramRequest {
  const message = update.message ?? update.edited_message ?? update.channel_post ?? update.edited_channel_post;
  return {
    userId: message?.from?.id === undefined ? '' : String(message.from.id),
    chatId: message?.chat?.id === undefined ? '' : String(message.chat.id),
    isPrivateChat: message?.chat?.type === 'private',
    isEdited: Boolean(update.edited_message || update.edited_channel_post || message?.edit_date),
    isBot: message?.from?.is_bot === true,
    isForwarded: Boolean(message?.forward_origin || message?.forward_from || message?.forward_from_chat || message?.forward_date || message?.via_bot || message?.sender_chat),
    isReplay: options.seenUpdateIds?.has(update.update_id) ?? false,
    requestId: `telegram:${update.update_id}:${message?.message_id ?? 'unknown'}`,
    updateId: update.update_id,
    messageId: message?.message_id ?? 0,
  };
}

function rejectionReason(request: TelegramRequest, update: TelegramUpdate, allowlist: TelegramAllowlist, intent: IntakeIntent | null) {
  if (update.edited_message || update.edited_channel_post || request.isEdited) return 'edited_message';
  if (request.isReplay) return 'replayed_update';
  if (request.isForwarded) return 'forwarded_message';
  if (request.isBot) return 'bot_sender';
  if (!request.isPrivateChat) return 'non_private_chat';
  if (!allowlist.userIds.has(request.userId)) return 'unauthorized_user';
  if (!allowlist.privateChatIds.has(request.chatId)) return 'unauthorized_chat';
  if (!request.userId || !request.chatId) return 'missing_sender';
  if (!intent) return 'invalid_command';
  if (intent.kind === 'save_job') {
    try { assertJobUrl(intent.url); } catch { return 'unsupported_job_url'; }
  }
  return null;
}

export async function authorizeTelegramUpdate(
  update: TelegramUpdate,
  allowlist: TelegramAllowlist,
  audit: TelegramAuditWriter = { append: async () => {} },
  options: { seenUpdateIds?: ReadonlySet<number>; now?: () => Date } = {},
): Promise<{ accepted: true; request: TelegramRequest; intent: IntakeIntent } | { accepted: false; request: TelegramRequest; reason: string }> {
  const request = deriveTelegramRequest(update, options);
  const intent = parseIntakeCommand((update.message ?? update.edited_message)?.text);
  const reason = rejectionReason(request, update, allowlist, intent);
  if (reason || !intent || !isAllowedTelegramRequest(request, allowlist)) {
    const rejected = reason ?? 'unauthorized_request';
    await audit.append({ kind: 'telegram_rejection', requestId: request.requestId, updateId: request.updateId, messageId: request.messageId, userId: request.userId, chatId: request.chatId, reason: rejected, actor: 'telegram', timestamp: (options.now ?? (() => new Date()))().toISOString() });
    return { accepted: false, request, reason: rejected };
  }
  return { accepted: true, request, intent };
}
