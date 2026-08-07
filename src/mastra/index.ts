import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { Observability } from '@mastra/observability';
import { LibSQLStore } from '@mastra/libsql';
import { createCareerAgentKit } from '../agents/agent.ts';
import { resolveRuntimeConfig } from '../config/runtime.ts';
import { CareerStore } from '../storage/career-store.ts';
import { createAgentResponder, createCareerCopilotRuntime } from '../services/career-runtime.ts';
import { GoogleSheetsBoundary, GoogleOAuthRefreshProvider, GoogleSheetsHttpApi, type SheetAdapter } from '../integrations/google-sheets.ts';
import { readProfile } from '../integrations/local-files.ts';
import { createTelegramPollingTransport } from '../channels/telegram-transport.ts';
import { createTraceStorageExporter, redactTracePayloads } from '../observability.ts';

const config = resolveRuntimeConfig({ requireDeployment: process.env.NODE_ENV === 'production' });
const store = new CareerStore(`file:${config.dataDir}/career.db`);
const oauth = new GoogleOAuthRefreshProvider(config.sheetsOAuth);
const sheets = new GoogleSheetsBoundary({ target: config.sheetsTarget, authorize: () => oauth.getAccessToken(), api: new GoogleSheetsHttpApi() });
const sheet: SheetAdapter = { findByJobId: (jobId) => sheets.findByJobId(jobId), write: async (row) => { await sheets.upsert(row); } };
const profileText = Object.entries(readProfile(config.profilePath)).map(([name, text]) => `${name}:\n${text}`).join('\n').slice(0, 100_000);
let lifecycleLogger: ReturnType<Mastra['getLogger']> | undefined;
const observe = (level: 'info' | 'warn' | 'error', event: string, data?: Record<string, unknown>) => lifecycleLogger?.[level](event, data);

const career = createCareerAgentKit({ store, reportsRoot: config.reportsPath, profileText, sheet, observe });
export const agent = career.agent;
export const careerTools = career.tools;
export const observability = new Observability({ configs: { default: { serviceName: 'career-copilot', exporters: [createTraceStorageExporter()], spanOutputProcessors: [redactTracePayloads], logging: { enabled: false } } } });
export const mastra = new Mastra({ agents: { agent }, storage: new MastraCompositeStore({ id: 'career-copilot-storage', default: new LibSQLStore({ id: 'mastra-storage', url: config.databaseUrl }) }), observability });
lifecycleLogger = mastra.getLogger();
export const careerCopilotRuntime = createCareerCopilotRuntime({ ownerId: config.owner.resourceId, ownerEnabled: config.owner.enabled, allowedUserIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds, store, observe, respond: createAgentResponder(agent, config.owner.resourceId) });
export const telegramIngress = careerCopilotRuntime.handleTelegramUpdate;
export const telegramTransport = createTelegramPollingTransport(config.telegram.botToken, telegramIngress, observe);
export const startupRecovery = config.telegram.botToken
  ? careerCopilotRuntime.recoverUnfinished((text, chatId) => chatId ? telegramTransport.sendMessage(chatId, text) : Promise.reject(new Error('Recovered job has no Telegram chat.')))
  : careerCopilotRuntime.recoverUnfinished(async () => {}, { notify: false });
if (config.telegram.botToken) void startupRecovery.then(() => { observe('info', 'startup.recovery.completed'); return telegramTransport.start(); }).catch((error) => { observe('error', 'startup.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); });
