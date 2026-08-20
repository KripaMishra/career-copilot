import { createCareerToolContext } from '../tools/career-context.ts';
import { assertRawTelegramUpdate, authorizeResumeDocument, deriveTelegramRequest, RESUME_MAX_DOWNLOAD_BYTES, type PrincipalInput, type TelegramDocument } from '../channels/telegram-auth.ts';
import { DownloadLimitExceededError, type TelegramFileDownload } from '../channels/telegram-transport.ts';
import { CareerStore, ResumeRevalidationError } from '../storage/career-store.ts';
import type { Job } from '../contracts/v0.ts';
import { OnboardingDecisionSchema, assertSafeOnboardingDraft, isDirectIdentifierOnboardingInput, isUnavailableOnboardingInput, nextOnboardingQuestion, onboardingFieldFromLabel, onboardingFields, onboardingMissingFields, onboardingReviewText, requiredOnboardingComplete, type OnboardingDecision, type OnboardingDraft, type OnboardingStatus } from '../contracts/onboarding.ts';
import type { AppLogger } from '../observability.ts';
import { extractPdfText, type PdfRejectionReason } from '../integrations/pdf-text.ts';
import type { PiiService } from './pii.ts';
import type { DiscoveryCommandHandler } from '../discovery/commands.ts';

export type Command = { kind: 'save'; url: string } | { kind: 'job'; jobId?: string } | { kind: 'queue' } | { kind: 'onboarding'; action: 'start' | 'restart' | 'cancel' | 'status' } | { kind: 'reset'; scope: 'onboarding' | 'profile' | 'all' } | { kind: 'discovery'; action: 'status' | 'on' | 'off' };
export type WorkflowTask = { id: string; content: string; status: 'pending'; activeForm: string };
export type CommandWorkflow = { id: string; tasks: WorkflowTask[] };

