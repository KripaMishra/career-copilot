import type { WorkflowRunStatus } from '@mastra/core/workflows';

import type { CareerStore, QueueClaim, TerminalSnapshotCapability, WorkerFence } from '../storage/career-store.ts';
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

export type LifecycleState = 'stopped' | 'initializing' | 'ready' | 'draining' | 'degraded';
export type LifecycleTimer = {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
  delay(delayMs: number): Promise<void>;
};
export type LifecycleBootstrapAttestation = Readonly<{ configurationValidated:true; storeOpened:true; migrationsVerified:true }>;
export type LifecycleEvent = Readonly<{
  timestamp: number;
  transition: 'store_opened'|'migrations_verified'|'bootstrap_attested'|'reconciliation'|'components_started'|'ready'|'claim'|'heartbeat'|'lease_lost'|'terminal'|'draining'|'stopped'|'startup_failed'|'worker_failure'|'reconciliation_failure'|'cleanup_failure';
  commandId?: string; runId?: string; generation?: number; durationMs?: number;
  errorClass?: 'startup'|'lease'|'workflow'|'database'|'cleanup';
}>;
export type CommandRunResult =
  | { kind:'checkpoint' }
  | { kind:'workflow_terminal'; observation:TerminalSnapshotCapability; safeError?:string }
  | { kind:'operator_reconciliation_required'; classification:'start_unknown'|'resume_unknown'|'outcome_unknown' };

const nativeTimer: LifecycleTimer = {
  setTimeout:(callback,delayMs)=>setTimeout(callback,delayMs),
  clearTimeout:(handle)=>clearTimeout(handle as ReturnType<typeof setTimeout>),
  now:()=>Date.now(),
  delay:(delayMs)=>new Promise(resolve=>setTimeout(resolve,delayMs)),
};

export class WorkerWakeSignal {
  private readonly listeners=new Set<()=>void>();
  notify():void { for(const listener of this.listeners) listener(); }
  subscribe(listener:()=>void):()=>void { this.listeners.add(listener); return()=>this.listeners.delete(listener); }
}

export class GlobalResourceMutex {
  private owner=false;
  private readonly waiters:Array<(release:()=>void)=>void>=[];
  private readonly timer:LifecycleTimer;
  constructor(timer:LifecycleTimer=nativeTimer) {this.timer=timer;}
  get locked():boolean { return this.owner; }
  private acquire(waitMs:number):Promise<()=>void> {
    if(!Number.isSafeInteger(waitMs)||waitMs<1||waitMs>30_000) return Promise.reject(new Error('Resource mutex wait must be between 1 and 30000 milliseconds.'));
    return new Promise((resolve,reject)=>{
      let timeout:unknown;
      const grant=(release:()=>void)=>{ if(timeout!==undefined)this.timer.clearTimeout(timeout); resolve(release); };
      timeout=this.timer.setTimeout(()=>{ const index=this.waiters.indexOf(grant); if(index>=0)this.waiters.splice(index,1); reject(new Error('Resource acquisition deadline expired.')); },waitMs);
      if(!this.owner){this.owner=true;grant(()=>this.release());} else this.waiters.push(grant);
    });
  }
  private release():void { const next=this.waiters.shift(); if(next)next(()=>this.release()); else this.owner=false; }
  async runExclusive<T>(operation:()=>Promise<T>,waitMs=30_000):Promise<T>{const release=await this.acquire(waitMs);try{return await operation();}finally{release();}}
}

export type CareerWorkerLifecycleDependencies={
  leaseOwner:string; store?:CareerStore; openStore?:()=>CareerStore; validate?:()=>void|Promise<void>;
  bootstrapAttestation?:LifecycleBootstrapAttestation;
  reconcileAdapters?:()=>void|Promise<void>; startComponents?:()=>void|Promise<void>;
  runner:{run(claim:QueueClaim,signal:AbortSignal):Promise<CommandRunResult>}; timer?:LifecycleTimer; wakeSignal?:WorkerWakeSignal;
  eventSink?:(event:LifecycleEvent)=>void; cleanupOwnedResources?:()=>void|Promise<void>; closeResources?:()=>void|Promise<void>;
  drainDeadlineMs?:number; heartbeatMs?:number; reconcileMs?:number; fallbackPollMs?:number;
};

