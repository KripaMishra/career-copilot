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

// Maps a failed job to a user-facing "what failed + why" message. Each message
// leads with the failure kind so the agent can relay exactly what happened, and
// ends with an actionable hint instead of a recovery claim.
export function safeErrorMessage(error: unknown): string {
  const err = error instanceof Error ? error : new Error(String(error));
  const message = err.message;
  const status = Number((err as { status?: unknown }).status) || Number((message.match(/\((\d{3})\)/) ?? [])[1] || 0);
  const code = String((err as { code?: unknown }).code ?? '');
  if (/automatic retry limit/i.test(message)) return 'Automatic retry limit reached; send a new save request.';
  if (status === 403) return 'Job fetch failed (blocked): the site blocked automatic access (HTTP 403), usually bot protection. Try pasting the job text instead.';
  if (status === 404 || status === 410) return `Job fetch failed (unavailable): the job page no longer exists (HTTP ${status}).`;
  if (status === 429) return 'Job fetch failed (rate-limited): the site is limiting requests right now (HTTP 429). Try again in a minute.';
  if (status >= 500) return `Job fetch failed (site-down): the site is having server problems right now (HTTP ${status}). Try again later.`;
  if (status >= 400) return `Job fetch failed (refused): the site returned an error (HTTP ${status}).`;
  if (/size limit/i.test(message)) return 'Job fetch failed (too-large): the job page is too large to process.';
  if (/content type is not supported/i.test(message)) return 'Job fetch failed (unreadable): the page is not readable text.';
  if (/private or reserved/i.test(message)) return 'Job fetch failed (unsafe-link): the link points to a private network address.';
  if (/redirect/i.test(message)) return 'Job fetch failed (bad-redirect): the page redirected to another site.';
  if (/timed out|timeout/i.test(message) || /ETIMEDOUT|UND_ERR_CONNECT_TIMEOUT/.test(code)) return 'Job fetch failed (slow): the site did not respond in time.';
  if (/EAI_AGAIN|ENOTFOUND/.test(code)) return 'Job fetch failed (unreachable): the site address could not be found.';
  if (/ECONNRESET|ECONNREFUSED/.test(code)) return 'Job fetch failed (connection): the connection to the site was dropped.';
  if (/host is not supported/i.test(message)) return 'Job fetch failed (unsupported-site): only job links from supported job sites can be saved. Try pasting the job text instead.';
  if (/valid absolute|HTTPS|credentials/i.test(message)) return 'Job fetch failed (invalid-link): the link is not a valid job link.';
  if (/\bfetch\b/i.test(message)) return 'Job fetch failed (fetch): the job page could not be fetched.';
  return 'Job processing failed (processing): something went wrong while preparing the job.';
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
