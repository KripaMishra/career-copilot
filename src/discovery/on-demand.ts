import { randomUUID } from 'node:crypto';
import type { JobInput } from '../contracts/v0.ts';
import type { AppLogger } from '../observability.ts';
import type { CareerStore, DiscoveryCounts, DiscoverySiteInput } from '../storage/career-store.ts';
import { buildDiscoveryDigest } from './digest.ts';
import type { DiscoveryQualifiedCandidate } from './qualify.ts';
import { createDiscoverySiteStep, DISCOVERY_SITE_LANDINGS, type DiscoveryCandidate } from './site-step.ts';
import { DISCOVERY_SITES } from './sites.ts';

/** Best-effort per-site search URLs for an inline on-demand query (D7). Exact
 * crawl/search paths evolve against the live sites; refinement is
 * `discovery-strategy` tech debt. Always on the allowlist (HTTPS, allowed host). */
export function buildSiteSearchUrl(site: string, query: string): string {
  const q = encodeURIComponent(query.trim());
  switch (site) {
    case 'linkedin.com': return `https://www.linkedin.com/jobs/search/?keywords=${q}`;
    case 'foundit.in': return `https://www.foundit.in/search?query=${q}`;
    case 'cutshort.io': return `https://cutshort.io/jobs?query=${q}`;
    case 'naukri.com': return `https://www.naukri.com/${encodeURIComponent(query.trim().replace(/\s+/g, '-'))}-jobs`;
    case 'indeed.com': return `https://www.indeed.com/jobs?q=${q}`;
    default: return DISCOVERY_SITE_LANDINGS[site];
  }
}

export type OnDemandDiscoveryDeps = {
  store: CareerStore;
  browserRead: (url: string) => Promise<{ url: string; text: string }>;
  ownerId: string;
  chatId: string;
  qualify: (candidates: DiscoveryCandidate[], profile: string, query?: string) => Promise<DiscoveryQualifiedCandidate[]>;
  saveJob: (input: JobInput) => Promise<unknown>;
  query?: string;
  logger?: AppLogger;
};

const zeroCounts: DiscoveryCounts = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };

/** One /explore_jobs pass (spec D7): an immediate discovery across all allowed
 * sites, reusing the same guarded browser step + dedup + qualification + D4
 * evidence saves as the scheduled run, but with a non-lease pass id
 * (`ondemand-<uuid>`) so it can never block or be blocked by a scheduled fire.
 * Persists the pass summary + per-site rows via recordDiscoveryPass and returns
 * the single reply (digest shape + the qualifying roles actually saved). */
export async function runOnDemandDiscovery(options: OnDemandDiscoveryDeps): Promise<{ runId: string; outcome: 'succeeded'; summary: string }> {
  const runId = `ondemand-${randomUUID()}`;
  const query = options.query?.trim() || undefined;
  const step = createDiscoverySiteStep({
    store: options.store,
    browserRead: options.browserRead,
    ownerId: options.ownerId,
    chatId: options.chatId,
    qualify: (candidates, profile) => options.qualify(candidates, profile, query),
    saveJob: options.saveJob,
    ...(query ? { landingUrl: (site: string) => buildSiteSearchUrl(site, query) } : {}),
    ...(query ? { query } : {}),
    logger: options.logger,
  });
  const counts: DiscoveryCounts = { ...zeroCounts };
  const siteInputs: DiscoverySiteInput[] = [];
  const savedBySite: Record<string, string[]> = {};
  for (const site of DISCOVERY_SITES) {
    try {
      const result = await step({ runId, site, cursor: null, addedCount: 0 });
      siteInputs.push({ runId, site, status: result.status, cursor: result.cursor ?? null, counts: result.counts, ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}), ...(result.blockedEvidence !== undefined ? { blockedEvidence: result.blockedEvidence } : {}) });
      for (const key of Object.keys(counts) as (keyof DiscoveryCounts)[]) counts[key] += result.counts[key];
      if (result.counts.added > 0) savedBySite[site] = [...(savedBySite[site] ?? []), ...await savedRoleSummaries(options.store, options.ownerId, `disc-${runId}-${site}-`)];
      // the step's saves are tracked once per site via the transportEventId prefix
    } catch (error) {
      siteInputs.push({ runId, site, status: 'error', counts: { ...zeroCounts, error: 1 } });
      counts.error += 1;
    }
  }
  const run = await options.store.recordDiscoveryPass({ runId, status: 'succeeded', counts, sites: siteInputs });
  const sites = await options.store.listDiscoverySites(runId);
  const heading = query ? `On-demand job search — "${query}"` : 'On-demand job search';
  let summary = `${heading}\n${buildDiscoveryDigest({ run, sites }, 'On-demand pass')}`;
  const savedLines = Object.entries(savedBySite).flatMap(([site, roles]) => roles.length > 0 ? [`${site}:`, ...roles.map((role) => `- ${role}`)] : []);
  if (savedLines.length > 0) summary += `\n\nSaved roles:\n${savedLines.join('\n')}`;
  return { runId, outcome: 'succeeded', summary };
}

async function savedRoleSummaries(store: CareerStore, ownerId: string, transportPrefix: string): Promise<string[]> {
  const jobs = await store.list();
  return jobs.filter((job) => job.ownerId === ownerId && job.status === 'succeeded' && job.transportEventId.startsWith(transportPrefix)).map((job) => job.safeResult?.summary ?? job.canonicalUrl);
}

export type ExploreJobsCommand = { kind: 'exploreJobs'; query?: string };
export type ExploreJobsHandler = (command: ExploreJobsCommand) => Promise<string>;

/** Telegram-facing handler (D7): runs an on-demand pass for the requesting
 * owner and returns the single summary reply. Auth is enforced by the runtime
 * ingress before this handler is reached. */
export function createExploreJobsHandler(deps: Omit<OnDemandDiscoveryDeps, 'query'>): ExploreJobsHandler {
  return async (command) => (await runOnDemandDiscovery({ ...deps, query: command.query })).summary;
}
