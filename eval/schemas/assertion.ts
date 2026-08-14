import { z } from 'zod';

/**
 * Deterministic assertion catalog (issue #13). Each ID is a pass/fail gate over
 * the run context; they are NOT judge opinions. Unknown assertion IDs fail
 * scenario validation.
 */
export const ASSERTION_IDS = [
  'A-AUTH-BEFORE-MODEL',
  'A-TOOLS-EXACT',
  'A-TOOL-CONTEXT',
  'A-ONBOARDING-STATE',
  'A-NO-ACTIVATION-BEFORE-CONFIRM',
  'A-PROFILE-ACTIVATED',
  'A-DRAFT-PATCH-ONLY',
  'A-URL-POLICY',
  'A-REDIRECT-POLICY',
  'A-SSRF-BLOCK',
  'A-CONTENT-LIMIT',
  'A-LIFECYCLE-ORDER',
  'A-JOB-STATE',
  'A-REPORT-BEFORE-SUCCESS',
  'A-NOTIFY-AFTER-COMPLETE',
  'A-NOTIFY-MARK-AFTER-SEND',
  'A-RECOVERY-REAUTH',
  'A-OWNER-CONVERSATION-SCOPE',
  'A-CANARY-CONTAINED',
  'A-FETCH-DATA-NOT-POLICY',
  'A-SAFE-ERROR',
  'A-LOG-ALLOWLIST',
  'A-TRANSCRIPT-COMPLETE',
  'A-BUDGET',
  'A-ISOLATED-FIXTURE',
  'A-NO-UNHANDLED-ERROR',
] as const;

export type AssertionId = (typeof ASSERTION_IDS)[number];

export const assertionIdSchema = z.string().refine(
  (value) => (ASSERTION_IDS as readonly string[]).includes(value),
  'unknown assertion ID',
);

/** Value operators — data only, no arbitrary code in YAML. */
export const operatorSchema = z.enum(['eq', 'member', 'count', 'prefix', 'order', 'path', 'absent']);

/**
 * An assertion entry is either a catalog ID (plain string) or a value assertion:
 * `{ id, path, op, value }` evaluated against the run context.
 */
export const valueAssertionSchema = z.strictObject({
  id: assertionIdSchema,
  path: z.string().min(1).max(500),
  op: operatorSchema,
  value: z.unknown().optional(),
});

export const assertionSchema = z.union([assertionIdSchema, valueAssertionSchema]);

export type AssertionEntry = z.infer<typeof assertionSchema>;
export type ValueAssertion = z.infer<typeof valueAssertionSchema>;
export type Operator = z.infer<typeof operatorSchema>;

export function isValueAssertion(entry: AssertionEntry): entry is ValueAssertion {
  return typeof entry !== 'string';
}
