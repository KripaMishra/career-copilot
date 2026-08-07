import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { basename } from 'node:path';
import { AnalysisSchema, JobInputSchema, SafeResultSchema, type Analysis } from '../contracts/v0.ts';
import { acquireJobText } from '../tools/web-fetch-tool.ts';
import { writeAtomicReport } from '../integrations/local-files.ts';
import { upsertSheetRow, type SheetAdapter } from '../integrations/google-sheets.ts';
import type { CareerStore } from '../storage/career-store.ts';
import type { Agent } from '@mastra/core/agent';
import { analyzeJob } from '../agents/agent.ts';

const acquired = JobInputSchema.extend({ text: z.string().max(100_000) });
const analyzed = acquired.extend({ analysis: AnalysisSchema });
const written = analyzed.extend({ reportPath: z.string().max(2048), reportHash: z.string() });
const sheeted = written.extend({ sheetReference: z.string().max(500) });
function transient(error: unknown) { const message = error instanceof Error ? error.message : ''; const code = (error as { code?: unknown })?.code; const status = Number((error as { status?: unknown })?.status); return ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'UND_ERR_CONNECT_TIMEOUT'].includes(String(code)) || status === 408 || status === 429 || status >= 500 || /timeout|temporarily unavailable|network/i.test(message); }
async function retryTransient<T>(operation: () => Promise<T>, attempts = 3): Promise<T> { for (let attempt = 1; ; attempt++) { try { return await operation(); } catch (error) { if (attempt >= attempts || !transient(error)) throw error; } } }
export type SaveJobWorkflowDeps = { store: CareerStore; reportsRoot: string; profileText: string; sheet: SheetAdapter; analysisAgent?: Agent; acquire?: typeof acquireJobText; analyze?: (text: string, profile: string) => Promise<Analysis>; report?: typeof writeAtomicReport };
export function createSaveJobWorkflow(deps: SaveJobWorkflowDeps) {
  const assertPersisted = createStep({ id: 'assertPersistedRunningJob', inputSchema: JobInputSchema, outputSchema: JobInputSchema, retries: 0, execute: async ({ inputData }) => { deps.store.assertRunningInput(inputData); return inputData; } });
  const acquire = createStep({ id: 'acquireJobText', inputSchema: JobInputSchema, outputSchema: acquired, retries: 0, execute: async ({ inputData }) => ({ ...inputData, ...(await retryTransient(() => (deps.acquire ?? acquireJobText)(inputData.canonicalUrl))) }) });
  const analyze = createStep({ id: 'structuredAnalysisV1', inputSchema: acquired, outputSchema: analyzed, retries: 0, execute: async ({ inputData }) => ({ ...inputData, analysis: await retryTransient(() => (deps.analyze ?? ((text, profile) => analyzeJob(deps.analysisAgent!, text, profile)))(inputData.text, deps.profileText)) }) });
  const write = createStep({ id: 'atomicReport', inputSchema: analyzed, outputSchema: written, execute: async ({ inputData }) => { const content = `# ${inputData.analysis.title}\n\nCompany: ${inputData.analysis.company}\nLocation: ${inputData.analysis.location}\n\n${inputData.analysis.summary}\n\nNext step: ${inputData.analysis.nextStep}\n`; const report = await (deps.report ?? writeAtomicReport)(deps.reportsRoot, inputData.jobId, content); return { ...inputData, reportPath: report.path, reportHash: report.hash }; } });
  const sheet = createStep({ id: 'idempotentSheetsUpsert', inputSchema: written, outputSchema: sheeted, execute: async ({ inputData }) => { const row = await upsertSheetRow(deps.sheet, { jobId: inputData.jobId, status: 'succeeded', title: inputData.analysis.title, company: inputData.analysis.company, reportPath: basename(inputData.reportPath) }); return { ...inputData, sheetReference: String(row.jobId) }; } });
  const complete = createStep({ id: 'storeCompletion', inputSchema: sheeted, outputSchema: SafeResultSchema, execute: async ({ inputData }) => { const result = { summary: `${inputData.analysis.title} at ${inputData.analysis.company}: ${inputData.analysis.nextStep}`, reportPath: inputData.reportPath, sheetReference: inputData.sheetReference }; deps.store.complete(inputData.jobId, result, inputData.reportPath, inputData.sheetReference); return result; } });
  return createWorkflow({ id: 'saveJobWorkflow', description: 'Acquire, analyze, report, and track one job.', inputSchema: JobInputSchema, outputSchema: SafeResultSchema }).then(assertPersisted).then(acquire).then(analyze).then(write).then(sheet).then(complete).commit();
}