function boundedPeriod(name:string,value:number,maximum:number):number {
  if(!Number.isSafeInteger(value)||value<1||value>maximum) throw new Error(`${name} must be between 1 and ${maximum} milliseconds.`);
  return value;
}

export class CareerWorkerLifecycle {
  private readonly dependencies:CareerWorkerLifecycleDependencies;
  private readonly timer:LifecycleTimer;
  private readonly wake:WorkerWakeSignal;
  private readonly fallbackMs:number;
  private readonly heartbeatMs:number;
  private readonly reconcileMs:number;
  private readonly drainMs:number;
  private store?:CareerStore;
  private stateValue:LifecycleState='stopped';
  private initialized=false;
  private current:Promise<void>|null=null;
  private currentClaim:QueueClaim|null=null;
  private currentAbort?:AbortController;
  private workTimer?:unknown;
  private reconcileTimer?:unknown;
  private heartbeatTimer?:unknown;
  private unsubscribeWake?:()=>void;
  private lastReconciliationAt:number|null=null;
  private expiredLeaseCycles=0;
  private startedOnce=false;
  private startupOpened=false;
  private storeOwned=false;
  private drainStarted=false;
  private drainTimedOut=false;
  private closeStarted=false;
  private shutdownCompletion:Promise<void>=Promise.resolve();

  constructor(dependencies:CareerWorkerLifecycleDependencies){
    if(!/^[A-Za-z0-9_.:@-]{1,200}$/.test(dependencies.leaseOwner))throw new Error('Worker lease owner is invalid.');
    this.dependencies=dependencies;
    this.timer=dependencies.timer??nativeTimer;
    this.wake=dependencies.wakeSignal??new WorkerWakeSignal();
    this.fallbackMs=boundedPeriod('Fallback poll',dependencies.fallbackPollMs??5_000,5_000);
    this.heartbeatMs=boundedPeriod('Heartbeat cadence',dependencies.heartbeatMs??30_000,30_000);
    this.reconcileMs=boundedPeriod('Reconciliation cadence',dependencies.reconcileMs??30_000,30_000);
    this.drainMs=boundedPeriod('Drain deadline',dependencies.drainDeadlineMs??30_000,30_000);
  }
  get state():LifecycleState{return this.stateValue;}
  get started():boolean{return this.startedOnce;}

  async start():Promise<void>{
    if(this.startedOnce)throw new Error('Worker lifecycle instances are single-use.');
    this.startedOnce=true;
    if(this.stateValue!=='stopped')throw new Error('Worker lifecycle can only start from stopped.');
    this.stateValue='initializing';
    try{
      if(this.dependencies.bootstrapAttestation){
        const attestation=this.dependencies.bootstrapAttestation;
        if(!this.dependencies.store||attestation.configurationValidated!==true||attestation.storeOpened!==true||attestation.migrationsVerified!==true)throw new Error('Worker bootstrap attestation is invalid.');
        this.store=this.dependencies.store;this.storeOwned=false;this.startupOpened=true;
        if(!this.store.migrationStatus().verified)throw new Error('Attested worker migrations are not verified.');
        this.emit('bootstrap_attested');
      }else{
        if(!this.dependencies.validate)throw new Error('Worker startup requires validation.');
        await this.dependencies.validate();
        if(!this.dependencies.openStore)throw new Error('Worker startup requires a real store opener.');
        this.store=this.dependencies.openStore();this.storeOwned=true;this.startupOpened=true;
        this.emit('store_opened');
        if(!this.store.migrationStatus().verified)throw new Error('Worker migrations are not verified.');
        this.emit('migrations_verified');
      }
      await this.reconcileNow(true);
      await this.dependencies.reconcileAdapters?.();
      await this.dependencies.startComponents?.();
      this.emit('components_started');
      this.unsubscribeWake=this.wake.subscribe(()=>this.scheduleWork(0));
      this.initialized=true;this.stateValue='ready';this.emit('ready');
      this.scheduleWork();this.scheduleReconciliation();
      if(this.stateValue!=='ready')throw new Error('Worker lifecycle timers failed to initialize.');
    }catch(error){
      this.initialized=false;this.stateValue='degraded';this.emit('startup_failed',{errorClass:'startup'});
      await this.rollbackStartup();
      throw error;
    }
  }

