import { createStep, createWorkflow } from '@mastra/core/workflows';
import { z } from 'zod';
import { runDiscoveryAndDigest, type DiscoveryDigestSender } from '../../discovery/run.ts';
import { stubDiscoverySiteStep, type DiscoverySiteStep } from '../../discovery/sites.ts';
import { JOB_DISCOVERY_WORKFLOW_ID } from '../../discovery/schedule.ts';
import type { CareerStore } from '../../storage/career-store.ts';

export { JOB_DISCOVERY_WORKFLOW_ID };
export const runInputSchema = z.object({ runId: z.string().optional() });
const runOutputSchema = z.object({ runId: z.string(), digest: z.string() });

export type JobDiscoveryWorkflowOptions = {
  store: CareerStore;
  /** Replaced by the real per-site reads in the discovery-sites ticket. */
  siteStep?: DiscoverySiteStep;
  send: DiscoveryDigestSender;
};

/** The code-driven job discovery workflow (spec D1): a single deterministic
 * step that owns lease acquisition, strict site order, per-site persistence,
 * stop-continue, run finish, and the one authorized digest. The per-site
 * reader is injectable; the digest sender is injected (owner's private chat). */
export function createJobDiscoveryWorkflow(options: JobDiscoveryWorkflowOptions) {
  const { store, send, siteStep = stubDiscoverySiteStep } = options;
  const runDiscoveryStep = createStep({
    id: 'runDiscovery',
    inputSchema: runInputSchema,
    outputSchema: runOutputSchema,
    execute: async () => {
      const result = await runDiscoveryAndDigest({ store, siteStep, send });
      if (result.outcome === 'skipped_overlap') return { runId: '', digest: '' };
      return { runId: result.runId, digest: result.digest };
    },
  });
  return createWorkflow({ id: JOB_DISCOVERY_WORKFLOW_ID, inputSchema: runInputSchema, outputSchema: runOutputSchema }).then(runDiscoveryStep).commit();
}
