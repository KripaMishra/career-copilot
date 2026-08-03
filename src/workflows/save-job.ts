import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

export const SAVE_JOB_WORKFLOW_VERSION = 1 as const;

const id = z.string().min(1).max(200);
export const SaveJobInputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowVersion: z.literal(SAVE_JOB_WORKFLOW_VERSION),
  commandId: id,
  attempt: z.number().int().positive(),
  runId: id,
  resourceId: id,
  canonicalUrl: z.url({ protocol: /^https$/ }),
});
export const SaveJobOutputV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  workflowVersion: z.literal(SAVE_JOB_WORKFLOW_VERSION),
  commandId: id,
  attempt: z.number().int().positive(),
  runId: id,
  resourceId: id,
  outcome: z.literal('skeleton_complete'),
});

const skeleton = createStep({
  id: 'save-job-skeleton-v1',
  inputSchema: SaveJobInputV1Schema,
  outputSchema: SaveJobOutputV1Schema,
  execute: async ({ inputData }) => ({
    schemaVersion: 1 as const,
    workflowVersion: SAVE_JOB_WORKFLOW_VERSION,
    commandId: inputData.commandId,
    attempt: inputData.attempt,
    runId: inputData.runId,
    resourceId: inputData.resourceId,
    outcome: 'skeleton_complete' as const,
  }),
});

export const saveJobWorkflow = createWorkflow({
  id: 'save-job-v1',
  inputSchema: SaveJobInputV1Schema,
  outputSchema: SaveJobOutputV1Schema,
}).then(skeleton).commit();