  notifyEnqueued():void{this.wake.notify();}

  async runOnce():Promise<boolean>{
    if(this.stateValue!=='ready'||this.current||!this.store)return false;
    const claim=this.store.claimNextRunnable(this.dependencies.leaseOwner);
    if(!claim)return false;
    const execution=this.executeClaim(claim);
    this.current=execution;
    try{await execution;}finally{
      if(this.current===execution)this.current=null;
      if((this.stateValue as LifecycleState)==='draining')await this.finishShutdown();
    }
    return true;
  }

  private async executeClaim(claim:QueueClaim):Promise<void>{
    const startedAt=this.timer.now();const abort=new AbortController();
    this.currentAbort=abort;this.currentClaim=claim;
    this.emit('claim',{commandId:claim.commandId,runId:claim.runId,generation:claim.claimGeneration});
    try{
      this.scheduleHeartbeat(claim,abort);
      const result=await this.dependencies.runner.run(claim,abort.signal);
      if(abort.signal.aborted||!this.store)return;
      if(result.kind==='workflow_terminal'){
        const currentState=this.store.getCommand(claim.commandId)?.queueState;
        const sourceState=currentState==='starting'||currentState==='running'||currentState==='resuming'?currentState:claim.queueState;
        const fence={...claim,sourceState};
        const projected=this.store.projectWorkflowTerminal(fence,result.observation,result.safeError);
        if(!projected.applied){this.loseLease(claim,abort);return;}
        this.emit('terminal',{commandId:claim.commandId,runId:claim.runId,generation:claim.claimGeneration,durationMs:Math.max(0,this.timer.now()-startedAt)});
      }
    }catch{
      abort.abort();this.fail('worker_failure','workflow',claim);
    }finally{
      try{if(this.heartbeatTimer!==undefined)this.timer.clearTimeout(this.heartbeatTimer);}catch{this.fail('cleanup_failure','cleanup',claim);}
      this.heartbeatTimer=undefined;
      if(this.currentAbort===abort)this.currentAbort=undefined;
      if(this.currentClaim===claim)this.currentClaim=null;
      try{await this.dependencies.cleanupOwnedResources?.();}catch{this.fail('cleanup_failure','cleanup',claim);}
    }
  }

  private scheduleHeartbeat(claim:QueueClaim,abort:AbortController):void{
    this.heartbeatTimer=this.timer.setTimeout(()=>{void this.heartbeatTick(claim,abort);},this.heartbeatMs);
  }
  private async heartbeatTick(claim:QueueClaim,abort:AbortController):Promise<void>{
    try{
      if(abort.signal.aborted||!this.store||this.stateValue==='stopped')return;
      const sourceState=this.store.getCommand(claim.commandId)?.queueState;
      const renewed=sourceState==='starting'||sourceState==='running'||sourceState==='resuming'
        ?this.store.renewClaim({...claim,sourceState}):{applied:false as const,reason:'lease_lost' as const};
      if(!renewed.applied){this.loseLease(claim,abort);return;}
      this.emit('heartbeat',{commandId:claim.commandId,runId:claim.runId,generation:claim.claimGeneration});
      this.scheduleHeartbeat(claim,abort);
    }catch{abort.abort();this.fail('worker_failure','database',claim);}
  }