const workflows: Record<string, CommandWorkflow> = {
  save_job: { id: 'save_job', tasks: [
    { id: 'validate_url', content: 'Validate and canonicalize the requested job URL', status: 'pending', activeForm: 'Validating the requested job URL' },
    { id: 'check_profile', content: 'Check persisted and current-turn career context', status: 'pending', activeForm: 'Checking career context' },
    { id: 'save_job', content: 'Call save-job exactly once when context is sufficient', status: 'pending', activeForm: 'Saving the job' },
    { id: 'report_result', content: 'Report only the tool-confirmed job result', status: 'pending', activeForm: 'Reporting the confirmed job result' },
  ] },
  job_status: { id: 'job_status', tasks: [
    { id: 'resolve_job', content: 'Resolve the requested or latest owned job', status: 'pending', activeForm: 'Resolving the requested job' },
    { id: 'check_status', content: 'Call job-status for the resolved job', status: 'pending', activeForm: 'Checking the persisted job status' },
    { id: 'report_result', content: 'Report only the returned persisted status and safe summary', status: 'pending', activeForm: 'Reporting the persisted job status' },
  ] },
  job_queue: { id: 'job_queue', tasks: [
    { id: 'resolve_scope', content: 'Resolve the trusted owner and conversation scope', status: 'pending', activeForm: 'Resolving the trusted job scope' },
    { id: 'check_queue', content: 'Call job-queue for the current conversation', status: 'pending', activeForm: 'Checking the persisted job queue' },
    { id: 'report_result', content: 'Report only returned persisted job IDs and statuses', status: 'pending', activeForm: 'Reporting the persisted job queue' },
  ] },
  onboarding: { id: 'onboarding', tasks: [
    { id: 'read_state', content: 'Read the current onboarding state', status: 'pending', activeForm: 'Reading the onboarding state' },
    { id: 'collect_facts', content: 'Collect and validate structured career facts', status: 'pending', activeForm: 'Collecting structured career facts' },
    { id: 'review_profile', content: 'Move to review only when required fields are complete', status: 'pending', activeForm: 'Preparing the profile for review' },
    { id: 'activate_profile', content: 'Activate the profile only after exact runtime confirmation', status: 'pending', activeForm: 'Activating the confirmed profile' },
  ] },
  onboarding_restart: { id: 'onboarding_restart', tasks: [
    { id: 'clear_draft', content: 'Clear only the current onboarding draft', status: 'pending', activeForm: 'Clearing the onboarding draft' },
    { id: 'start_onboarding', content: 'Start a fresh structured onboarding flow', status: 'pending', activeForm: 'Starting fresh onboarding' },
  ] },
  onboarding_cancel: { id: 'onboarding_cancel', tasks: [
    { id: 'read_state', content: 'Read the active onboarding draft', status: 'pending', activeForm: 'Reading the onboarding draft' },
    { id: 'clear_draft', content: 'Cancel and clear only the onboarding draft', status: 'pending', activeForm: 'Clearing the onboarding draft' },
    { id: 'report_result', content: 'Confirm profile and jobs were not changed', status: 'pending', activeForm: 'Reporting the cancellation result' },
  ] },
  onboarding_status: { id: 'onboarding_status', tasks: [
    { id: 'read_state', content: 'Read the authoritative onboarding state', status: 'pending', activeForm: 'Reading the onboarding state' },
    { id: 'check_profile', content: 'Check whether a confirmed profile is active', status: 'pending', activeForm: 'Checking the confirmed profile state' },
    { id: 'report_result', content: 'Report the deterministic onboarding status', status: 'pending', activeForm: 'Reporting the onboarding status' },
  ] },
  reset_onboarding: { id: 'reset_onboarding', tasks: [
    { id: 'verify_scope', content: 'Verify the authenticated owner and conversation scope', status: 'pending', activeForm: 'Verifying the reset scope' },
    { id: 'clear_draft', content: 'Clear only the current onboarding draft', status: 'pending', activeForm: 'Clearing the onboarding draft' },
    { id: 'report_result', content: 'Report the idempotent reset result', status: 'pending', activeForm: 'Reporting the onboarding reset' },
  ] },
  reset_profile: { id: 'reset_profile', tasks: [
    { id: 'verify_scope', content: 'Verify the authenticated owner scope', status: 'pending', activeForm: 'Verifying the reset scope' },
    { id: 'clear_profile', content: 'Remove the owner profile and onboarding drafts', status: 'pending', activeForm: 'Clearing the owner profile' },
    { id: 'report_result', content: 'Report safe counts and preserved job data', status: 'pending', activeForm: 'Reporting the profile reset' },
  ] },
  reset_all: { id: 'reset_all', tasks: [
    { id: 'verify_scope', content: 'Verify the authenticated owner scope', status: 'pending', activeForm: 'Verifying the reset scope' },
    { id: 'delete_owner_data', content: 'Delete owner-scoped reports, jobs, profile, and onboarding data transactionally', status: 'pending', activeForm: 'Deleting owner-scoped data' },
    { id: 'report_result', content: 'Report only the committed reset counts', status: 'pending', activeForm: 'Reporting the complete reset' },
  ] },
};

function workflowFor(command: Command | null): CommandWorkflow | null {
  if (!command) return null;
  if (command.kind === 'save') return workflows.save_job;
  if (command.kind === 'job') return workflows.job_status;
  if (command.kind === 'queue') return workflows.job_queue;
  if (command.kind === 'onboarding') return workflows[command.action === 'start' ? 'onboarding' : `onboarding_${command.action}`];
  if (command.kind === 'discovery') return null;
  return workflows[`reset_${command.scope}`];
}

export function commandWorkflow(command: Command | null): CommandWorkflow | null {
  const workflow = workflowFor(command);
  return workflow ? { id: workflow.id, tasks: workflow.tasks.map((task) => ({ ...task })) } : null;
}

function workflowInstruction(command: Command) {
  const workflow = commandWorkflow(command);
  if (!workflow) return '';
  return `Execute workflow ${workflow.id}. At the start, use task_write with this exact checklist: ${JSON.stringify(workflow.tasks)}. Use task_update or task_complete only as the corresponding step succeeds, and use task_check before the final response. Task completion is bookkeeping, not proof of business success.`;
}

function onboardingStatusReply(status: Awaited<ReturnType<CareerStore['onboardingStatus']>>) {
  if (status.found && status.status === 'collecting') return `Onboarding is active and collecting answers. ${status.missingFields.length} required field(s) remain.`;
  if (status.found && status.status === 'review') return 'Onboarding is in review. Send exactly confirm to activate the profile.';
  if (status.profileFound) return 'Onboarding is complete. Your confirmed profile is active.';
  return 'Onboarding is not active and no confirmed profile is saved. Send /onboarding to start.';
}

