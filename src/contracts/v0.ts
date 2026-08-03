import { z } from 'zod';

export const V0_DOMAIN_AUTHORITY_ORDER = [
  'application_queue:lifecycle_claim_retry_blocker',
  'mastra_snapshot:workflow_execution_position',
  'stage_journal_and_verified_external_stores:effect_truth',
  'completion_outbox:notification_intent',
  'delivery_record_and_provider_evidence:send_outcome',
  'bounded_memory:conversation_context_only',
] as const;

// P14 precedence is intentionally separate from the P18 domain authority order.
export const V0_TURN_PRECEDENCE_ORDER = [
  'server_authorization_and_configuration',
  'fresh_typed_operational_read',
  'current_validated_user_intent',
  'timestamped_bootstrap_snapshot',
  'bounded_message_history',
] as const;

export const V0_DEFAULTS = {
  queue: {
    leaseSeconds: 120,
    heartbeatSeconds: 30,
    reconciliationSeconds: 30,
    fallbackPollSeconds: 5,
    drainDeadlineSeconds: 30,
    lifecycleStates: ['queued', 'starting', 'running', 'retry_wait', 'suspended', 'resuming', 'succeeded', 'failed', 'timed_out'],
  },
  workflow: {
    runsPerCommandAttempt: 1,
    startDispatchStates: ['not_dispatched', 'dispatching', 'dispatched', 'start_unknown'],
    blanketRetries: false,
    sideEffectStepRetries: 0,
  },
  tracker: { newRowStatus: 'pending_review', commandMarkerColumn: true, rowVersionColumn: true, reconciliation: 'forward_only' },
  authorization: {
    ownerCount: 1,
    revocation: 'stop_at_next_authorization_or_side_effect_boundary',
    studioAndStdioTrust: 'local',
    identityAuthority: 'server_only',
  },
  retry: {
    automaticRepeatTokens: 5,
    automaticProcessingDeadlineSeconds: 1_800,
    directAcquisitionMaxAttempts: 3,
    browserConnectionMaxAttempts: 3,
    providerInferenceMaxAttempts: 2,
    schemaRepairMaxAttempts: 1,
    unknownSideEffectBlindRepeats: 0,
    jitter: 'deterministic_full',
    jitterBaseSeconds: 2,
    jitterCapSeconds: 60,
    retryAfterCap: 'remaining_command_deadline',
  },
  blocker: { suspensionExpirySeconds: 604_800, acceptedResponsesPerGeneration: 1 },
  dispatcher: {
    leaseSeconds: 180,
    heartbeatSeconds: 30,
    definiteDeliveryRetries: 5,
    retryWindowSeconds: 86_400,
    sendUnknownPolicy: 'manual_or_provider_reconciliation',
  },
  deadlines: {
    databaseSeconds: 5,
    directFetchSeconds: 30,
    browserAcquisitionSeconds: 120,
    modelRequestSeconds: 120,
    sheetOrFileSeconds: 30,
    channelSendSeconds: 15,
    browserMutexWaitSeconds: 30,
    humanSuspensionSeconds: 604_800,
  },
  cancellation: { userCancellation: false, gracefulShutdownIsCancellation: false },
  browser: {
    topLevelRedirects: 3,
    topLevelWireBytes: 2_097_152,
    topLevelDecodedBytes: 5_242_880,
    subresourceBytes: 5_242_880,
    aggregateTransferBytes: 26_214_400,
    extractedCharacters: 500_000,
    profileDirectoryMode: '0700',
    secretFileMode: '0600',
    failOnClickThrough: true,
    screenshots: false,
    mutexScope: 'global',
    ownedTabs: 1,
    allowedOperations: ['browser_goto', 'browser_wait', 'browser_snapshot', 'browser_scroll', 'owned_tab_cleanup'],
  },
  network: {
    scheme: 'https',
    defaultPortsOnly: true,
    topLevelContentTypes: ['text/html', 'application/xhtml+xml', 'text/plain'],
    jsonRequiresVerifiedAdapter: true,
  },
  sheets: { oauthScope: 'https://www.googleapis.com/auth/spreadsheets', driveScope: false, strictTargetBinding: true },
  memory: {
    lastMessages: 20,
    generateTitle: false,
    semanticRecall: false,
    workingMemory: false,
    observationalMemory: false,
    customProcessors: false,
    automaticSummaries: false,
    specialistMemory: false,
  },
  runtime: { runtimeSkills: 0, productionScorers: 0, primaryToolPolicy: 'narrow_typed_only' },
  bootstrap: { actionableItems: 20, recentTerminalItems: 5, storageUnavailable: 'fail_closed' },
  retention: {
    standaloneEvidenceDays: 30,
    terminalOperationalRecordsDays: 90,
    deliveredDeliveryRecordsDays: 90,
    resolvedOutboxDays: 90,
    conversationAfterActivityDays: 90,
    structuredLogsDays: 30,
    unresolvedOutbox: 'until_resolved',
    reportsTopicsTracker: 'until_owner_deletion',
    reportCitedExcerpts: 'until_owner_deletion',
    oauthAndBrowserProfile: 'until_revoke_or_reset',
    minimalAuditTombstone: 'indefinite',
  },
  health: { oldestRunnableDegradedSeconds: 300, expiredLeaseDegradedReconciliationCycles: 2, pendingDeliveryDegradedSeconds: 900 },
  storage: { operationalBackend: 'absolute_local_file', remoteLibsql: false },
  intake: { globalFifoConsumers: 1, rawChannelUpdateRetention: 'discard_after_validation' },
  artifacts: { claim: 'auditable_and_traceable_not_reproducible', encryptedFullPageSnapshot: false },
} as const;

