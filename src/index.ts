import { Mastra } from '@mastra/core/mastra';
import { MastraCompositeStore } from '@mastra/core/storage';
import { DuckDBStore } from '@mastra/duckdb';
import { MastraEditor } from '@mastra/editor';
import { LibSQLStore } from '@mastra/libsql';
import { MastraPlatformExporter, MastraStorageExporter, Observability, SensitiveDataFilter } from '@mastra/observability';
import { createAgent } from './agent';
import { resolveRuntimeConfig } from './runtime-config';
import { createCareerCopilotRuntime } from './career-runtime';
import { startScheduleTool, stopScheduleTool } from './schedule-tools';
import { webFetchTool } from './web-fetch-tool';

// Production startup is deliberately fail-closed. Tests/builds use explicit factories and never import this runtime.
const runtimeConfig = resolveRuntimeConfig({ requireDeployment: true });
export const careerCopilotRuntime = createCareerCopilotRuntime(runtimeConfig);
export const telegramIngress = careerCopilotRuntime.handleTelegramUpdate;
export const agent = createAgent(
  runtimeConfig,
  (update, reply) => careerCopilotRuntime.handleTelegramUpdate(update, reply).then(() => undefined),
  careerCopilotRuntime.tools,
);

export const mastra = new Mastra({
  agents: { agent },
  tools: { startScheduleTool, stopScheduleTool, webFetchTool, ...careerCopilotRuntime.tools },
  editor: new MastraEditor(),
  storage: new MastraCompositeStore({
    id: 'composite-storage',
    default: new LibSQLStore({
      id: 'mastra-storage',
      url: runtimeConfig.databaseUrl,
      authToken: process.env.TURSO_AUTH_TOKEN || undefined,
    }),
    domains: { observability: await new DuckDBStore().getStore('observability') },
  }),
  observability: new Observability({
    configs: {
      default: {
        serviceName: 'mastra',
        exporters: [new MastraStorageExporter(), new MastraPlatformExporter()],
        spanOutputProcessors: [new SensitiveDataFilter()],
      },
    },
  }),
});
