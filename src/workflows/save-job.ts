import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';

import { SuspensionTokenV1Schema } from '../contracts/v0.ts';

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
  suspendForClarification: z.boolean().optional(),
  suspensionToken: SuspensionTokenV1Schema.optional(),
}).superRefine((input, context) => {
  if (Boolean(input.suspendForClarification) !== (input.suspensionToken !== undefined)) {
    context.addIssue({ code: 'custom', path: ['suspensionToken'], message: 'clarification requires one pre-issued suspension token' });
  }
  const token = input.suspensionToken;
  if (token && (token.commandId !== input.commandId || token.runId !== input.runId || token.resourceId !== input.resourceId || token.suspendedStep !== SAVE_JOB_SUSPENDED_STEP)) {
    context.addIssue({ code: 'custom', path: ['suspensionToken'], message: 'suspension token correlation must match workflow input' });
  }
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

export const SAVE_JOB_SUSPENDED_STEP = 'save-job-skeleton-v1' as const;
export const SaveJobResumeV1Schema = z.strictObject({
  schemaVersion: z.literal(1), kind: z.literal('confirmation'), value: z.literal('ready'),
});
const SaveJobSuspendV1Schema = SuspensionTokenV1Schema;

const skeleton = createStep({
  id: SAVE_JOB_SUSPENDED_STEP,
  inputSchema: SaveJobInputV1Schema,
  outputSchema: SaveJobOutputV1Schema,
  resumeSchema: SaveJobResumeV1Schema,
  suspendSchema: SaveJobSuspendV1Schema,
  execute: async ({ inputData, resumeData, suspend }) => {
    if (inputData.suspensionToken && !resumeData) return suspend(inputData.suspensionToken);
    return {
      schemaVersion: 1 as const,
      workflowVersion: SAVE_JOB_WORKFLOW_VERSION,
      commandId: inputData.commandId,
      attempt: inputData.attempt,
      runId: inputData.runId,
      resourceId: inputData.resourceId,
      outcome: 'skeleton_complete' as const,
    };
  },
});

export const saveJobWorkflow = createWorkflow({
  id: 'save-job-v1',
  inputSchema: SaveJobInputV1Schema,
  outputSchema: SaveJobOutputV1Schema,
}).then(skeleton).commit();