const id = z.string().trim().min(1).max(200);
const shortText = z.string().trim().min(1).max(500);
const safeText = z.string().trim().min(1).max(4_000);
const isoDateTime = z.string().datetime({ offset: false, precision: 3 });
const sha256 = z.string().regex(/^sha256:[a-f0-9]{64}$/);
const safeHttpsUrl = z.string().max(2_048).superRefine((value, context) => {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'URL must be valid' });
    return;
  }
  if (parsed.protocol !== 'https:') context.addIssue({ code: 'custom', message: 'URL must use HTTPS' });
  if (parsed.username || parsed.password) context.addIssue({ code: 'custom', message: 'URL cannot contain credentials' });
  if (parsed.hash) context.addIssue({ code: 'custom', message: 'URL cannot contain a fragment' });
  if (parsed.port) context.addIssue({ code: 'custom', message: 'URL cannot use a non-default port' });
});
const canonicalUrl = safeHttpsUrl.refine((value) => {
  try {
    return new URL(value).href === value;
  } catch {
    return false;
  }
}, 'canonical URL must use its serialized form');
const boundedRenderedResponse = z.string().max(8_000).refine((value) => Buffer.byteLength(value, 'utf8') <= 8_000, 'rendered response exceeds 8000 bytes');
const nonNegativeInteger = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().positive().max(Number.MAX_SAFE_INTEGER);

export const QueueStateV0Schema = z.enum([
  'queued',
  'starting',
  'running',
  'retry_wait',
  'suspended',
  'resuming',
  'succeeded',
  'failed',
  'timed_out',
]);
export type QueueStateV0 = z.infer<typeof QueueStateV0Schema>;

export const LEGAL_QUEUE_TRANSITIONS_V0 = Object.freeze({
  queued: Object.freeze(['starting']),
  starting: Object.freeze(['running', 'timed_out']),
  running: Object.freeze(['retry_wait', 'suspended', 'succeeded', 'failed', 'timed_out']),
  retry_wait: Object.freeze(['resuming', 'timed_out']),
  suspended: Object.freeze(['resuming', 'timed_out']),
  resuming: Object.freeze(['running', 'timed_out']),
  succeeded: Object.freeze([]),
  failed: Object.freeze([]),
  timed_out: Object.freeze([]),
} as const satisfies Record<QueueStateV0, readonly QueueStateV0[]>);

export function isLegalQueueTransitionV0(from: unknown, to: unknown): boolean {
  const source = QueueStateV0Schema.safeParse(from);
  const target = QueueStateV0Schema.safeParse(to);
  return source.success && target.success && (LEGAL_QUEUE_TRANSITIONS_V0[source.data] as readonly QueueStateV0[]).includes(target.data);
}

export const StartDispatchStateV0Schema = z.enum(['not_dispatched', 'dispatching', 'dispatched', 'start_unknown']);
export const StageStateV0Schema = z.enum([
  'planned',
  'applying',
  'applied',
  'outcome_unknown',
  'reconciled',
  'authorization_blocked',
  'compensated',
]);
export const BlockerStateV0Schema = z.enum(['pending', 'accepted', 'applying', 'applied', 'invalidated', 'expired']);
export const DeliveryStateV0Schema = z.enum([
  'pending',
  'claimed',
  'rendered',
  'sending',
  'delivered',
  'retry_wait',
  'blocked',
  'send_unknown',
  'dead_letter',
]);

const identityFields = {
  identityAuthority: z.literal('server'),
  resourceId: id,
  threadId: id,
};

const OriginCorrelationSchema = z.strictObject({
  channel: z.enum(['telegram', 'studio', 'stdio', 'api']),
  channelThreadId: id,
  messageId: id,
  replyToMessageId: id.nullable(),
});

const SaveIntentSchema = z.strictObject({ kind: z.literal('save_job'), canonicalUrl });
const QueueIntentSchema = z.strictObject({ kind: z.enum(['queue', 'status']) });
const ResumeIntentSchema = z.strictObject({ kind: z.literal('resume'), commandId: id, suspensionGeneration: positiveInteger });
const FreeFormIntentSchema = z.strictObject({ kind: z.literal('free_form'), text: z.string().trim().min(1).max(4_000) });

const InboundProcessingResultSchema = z.discriminatedUnion('status', [
  z.strictObject({ status: z.literal('accepted'), kind: z.enum(['command', 'turn', 'resume']), referenceId: id }),
  z.strictObject({ status: z.literal('rejected'), reason: z.enum(['unauthorized', 'invalid_intent', 'duplicate', 'storage_unavailable']), safeMessage: safeText }),
]);

