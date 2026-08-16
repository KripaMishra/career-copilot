import { z } from 'zod';
import { SCHEMA_VERSION } from './scenario.ts';

/**
 * Fixture schema v1 — strict; unknown keys fail validation.
 *
 * A fixture declares every external fact a scenario may depend on: owner/actor/
 * conversation/request identity, the fixed clock, initial persisted rows (the
 * canonical profile lives in db.profiles rows, read via the career-profile
 * tool / store), fetch/DNS/redirect plans, the notification plan,
 * scripted model responses (with optional usage), and canaries.
 */

export const fixtureIdSchema = z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/, 'fixture IDs must match ^[a-z0-9][a-z0-9-]{2,80}$');

const onboardingRowSchema = z.strictObject({
  ownerId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  status: z.enum(['collecting', 'review', 'completed', 'cancelled']),
  version: z.number().int().min(1).max(10_000),
  draft: z.record(z.string(), z.string()).default({}),
});

const profileRowSchema = z.strictObject({
  ownerId: z.string().min(1).max(200),
  name: z.string().min(1).max(200),
  content: z.string().max(100_000),
  active: z.boolean().default(false),
  version: z.number().int().min(1).max(10_000).default(1),
});

const jobRowSchema = z.strictObject({
  jobId: z.string().min(1).max(200),
  userId: z.string().nullable().default(null),
  ownerId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  transportEventId: z.string().min(1).max(200),
  originalUrl: z.string().url().max(2048),
  canonicalUrl: z.string().url().max(2048),
  status: z.enum(['queued', 'running', 'succeeded', 'failed']),
  mastraRunId: z.string().nullable().default(null),
  attempts: z.number().int().min(0).max(3).default(0),
  reportId: z.string().nullable().default(null),
  safeResult: z
    .strictObject({
      summary: z.string().min(1).max(4000),
      reportId: z.string().max(500).nullable(),
    })
    .nullable()
    .default(null),
  safeError: z.string().nullable().default(null),
  notifiedAt: z.number().int().nullable().default(null),
  createdAt: z.number().int().default(0),
  updatedAt: z.number().int().default(0),
});

const reportRowSchema = z.strictObject({
  reportId: z.string().min(1).max(200),
  ownerId: z.string().min(1).max(200),
  jobId: z.string().min(1).max(200),
  content: z.string().max(100_000),
});

const dbSchema = z.strictObject({
  onboarding: z.array(onboardingRowSchema).default([]),
  profiles: z.array(profileRowSchema).default([]),
  jobs: z.array(jobRowSchema).default([]),
  reports: z.array(reportRowSchema).default([]),
});

const redirectPlanSchema = z.strictObject({
  status: z.number().int().min(301).max(308),
  location: z.string().min(1).max(2048),
});

const fetchPlanSchema = z.strictObject({
  url: z.string().min(1).max(2048),
  dns: z.array(z.string()).default([]),
  redirect: redirectPlanSchema.optional(),
  status: z.number().int().min(100).max(599).default(200),
  contentType: z.string().max(200).default('text/html'),
  body: z.string().max(1_000_000).default(''),
  timeout: z.boolean().default(false),
  abort: z.boolean().default(false),
});

const notificationPlanSchema = z.strictObject({
  jobId: z.string().min(1).max(200),
  deliver: z.enum(['ok', 'fail-first']).default('ok'),
});

const documentPlanSchema = z.strictObject({
  fileId: z.string().min(1).max(500),
  fileUniqueId: z.string().min(1).max(500).optional(),
  fileName: z.string().min(1).max(1024).default('resume.pdf'),
  mimeType: z.string().max(200).default('application/pdf'),
  fileSize: z.number().int().nonnegative().default(0),
  caption: z.string().max(1024).optional(),
  /** Text generated into a real text-based PDF (bounded). */
  text: z.string().max(10_000).optional(),
  /** Multi-page variant; each entry becomes one page. */
  pages: z.array(z.string().max(2000)).max(60).optional(),
  /** Force a download failure for the file id. */
  downloadFail: z.boolean().default(false),
  /** Extraction rejects with this reason (engine-level). */
  extractFail: z.enum(['not_pdf', 'encrypted', 'malformed', 'no_text', 'too_many_pages', 'overlong', 'timeout']).optional(),
  /** Envelope declares a size above the 5 MiB download cap. */
  oversized: z.boolean().default(false),
});

