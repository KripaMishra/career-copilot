import type { DiscoveryRun, DiscoverySite } from '../storage/career-store.ts';
import { DISCOVERY_SITES } from './sites.ts';

/** Data the digest is built from — the finished run row plus its per-site
 * rows, read back from the persisted store (spec D5). */
export type DiscoveryDigestData = { run: DiscoveryRun; sites: DiscoverySite[] };

const countsOf = (site: DiscoverySite) =>
  `added ${site.counts.added} · dup ${site.counts.duplicate} · non-qual ${site.counts.nonQualifying} · blocked ${site.counts.blocked} · error ${site.counts.error}`;

/** Exactly-one authorized Telegram digest (spec D5/D8): per-site added /
 * duplicate / non-qualifying / blocked / error counts plus the overall run
 * outcome, in discovery order. Pure — the sender (run shell / on-demand pass)
 * decides when a message is warranted; overlap-skipped runs never reach this
 * builder. */
export function buildDiscoveryDigest({ run, sites }: DiscoveryDigestData, title = 'Daily discovery run'): string {
  const bySite = new Map(sites.map((site) => [site.site, site]));
  const lines = DISCOVERY_SITES
    .map((site) => bySite.get(site))
    .filter((site): site is DiscoverySite => site !== undefined)
    .map((site) => `${site.site}: ${countsOf(site)}`);
  return [
    `${title} · ${run.runId.slice(0, 8)}`,
    `Outcome: ${run.status} · Sites: ${lines.length} · Added: ${run.counts.added} · Duplicates: ${run.counts.duplicate} · Non-qualifying: ${run.counts.nonQualifying} · Blocked: ${run.counts.blocked} · Errors: ${run.counts.error}`,
    ...lines,
  ].join('\n');
}