const inboundEventFields = {
  schemaVersion: z.literal(1),
  eventId: id,
  sequence: positiveInteger,
  receivedAt: isoDateTime,
  payloadHash: sha256,
  origin: OriginCorrelationSchema,
  intent: z.discriminatedUnion('kind', [SaveIntentSchema, QueueIntentSchema, ResumeIntentSchema, FreeFormIntentSchema]),
  processingResult: InboundProcessingResultSchema,
};

export const UntrustedInboundEventV1Schema = z.strictObject(inboundEventFields);
export const InboundEventV1Schema = z.strictObject({ ...inboundEventFields, ...identityFields });
const ServerIdentityContextSchema = z.strictObject({ resourceId: id, threadId: id });

export function normalizeInboundEventV1(input: unknown, serverContext: unknown) {
  const event = UntrustedInboundEventV1Schema.parse(input);
  const identity = ServerIdentityContextSchema.parse(serverContext);
  return InboundEventV1Schema.parse({ ...event, identityAuthority: 'server', ...identity });
}

const CommandClaimSchema = z.strictObject({
  generation: nonNegativeInteger,
  leaseOwner: id.nullable(),
  leaseExpiresAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
});
const WorkflowCorrelationSchema = z.strictObject({
  workflowVersion: id,
  attempt: positiveInteger,
  runId: id.nullable(),
  resourceId: id,
  startDispatchState: StartDispatchStateV0Schema,
});
const RetryStateSchema = z.strictObject({
  automaticRepeatsUsed: nonNegativeInteger.max(V0_DEFAULTS.retry.automaticRepeatTokens),
  processingStartedAt: isoDateTime.nullable(),
  processingDeadlineAt: isoDateTime.nullable(),
  nextAttemptAt: isoDateTime.nullable(),
  stage: id.nullable(),
  errorClass: id.nullable(),
  errorCode: id.nullable(),
  stageAttempts: nonNegativeInteger,
  lastSafeError: safeText.nullable(),
});

export const CommandV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  commandId: id,
  attemptId: id,
  requestId: id,
  idempotencyKey: id,
  canonicalJobKey: id,
  commandName: z.literal('save_job'),
  arguments: z.strictObject({ canonicalUrl }),
  ...identityFields,
  origin: OriginCorrelationSchema,
  queueSequence: positiveInteger,
  state: QueueStateV0Schema,
  terminalGeneration: nonNegativeInteger,
  receivedAt: isoDateTime,
  updatedAt: isoDateTime,
  claim: CommandClaimSchema,
  workflow: WorkflowCorrelationSchema,
  progress: z.strictObject({ latestStage: id.nullable(), suspensionGeneration: nonNegativeInteger, blockerId: id.nullable() }),
  retry: RetryStateSchema,
  references: z.strictObject({ completionEnvelopeId: id.nullable(), deliveryRecordId: id.nullable(), linkedPriorCommandId: id.nullable() }),
}).superRefine((command, context) => {
  const issue = (path: (string | number)[], message: string) => context.addIssue({ code: 'custom', path, message });
  const claimValues = [command.claim.leaseOwner, command.claim.leaseExpiresAt, command.claim.heartbeatAt];
  const hasClaim = claimValues.every((value) => value !== null);
  if (!hasClaim && !claimValues.every((value) => value === null)) issue(['claim'], 'claim owner, expiry, and heartbeat must be all present or all null');
  if (hasClaim && command.claim.generation === 0) issue(['claim', 'generation'], 'active claim generation must be positive');

  const isQueued = command.state === 'queued';
  const isSuspended = command.state === 'suspended';
  const isTerminal = ['succeeded', 'failed', 'timed_out'].includes(command.state);
  const isSuspensionExpiryTimeout = command.state === 'timed_out'
    && command.progress.suspensionGeneration > 0
    && command.retry.errorClass === 'blocker'
    && command.retry.errorCode === 'suspension_expired'
    && command.retry.lastSafeError !== null;
  const requiresClaim = ['starting', 'running', 'resuming'].includes(command.state);
  if (requiresClaim && !hasClaim) issue(['claim'], `${command.state} requires an active claim`);
  if ((isQueued || isSuspended || isTerminal || command.state === 'retry_wait') && hasClaim) issue(['claim'], `${command.state} cannot carry an active claim`);

  if (isQueued) {
    if (command.workflow.runId !== null) issue(['workflow', 'runId'], 'queued cannot carry a run ID');
    if (command.workflow.startDispatchState !== 'not_dispatched') issue(['workflow', 'startDispatchState'], 'queued cannot carry dispatch evidence');
    for (const field of ['processingStartedAt', 'processingDeadlineAt', 'nextAttemptAt'] as const) {
      if (command.retry[field] !== null) issue(['retry', field], `queued cannot carry ${field}`);
    }
  } else {
    if (command.workflow.runId === null) issue(['workflow', 'runId'], `${command.state} requires a persisted workflow run ID`);
    if (command.retry.processingStartedAt === null) issue(['retry', 'processingStartedAt'], `${command.state} requires processingStartedAt`);
  }

  if (command.workflow.resourceId !== command.resourceId) issue(['workflow', 'resourceId'], 'workflow resourceId must match command resourceId');
  if (command.state === 'starting') {
    const expectedRunId = `cc-save-v1:${command.commandId}:${command.workflow.attempt}`;
    if (command.workflow.runId !== expectedRunId) issue(['workflow', 'runId'], 'starting requires its deterministic run ID');
  }
  if (['running', 'retry_wait', 'suspended', 'resuming', 'succeeded'].includes(command.state) && command.workflow.startDispatchState !== 'dispatched') {
    issue(['workflow', 'startDispatchState'], `${command.state} requires dispatched evidence`);
  }
  if (isTerminal && command.workflow.startDispatchState === 'start_unknown' && (command.retry.errorClass === null || command.retry.errorCode === null || command.retry.lastSafeError === null)) {
    issue(['retry'], 'terminal start_unknown requires stable reconciliation error evidence');
  }
  if (isSuspended) {
    if (command.retry.processingDeadlineAt !== null) issue(['retry', 'processingDeadlineAt'], 'human suspension pauses the processing deadline');
    if (command.progress.suspensionGeneration === 0 || command.progress.blockerId === null) issue(['progress'], 'suspended requires the current blocker generation');
  } else if (command.state === 'resuming') {
    const retryResume = command.progress.blockerId === null;
    const suspensionResume = command.progress.suspensionGeneration > 0 && command.progress.blockerId !== null;
    if (!retryResume && !suspensionResume) issue(['progress'], 'resuming requires either retry or accepted blocker correlation');
  } else if (command.progress.blockerId !== null) {
    issue(['progress', 'blockerId'], `${command.state} cannot carry an active blocker`);
  }
  if (!isQueued && !isSuspended && !isSuspensionExpiryTimeout && command.retry.processingDeadlineAt === null) issue(['retry', 'processingDeadlineAt'], `${command.state} requires processingDeadlineAt`);
  if (command.state === 'retry_wait' && command.retry.nextAttemptAt === null) issue(['retry', 'nextAttemptAt'], 'retry_wait requires nextAttemptAt');
  if (command.state !== 'retry_wait' && command.retry.nextAttemptAt !== null) issue(['retry', 'nextAttemptAt'], `${command.state} cannot carry nextAttemptAt`);
  if (isTerminal ? command.terminalGeneration === 0 : command.terminalGeneration !== 0) issue(['terminalGeneration'], 'terminal generation must be positive only for terminal states');
});

