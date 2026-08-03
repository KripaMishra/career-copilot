import type { WorkflowRunStatus } from '@mastra/core/workflows';

import type { CareerStore, QueueClaim, WorkerFence } from '../storage/career-store.ts';
import { SAVE_JOB_WORKFLOW_VERSION } from '../workflows/save-job.ts';

export type FirstStartFailpoint = 'beforeRunCreation' | 'afterRunCreation' | 'afterDispatching' | 'duringStartAsync' | 'afterStartAsync' | 'beforeRunning';
export type FirstStartFailpoints = { on?: (point: FirstStartFailpoint) => void | Promise<void> };

export class FirstStartCrashError extends Error {
  readonly point: FirstStartFailpoint;
  constructor(point: FirstStartFailpoint) {
    super(`Injected first-start crash at ${point}.`);
    this.point = point;
    this.name = 'FirstStartCrashError';
  }
}

type WorkflowStateEvidence = {
  runId: string;
  workflowName: string;
  resourceId?: string;
  status: WorkflowRunStatus;
};
type WorkflowRunPort = {
  runId: string;
  resourceId?: string;
  startAsync(args: { inputData: SaveJobStartInput }): Promise<{ runId: string }>;
};
export type SaveJobWorkflowPort = {
  id: string;
  getWorkflowRunById(runId: string): Promise<WorkflowStateEvidence | null>;
  createRun(options: { runId: string; resourceId: string }): Promise<WorkflowRunPort>;
  /** Reconstructs a handle only after the caller proved the exact same-ID run exists. It must never create a run. */
  reconstructRun(options: { runId: string; resourceId: string }): Promise<WorkflowRunPort>;
};

type SaveJobStartInput = {
  schemaVersion: 1;
  workflowVersion: 1;
  commandId: string;
  attempt: number;
  runId: string;
  resourceId: string;
  canonicalUrl: string;
};
export type FirstStartResult =
  | { kind: 'running'; runId: string; status: 'running' }
  | { kind: 'dispatched'; runId: string; status: 'pending' }
  | { kind: 'reconnected'; runId: string; status: 'waiting' | 'suspended' | 'paused' }
  | { kind: 'terminal'; runId: string; status: 'success' | 'failed' | 'tripwire' | 'canceled' | 'bailed' | 'skipped' }
  | { kind: 'operator_reconciliation_required'; runId: string; status: 'pending' }
  | { kind: 'recovery_in_progress'; runId: string; status: 'pending' };

const terminal = new Set<WorkflowRunStatus>(['success', 'failed', 'tripwire', 'canceled', 'bailed', 'skipped']);

export class CareerWorker {
  private readonly dependencies: { store: CareerStore; workflow: SaveJobWorkflowPort };
  constructor(dependencies: { store: CareerStore; workflow: SaveJobWorkflowPort }) { this.dependencies = dependencies; }

