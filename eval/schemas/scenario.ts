import { z } from 'zod';
import { assertionSchema, assertionIdSchema } from './assertion.ts';
import { rubricIdSchema } from './rubric.ts';

export const SCHEMA_VERSION = 1 as const;

export const scenarioIdSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{2,80}$/, 'scenario IDs must match ^[a-z0-9][a-z0-9-]{2,80}$');

export const personaIdSchema = z.enum([
  'P01', 'P02', 'P03', 'P04', 'P05', 'P06', 'P07', 'P08', 'P09', 'P10',
  'P11', 'P12', 'P13', 'P14', 'P15', 'P16', 'P17', 'P18',
]);

export const channelSchema = z.enum(['telegram']);

export const turnInputSchema = z.strictObject({
  kind: z.enum(['text', 'non_text']),
  text: z.string().max(10_000).optional(),
}).refine((input) => input.kind === 'text' ? typeof input.text === 'string' : input.text === undefined, {
  message: 'text turns require text; non_text turns must not carry text',
});

export const turnSchema = z.strictObject({
  id: z.string().regex(/^t[0-9]+$/, 'turn IDs must be t1, t2, ...'),
  channel: channelSchema,
  input: turnInputSchema,
  actorId: z.string().min(1).max(200),
  conversationId: z.string().min(1).max(200),
  expected: z.enum(['accepted', 'rejected']),
  envelope: z.enum(['malformed', 'forwarded', 'edited', 'group', 'bot']).optional(),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  updateId: z.number().int().positive().max(2_000_000_000).optional(),
});

export const limitsSchema = z.strictObject({
  maxTurns: z.number().int().positive().max(500).optional(),
  maxWallClockMs: z.number().int().positive().max(600_000).optional(),
  maxModelCalls: z.number().int().positive().max(10_000).optional(),
});

export const toolExpectationSchema = z.strictObject({
  require: z.array(z.string()).max(20).default([]),
  forbid: z.array(z.string()).max(20).default([]),
  counts: z.record(z.string(), z.number().int().min(0).max(1000)).default({}),
});

export const scenarioSchema = z.strictObject({
  schemaVersion: z.literal(SCHEMA_VERSION),
  id: scenarioIdSchema,
  description: z.string().max(2000).optional(),
  kind: z.enum(['contract', 'quality']),
  persona: personaIdSchema,
  fixture: z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/, 'fixture IDs must match the scenario ID shape'),
  turns: z.array(turnSchema).min(1).max(500),
  stubs: z.array(z.string().regex(/^[a-z0-9][a-z0-9-]{2,80}$/)).max(20).optional(),
  assertions: z.array(assertionSchema).min(1).max(100),
  rubrics: z.array(rubricIdSchema).max(10).optional(),
  tools: toolExpectationSchema.optional(),
  limits: limitsSchema.optional(),
});

export type Scenario = z.infer<typeof scenarioSchema>;
export type Turn = z.infer<typeof turnSchema>;
export type Limits = z.infer<typeof limitsSchema>;

export const DEFAULT_LIMITS: Required<Limits> = { maxTurns: 50, maxWallClockMs: 30_000, maxModelCalls: 100 };

export function resolveLimits(limits: Limits | undefined): Required<Limits> {
  return { ...DEFAULT_LIMITS, ...(limits ?? {}) };
}

export function parseScenario(value: unknown): Scenario {
  return scenarioSchema.parse(value);
}
