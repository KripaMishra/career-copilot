import { pathToFileURL } from 'node:url';

import { google } from '@ai-sdk/google';
import { Agent } from '@mastra/core/agent';
import { TaskSignalProvider } from '@mastra/core/signals';
import { askUserTool } from '@mastra/core/tools';
import { LocalFilesystem, LocalSandbox, WORKSPACE_TOOLS, Workspace } from '@mastra/core/workspace';
import { Memory } from '@mastra/memory';

import { webFetchTool } from '../tools/web-fetch-tool';
import { startScheduleTool, stopScheduleTool } from '../tools/schedule-tools';
import { resolveRuntimeConfig } from '../config/runtime';

const { workspacePath } = resolveRuntimeConfig();

const workspace = new Workspace({
  id: 'agent-workspace',
  name: 'Agent Workspace',
  filesystem: new LocalFilesystem({
    basePath: workspacePath,
  }),
  sandbox: new LocalSandbox({
    workingDirectory: workspacePath,
  }),
  tools: {
    [WORKSPACE_TOOLS.FILESYSTEM.WRITE_FILE]: {
      requireReadBeforeWrite: true,
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.EDIT_FILE]: {
      requireReadBeforeWrite: true,
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.SANDBOX.EXECUTE_COMMAND]: {
      requireApproval: true,
    },
    [WORKSPACE_TOOLS.FILESYSTEM.DELETE]: {
      requireApproval: true,
    },
  },
});

export const agent = new Agent({
  id: 'agent',
  name: 'Career Copilot',
  description:
    'A personal career assistant for finding jobs, tailoring resumes, and completing browser-assisted applications.',
  instructions: `You are a personal career assistant. Help the user find relevant jobs, tailor resumes and application materials to each role, and complete applications using available browser tools.

Ask concise questions when requirements or personal details are unclear. Never invent experience, skills, qualifications, or employment history. Before submitting an application or making another irreversible external action, show the final details and get the user's explicit approval.

For local file changes, end with a plain-text URL using ${pathToFileURL(`${workspacePath}/`).href}; avoid Markdown links, localhost, /workspace, relative paths, and static-file servers.
`,
  model: 'opencode-go/deepseek-v4-flash',
  defaultOptions: {
    maxSteps: 100,
    autoResumeSuspendedTools: false,
  },
  memory: new Memory({
    options: {
      generateTitle: true,
      observationalMemory: {
        model: 'opencode-go/deepseek-v4-flash',
      },
    },
  }),
  workspace,
  tools: {
    ask_user: askUserTool,
    start_schedule: startScheduleTool,
    stop_schedule: stopScheduleTool,
    web_fetch: webFetchTool,
    web_search: google.tools.googleSearch({}),
  },
  signals: [new TaskSignalProvider()],
});