function resetReply(scope: 'onboarding' | 'profile' | 'all', counts: Record<string, number>) {
  if (scope === 'onboarding') return `Onboarding draft reset. ${counts.onboardingRows ?? 0} draft row(s) cleared.`;
  if (scope === 'profile') return `Profile reset. ${counts.profileDocuments ?? 0} profile document(s) and ${counts.onboardingRows ?? 0} onboarding row(s) cleared. Jobs and reports were preserved.`;
  return `Complete reset committed. ${counts.jobs ?? 0} job(s), ${counts.reports ?? 0} report(s), ${counts.profileDocuments ?? 0} profile document(s), and ${counts.onboardingRows ?? 0} onboarding row(s) cleared. Conversation history and task state are preserved.`;
}
const unavailableOnboardingReply = 'Resume, URL, and file ingestion are unavailable in V1. Please answer the current structured question instead.';
const longOnboardingReply = 'That onboarding answer is too long (maximum 4000 characters). Please shorten it and try again.';
const onboardingModelRetryReply = 'I could not safely process that onboarding reply. Please try again with a short text answer.';
const directIdentifierOnboardingReply = 'That looks like direct personal identifier or credential information, which onboarding cannot accept. Please share only career-relevant facts.';
const redactionFailedReply = 'Your document could not be processed safely. Please try again or share the information as text.';
const resumeUnavailableReply = 'Resume document ingestion is currently unavailable. Please answer the structured questions or share your details as text.';
const resumeNoOnboardingReply = 'Start /onboarding first, then send your resume PDF.';
function resumeRejectionReply(reason: PdfRejectionReason | 'download_failed'): string {
  switch (reason) {
    case 'not_a_document': return 'That message is not a supported document.';
    case 'unsupported_mime': return 'Only text-based PDF documents are accepted.';
    case 'unsupported_extension': return 'Only .pdf documents are accepted.';
    case 'oversized': return 'That document is too large (maximum 5 MiB).';
    case 'caption_unsupported': return 'Documents with captions are not accepted. Please send the PDF without a caption.';
    case 'download_failed': return 'The document could not be downloaded safely. Please try again.';
    case 'not_pdf': return 'That file is not a valid PDF.';
    case 'encrypted': return 'Encrypted PDFs cannot be processed safely.';
    case 'malformed': return 'That PDF is malformed and could not be read.';
    case 'no_text': return 'That PDF contains no extractable text (scanned or image-only PDFs are not supported).';
    case 'too_many_pages': return 'That PDF has too many pages (maximum 50).';
    case 'overlong': return 'That PDF has too much text (maximum 200,000 characters).';
    case 'timeout': return 'The PDF could not be processed in time. Please try a smaller document.';
  }
}

/**
 * Pre-agent redaction trust boundary: raw extracted resume text goes through
 * the local engine before anything else sees it. Fails closed — while PII is
 * disabled or un-warmed, or when redaction itself throws, nothing raw
 * proceeds; callers surface a safe message instead.
 */
