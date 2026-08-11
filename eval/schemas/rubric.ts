import { z } from 'zod';

/** The 10 rubrics from issue #13. Quality lane only; judged manually after contract replay passes. */
export const RUBRIC_IDS = [
  'task_completion',
  'tool_selection',
  'grounding',
  'privacy_safety',
  'truthfulness',
  'memory_use',
  'onboarding_discipline',
  'job_analysis_quality',
  'conversational_quality',
  'recovery_quality',
] as const;

export type RubricId = (typeof RUBRIC_IDS)[number];

export const rubricIdSchema = z.string().refine(
  (value) => (RUBRIC_IDS as readonly string[]).includes(value),
  'unknown rubric ID',
);
