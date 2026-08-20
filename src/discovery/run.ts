import type { AppLogger } from '../observability.ts';
import type { CareerStore, DiscoveryCounts, DiscoverySite } from '../storage/career-store.ts';
import { buildDiscoveryDigest } from './digest.ts';
import { DISCOVERY_SITES, type DiscoverySiteStep, type DiscoverySiteStepResult } from './sites.ts';

/** Digest sender — injectable so tests spy on it and production binds the
 * owner's private Telegram chat (config.telegram.privateChatIds). */
export type DiscoveryDigestSender = (text: string) => Promise<void>;

export type DiscoveryRunOutcome = { outcome: 'skipped_overlap' }
  | { outcome: 'succeeded' | 'failed'; runId: string; digest: string; digestSent: boolean };

export type DiscoveryRunOptions = {
  store: CareerStore;
  siteStep: DiscoverySiteStep;
  send: DiscoveryDigestSender;
  logger?: AppLogger;
};

const zeroCounts: DiscoveryCounts = { added: 0, duplicate: 0, nonQualifying: 0, blocked: 0, error: 0 };

function sumCounts(sites: { counts: DiscoveryCounts }[]): DiscoveryCounts {
  const total = { ...zeroCounts };
  for (const site of sites) for (const key of Object.keys(total) as (keyof DiscoveryCounts)[]) total[key] += site.counts[key];
  return total;
}

/** The deterministic run shell (spec D1/D2/D3/D5): acquire the lease; when no
 * other run owns it, walk the sites in strict order through the injectable
 * site step, persist per-site rows, and stop-continue on any site failure; then
 * finish the run row with aggregate counts and send exactly one digest.
 *
 * Overlap-skip exits before touching any site or sending any digest — the
 * previous run owns that fire. */
export async function runDiscoveryAndDigest(options: DiscoveryRunOptions): Promise<DiscoveryRunOutcome> {
  const log: AppLogger = (level, event, data) => { try { options.logger?.(level, event, data); } catch { /* logging cannot break a run */ } };
  const { store, siteStep, send } = options;
  const created = await store.createDiscoveryRun();
  if (created.outcome === 'skipped_overlap') {
    log('info', 'discovery.run.skipped_overlap', {});
    return { outcome: 'skipped_overlap' };
  }
  const { runId } = created.run;
  log('info', 'discovery.run.started', { runId });
  const sites: DiscoverySite[] = [];
  let failed = false;
  for (const site of DISCOVERY_SITES) {
    const cursor = (await store.latestDiscoverySite(site))?.cursor ?? null;
    const addedCount = await store.discoverySiteAddedCount(runId, site);
    let result: DiscoverySiteStepResult;
    try {
      result = await siteStep({ runId, site, cursor, addedCount });
      log('info', 'discovery.site.step.succeeded', { runId, site, status: result.status });
    } catch (error) {
      // a throwing site step is contained: record an error row and continue
      result = { status: 'error', counts: { ...zeroCounts, error: 1 } };
      log('error', 'discovery.site.step.failed', { runId, site, errorName: error instanceof Error ? error.name : 'UnknownError' });
    }
    try {
      sites.push(await store.upsertDiscoverySite({
        runId, site,
        status: result.status,
        ...(result.cursor !== undefined ? { cursor: result.cursor } : {}),
        counts: result.counts,
        ...(result.blockedReason !== undefined ? { blockedReason: result.blockedReason } : {}),
        ...(result.blockedEvidence !== undefined ? { blockedEvidence: result.blockedEvidence } : {}),
      }));
    } catch (error) {
      // a storage write failure is run-level: stop the loop, fail the run
      failed = true;
      log('error', 'discovery.site.persist.failed', { runId, site, errorName: error instanceof Error ? error.name : 'UnknownError' });
      break;
    }
  }
  const status = failed ? 'failed' : 'succeeded';
  const counts = sumCounts(sites);
  let run;
  try {
    run = await store.finishDiscoveryRun({ runId, status, counts });
  } catch (error) {
    log('error', 'discovery.run.finish.failed', { runId, errorName: error instanceof Error ? error.name : 'UnknownError' });
    return { outcome: 'failed', runId, digest: '', digestSent: false };
  }
  const digest = buildDiscoveryDigest({ run, sites });
  let digestSent = false;
  try {
    await send(digest);
    digestSent = true;
    log('info', 'discovery.run.completed', { runId, outcome: status, digest: true });
  } catch (error) {
    log('error', 'discovery.digest.failed', { runId, errorName: error instanceof Error ? error.name : 'UnknownError' });
  }
  return { outcome: status, runId, digest, digestSent };
}
