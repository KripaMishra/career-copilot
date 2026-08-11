import { z } from 'zod';

export const RUN_SCHEMA_VERSION = 1 as const;
export const RUN_STATUSES = ['passed', 'failed', 'incomplete', 'skipped'] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const eventTypeSchema = z.enum([
  'user_turn', 'assistant_reply', 'tool_call', 'tool_result', 'model_call',
  'lifecycle', 'state_snapshot', 'notification', 'error',
]);

export const eventSchema = z.strictObject({
  sequence: z.number().int().min(1),
  turnId: z.string().nullable(),
  type: eventTypeSchema,
  atMs: z.number().int().nonnegative(),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export const transcriptSchema = z.strictObject({
  complete: z.boolean(),
  events: z.array(eventSchema),
});

export const assertionResultSchema = z.strictObject({
  id: z.string(),
  status: z.enum(['passed', 'failed', 'incomplete']),
  evidence: z.string(),
});

export const qualitySchema = z.strictObject({
  status: z.enum(['not-run', 'passed', 'failed', 'incomplete']).default('not-run'),
  rubrics: z
    .array(z.strictObject({
      id: z.string(),
      status: z.enum(['not-run', 'passed', 'failed', 'incomplete']),
      score: z.number().int().min(1).max(5).nullable(),
      evidence: z.string(),
      criticalFailure: z.boolean().default(false),
    }))
    .default([]),
});

export const metricsSchema = z.strictObject({
  durationMs: z.number().int().nonnegative(),
  ttFirstResponseMs: z.number().int().nonnegative().nullable(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable(),
  peakRssBytes: z.number().int().nonnegative().nullable(),
  transcriptBytes: z.number().int().nonnegative(),
});

export const redactionSchema = z.strictObject({
  canariesFound: z.array(z.string()),
  sinksScanned: z.array(z.string()),
  rawArtifactPath: z.string().nullable(),
});

export const manifestSchema = z.strictObject({
  sourceRevision: z.string(),
  runnerVersion: z.string(),
  nodeVersion: z.string(),
  lockfileHash: z.string(),
  seed: z.string(),
  clock: z.string(),
  model: z.string().nullable(),
  judge: z.string().nullable(),
  retry: z.string(),
});

export const runResultSchema = z.strictObject({
  runSchemaVersion: z.literal(RUN_SCHEMA_VERSION),
  runId: z.string(),
  scenarioId: z.string(),
  fixtureId: z.string(),
  status: z.enum(RUN_STATUSES),
  corpusHash: z.string().regex(/^[0-9a-f]{64}$/),
  manifest: manifestSchema,
  transcript: transcriptSchema,
  state: z.strictObject({
    onboarding: z.array(z.record(z.string(), z.unknown())),
    profiles: z.array(z.record(z.string(), z.unknown())),
    jobs: z.array(z.record(z.string(), z.unknown())),
    reports: z.array(z.record(z.string(), z.unknown())),
    sheets: z.array(z.record(z.string(), z.unknown())),
    notifications: z.array(z.record(z.string(), z.unknown())),
  }),
  assertions: z.array(assertionResultSchema),
  quality: qualitySchema,
  metrics: metricsSchema,
  redaction: redactionSchema,
});

export type RunResult = z.infer<typeof runResultSchema>;
export type TranscriptEvent = z.infer<typeof eventSchema>;
export type AssertionResult = z.infer<typeof assertionResultSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type Redaction = z.infer<typeof redactionSchema>;

export function parseRunResult(value: unknown): RunResult {
  return runResultSchema.parse(value);
}
