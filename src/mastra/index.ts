import { Mastra } from '@mastra/core/mastra';
import { createGuardedBrowserTool } from '../browser/guard.ts';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { LibSQLStore } from '@mastra/libsql';
import { createCareerAgentKit } from '../agents/agent.ts';
import { resolveRuntimeConfig } from '../config/runtime.ts';
import { CareerStore } from '../storage/career-store.ts';
import { createAgentResponder, createCareerCopilotRuntime, createOnboardingResponder } from '../services/career-runtime.ts';
import { createPiiService } from '../services/pii.ts';
import { createTelegramFileDownloader, createTelegramPollingTransport } from '../channels/telegram-transport.ts';
import { createTerminalAppLogger, createTraceStorageExporter, redactTracePayloads } from '../observability.ts';

const config = resolveRuntimeConfig({ requireDeployment: process.env.NODE_ENV === 'production' });
const storageConfig = { id: 'mastra-storage', url: config.databaseUrl, ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}) };
const pii = createPiiService(config.pii);
const store = new CareerStore({ url: config.databaseUrl, ...(config.databaseAuthToken ? { authToken: config.databaseAuthToken } : {}) }, pii.enabled ? { piiRevalidator: { redactText: (text) => pii.redactText(text), redactDocument: (value) => pii.redactDocument(value) } } : {});
await store.ready();
const logger = createTerminalAppLogger();
try { await pii.warmup(); } catch (error) { logger('error', 'pii.warmup.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); }

const career = createCareerAgentKit({ store, logger, memoryModel: config.memoryModel, ...(pii.enabled ? { processors: { input: [pii.processor], output: [pii.processor] } } : {}) });
export const agent = career.agent;
export const careerTools = career.tools;
// #24 guarded browser foundation: single read-only tool over the shared authenticated
// CDP session. Not yet handed to the chat agent — job discovery (#3) and auto-application
// (#4) will wire it in. Constructed always; only connects when BROWSER_CDP_URL is set.
export const browserReadTool = createGuardedBrowserTool();
export const observability = new Observability({ configs: { default: { serviceName: 'career-copilot', exporters: [createTraceStorageExporter()], spanOutputProcessors: [redactTracePayloads], logging: { enabled: false } } } });
export const mastra = new Mastra({ agents: { agent }, storage: new MastraCompositeStore({ id: 'career-copilot-storage', default: new LibSQLStore(storageConfig) }), observability });
export const careerCopilotRuntime = createCareerCopilotRuntime({ ownerId: config.owner.resourceId, ownerEnabled: config.owner.enabled, allowedUserIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds, store, logger, respond: createAgentResponder(agent, config.owner.resourceId, logger), onboard: createOnboardingResponder(agent), pii, downloadFile: createTelegramFileDownloader(config.telegram.botToken, logger) });
logger('info', 'runtime.ready', { status: 'ready' });
export const telegramIngress = careerCopilotRuntime.handleTelegramUpdate;
export const telegramTransport = createTelegramPollingTransport(config.telegram.botToken, telegramIngress, logger);
export const startupRecovery = config.telegram.botToken
  ? careerCopilotRuntime.recoverUnfinished((text, chatId) => chatId ? telegramTransport.sendMessage(chatId, text) : Promise.reject(new Error('Recovered job has no Telegram chat.')))
  : careerCopilotRuntime.recoverUnfinished(async () => {}, { notify: false });
if (config.telegram.botToken) void startupRecovery.then(() => { logger('info', 'startup.recovery.completed'); return telegramTransport.start(); }).catch((error) => { logger('error', 'startup.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); });