export const modelPurposeSchema = z.enum(['onboarding', 'analysis', 'chat', 'memory']);

const modelUsageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
});

const modelResponseSchema = z.strictObject({
  purpose: modelPurposeSchema,
  match: z.string().max(2000).optional(),
  text: z.string().max(100_000).optional(),
  object: z.record(z.string(), z.unknown()).optional(),
  toolCalls: z.array(z.strictObject({ toolName: z.string().min(1).max(200), args: z.record(z.string(), z.unknown()).default({}) })).max(20).optional(),
  usage: modelUsageSchema.optional(),
  throws: z.string().max(200).optional(),
  malformed: z.boolean().default(false),
}).refine((response) => response.malformed || response.text !== undefined || response.object !== undefined || response.throws !== undefined || (response.toolCalls?.length ?? 0) > 0, {
  message: 'a scripted model response must supply text, object, toolCalls, or throws',
});

const modelPlanSchema = z.strictObject({
  responses: z.array(modelResponseSchema).min(1).max(1000),
});

export const canarySinkSchema = z.enum(['all', 'model', 'reply', 'trace', 'log', 'database', 'report', 'judge']);

const canarySchema = z.strictObject({
  value: z.string().min(1).max(500),
  // sinks is an ALLOWLIST: an empty array makes the canary source-only —
  // forbidden in every runtime sink (model, reply, trace, log, database,
  // report, judge). Used for resume-input canaries the pipeline must never leak.
  sinks: z.array(canarySinkSchema),
});

const EMPTY_DB = { onboarding: [], profiles: [], jobs: [], reports: [] } as const;

export const fixtureSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: fixtureIdSchema,
  description: z.string().max(2000).optional(),
  ownerId: z.string().min(1).max(200),
  clock: z.string().datetime({ offset: true }).default('2026-01-01T00:00:00Z'),
  users: z.array(z.string().min(1).max(200)).default([]),
  chats: z.array(z.string().min(1).max(200)).default([]),
  db: dbSchema.default(EMPTY_DB),
  fetch: z.array(fetchPlanSchema).default([]),
  notifications: z.array(notificationPlanSchema).default([]),
  // resume document download/extraction plan (S19); presence enables the
  // runtime's PII ingestion wiring for this scenario
  documents: z.array(documentPlanSchema).default([]),
  pii: z.boolean().default(false),
  // inert default: a memory no-op is only consumable by memory extraction
  // (serve() never matches it for chat/onboarding/analysis purposes), so a
  // fixture that declares no model plan cannot pollute the scripted queue
  model: modelPlanSchema.default({ responses: [{ purpose: 'memory', text: '{}' }] }),
  canaries: z.array(canarySchema).default([]),
});

export type Fixture = z.infer<typeof fixtureSchema>;
export type FetchPlan = z.infer<typeof fetchPlanSchema>;
export type ModelResponse = z.infer<typeof modelResponseSchema>;
export type ModelPlan = z.infer<typeof modelPlanSchema>;
export type Canary = z.infer<typeof canarySchema>;
export type CanarySink = z.infer<typeof canarySinkSchema>;
export type NotificationPlan = z.infer<typeof notificationPlanSchema>;
export type DocumentPlan = z.infer<typeof documentPlanSchema>;
export type JobRow = z.infer<typeof jobRowSchema>;

export const ALL_SINKS: CanarySink[] = ['all', 'model', 'reply', 'trace', 'log', 'database', 'report', 'judge'];

export function parseFixture(value: unknown): Fixture {
  return fixtureSchema.parse(value);
}
