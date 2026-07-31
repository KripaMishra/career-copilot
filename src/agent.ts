import { pathToFileURL } from 'node:url';

import { google } from '@ai-sdk/google';
import { CareerCopilotTelegramAdapter } from './telegram-ingress.ts';
import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';

import { resolveRuntimeConfig, type RuntimeConfig } from './runtime-config';
import type { TelegramUpdate } from './telegram-auth.ts';
import { webFetchTool } from './web-fetch-tool';
import { startScheduleTool, stopScheduleTool } from './schedule-tools';

export type TelegramUpdateHandler = (update: TelegramUpdate, reply: (text: string) => Promise<void>) => Promise<void>;

export function createAgent(
  config: RuntimeConfig = resolveRuntimeConfig(),
  onTelegramUpdate?: TelegramUpdateHandler,
  additionalTools: Record<string, unknown> = {},
) {
  const profileFilesystem = new LocalFilesystem({ id: 'approved-profile-read-only', basePath: config.profilePath, readOnly: true });
  const reportsFilesystem = new LocalFilesystem({ id: 'private-reports', basePath: config.reportsPath });
  const topicsFilesystem = new LocalFilesystem({ id: 'shared-topics', basePath: config.topicsPath });
  const workspace = new Workspace({
    id: 'agent-workspace',
    name: 'Agent Workspace',
    filesystem: new LocalFilesystem({ basePath: config.workspacePath }),
    sandbox: new LocalSandbox({ workingDirectory: config.workspacePath }),
    tools: {
      [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: { requireReadBeforeWrite: true, requireApproval: true },
      [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: { requireReadBeforeWrite: true, requireApproval: true },
      [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: { requireApproval: true },
      [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: { requireApproval: true },
    },
  });
  void profileFilesystem; void reportsFilesystem; void topicsFilesystem;

  const telegramAdapter = config.telegram.botToken
    ? new CareerCopilotTelegramAdapter(
        {
          botToken: config.telegram.botToken,
          secretToken: config.telegram.secretToken,
          allowedUserIds: [...config.telegram.allowedUserIds],
          userName: process.env.TELEGRAM_BOT_USERNAME,
        },
        onTelegramUpdate ?? (async () => {}),
      )
    : undefined;

  return new Agent({
    id: 'agent',
    name: 'Career Copilot',
    description: 'A personal career assistant for finding jobs, tailoring resumes, and completing browser-assisted applications.',
    instructions: `You are a personal career assistant. Help the user find relevant jobs, tailor resumes and application materials to each role, and complete applications using available browser tools.

Ask concise questions when requirements or personal details are unclear. Never invent experience, skills, qualifications, or employment history. Before submitting an application or making another irreversible external action, show the final details and get the user's explicit approval.

For local file changes, end with a plain-text URL using ${pathToFileURL(`${config.workspacePath}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
`,
    model: 'opencode-go/deepseek-v4-flash',
    defaultOptions: { maxSteps: 100, autoResumeSuspendedTools: false },
    memory: new Memory({ options: { generateTitle: true, observationalMemory: { model: 'opencode-go/deepseek-v4-flash' } } }),
    workspace,
    tools: {
      ask_user: askUserTool,
      start_schedule: startScheduleTool,
      stop_schedule: stopScheduleTool,
      web_fetch: webFetchTool,
      web_search: google.tools.googleSearch({}),
      ...additionalTools,
    },
    signals: [new TaskSignalProvider()],
    ...(telegramAdapter
      ? {
          channels: {
            adapters: { telegram: telegramAdapter },
            handlers: { onDirectMessage: false },
          },
        }
      : {}),
  });
}

export const agent = createAgent();
