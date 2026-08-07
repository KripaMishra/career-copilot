export type WorkflowSnapshotLike = { status: string; isFromInMemory?: boolean; payload?: unknown } | null;

export function isRestartableWorkflowSnapshot(snapshot: WorkflowSnapshotLike): boolean {
  return Boolean(snapshot && !snapshot.isFromInMemory && (snapshot.status === 'running' || snapshot.status === 'waiting'
    || (snapshot.status === 'pending' && snapshot.payload !== undefined)));
}
