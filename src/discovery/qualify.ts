import { z } from 'zod';
import type { AppLogger } from '../observability.ts';

/** Batched one-pass qualification verdict over a page's candidates (spec Q):
 * same analysis seam as save-job (structured model output over the stored
 * owner profile), reasoned per candidate with no fixed thresholds. */
export const DiscoveryQualificationSchema = z.object({
  candidates: z.array(z.object({
    url: z.string().url(),
    label: z.string().trim().min(1).max(2000),
    qualified: z.boolean(),
    reason: z.string().trim().min(1).max(800),
  })).min(1).max(50),
});
export type DiscoveryQualification = z.infer<typeof DiscoveryQualificationSchema>;
export type DiscoveryQualifiedCandidate = DiscoveryQualification['candidates'][number];
export type DiscoveryCandidateRef = { url: string; label: string };

/** Minimal agent surface reused by the run shell (same shape as `analyzeJob`). */
export type DiscoveryQualifyAgent = { generate: (text: string, options: Record<string, unknown>) => Promise<{ object?: unknown; text?: string }> };

const qualificationPrompt = (candidates: DiscoveryCandidateRef[], profile: string, query?: string) => { const narrowed = query?.trim() ? `\n\nThe owner explicitly narrowed this search with an inline query — the role must be consistent with: \"${query.trim()}\" (combined with the criteria above).\n` : ''; return `You are scanning job-board listing candidates for one owner profile. Decide for EVERY candidate whether it qualifies. This is judgment, not fixed thresholds.

Criteria — combine all that apply, and never infer fit for fields that are absent:
1. Role: must align with the profile's target roles AND involve AI. Hard excludes: non-AI data-engineering roles, prompt-engineering roles, GTM/sales roles.
2. Experience: accept when the posting does not state a level (the role may be flexible); match the profile's range when stated.
3. Salary: reasonable vs the profile's stated expectations when salary is present.
4. Location: preference order Remote < Gurugram < Delhi NCR < Noida < Indore < Bengaluru (etc.), when location is present.
5. Tech stack: align with the profile's stack when mentioned.

Judge from each candidate link label only. A sparse label is not evidence against a candidate — do not over-reject. Mark qualified=true when the label is consistent with the profile, qualified=false when it clearly conflicts (a hard exclude, or a conflicting role/stack/location).

Owner profile:
${profile}

Candidates (label = link text, url in angle brackets):
${candidates.map((candidate) => `- ${candidate.label} <${candidate.url}>`).join('\n')}${narrowed}

Return ONLY JSON: {"candidates": [{"url", "label", "qualified", "reason"}]}`; };

/** Batched one-pass scan (spec Q): one structured model call over the page's
 * candidates with the owner profile and an optional inline narrow query.
 * Headless — no conversation memory. Logs a warn when the model omits expected
 * verdicts (drop-outs would otherwise inflate nonQualifying). */
export async function qualifyDiscoveredCandidates(agent: DiscoveryQualifyAgent, candidates: DiscoveryCandidateRef[], profile: string, query?: string, logger?: AppLogger): Promise<DiscoveryQualifiedCandidate[]> {
  const result = await agent.generate(qualificationPrompt(candidates, profile, query), { structuredOutput: { schema: DiscoveryQualificationSchema, jsonPromptInjection: 'inline' }, toolChoice: 'none', maxSteps: 1 });
  const parsed = DiscoveryQualificationSchema.parse((result as { object?: unknown }).object);
  if (parsed.candidates.length < candidates.length) { try { logger?.('warn', 'discovery.qualification.verdicts_missing', { expected: candidates.length, received: parsed.candidates.length }); } catch { /* logging cannot break qualification */ } }
  return parsed.candidates;
}