  private loseLease(claim:QueueClaim,abort:AbortController):void{
    abort.abort();this.initialized=false;this.stateValue='degraded';
    for(const key of ['workTimer','reconcileTimer'] as const){const handle=this[key];try{if(handle!==undefined)this.timer.clearTimeout(handle);}catch{}this[key]=undefined;}
    this.emit('lease_lost',{commandId:claim.commandId,runId:claim.runId,generation:claim.claimGeneration,errorClass:'lease'});
  }

  private scheduleWork(delayMs?:number):void{
    if(this.stateValue!=='ready'||!this.store)return;
    try{
      if(this.workTimer!==undefined)this.timer.clearTimeout(this.workTimer);
      const wait=delayMs??this.store.nextRunnableDelayMs(this.fallbackMs);
      this.workTimer=this.timer.setTimeout(()=>{this.workTimer=undefined;void this.workTick();},wait);
    }catch{this.fail('worker_failure','database');}
  }
  private async workTick():Promise<void>{
    try{await this.runOnce();}catch{this.fail('worker_failure','database');}
    if(this.stateValue==='ready')this.scheduleWork();
  }

  private scheduleReconciliation():void{
    if(this.stateValue!=='ready')return;
    try{this.reconcileTimer=this.timer.setTimeout(()=>{this.reconcileTimer=undefined;void this.reconciliationTick();},this.reconcileMs);}
    catch{this.fail('reconciliation_failure','database');}
  }
  private async reconciliationTick():Promise<void>{
    try{await this.reconcileNow(false);}catch{this.fail('reconciliation_failure','database');return;}
    if(this.stateValue==='ready')this.scheduleReconciliation();
  }
  private async reconcileNow(initial:boolean):Promise<void>{
    if(!this.store)throw new Error('Worker store is unavailable for reconciliation.');
    const result=this.store.reconcileLifecycle();this.expiredLeaseCycles=result.expiredLeaseCycles;
    this.lastReconciliationAt=this.timer.now();this.emit('reconciliation');
    if(!initial&&this.expiredLeaseCycles>=2)this.stateValue='degraded';
  }

  private stopLifecycleTimers():void{
    this.unsubscribeWake?.();this.unsubscribeWake=undefined;
    for(const key of ['workTimer','reconcileTimer','heartbeatTimer'] as const){
      const handle=this[key];
      try{if(handle!==undefined)this.timer.clearTimeout(handle);}catch{this.fail('cleanup_failure','cleanup');}
      this[key]=undefined;
    }
  }

  private async rollbackStartup():Promise<void>{
    this.stopLifecycleTimers();
    if(!this.startupOpened){this.store=undefined;return;}
    if(this.closeStarted){this.store=undefined;return;}
    this.closeStarted=true;
    try{await this.dependencies.cleanupOwnedResources?.();}catch{this.emit('cleanup_failure',{errorClass:'cleanup'});}
    try{await this.dependencies.closeResources?.();}catch{this.emit('cleanup_failure',{errorClass:'cleanup'});}
    if(this.storeOwned){try{this.store?.close();}catch{this.emit('cleanup_failure',{errorClass:'cleanup'});}}
    this.store=undefined;
  }

  async drain():Promise<void>{
    if(this.stateValue==='stopped'||(this.closeStarted&&!this.store))return;
    if(this.drainStarted)return;
    this.drainStarted=true;this.stateValue='draining';this.initialized=false;this.emit('draining');
    this.unsubscribeWake?.();this.unsubscribeWake=undefined;
    for(const key of ['workTimer','reconcileTimer'] as const){
      const handle=this[key];try{if(handle!==undefined)this.timer.clearTimeout(handle);}catch{this.fail('cleanup_failure','cleanup');}this[key]=undefined;
    }
    const current=this.current;
    if(!current){await this.finishShutdown();return;}
    this.shutdownCompletion=current.then(()=>this.finishShutdown());
    let deadlineHandle:unknown;
    let settled=false;
    try{
      const deadline=new Promise<boolean>(resolve=>{deadlineHandle=this.timer.setTimeout(()=>resolve(false),this.drainMs);});
      settled=await Promise.race([current.then(()=>true),deadline]);
    }catch{this.fail('cleanup_failure','cleanup');this.currentAbort?.abort();return;}
    finally{try{if(deadlineHandle!==undefined)this.timer.clearTimeout(deadlineHandle);}catch{this.fail('cleanup_failure','cleanup');}}
    if(settled){await this.shutdownCompletion;return;}
    this.drainTimedOut=true;this.currentAbort?.abort();
    try{if(this.heartbeatTimer!==undefined)this.timer.clearTimeout(this.heartbeatTimer);}catch{this.fail('cleanup_failure','cleanup');}
    this.heartbeatTimer=undefined;
  }

