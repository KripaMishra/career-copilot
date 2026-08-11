import type { RunStatus } from './schemas/run.ts';

/**
 * Hermetic status semantics (issue #13):
 * - passed: replay complete, every deterministic assertion passed.
 * - failed: replay complete, >= 1 assertion failure.
 * - incomplete: setup/timeout/model/adapter/capture/judge prevented a complete
 *   result — always with an explicit reason.
 * - skipped: explicit filter exclusion; never participates in comparison/pinning.
 *
 * Run aggregation: passed iff all selected passed; failed if any failed;
 * incomplete if none failed but any incomplete; skipped only if none executed.
 */

export type ScenarioOutcome = {
  scenarioId: string;
  status: RunStatus;
  reason?: string;
  assertionFailures: number;
  incomplete: boolean;
};

export type RunAggregate = { status: RunStatus; passed: number; failed: number; incomplete: number; skipped: number; executed: number };

export function aggregateOutcomes(outcomes: ScenarioOutcome[]): RunAggregate {
  const passed = outcomes.filter((outcome) => outcome.status === 'passed').length;
  const failed = outcomes.filter((outcome) => outcome.status === 'failed').length;
  const incomplete = outcomes.filter((outcome) => outcome.status === 'incomplete').length;
  const skipped = outcomes.filter((outcome) => outcome.status === 'skipped').length;
  const executed = passed + failed + incomplete;
  let status: RunStatus;
  if (executed === 0) status = 'skipped';
  else if (failed > 0) status = 'failed';
  else if (incomplete > 0) status = 'incomplete';
  else status = 'passed';
  return { status, passed, failed, incomplete, skipped, executed };
}

export function exitCodeFor(aggregate: RunAggregate, scenarioCount: number): number {
  // Exit 0 only for documented successful terminal status; empty corpus is a
  // successful no-op (scenarios land in #13c).
  if (scenarioCount === 0) return 0;
  if (aggregate.status === 'passed' || aggregate.status === 'skipped') return 0;
  return 1;
}
