import { z } from 'zod';

export const JobStatusSchema = z.enum(['queued', 'running', 'succeeded', 'failed']);
export type JobStatus = z.infer<typeof JobStatusSchema>;

export const JobInputSchema = z.object({
  jobId: z.string().min(1).max(200),
  userId: z.string().min(1).max(200),
  ownerId: z.string().min(1).max(200),
  chatId: z.string().min(1).max(200),
  transportEventId: z.string().min(1).max(200),
  originalUrl: z.string().url().max(2048),
  canonicalUrl: z.string().url().max(2048),
});
export type JobInput = z.infer<typeof JobInputSchema>;

export const AnalysisSchema = z.object({
  schemaVersion: z.literal(1),
  title: z.string().trim().min(1).max(500),
  company: z.string().trim().min(1).max(500),
  location: z.string().trim().max(500),
  summary: z.string().trim().min(1).max(8000),
  fitScore: z.number().int().min(0).max(100),
  nextStep: z.string().trim().min(1).max(1000),
});
export type Analysis = z.infer<typeof AnalysisSchema>;

export const SafeResultSchema = z.object({
  summary: z.string().trim().min(1).max(4000),
  reportId: z.string().max(500).nullable(),
});
export type SafeResult = z.infer<typeof SafeResultSchema>;

export function safeErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (/automatic retry limit/i.test(message)) return 'Automatic retry limit reached; use /job for recovery.';
  if (/content type|size limit|redirect|not supported|unsupported|\bfetch\b|private or reserved|valid absolute|https/i.test(message)) return 'Job content could not be fetched safely.';
  return 'Job processing failed; use /job for recovery.';
}

export type Job = Omit<JobInput, 'userId'> & { userId: string | null } & {
  status: JobStatus;
  mastraRunId: string | null;
  attempts: number;
  reportId: string | null;
  safeResult: SafeResult | null;
  safeError: string | null;
  notifiedAt: number | null;
  createdAt: number;
  updatedAt: number;
};