export const StageRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  stageRecordId: id,
  commandId: id,
  runId: id,
  stage: id,
  idempotencyKey: id,
  state: StageStateV0Schema,
  expectedSheetFingerprint: sha256.nullable(),
  expectedRowVersion: nonNegativeInteger.nullable(),
  externalReference: z.string().trim().min(1).max(1_024).nullable(),
  contentHash: sha256.nullable(),
  safeOutcome: z.enum(['not_started', 'effect_verified', 'effect_absent', 'outcome_unknown', 'authorization_blocked', 'compensated']),
  plannedAt: isoDateTime,
  applyingAt: isoDateTime.nullable(),
  completedAt: isoDateTime.nullable(),
  updatedAt: isoDateTime,
}).superRefine((stage, context) => {
  const allowedOutcomes: Record<typeof stage.state, typeof stage.safeOutcome[]> = {
    planned: ['not_started'],
    applying: ['not_started'],
    applied: ['effect_verified'],
    outcome_unknown: ['outcome_unknown'],
    reconciled: ['effect_verified', 'effect_absent'],
    authorization_blocked: ['authorization_blocked'],
    compensated: ['compensated'],
  };
  if (!allowedOutcomes[stage.state].includes(stage.safeOutcome)) {
    context.addIssue({ code: 'custom', path: ['safeOutcome'], message: `${stage.state} cannot have safe outcome ${stage.safeOutcome}` });
  }
});

const AllowedResponseSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('confirmation'), choices: z.array(id).min(1).max(10) }),
  z.strictObject({ kind: z.literal('text'), minimumLength: positiveInteger, maximumLength: positiveInteger.max(4_000) })
    .refine(({ minimumLength, maximumLength }) => minimumLength <= maximumLength, { path: ['minimumLength'], message: 'minimumLength cannot exceed maximumLength' }),
]);
export const ResumePayloadV1Schema = z.strictObject({ schemaVersion: z.literal(1), kind: z.enum(['confirmation', 'text']), value: z.string().trim().min(1).max(4_000) });