  async startOrRecover(claim: QueueClaim, failpoints: FirstStartFailpoints = {}): Promise<FirstStartResult> {
    if (claim.queueState !== 'starting') throw new Error('First-start recovery requires a starting claim.');
    const fence: WorkerFence = {
      commandId: claim.commandId, runId: claim.runId, ownerResourceId: claim.ownerResourceId,
      leaseOwner: claim.leaseOwner, claimGeneration: claim.claimGeneration, sourceState: 'starting',
    };
    let journal = this.dependencies.store.getFirstStartJournal(claim.commandId);
    if (!journal || journal.runId !== claim.runId || journal.resourceId !== claim.ownerResourceId
      || journal.claimGeneration !== claim.claimGeneration || journal.workflowVersion !== SAVE_JOB_WORKFLOW_VERSION) {
      throw new Error('First-start journal correlation does not match the current claim fence.');
    }

    let evidence = await this.dependencies.workflow.getWorkflowRunById(claim.runId);
    let run: WorkflowRunPort | undefined;
    if (!evidence) {
      if (journal.runCreationState === 'create_unknown' || journal.dispatchState === 'start_unknown') {
        return { kind: 'operator_reconciliation_required', runId: claim.runId, status: 'pending' };
      }
      if (journal.runCreationState === 'creating' || journal.runCreationState === 'created') {
        if (journal.runCreationState === 'creating' && journal.creationClaimGeneration === claim.claimGeneration) {
          return { kind: 'recovery_in_progress', runId: claim.runId, status: 'pending' };
        }
        if (!this.dependencies.store.markFirstRunCreateUnknown(fence).applied) throw new Error('Ambiguous run creation fence was lost.');
        return { kind: 'operator_reconciliation_required', runId: claim.runId, status: 'pending' };
      }
      await failpoints.on?.('beforeRunCreation');
      const creation = this.dependencies.store.claimFirstRunCreation(fence);
      if (!creation.applied) {
        evidence = await this.dependencies.workflow.getWorkflowRunById(claim.runId);
        if (!evidence) return { kind: 'recovery_in_progress', runId: claim.runId, status: 'pending' };
      } else {
        try {
          run = await this.dependencies.workflow.createRun({ runId: claim.runId, resourceId: claim.ownerResourceId });
        } catch {
          this.dependencies.store.markFirstRunCreateUnknown(fence);
          return { kind: 'operator_reconciliation_required', runId: claim.runId, status: 'pending' };
        }
        await failpoints.on?.('afterRunCreation');
        if (!this.dependencies.store.markFirstRunCreated(fence).applied) throw new Error('First-start run creation fence was lost.');
        evidence = await this.dependencies.workflow.getWorkflowRunById(claim.runId);
      }
    }
    if (!evidence) throw new Error('Created workflow run is not observable by its deterministic ID.');
    this.assertCorrelation(evidence, claim);
    journal = this.dependencies.store.getFirstStartJournal(claim.commandId)!;
    if (journal.runCreationState === 'not_created' || journal.runCreationState === 'creating') {
      if (!this.dependencies.store.markFirstRunCreated(fence).applied) throw new Error('First-start creation evidence fence was lost.');
    }

    if (evidence.status === 'pending') {
      journal = this.dependencies.store.getFirstStartJournal(claim.commandId)!;
      if (journal.dispatchState !== 'not_dispatched') {
        if (journal.dispatchState !== 'start_unknown') this.dependencies.store.markFirstStartUnknown(fence);
        return { kind: 'operator_reconciliation_required', runId: claim.runId, status: 'pending' };
      }
      if (!this.dependencies.store.markFirstStartDispatching(fence).applied) {
        return { kind: 'operator_reconciliation_required', runId: claim.runId, status: 'pending' };
      }
      await failpoints.on?.('afterDispatching');
      run ??= await this.dependencies.workflow.reconstructRun({ runId: claim.runId, resourceId: claim.ownerResourceId });
      const started = run.startAsync({ inputData: this.input(journal) });
      await failpoints.on?.('duringStartAsync');
      const dispatch = await started;
      if (dispatch.runId !== claim.runId) throw new Error('Workflow first-start returned mismatched run correlation.');
      await failpoints.on?.('afterStartAsync');
      if (!this.dependencies.store.markFirstStartDispatched(fence).applied) throw new Error('First-start dispatch fence was lost.');
      evidence = await this.dependencies.workflow.getWorkflowRunById(claim.runId);
      if (!evidence) throw new Error('Dispatched workflow run disappeared.');
      this.assertCorrelation(evidence, claim);
      if (evidence.status === 'pending') return { kind: 'dispatched', runId: claim.runId, status: 'pending' };
    }

    if (!this.dependencies.store.recordFirstStartObservation(fence, evidence.status).applied) {
      throw new Error('Workflow observation fence was lost.');
    }
    if (evidence.status === 'running') {
      await failpoints.on?.('beforeRunning');
      if (!this.dependencies.store.markRunning(fence).applied) throw new Error('Running persistence fence was lost.');
      return { kind: 'running', runId: claim.runId, status: 'running' };
    }
    if (evidence.status === 'waiting' || evidence.status === 'suspended' || evidence.status === 'paused') {
      return { kind: 'reconnected', runId: claim.runId, status: evidence.status };
    }
    if (terminal.has(evidence.status)) return { kind: 'terminal', runId: claim.runId, status: evidence.status as 'success' | 'failed' | 'tripwire' | 'canceled' | 'bailed' | 'skipped' };
    throw new Error(`Unsupported installed workflow state ${evidence.status}.`);
  }

  private input(journal: NonNullable<ReturnType<CareerStore['getFirstStartJournal']>>): SaveJobStartInput {
    return { schemaVersion: 1, workflowVersion: 1, commandId: journal.commandId, attempt: journal.workflowAttempt,
      runId: journal.runId, resourceId: journal.resourceId, canonicalUrl: journal.canonicalUrl };
  }

  private assertCorrelation(evidence: WorkflowStateEvidence, claim: QueueClaim): void {
    if (evidence.runId !== claim.runId || evidence.workflowName !== this.dependencies.workflow.id || evidence.resourceId !== claim.ownerResourceId) {
      throw new Error('Workflow run correlation does not match the durable first-start journal.');
    }
  }
}
