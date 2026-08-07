import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { LibSQLStore } from '@mastra/libsql';
import { createPrimaryAgent, createAnalysisAgent } from './agents/agent.ts';
import { resolveRuntimeConfig } from './config/runtime.ts';
import { CareerStore } from './storage/career-store.ts';
import { createCareerCopilotRuntime } from './services/career-runtime.ts';
import { createSaveJobWorkflow } from './workflows/save-job.ts';
import { webFetchTool } from './tools/web-fetch-tool.ts';
import { GoogleSheetsBoundary, GoogleOAuthRefreshProvider, GoogleSheetsHttpApi, type SheetAdapter } from './integrations/google-sheets.ts';
import { readProfile } from './integrations/local-files.ts';
import { createTelegramPollingTransport } from './channels/telegram-transport.ts';
import type { JobInput } from './contracts/v0.ts';
import { isRestartableWorkflowSnapshot } from './workflows/run-selection.ts';

const config = resolveRuntimeConfig({ requireDeployment: process.env.NODE_ENV === 'production' });
const store = new CareerStore(`file:${config.dataDir}/career.db`);
const oauth = new GoogleOAuthRefreshProvider(config.sheetsOAuth);
const sheets = new GoogleSheetsBoundary({ target: config.sheetsTarget, authorize: () => oauth.getAccessToken(), api: new GoogleSheetsHttpApi() });
const sheet: SheetAdapter = { findByJobId: (jobId) => sheets.findByJobId(jobId), write: async (row) => { await sheets.upsert(row); } };
export const analysisAgent = createAnalysisAgent();
const profileText = Object.entries(readProfile(config.profilePath)).map(([name, text]) => `${name}:\n${text}`).join('\n').slice(0, 100_000);
export const saveJobWorkflow = createSaveJobWorkflow({ store, reportsRoot: config.reportsPath, profileText, sheet, analysisAgent });
export const agent = createPrimaryAgent();
export const mastra = new Mastra({ agents: { agent, jobAnalysis: analysisAgent }, workflows: { saveJobWorkflow }, tools: { webFetchTool }, storage: new MastraCompositeStore({ id: 'career-copilot-storage', default: new LibSQLStore({ id: 'mastra-storage', url: config.databaseUrl }) }) });
export const careerCopilotRuntime = createCareerCopilotRuntime({ ownerId: config.owner.resourceId, ownerEnabled: config.owner.enabled, allowedUserIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds, store, processor: async (job) => {
  if (!job.userId) throw new Error('Persisted job has no originating Telegram user.');
  const run = await saveJobWorkflow.createRun({ runId: job.mastraRunId ?? undefined, resourceId: job.ownerId });
  const inputData: JobInput = { ...job, userId: job.userId };
  const snapshot = job.mastraRunId ? await saveJobWorkflow.getWorkflowRunById(run.runId, { withNestedWorkflows: false }) : null;
  return isRestartableWorkflowSnapshot(snapshot) ? run.restart() : run.start({ inputData });
} });
export const telegramIngress = careerCopilotRuntime.handleTelegramUpdate;
export const telegramTransport = createTelegramPollingTransport(config.telegram.botToken, telegramIngress);
export const startupRecovery = config.telegram.botToken
  ? careerCopilotRuntime.recoverUnfinished((text, chatId) => chatId ? telegramTransport.sendMessage(chatId, text) : Promise.reject(new Error('Recovered job has no Telegram chat.')))
  : careerCopilotRuntime.recoverUnfinished(async () => {}, { notify: false });
if (config.telegram.botToken) void startupRecovery.then(() => telegramTransport.start()).catch(() => undefined);