export const BlockerEnvelopeV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  blockerId: id,
  commandId: id,
  runId: id,
  suspendedStep: id,
  suspensionGeneration: positiveInteger,
  ...identityFields,
  blockerKind: z.enum(['needs_browser_session', 'reauth_required', 'manual_intervention_required', 'browser_intervention_required', 'clarification_required']),
  state: BlockerStateV0Schema,
  sourceHash: sha256,
  profileHash: sha256,
  promptVersion: positiveInteger,
  promptHash: sha256,
  resumeSchemaVersion: z.literal(1),
  resumeSchemaHash: sha256,
  allowedResponse: AllowedResponseSchema,
  issuedAt: isoDateTime,
  expiresAt: isoDateTime,
  acceptedAt: isoDateTime.nullable(),
  resumePayload: ResumePayloadV1Schema.nullable(),
  resumePayloadHash: sha256.nullable(),
  safeMessage: safeText,
}).superRefine((blocker, context) => {
  if (Date.parse(blocker.expiresAt) <= Date.parse(blocker.issuedAt)) {
    context.addIssue({ code: 'custom', path: ['expiresAt'], message: 'blocker expiry must be after issue time' });
  }
  const accepted = ['accepted', 'applying', 'applied'].includes(blocker.state);
  const acceptanceValues = [blocker.acceptedAt, blocker.resumePayload, blocker.resumePayloadHash];
  if (accepted && acceptanceValues.some((value) => value === null)) {
    context.addIssue({ code: 'custom', path: ['resumePayload'], message: `${blocker.state} requires complete acceptance evidence` });
  }
  if (!accepted && acceptanceValues.some((value) => value !== null)) {
    context.addIssue({ code: 'custom', path: ['resumePayload'], message: `${blocker.state} cannot carry acceptance evidence` });
  }
  if (blocker.acceptedAt !== null && (Date.parse(blocker.acceptedAt) < Date.parse(blocker.issuedAt) || Date.parse(blocker.acceptedAt) >= Date.parse(blocker.expiresAt))) {
    context.addIssue({ code: 'custom', path: ['acceptedAt'], message: 'acceptance must occur while the blocker is valid' });
  }
  if (blocker.resumePayload !== null) {
    if (blocker.resumePayload.schemaVersion !== blocker.resumeSchemaVersion) context.addIssue({ code: 'custom', path: ['resumePayload', 'schemaVersion'], message: 'resume payload must match the bound schema version' });
    if (blocker.resumePayload.kind !== blocker.allowedResponse.kind) context.addIssue({ code: 'custom', path: ['resumePayload', 'kind'], message: 'resume kind must match allowed response kind' });
    if (blocker.allowedResponse.kind === 'confirmation' && !blocker.allowedResponse.choices.includes(blocker.resumePayload.value)) {
      context.addIssue({ code: 'custom', path: ['resumePayload', 'value'], message: 'confirmation must be an allowed choice' });
    }
    if (blocker.allowedResponse.kind === 'text') {
      const length = blocker.resumePayload.value.length;
      if (length < blocker.allowedResponse.minimumLength || length > blocker.allowedResponse.maximumLength) context.addIssue({ code: 'custom', path: ['resumePayload', 'value'], message: 'text response violates configured length bounds' });
    }
  }
});

const EvidenceExcerptSchema = z.strictObject({
  excerptId: id,
  text: z.string().min(1).max(4_000),
  start: nonNegativeInteger,
  end: positiveInteger,
  hash: sha256,
});

export const EvidenceRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  evidenceId: id,
  commandId: id,
  canonicalUrl,
  acquiredAt: isoDateTime,
  retentionDeadline: isoDateTime,
  acquisitionMethod: z.enum(['direct_fetch', 'browser']),
  sourceHash: sha256,
  sourceVersion: id,
  profileHash: sha256,
  profileVersion: id,
  contentType: z.enum(['text/html', 'application/xhtml+xml', 'text/plain', 'application/json']),
  extractedCharacterCount: nonNegativeInteger.max(V0_DEFAULTS.browser.extractedCharacters),
  excerpts: z.array(EvidenceExcerptSchema).max(200),
}).superRefine((evidence, context) => {
  for (const [index, excerpt] of evidence.excerpts.entries()) {
    if (excerpt.start >= excerpt.end) context.addIssue({ code: 'custom', path: ['excerpts', index, 'end'], message: 'excerpt start must be before end' });
    if (excerpt.end > evidence.extractedCharacterCount) context.addIssue({ code: 'custom', path: ['excerpts', index, 'end'], message: 'excerpt span exceeds extracted character count' });
  }
});

const CitedExcerptSchema = z.strictObject({
  evidenceId: id,
  start: nonNegativeInteger,
  end: positiveInteger,
  text: z.string().min(1).max(4_000),
  hash: sha256,
}).refine(({ start, end }) => start < end, { path: ['end'], message: 'cited excerpt start must be before end' });

export const ArtifactManifestV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  artifactId: id,
  commandId: id,
  runId: id,
  auditability: z.literal('auditable_and_traceable'),
  canonicalUrl,
  acquiredAt: isoDateTime,
  evidenceIds: z.array(id).min(1).max(200),
  sourceHash: sha256,
  profileHash: sha256,
  sourceVersion: id,
  profileVersion: id,
  promptId: id,
  promptVersion: id,
  schemaId: id,
  modelId: id,
  stageRecordIds: z.array(id).min(1).max(100),
  finalArtifactHash: sha256,
  reportReference: z.string().trim().min(1).max(1_024),
  citedExcerpts: z.array(CitedExcerptSchema).min(1).max(200),
  fullPageSnapshotRetained: z.literal(false),
}).superRefine((artifact, context) => {
  for (const [index, citation] of artifact.citedExcerpts.entries()) {
    if (!artifact.evidenceIds.includes(citation.evidenceId)) context.addIssue({ code: 'custom', path: ['citedExcerpts', index, 'evidenceId'], message: 'citation evidenceId must be declared in evidenceIds' });
  }
});