  waitForShutdown():Promise<void>{return this.shutdownCompletion;}

  private async finishShutdown():Promise<void>{
    if(this.current||this.closeStarted)return;
    this.closeStarted=true;
    let failed=false;
    try{await this.dependencies.closeResources?.();}catch{failed=true;this.emit('cleanup_failure',{errorClass:'cleanup'});}
    if(this.storeOwned){try{this.store?.close();}catch{failed=true;this.emit('cleanup_failure',{errorClass:'cleanup'});}}
    this.store=undefined;
    if(failed){this.stateValue='degraded';return;}
    this.stateValue='stopped';this.emit('stopped');
  }

  health():{
    state:LifecycleState;ready:boolean;degraded:boolean;database:boolean;migrations:boolean;queueDepth:number;oldestRunnableAgeMs:number;
    dueRetries:number;suspensions:number;expiredLeases:number;currentClaim:{commandId:string;runId:string;generation:number;state:QueueClaim['queueState']}|null;
    lastReconciliationAt:number|null;startUnknown:number;resumeUnknown:number;outcomeUnknownEffects:number;
  }{
    const database=Boolean(this.store);const migrations=this.store?.migrationStatus().verified??false;
    const stats=this.store?.lifecycleHealth()??{queueDepth:0,oldestRunnableAgeMs:0,dueRetries:0,suspensions:0,expiredLeases:0,stuckLeases:0,startUnknown:0,resumeUnknown:0,outcomeUnknownEffects:0};
    const degraded=this.stateValue==='degraded'||this.drainTimedOut||stats.oldestRunnableAgeMs>300_000||stats.stuckLeases>0||stats.startUnknown>0||stats.resumeUnknown>0||stats.outcomeUnknownEffects>0;
    return{state:this.stateValue,ready:this.stateValue==='ready'&&this.initialized&&database&&migrations,degraded,database,migrations,
      queueDepth:stats.queueDepth,oldestRunnableAgeMs:stats.oldestRunnableAgeMs,dueRetries:stats.dueRetries,suspensions:stats.suspensions,
      expiredLeases:stats.expiredLeases,currentClaim:this.currentClaim?{commandId:this.currentClaim.commandId,runId:this.currentClaim.runId,
        generation:this.currentClaim.claimGeneration,state:this.currentClaim.queueState}:null,lastReconciliationAt:this.lastReconciliationAt,
      startUnknown:stats.startUnknown,resumeUnknown:stats.resumeUnknown,outcomeUnknownEffects:stats.outcomeUnknownEffects};
  }

  private fail(transition:'worker_failure'|'reconciliation_failure'|'cleanup_failure',errorClass:'workflow'|'database'|'cleanup',claim?:QueueClaim):void{
    this.initialized=false;if(this.stateValue==='ready')this.stateValue='degraded';else if(this.stateValue==='draining')this.drainTimedOut=true;
    this.emit(transition,{errorClass,...(claim?{commandId:claim.commandId,runId:claim.runId,generation:claim.claimGeneration}:{})});
  }
  private emit(transition:LifecycleEvent['transition'],fields:Omit<LifecycleEvent,'timestamp'|'transition'>={}):void{
    try{this.dependencies.eventSink?.(Object.freeze({timestamp:this.timer.now(),transition,...fields}));}catch{/* telemetry is never authority */}
  }
}

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
