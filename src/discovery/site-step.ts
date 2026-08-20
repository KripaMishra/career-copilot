import { randomUUID } from 'node:crypto';
import { BrowserGuardError } from '../browser/driver.ts';
import { assertJobUrl, jobSiteFor } from '../tools/job-url.ts';
import type { JobInput } from '../contracts/v0.ts';
import type { AppLogger } from '../observability.ts';
import type { CareerStore, DiscoveryCounts } from '../storage/career-store.ts';
import type { DiscoverySiteStep, DiscoverySiteStepResult } from './sites.ts';
import { qualifyDiscoveredCandidates, type DiscoveryQualifiedCandidate } from './qualify.ts';

/** Conservative per-site landings (spec D6): each site's job-search/careers
 * entry point under the allowlist. Exact crawl paths/pagination evolve against
 * the live sites; optimization is `discovery-strategy` tech debt. */
export const DISCOVERY_SITE_LANDINGS: Record<string, string> = {
  'linkedin.com': 'https://www.linkedin.com/jobs/',
  'foundit.in': 'https://www.foundit.in/search',
  'cutshort.io': 'https://cutshort.io/jobs',
  'naukri.com': 'https://www.naukri.com/',
  'indeed.com': 'https://www.indeed.com/jobs',
};

/** Upper bound on candidates scanned per site per run (keeps the batched
 * qualification call bounded); walking deeper feeds is discovery-strategy.) */
export const MAX_DISCOVERY_CANDIDATES = 25;
/** At most this many qualifying, globally non-duplicate roles per site per run (D5). */
export const DISCOVERY_SITE_QUOTA = 4;

export type DiscoveryCandidate = { url: string; label: string };

/** Extract candidate job links from a site's accessibility-tree text (D6):
 * only URLs whose host resolves to the current site, deduped, capped, with the
 * preceding line as a title hint. Conservative MVP; richer extraction is
 * discovery-strategy work. */
export function extractCandidateLinks(site: string, text: string, limit = MAX_DISCOVERY_CANDIDATES): DiscoveryCandidate[] {
  const seen = new Set<string>(); const candidates: DiscoveryCandidate[] = [];
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>)\]]+/g)) {
    const raw = match[0].replace(/[),.;]+$/, '');
    let url: URL;
    try { url = new URL(raw); } catch { continue; }
    if (!/^https:$/.test(url.protocol) || jobSiteFor(url.hostname) !== site) continue;
    const href = url.href;
    if (seen.has(href)) continue;
    seen.add(href);
    const label = (text.slice(0, match.index).split('\n').filter((line) => line.trim()).at(-1) ?? '').trim() || href;
    candidates.push({ url: href, label: label.slice(0, 200) });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export type DiscoverySiteStepDeps = {
  store: CareerStore;
  /** Read-only guarded browser read for one page; throws BrowserGuardError on
   * blocked/forbidden, matching createGuardedBrowserTool.execute. */
  browserRead: (url: string) => Promise<{ url: string; text: string }>;
  ownerId: string;
  /** Digest target chat used as the synthetic scheduled save context (D4). */
  chatId: string;
  qualify: (candidates: DiscoveryCandidate[], profile: string, query?: string) => Promise<DiscoveryQualifiedCandidate[]>;
  saveJob: (input: JobInput) => Promise<unknown>;
  /** Override the per-site entry URL (e.g. a site-search URL for an inline
   * on-demand query). Defaults to the conservative landings. */
  landingUrl?: (site: string) => string;
  /** Optional inline narrow query threaded into qualification (on-demand). */
  query?: string;
  logger?: AppLogger;
};

function failCounts(kind: 'blocked' | 'error'): DiscoveryCounts {
  return { added: 0, duplicate: 0, nonQualifying: 0, blocked: kind === 'blocked' ? 1 : 0, error: kind === 'error' ? 1 : 0 };
}

/** Real per-site discovery step (spec D3/D4/D5/D6 + ticket ACs) replacing the
 * stub: navigate the site landing via browserReadTool, extract candidate
 * links, previously-seen dedup (byCanonicalUrl), batched profile qualification,
 * and quota-bounded saves through executeSaveJob with the synthetic scheduled
 * context. Any guard block stops only this site and is reported (redacted)
 * in the digest; with no browser the site fails closed per-site. */