const ArtifactReferenceSchema = z.strictObject({ artifactId: id, reference: z.string().trim().min(1).max(1_024), hash: sha256 });
const VersionReferenceSchema = z.strictObject({ promptId: id, version: id });
const SchemaVersionReferenceSchema = z.strictObject({ schemaId: id, version: positiveInteger });
const CompletionRetrySchema = z.strictObject({ stage: id, attempt: positiveInteger, nextAttemptAt: isoDateTime.nullable(), safeError: safeText });
const CompletionBlockerSchema = z.strictObject({ blockerId: id, kind: id, requiredAction: safeText, expiresAt: isoDateTime });
const CompletionHandoffCommonFields = {
  evidencedTitle: shortText.nullable(),
  evidencedCompany: shortText.nullable(),
  finalTrackerStatus: id.nullable(),
  topicCount: nonNegativeInteger.max(1_000),
  warnings: z.array(shortText).max(20),
};
const CompletionDetailSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('success'), trackerReference: id, reportReference: id }),
  z.strictObject({ kind: z.literal('duplicate'), linkedPriorCommandId: id, trackerReference: id, reportReference: id }),
  z.strictObject({ kind: z.literal('failure'), failedStage: id.nullable(), errorClass: id, errorCode: id, safeError: safeText }),
  z.strictObject({ kind: z.literal('timeout'), failedStage: id.nullable(), errorClass: id, errorCode: id, safeError: safeText }),
  z.strictObject({ kind: z.literal('suspension'), safeReason: safeText }),
]);
const CompletionHandoffSchema = z.strictObject({ ...CompletionHandoffCommonFields, details: CompletionDetailSchema });
const completionCommonFields = {
  schemaVersion: z.literal(1),
  envelopeId: id,
  idempotencyKey: id,
  commandId: id,
  runId: id,
  requestId: id,
  ...identityFields,
  origin: OriginCorrelationSchema,
  latestStage: id.nullable(),
  retry: CompletionRetrySchema.nullable(),
  artifacts: z.array(ArtifactReferenceSchema).max(20),
  safeSummary: safeText,
  safeInput: z.strictObject({ originalUrl: safeHttpsUrl, canonicalUrl }),
  handoff: CompletionHandoffSchema,
  promptVersions: z.array(VersionReferenceSchema).max(20),
  schemaVersions: z.array(SchemaVersionReferenceSchema).min(1).max(20),
  writes: z.strictObject({
    completed: z.array(id).max(20),
    notCompleted: z.array(id).max(20),
    priorTrackerStatusPreserved: z.boolean(),
    reconciliationRequired: z.boolean(),
  }),
  createdAt: isoDateTime,
};
const SuspensionCompletionEnvelopeV1Schema = z.strictObject({
  ...completionCommonFields,
  envelopeKind: z.literal('suspension'),
  terminalGeneration: z.null(),
  suspensionGeneration: positiveInteger,
  queueState: z.literal('suspended'),
  outcome: z.literal('blocked'),
  blocker: CompletionBlockerSchema,
  handoff: z.strictObject({ ...CompletionHandoffCommonFields, details: z.strictObject({ kind: z.literal('suspension'), safeReason: safeText }) }),
});
const TerminalCompletionEnvelopeV1Schema = z.strictObject({
  ...completionCommonFields,
  envelopeKind: z.literal('terminal'),
  terminalGeneration: positiveInteger,
  suspensionGeneration: z.null(),
  queueState: z.enum(['succeeded', 'failed', 'timed_out']),
  outcome: z.enum(['succeeded', 'previously_seen', 'failed', 'timed_out']),
  blocker: z.null(),
  handoff: CompletionHandoffSchema,
}).superRefine((envelope, context) => {
  if (['succeeded', 'previously_seen'].includes(envelope.outcome) && envelope.handoff.finalTrackerStatus === null) {
    context.addIssue({ code: 'custom', path: ['handoff', 'finalTrackerStatus'], message: `${envelope.outcome} handoff requires final tracker status` });
  }
  const outcomeMatches = envelope.queueState === 'succeeded'
    ? ['succeeded', 'previously_seen'].includes(envelope.outcome)
    : envelope.outcome === envelope.queueState;
  if (!outcomeMatches) context.addIssue({ code: 'custom', path: ['outcome'], message: `${envelope.queueState} cannot have outcome ${envelope.outcome}` });
  const expectedKind = envelope.outcome === 'previously_seen' ? 'duplicate' : envelope.outcome === 'failed' ? 'failure' : envelope.outcome === 'timed_out' ? 'timeout' : 'success';
  if (envelope.handoff.details.kind !== expectedKind) context.addIssue({ code: 'custom', path: ['handoff', 'details', 'kind'], message: `${envelope.outcome} requires ${expectedKind} handoff details` });
});

export const CompletionEnvelopeV1Schema = z.discriminatedUnion('envelopeKind', [
  SuspensionCompletionEnvelopeV1Schema,
  TerminalCompletionEnvelopeV1Schema,
]);

export const TurnDeliveryV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  turnDeliveryId: id,
  transportEventId: id,
  turnId: id,
  deliveryKey: id,
  ...identityFields,
  origin: OriginCorrelationSchema,
  renderedResponse: boundedRenderedResponse,
  responseHash: sha256,
  createdAt: isoDateTime,
});

const DeliverySourceSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('completion'), envelopeId: id, commandId: id, runId: id }),
  z.strictObject({ kind: z.literal('turn'), turnDeliveryId: id }),
]);
const ProviderEvidenceSchema = z.strictObject({
  provider: z.enum(['telegram', 'studio', 'stdio']),
  outcome: z.enum(['acknowledged', 'definite_failure', 'unknown']),
  messageId: id.nullable(),
  observedAt: isoDateTime,
});

export const DeliveryRecordV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  deliveryRecordId: id,
  source: DeliverySourceSchema,
  deliveryKey: id,
  ...identityFields,
  origin: OriginCorrelationSchema,
  state: DeliveryStateV0Schema,
  authorizationRevision: nonNegativeInteger,
  claimGeneration: nonNegativeInteger,
  claimOwner: id.nullable(),
  claimExpiresAt: isoDateTime.nullable(),
  heartbeatAt: isoDateTime.nullable(),
  renderedResponse: boundedRenderedResponse.nullable(),
  responseHash: sha256.nullable(),
  attemptCount: nonNegativeInteger,
  firstAttemptAt: isoDateTime.nullable(),
  nextAttemptAt: isoDateTime.nullable(),
  retryDeadlineAt: isoDateTime,
  providerEvidence: ProviderEvidenceSchema.nullable(),
  lastSafeError: safeText.nullable(),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
}).superRefine((delivery, context) => {
  const issue = (path: string[], message: string) => context.addIssue({ code: 'custom', path, message });
  const claimValues = [delivery.claimOwner, delivery.claimExpiresAt, delivery.heartbeatAt];
  const hasClaim = claimValues.every((value) => value !== null);
  if (!hasClaim && !claimValues.every((value) => value === null)) issue(['claimOwner'], 'delivery claim fields must be all present or all null');
  if (['claimed', 'sending'].includes(delivery.state)) {
    if (!hasClaim) issue(['claimOwner'], `${delivery.state} requires a complete claim`);
    if (delivery.claimGeneration === 0) issue(['claimGeneration'], `${delivery.state} requires a positive claim generation`);
  } else if (hasClaim) issue(['claimOwner'], `${delivery.state} cannot carry an active claim`);
  const hasRendering = delivery.renderedResponse !== null && delivery.responseHash !== null;
  if ((delivery.renderedResponse === null) !== (delivery.responseHash === null)) issue(['renderedResponse'], 'rendered response and hash must be present together');
  if (['pending', 'claimed'].includes(delivery.state) && hasRendering) issue(['renderedResponse'], `${delivery.state} cannot carry rendered bytes`);
  if (['rendered', 'sending', 'delivered', 'retry_wait', 'send_unknown', 'dead_letter'].includes(delivery.state) && !hasRendering) issue(['renderedResponse'], `${delivery.state} requires rendered bytes and hash`);
  if ((delivery.attemptCount === 0) !== (delivery.firstAttemptAt === null)) issue(['firstAttemptAt'], 'firstAttemptAt must be null exactly when attemptCount is zero');
  if (['sending', 'delivered', 'retry_wait', 'send_unknown', 'dead_letter'].includes(delivery.state) && delivery.attemptCount === 0) issue(['attemptCount'], `${delivery.state} requires a provider attempt`);
  if (delivery.state === 'delivered' && (delivery.providerEvidence?.outcome !== 'acknowledged' || delivery.providerEvidence.messageId === null)) issue(['providerEvidence'], 'delivered requires acknowledged provider evidence and message ID');
  if (delivery.state === 'send_unknown' && delivery.providerEvidence?.outcome !== 'unknown') issue(['providerEvidence'], 'send_unknown requires unknown provider evidence');
  if (delivery.state === 'retry_wait' && delivery.providerEvidence?.outcome !== 'definite_failure') issue(['providerEvidence'], 'retry_wait requires definite failure evidence');
  if (delivery.state === 'dead_letter' && delivery.providerEvidence?.outcome !== 'definite_failure') issue(['providerEvidence'], 'dead_letter requires definite failure evidence');
  if (['pending', 'claimed', 'rendered', 'sending', 'blocked'].includes(delivery.state) && delivery.providerEvidence !== null) issue(['providerEvidence'], `${delivery.state} cannot carry provider outcome evidence`);
  if (delivery.providerEvidence?.outcome !== 'acknowledged' && delivery.providerEvidence?.messageId !== null && delivery.providerEvidence !== null) issue(['providerEvidence', 'messageId'], 'non-acknowledged evidence cannot carry a provider message ID');
  if (delivery.state === 'retry_wait' ? delivery.nextAttemptAt === null : delivery.nextAttemptAt !== null) issue(['nextAttemptAt'], `${delivery.state} has inconsistent retry schedule`);
});

