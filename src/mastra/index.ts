import { Mastra } from '@mastra/core/mastra';
import { createGuardedBrowserTool } from '../browser/guard.ts';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { LibSQLStore } from '@mastra/libsql';
import { createCareerAgentKit, analyzeJob } from '../agents/agent.ts';
import { resolveRuntimeConfig } from '../config/runtime.ts';
import { CareerStore } from '../storage/career-store.ts';
import { createAgentResponder, createCareerCopilotRuntime, createOnboardingResponder } from '../services/career-runtime.ts';
import { createPiiService } from '../services/pii.ts';
import { createTelegramFileDownloader, createTelegramPollingTransport } from '../channels/telegram-transport.ts';
import { executeSaveJob } from '../tools/save-job-tool.ts';
import type { JobInput } from '../contracts/v0.ts';
import { createTerminalAppLogger, createTraceStorageExporter, redactTracePayloads } from '../observability.ts';
import { createDiscoveryCommandHandler } from '../discovery/commands.ts';
import { ensureJobDiscoverySchedule, JOB_DISCOVERY_WORKFLOW_ID } from '../discovery/schedule.ts';
import { createDiscoverySiteStep, type DiscoveryCandidate } from '../discovery/site-step.ts';
import { qualifyDiscoveredCandidates } from '../discovery/qualify.ts';
import { createExploreJobsHandler } from '../discovery/on-demand.ts';
import type { DiscoveryDigestSender } from '../discovery/run.ts';
import { createJobDiscoveryWorkflow } from './workflows/discovery.ts';

const config = resolveRuntimeConfig({ requireDeployment: process.env.NODE_ENV === 'production' });
const storageConfig = { id: 'mastra-storage', url: config.databaseUrl, ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}) };
const pii = createPiiService(config.pii);
const logger = createTerminalAppLogger();
const store = new CareerStore({ url: config.databaseUrl, ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}) }, { logger, ...(pii.enabled ? { piiRevalidator: { redactText: (text) => pii.redactText(text), redactDocument: (value) => pii.redactDocument(value) } } : {}) });
await store.ready();
try { await pii.warmup(); } catch (error) { logger('error', 'pii.warmup.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); }

const career = createCareerAgentKit({ store, logger, memoryModel: config.memoryModel, ...(pii.enabled ? { processors: { input: [pii.processor], output: [pii.processor] } } : {}) });
export const agent = career.agent;
export const careerTools = career.tools;
// #24 guarded browser foundation: single read-only tool over the shared authenticated
// CDP session. Not yet handed to the chat agent — job discovery (#3) and auto-application
// (#4) will wire it in. Constructed always; only connects when BROWSER_CDP_URL is set.
export const browserReadTool = createGuardedBrowserTool();
export const observability = new Observability({ configs: { default: { serviceName: 'career-copilot', exporters: [createTraceStorageExporter()], spanOutputProcessors: [redactTracePayloads], logging: { enabled: false } } } });
// digest sender is bound once the polling transport exists (created below the
// runtime); the workflow step only needs it when a run actually completes
const digestChatId = [...config.telegram.privateChatIds][0];
if (!digestChatId) logger('warn', 'discovery.digest.disabled', { reason: 'no_private_chat' });
let digestSend: DiscoveryDigestSender = async () => {};
// discovery engine shared by the scheduled run and /explore_jobs: guarded
// browser read, batched qualification via the career agent, and evidence-only
// D4 synthetic-context saves. Without BROWSER_CDP_URL each site fails closed.
const discoveryBrowse = (url: string) => (browserReadTool.execute as unknown as (input: { url: string }) => Promise<{ url: string; text: string }>)({ url });
const discoveryQualify = (candidates: DiscoveryCandidate[], profile: string, query?: string) => qualifyDiscoveredCandidates(agent, candidates, profile, query, logger);
const discoverySaveJob = (input: JobInput) => executeSaveJob({ store, analyze: (text, profile) => analyzeJob(agent, text, profile), logger, input });
const discoveryChatId = digestChatId ?? config.owner.resourceId;
const discoverySiteStep = createDiscoverySiteStep({ store, browserRead: discoveryBrowse, ownerId: config.owner.resourceId, chatId: discoveryChatId, qualify: discoveryQualify, saveJob: discoverySaveJob, logger });
const exploreJobsHandler = createExploreJobsHandler({ store, browserRead: discoveryBrowse, ownerId: config.owner.resourceId, chatId: discoveryChatId, qualify: discoveryQualify, saveJob: discoverySaveJob, logger });
export const jobDiscovery = createJobDiscoveryWorkflow({ store, siteStep: discoverySiteStep, send: (text) => digestSend(text) });
export const mastra = new Mastra({ agents: { agent }, workflows: { [JOB_DISCOVERY_WORKFLOW_ID]: jobDiscovery }, storage: new MastraCompositeStore({ id: 'career-copilot-storage', default: new LibSQLStore(storageConfig) }), observability });
// schedule registration on startup, idempotent (create-or-update); the row is
// persisted in the app's LibSQL store and follows the captured owner timezone
const registerDiscoverySchedule = () => ensureJobDiscoverySchedule({ schedules: mastra.schedules, store, ownerId: config.owner.resourceId, logger });
void registerDiscoverySchedule().catch((error) => { logger('error', 'discovery.schedule.registration.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); });
const discoveryCommand = createDiscoveryCommandHandler({ schedules: mastra.schedules, store, ownerId: config.owner.resourceId, logger });
export const careerCopilotRuntime = createCareerCopilotRuntime({ ownerId: config.owner.resourceId, ownerEnabled: config.owner.enabled, allowedUserIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds, store, logger, respond: createAgentResponder(agent, config.owner.resourceId, logger), onboard: createOnboardingResponder(agent), discovery: discoveryCommand, exploreJobs: exploreJobsHandler, onOnboardingComplete: () => { void registerDiscoverySchedule().catch((error) => { logger('error', 'discovery.schedule.registration.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); }); }, pii, downloadFile: createTelegramFileDownloader(config.telegram.botToken, logger) });
logger('info', 'runtime.ready', { status: 'ready' });
export const telegramIngress = careerCopilotRuntime.handleTelegramUpdate;
export const telegramTransport = createTelegramPollingTransport(config.telegram.botToken, telegramIngress, logger);
digestSend = digestChatId ? (text) => telegramTransport.sendMessage(digestChatId, text) : async () => {};
export const startupRecovery = config.telegram.botToken
  ? careerCopilotRuntime.recoverUnfinished((text, chatId) => chatId ? telegramTransport.sendMessage(chatId, text) : Promise.reject(new Error('Recovered job has no Telegram chat.')))
  : careerCopilotRuntime.recoverUnfinished(async () => {}, { notify: false });
if (config.telegram.botToken) void startupRecovery.then(() => { logger('info', 'startup.recovery.completed'); return telegramTransport.start(); }).catch((error) => { logger('error', 'startup.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); });

/** Dev-only manual trigger (P3, documented in README): start a job discovery
 * run immediately instead of waiting for the 12:00 cron. Not a Telegram command
 * (owner confirmed no run-now). Boots the app and fires the workflow in-process:
 *   node --experimental-strip-types -e "const m = await import('./src/mastra/index.ts'); await m.triggerDiscoveryRun();"
 */
export async function triggerDiscoveryRun(input: Record<string, unknown> = {}) {
  const run = await jobDiscovery.createRun();
  return run.start({ inputData: input as never });
}