export async function redactTextForIngestion(pii: PiiService, text: string, logger?: AppLogger): Promise<string> {
  if (!pii.enabled || !pii.ready) { try { logger?.('warn', 'pii.redaction.unavailable', {}); } catch { /* logging cannot break ingestion */ } throw new Error(redactionFailedReply); }
  try { return await pii.redactText(text); }
  catch (error) {
    try { logger?.('warn', 'pii.redaction.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); } catch { /* logging cannot break ingestion */ }
    throw new Error(redactionFailedReply);
  }
}

export type ResumeDocumentInput = {
  store: CareerStore; ownerId: string; conversationId: string; requestId: string;
  document: TelegramDocument; pii: PiiService; onboard?: OnboardingResponder;
  download?: TelegramFileDownload; extract?: typeof extractPdfText; logger?: AppLogger; caption?: string;
};

/** Download → bounded extraction → redaction, isolated in one scope (spec rule
 * 11): raw bytes and the extraction object are unreachable once it resolves;
 * only sanitized text and page count survive into the onboarding turn. */
async function extractAndRedactResume(input: ResumeDocumentInput, log: AppLogger): Promise<{ sanitized: string; pageCount: number } | { rejected: string }> {
  let bytes: Uint8Array;
  try {
    const downloaded = await (input.download ?? (async () => { throw new Error('No download transport configured.'); }))(input.document.file_id, { maxBytes: RESUME_MAX_DOWNLOAD_BYTES });
    bytes = downloaded.bytes;
  } catch (error) {
    log('warn', 'resume.download.failed', { errorName: error instanceof DownloadLimitExceededError ? 'DownloadLimitExceeded' : (error instanceof Error ? error.name : 'UnknownError') });
    return { rejected: resumeRejectionReply(error instanceof DownloadLimitExceededError ? 'oversized' : 'download_failed') };
  }
  const extraction = await (input.extract ?? extractPdfText)(bytes);
  if (!extraction.ok) { log('warn', 'resume.extraction.rejected', { reason: extraction.reason }); return { rejected: resumeRejectionReply(extraction.reason) }; }
  try {
    const sanitized = await redactTextForIngestion(input.pii, extraction.text, log);
    return { sanitized, pageCount: extraction.pageCount };
  } catch (error) {
    log('warn', 'pii.redaction.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' });
    return { rejected: redactionFailedReply };
  }
}

/**
 * Bounded resume document ingestion (spec rules 1–12): authorize the envelope
 * before any download, cap the download, verify the signature and extract
 * in-memory under page/char/deadline caps, redact immediately, release the raw
 * bytes, and inject only sanitized text plus page count into the onboarding
 * turn. Every rejection — including redaction failure — is exactly one safe
 * terminal reply; raw bytes and ephemeral Telegram metadata never reach the
 * agent, memory, or persistence.
 */
export async function handleResumeDocument(input: ResumeDocumentInput): Promise<string> {
  const log: AppLogger = (level, event, data) => { try { input.logger?.(level, event, data); } catch { /* logging cannot break ingestion */ } };
  if (!input.pii.enabled || !input.pii.ready) { log('warn', 'resume.ingestion.disabled', { reason: 'not_ready' }); return resumeUnavailableReply; }
  const authorized = authorizeResumeDocument({ document: input.document, ...(input.caption !== undefined ? { caption: input.caption } : {}) });
  if (!authorized.accepted) { log('warn', 'resume.document.rejected', { reason: authorized.reason }); return resumeRejectionReply(authorized.reason); }
  const onboarding = await input.store.loadOnboarding(input.ownerId, input.conversationId);
  if (!onboarding || (onboarding.status !== 'collecting' && onboarding.status !== 'review')) { log('warn', 'resume.ingestion.disabled', { reason: 'no_onboarding' }); return resumeNoOnboardingReply; }
  const prepared = await extractAndRedactResume(input, log);
  if ('rejected' in prepared) return prepared.rejected;
  // D6: persist resume-derived lineage on the onboarding row so every later
  // write (ordinary review edits, confirmation) revalidates at the boundary
  try {
    await input.store.markOnboardingResumeDerived({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: onboarding.version });
  } catch {
    log('warn', 'resume.ingestion.disabled', { reason: 'no_onboarding' });
    return resumeNoOnboardingReply;
  }
  const turnText = `${prepared.sanitized}\n\n[Resume document processed safely: ${prepared.pageCount} page(s) extracted.]`;
  return handleOnboardingTurn({ store: input.store, ownerId: input.ownerId, conversationId: input.conversationId, documentText: turnText, documentPageCount: prepared.pageCount, onboard: input.onboard, logger: log });
}
export function parseCommand(text: string | undefined): Command | null {
  if (!text) return null; const trimmed = text.trim();
  const onboarding = trimmed.match(/^\/(?:onboarding(?:[ \t]+(restart|cancel|status|start))?|onboarding_(restart|cancel|status))$/i); if (onboarding) { const action = (onboarding[1] ?? onboarding[2])?.toLowerCase(); return { kind: 'onboarding', action: action === 'restart' ? 'restart' : action === 'cancel' ? 'cancel' : action === 'status' ? 'status' : 'start' }; }
  const reset = trimmed.match(/^\/(?:reset[ \t]+(onboarding|profile|all)|reset_(onboarding|profile|all))$/i); if (reset) return { kind: 'reset', scope: ((reset[1] ?? reset[2]).toLowerCase()) as 'onboarding' | 'profile' | 'all' };
  const save = trimmed.match(/^\/save[ \t]+(\S+)$/); if (save) return { kind: 'save', url: save[1] }; const job = trimmed.match(/^\/job(?:[ \t]+(\S+))?$/); if (job) return { kind: 'job', ...(job[1] ? { jobId: job[1] } : {}) }; if (trimmed === '/queue') return { kind: 'queue' }; const discovery = trimmed.match(/^\/discovery(?:[ \t]+(status|on|off))?$/i); if (discovery) { return { kind: 'discovery', action: ((discovery[1] ?? 'status').toLowerCase()) as 'status' | 'on' | 'off' }; } return null;
}

export function parseCommandError(text: string | undefined) {
  const trimmed = text?.trim(); if (!trimmed) return null;
  if (/^\/save(?:[ \t]|$)/i.test(trimmed)) return 'Usage: /save <url>.';
  if (/^\/job(?:[ \t]|$)/i.test(trimmed)) return 'Usage: /job [job-id].';
  if (/^\/queue(?:[ \t]|$)/i.test(trimmed)) return 'Usage: /queue.';
  if (/^\/onboarding(?:[ \t]|_|$)/i.test(trimmed)) return 'Usage: /onboarding, /onboarding status, /onboarding restart, or /onboarding cancel.';
  if (/^\/discovery(?:[ \t]|$)/i.test(trimmed)) return 'Usage: /discovery status, /discovery on, or /discovery off.';
  if (/^\/reset(?:[ \t]|_|$)/i.test(trimmed)) return 'Unknown reset command. Use /reset_onboarding, /reset_profile, or /reset_all.';
  return null;
}

export function injectCommand(text: string) { const command = parseCommand(text); if (command?.kind === 'onboarding' || command?.kind === 'reset' || command?.kind === 'discovery') throw new Error('This command is handled by runtime routing, not normal memory injection.'); if (command?.kind === 'save') return `Save this job now: ${command.url}. ${workflowInstruction(command)}`; if (command?.kind === 'job') return `Report the status of ${command.jobId ? `job ${command.jobId}` : 'the latest job'} using the job-status tool. ${workflowInstruction(command)}`; if (command?.kind === 'queue') return `List my saved jobs using the job-queue tool. ${workflowInstruction(command)}`; return text; }

const onboardingReply = (state: Awaited<ReturnType<CareerStore['loadOnboarding']>>) => state?.status === 'review' ? onboardingReviewText(state.draft) : `Let's build your career profile. ${nextOnboardingQuestion(state?.draft ?? {}) ?? 'Share any final preference, or say ready to review.'}`;

export type OnboardingResponderInput = { ownerId: string; conversationId: string; draft: OnboardingDraft; fields: typeof onboardingFields; missingFields: string[]; status: Extract<OnboardingStatus, 'collecting' | 'review'>; text: string };
export type OnboardingResponder = (input: OnboardingResponderInput) => Promise<OnboardingDecision>;

function onboardingPrompt(input: OnboardingResponderInput) {
  return `You are collecting a private career onboarding profile. Return only the requested JSON object.\n\nWorkflow checklist: read_state -> collect_facts -> review_profile -> activate_profile. The runtime, not the model, owns persistence and exact confirmation.\n\nRules:\n- Be conversational and helpful in reply.\n- Answer clarifying/off-topic questions naturally without changing draftPatch unless the user clearly provided profile facts.\n- Extract zero, one, or multiple clearly stated fields. Corrections should patch only the fields being corrected.\n- Ask one useful follow-up question for the most important missing required field.\n- Never invent facts.\n- Never request or accept resumes, files, uploads, URLs, legal name, exact birth date, street address, email, phone, government IDs, financial data, credentials, or tokens.\n- Set readyForReview true only when required fields are complete from the existing draft plus this patch and the user seems ready to review.\n- Do not include confirmation, authorization, activation, owner, chat, user, memory, or tool fields.\n\nCurrent structured draft JSON:\n${JSON.stringify(input.draft)}\n\nAllowed field definitions JSON:\n${JSON.stringify(input.fields.map(({ key, label, question, required }) => ({ key, label, question, required })))}\n\nMissing required fields JSON:\n${JSON.stringify(input.missingFields)}\n\nState JSON:\n${JSON.stringify({ status: input.status })}\n\nCurrent owner text:\n${input.text}`;
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
  try {
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
  } catch (error) {
    if (error instanceof ResumeRevalidationError) { input.logger('warn', 'onboarding.input.blocked', { reason: 'resume_revalidation', status: state.status }); return 'Your resume content could not be saved safely. Please share the details as text instead.'; }
    throw error;
  }
}

export async function handleOnboardingTurn(input: { store: CareerStore; ownerId: string; conversationId: string; text?: string; nonTextInput?: boolean; onboard?: OnboardingResponder; logger?: AppLogger; documentText?: string; documentPageCount?: number }) {
  const log: AppLogger = (level, event, data) => { try { input.logger?.(level, event, data); } catch { /* logging cannot break work */ } };
  const documentTurn = input.documentText !== undefined;
  const command = parseCommand(input.text);
  if (command?.kind === 'onboarding') {
    if (command.action === 'status') return onboardingStatusReply(await input.store.onboardingStatus(input.ownerId, input.conversationId));
    if (command.action === 'cancel') { const state = await input.store.loadOnboarding(input.ownerId, input.conversationId); if (!state || !['collecting', 'review'].includes(state.status)) return 'No active onboarding to cancel.'; await input.store.cancelOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version }); log('info', 'onboarding.cancelled', { status: 'cancelled', version: state.version + 1 }); return 'Onboarding cancelled and draft content cleared. Send /onboarding to start again.'; }
    const state = await input.store.startOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, restart: command.action === 'restart' }); log('info', 'onboarding.started', { status: state.status, version: state.version }); return onboardingReply(state);
  }
  if (command?.kind === 'reset') {
    const counts = command.scope === 'onboarding' ? await input.store.resetOnboarding(input.ownerId, input.conversationId) : command.scope === 'profile' ? await input.store.resetProfile(input.ownerId) : await input.store.resetAll(input.ownerId);
    log('info', 'career.reset', { scope: command.scope, ...counts });
    return resetReply(command.scope, counts);
  }
  const state = await input.store.loadOnboarding(input.ownerId, input.conversationId); if (!state || (state.status !== 'collecting' && state.status !== 'review')) return null;
  if (input.nonTextInput && !documentTurn) { log('warn', 'onboarding.input.blocked', { reason: 'non_text', status: state.status }); return unavailableOnboardingReply; }
  const trimmed = (documentTurn ? input.documentText : input.text)?.trim(); if (!trimmed) return null;
  if (!documentTurn) {
    if (/^\/?cancel$/i.test(trimmed)) { await input.store.cancelOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version }); log('info', 'onboarding.cancelled', { status: 'cancelled', version: state.version + 1 }); return 'Onboarding cancelled and draft content cleared. Send /onboarding to start again.'; }
    if (trimmed.startsWith('/')) { log('warn', 'onboarding.input.blocked', { reason: 'command', status: state.status }); return 'Please finish or cancel onboarding before using commands.'; }
    if (trimmed.length > 4000) { log('warn', 'onboarding.input.blocked', { reason: 'overlength', status: state.status }); return longOnboardingReply; }
    if (isUnavailableOnboardingInput(trimmed)) { log('warn', 'onboarding.input.blocked', { reason: 'unavailable_input', status: state.status }); return unavailableOnboardingReply; }
  }
  if (isDirectIdentifierOnboardingInput(trimmed)) { log('warn', 'onboarding.input.blocked', { reason: 'direct_identifier', status: state.status }); return directIdentifierOnboardingReply; }
  if (state.status === 'review') {
    if (/^confirm$/i.test(trimmed)) {
      try {
        await input.store.completeOnboarding({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version });
        log('info', 'onboarding.completed', { status: 'completed', version: state.version });
        return 'Onboarding complete. Your confirmed profile is active now.';
      } catch (error) {
        if (error instanceof ResumeRevalidationError) { log('warn', 'onboarding.input.blocked', { reason: 'resume_revalidation', status: state.status }); return 'Your resume content could not be saved safely. Please share the details as text instead.'; }
        throw error;
      }
    }
    if (!documentTurn) {
      const edit = trimmed.match(/^edit\s+([^:]+):\s*(.+)$/i); if (edit) { const key = onboardingFieldFromLabel(edit[1]); if (!key) return `Unknown field. Edit one of: ${onboardingFields.map((field) => field.key).join(', ')}.`; try { const saved = await input.store.saveOnboardingDraft({ ownerId: input.ownerId, conversationId: input.conversationId, expectedVersion: state.version, draft: { [key]: edit[2].trim() }, status: 'review' }); log('info', 'onboarding.draft.saved', { status: saved.status, version: saved.version, fieldKeys: [key] }); return onboardingReviewText(saved.draft); } catch (error) { if (error instanceof ResumeRevalidationError) { log('warn', 'onboarding.input.blocked', { reason: 'resume_revalidation', status: state.status }); return 'Your resume content could not be saved safely. Please share the details as text instead.'; } throw error; } }
    }
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

export type RuntimeOptions = { ownerId: string; ownerEnabled?: boolean; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string>; databaseUrl?: string; store?: CareerStore; respond: (turn: AgentTurn) => Promise<string>; onboard?: OnboardingResponder; pii?: PiiService; downloadFile?: TelegramFileDownload; extract?: typeof extractPdfText; discovery?: DiscoveryCommandHandler; logger?: AppLogger };
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
    const resumeDocument = message?.document && !hasText ? message.document : undefined;
    return enqueueTurn(async () => {
      const cached = cachedReplies.get(raw.update_id); if (cached) return sendCachedReply(cached, reply);
      if (seenUpdates.has(raw.update_id)) { log('warn', 'telegram.update.rejected', { updateId: raw.update_id, requestId: transportEventId, reason: 'replayed_update' }); return { outcome: 'rejected', reason: 'replayed_update' }; }
      const commandError = command ? null : parseCommandError(message?.text);
      if (commandError) {
        const result: TelegramResult = { outcome: 'accepted', command: 'usage' };
        cachedReplies.set(raw.update_id, { text: commandError, result, updateId: raw.update_id, requestId: transportEventId });
        await reply(commandError); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id);
        log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: 'usage' });
        return result;
      }
      if (resumeDocument && options.pii?.enabled && options.pii.ready) {
        const response = await handleResumeDocument({ store, ownerId: options.ownerId, conversationId, requestId: transportEventId, document: resumeDocument, caption: message?.caption, pii: options.pii, onboard: options.onboard, download: options.downloadFile, extract: options.extract, logger: log });
        const result: TelegramResult = { outcome: 'accepted', command: 'resume' };
        cachedReplies.set(raw.update_id, { text: response, result, updateId: raw.update_id, requestId: transportEventId });
        await reply(response); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id);
        log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: 'resume' });
        return result;
      }
      const onboardingResponse = await handleOnboardingTurn({ store, ownerId: options.ownerId, conversationId, text: message?.text, nonTextInput, onboard: options.onboard, logger: log });
      if (onboardingResponse) { const result: TelegramResult = { outcome: 'accepted', command: 'onboarding' }; cachedReplies.set(raw.update_id, { text: onboardingResponse, result, updateId: raw.update_id, requestId: transportEventId }); await reply(onboardingResponse); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id); log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: 'onboarding' }); return result; }
      if (command?.kind === 'discovery') {
        const response = options.discovery ? await options.discovery(command) : 'Discovery commands are unavailable.';
        const result: TelegramResult = { outcome: 'accepted', command: 'discovery' };
        cachedReplies.set(raw.update_id, { text: response, result, updateId: raw.update_id, requestId: transportEventId });
        await reply(response); seenUpdates.add(raw.update_id); cachedReplies.delete(raw.update_id);
        log('info', 'telegram.update.accepted', { updateId: raw.update_id, requestId: transportEventId, command: 'discovery' });
        return result;
      }
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
  return { store, handleTelegramUpdate, recoverUnfinished, health: () => ({ configurationValid: Boolean(options.ownerId) && (options.ownerEnabled ?? true), databaseOpen: true, processorRunning: active }), ingestionAvailable: () => Boolean(options.pii?.enabled && options.pii.ready), close: async () => { if (!options.store) await store.close(); } };
}
