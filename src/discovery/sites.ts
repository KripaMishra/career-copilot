import type { DiscoveryCounts } from '../storage/career-store.ts';

/** Strict discovery order per spec D6. Values match the job-site allowlist
 * tokens in src/tools/job-url.ts so a later real site step can use the same
 * identifiers. */
export const DISCOVERY_SITES = ['linkedin.com', 'foundit.in', 'cutshort.io', 'naukri.com', 'indeed.com'] as const;
export type DiscoverySiteName = (typeof DISCOVERY_SITES)[number];

/** Terminal outcome a placeable site step reports for its site. A pending
 * row is never written back — the shell only persists ok/blocked/error. */
export type DiscoverySiteStepResult = {
  status: 'ok' | 'blocked' | 'error';
  cursor?: string | null;
  counts: DiscoveryCounts;
  blockedReason?: string;
  blockedEvidence?: string;
};

/** Input the shell gives an injectable site step (per spec D1/D6): the run
 * lease id, the site in strict order, the persisted cursor for resume, and
 * the run-scoped quota read so the step can stop at 4 added (D5). */
export type DiscoverySiteStepInput = {
  runId: string;
  site: string;
  cursor: string | null;
  addedCount: number;
};

/** Injectable per-site job-discovery step. The shell owns lease, ordering,
 * persistence, and stop-continue; the step owns reading the site and judging
 * candidates. Replaced by real reads in the discovery-sites ticket. */
export type DiscoverySiteStep = (input: DiscoverySiteStepInput) => Promise<DiscoverySiteStepResult>;

/** Initial stub (discovery-run ticket): records a not-implemented error
 * outcome without touching the browser, so the loop, ordering, per-site row
 * writes, and stop-continue semantics are exercisable end to end. */
export const stubDiscoverySiteStep: DiscoverySiteStep = async () => ({
  status: 'error',
  counts: { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 1 },
});