export const HealthSnapshotV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  generatedAt: isoDateTime,
  status: z.enum(['starting', 'ready', 'degraded', 'not_ready']),
  ready: z.boolean(),
  degraded: z.boolean(),
  database: z.strictObject({ reachable: z.boolean(), migrationsComplete: z.boolean(), schemaVersion: nonNegativeInteger.nullable() }),
  workers: z.strictObject({ worker: z.enum(['stopped', 'starting', 'running', 'draining']), reconciler: z.enum(['stopped', 'running']), dispatcher: z.enum(['stopped', 'running']) }),
  queue: z.strictObject({
    depth: nonNegativeInteger,
    oldestRunnableAgeSeconds: nonNegativeInteger,
    expiredLeaseCount: nonNegativeInteger,
    expiredLeaseReconciliationCycles: nonNegativeInteger,
    retryWaitCount: nonNegativeInteger,
    suspendedCount: nonNegativeInteger,
  }),
  deliveries: z.strictObject({ pendingCount: nonNegativeInteger, blockedCount: nonNegativeInteger, sendUnknownCount: nonNegativeInteger, oldestPendingAgeSeconds: nonNegativeInteger }),
  capabilities: z.strictObject({ browser: z.enum(['available', 'unavailable', 'degraded']), channel: z.enum(['available', 'unavailable', 'degraded']) }),
  reasons: z.array(shortText).max(20),
}).superRefine((health, context) => {
  const flags = {
    starting: { ready: false, degraded: false },
    ready: { ready: true, degraded: false },
    degraded: { ready: true, degraded: true },
    not_ready: { ready: false, degraded: false },
  }[health.status];
  if (health.ready !== flags.ready) context.addIssue({ code: 'custom', path: ['ready'], message: `${health.status} has inconsistent ready flag` });
  if (health.degraded !== flags.degraded) context.addIssue({ code: 'custom', path: ['degraded'], message: `${health.status} has inconsistent degraded flag` });
});

const RetentionRuleSchema = z.discriminatedUnion('retention', [
  z.strictObject({ dataClass: id, retention: z.literal('days'), days: positiveInteger }),
  z.strictObject({ dataClass: id, retention: z.enum(['discard_after_validation', 'until_resolved_then_90_days', 'until_owner_deletion', 'until_revoke_or_reset', 'indefinite']) }),
]);

export const RetentionPolicyV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  policyId: z.literal('career-copilot-v0'),
  effectiveAt: isoDateTime,
  rules: z.array(RetentionRuleSchema).min(1).max(20),
  conversationRetrievalLastMessages: z.literal(20),
  deletionOrder: z.tuple([
    z.literal('disable_future_access'),
    z.literal('remove_derived_data_and_secrets'),
    z.literal('append_minimal_tombstone'),
  ]),
  exportFormat: z.literal('schema_versioned_safe_json_plus_artifact_references'),
});

export const V0_RETENTION_POLICY = {
  schemaVersion: 1,
  policyId: 'career-copilot-v0',
  effectiveAt: '2026-08-02T00:00:00.000Z',
  rules: [
    { dataClass: 'raw_channel_update', retention: 'discard_after_validation' },
    { dataClass: 'standalone_sanitized_evidence', retention: 'days', days: 30 },
    { dataClass: 'terminal_queue_run_attempt_blocker', retention: 'days', days: 90 },
    { dataClass: 'delivered_delivery_record', retention: 'days', days: 90 },
    { dataClass: 'unresolved_outbox', retention: 'until_resolved_then_90_days' },
    { dataClass: 'conversation_messages_after_thread_activity', retention: 'days', days: 90 },
    { dataClass: 'reports_topics_tracker_rows', retention: 'until_owner_deletion' },
    { dataClass: 'report_bounded_cited_excerpts', retention: 'until_owner_deletion' },
    { dataClass: 'oauth_token_and_browser_profile', retention: 'until_revoke_or_reset' },
    { dataClass: 'minimal_audit_tombstone', retention: 'indefinite' },
    { dataClass: 'structured_operational_logs', retention: 'days', days: 30 },
  ],
  conversationRetrievalLastMessages: 20,
  deletionOrder: ['disable_future_access', 'remove_derived_data_and_secrets', 'append_minimal_tombstone'],
  exportFormat: 'schema_versioned_safe_json_plus_artifact_references',
} as const;

export type UntrustedInboundEventV1 = z.infer<typeof UntrustedInboundEventV1Schema>;
export type InboundEventV1 = z.infer<typeof InboundEventV1Schema>;
export type ResumePayloadV1 = z.infer<typeof ResumePayloadV1Schema>;
export type CommandV1 = z.infer<typeof CommandV1Schema>;
export type StageRecordV1 = z.infer<typeof StageRecordV1Schema>;
export type BlockerEnvelopeV1 = z.infer<typeof BlockerEnvelopeV1Schema>;
export type EvidenceRecordV1 = z.infer<typeof EvidenceRecordV1Schema>;
export type ArtifactManifestV1 = z.infer<typeof ArtifactManifestV1Schema>;
export type CompletionEnvelopeV1 = z.infer<typeof CompletionEnvelopeV1Schema>;
export type TurnDeliveryV1 = z.infer<typeof TurnDeliveryV1Schema>;
export type DeliveryRecordV1 = z.infer<typeof DeliveryRecordV1Schema>;
export type HealthSnapshotV1 = z.infer<typeof HealthSnapshotV1Schema>;
export type RetentionPolicyV1 = z.infer<typeof RetentionPolicyV1Schema>;