export function createDiscoverySiteStep(deps: DiscoverySiteStepDeps): DiscoverySiteStep {
  const log: AppLogger = (level, event, data) => { try { deps.logger?.(level, event, data); } catch { /* logging cannot break discovery */ } };
  const zero: DiscoveryCounts = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };
  const landingUrl = deps.landingUrl ?? ((site: string) => DISCOVERY_SITE_LANDINGS[site]);
  return async ({ runId, site, cursor, addedCount }) => {
    const landing = landingUrl(site);
    if (!landing) return { status: 'error', counts: failCounts('error') };
    let read: { url: string; text: string };
    try {
      read = await deps.browserRead(landing);
      log('info', 'discovery.site.read.succeeded', { site, url: read.url });
    } catch (error) {
      if (error instanceof BrowserGuardError && error.kind === 'blocked') {
        log('warn', 'discovery.site.blocked', { site, reason: error.reason });
        return { status: 'blocked', counts: failCounts('blocked'), blockedReason: error.reason, blockedEvidence: error.evidence };
      }
      // forbidden (browser not configured / unauthorized host) and unknown errors
      // fail closed per-site: nothing is invented as saved (ticket AC).
      log('error', 'discovery.site.read.failed', { site, errorName: error instanceof Error ? error.name : 'UnknownError' });
      return { status: 'error', counts: failCounts('error') };
    }
    const candidates = extractCandidateLinks(site, read.text);
    if (candidates.length === 0) { log('info', 'discovery.site.empty', { site }); return { status: 'ok', counts: { ...zero } }; }
    // global dedup: anything already saved (any status) is Previously Seen
    const counts: DiscoveryCounts = { ...zero };
    const fresh: DiscoveryCandidate[] = [];
    for (const candidate of candidates) {
      try {
        const canonical = assertJobUrl(candidate.url);
        if (await deps.store.byCanonicalUrl(canonical.href)) { counts.duplicate += 1; continue; }
        fresh.push({ url: canonical.href, label: candidate.label });
      } catch { /* unusable link (off-site/hash/etc.) — drill noise, skip silently */ }
    }
    if (fresh.length === 0) { log('info', 'discovery.site.all_duplicates', { site, duplicates: counts.duplicate }); return { status: 'ok', counts }; }
    // qualification requires a profile; without one nothing can qualify (save-job
    // needs it) — keep the candidates visible as non-qualifying, never drop them
    const profile = await deps.store.profileText(deps.ownerId);
    let verdicts: DiscoveryQualifiedCandidate[] = [];
    if (profile.trim()) {
      try { verdicts = await deps.qualify(fresh, profile, deps.query); }
      catch (error) {
        log('error', 'discovery.site.qualification.failed', { site, errorName: error instanceof Error ? error.name : 'UnknownError' });
        counts.error += 1;
        return { status: 'error', counts };
      }
    }
    const verdictByUrl = new Map(verdicts.map((verdict) => [verdict.url, verdict]));
    const hasProfile = profile.trim().length > 0;
    let remaining = Math.max(0, DISCOVERY_SITE_QUOTA - addedCount);
    for (const [index, candidate] of fresh.entries()) {
      const verdict = verdictByUrl.get(candidate.url);
      const qualified = hasProfile ? Boolean(verdict?.qualified) : false;
      if (!qualified) { counts.nonQualifying += 1; continue; }
      if (remaining <= 0) break; // quota reached: later qualifying roles roll to the next run
      remaining -= 1;
      try {
        await deps.saveJob({
          jobId: randomUUID(),
          userId: deps.ownerId,
          ownerId: deps.ownerId,
          chatId: deps.chatId,
          transportEventId: `disc-${runId}-${site}-${index}`,
          originalUrl: candidate.url,
          canonicalUrl: candidate.url,
        });
        counts.added += 1;
        log('info', 'discovery.site.saved', { site, url: candidate.url, transportEventId: `disc-${runId}-${site}-${index}` });
      } catch (error) {
        counts.error += 1;
        log('error', 'discovery.site.save.failed', { site, errorName: error instanceof Error ? error.name : 'UnknownError' });
      }
    }
    log('info', 'discovery.site.completed', { site, ...counts, cursor: cursor ?? null });
    // cursor: landing-page reads resume from the top; the global dedup makes
    // re-reads duplicates (D5). Pagination markers are discovery-strategy work.
    return { status: 'ok', counts, cursor: null };
  };
}
