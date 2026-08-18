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

export const metricsSchema = z.strictObject({
  durationMs: z.number().int().nonnegative(),
  ttFirstResponseMs: z.number().int().nonnegative().nullable(),
  modelCalls: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative().nullable(),
  outputTokens: z.number().int().nonnegative().nullable(),
  estimatedCostUsd: z.number().nonnegative().nullable().default(null),
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
  clock: z.string(),
  model: z.string().nullable(),
  // quality-lane provenance (#13d): live model/judge identity, pricing table,
  // retry policy, metering stance. Absent on contract-only runs (defaults).
  provider: z.string().nullable().default(null),
  apiBase: z.string().nullable().default(null),
  revision: z.string().nullable().default(null),
  judgeModel: z.string().nullable().default(null),
  judgeProvider: z.string().nullable().default(null),
  judgeApiBase: z.string().nullable().default(null),
  judgeRevision: z.string().nullable().default(null),
  pricingTableVersion: z.string().nullable().default(null),
  retry: z.strictObject({ maxAttempts: z.number().int().nonnegative(), backoffMs: z.number().int().nonnegative() }).nullable().default(null),
  allowUnmetered: z.boolean().default(false),
});

export const qualityRubricResultSchema = z.strictObject({
  id: z.string(),
  status: z.enum(['passed', 'failed', 'incomplete']),
  score: z.number().int().min(1).max(5).nullable(),
  evidence: z.array(z.string()),
  criticalFailure: z.boolean(),
  note: z.string().nullable().default(null),
});

export const qualityMeteringSchema = z.strictObject({
  sutCalls: z.number().int().nonnegative(),
  sutInputTokens: z.number().int().nonnegative().nullable(),
  sutOutputTokens: z.number().int().nonnegative().nullable(),
  sutCostUsd: z.number().nonnegative().nullable(),
  judgeCalls: z.number().int().nonnegative(),
  judgeInputTokens: z.number().int().nonnegative().nullable(),
  judgeOutputTokens: z.number().int().nonnegative().nullable(),
  judgeCostUsd: z.number().nonnegative().nullable(),
  totalCostUsd: z.number().nonnegative().nullable(),
  budget: z.string(),
});

export const qualityResultSchema = z.strictObject({
  status: z.enum(['not-run', 'passed', 'failed', 'incomplete']),
  rubrics: z.array(qualityRubricResultSchema),
  reason: z.string().nullable().default(null),
  // #13d review round: combined SUT/judge metering + budget status for the
  // aggregate (per-call detail stays in the local eval/artifacts file)
  metering: qualityMeteringSchema.optional(),
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
    notifications: z.array(z.record(z.string(), z.unknown())),
  }),
  assertions: z.array(assertionResultSchema),
  metrics: metricsSchema,
  redaction: redactionSchema,
  // quality-lane block (#13d); absent on contract-only runs
  quality: qualityResultSchema.optional(),
});

export type RunResult = z.infer<typeof runResultSchema>;
export type TranscriptEvent = z.infer<typeof eventSchema>;
export type AssertionResult = z.infer<typeof assertionResultSchema>;
export type Manifest = z.infer<typeof manifestSchema>;
export type Metrics = z.infer<typeof metricsSchema>;
export type Redaction = z.infer<typeof redactionSchema>;
export type QualityResult = z.infer<typeof qualityResultSchema>;
export type QualityRubricResult = z.infer<typeof qualityRubricResultSchema>;

export function parseRunResult(value: unknown): RunResult {
  return runResultSchema.parse(value);
}
