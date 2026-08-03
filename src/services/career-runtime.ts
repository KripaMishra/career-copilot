import { GoogleOAuthRefreshProvider, GoogleSheetsBoundary, GoogleSheetsHttpApi, createGoogleSheetsTools, type SheetsApi } from '../integrations/google-sheets.ts';
import { CareerStore } from '../storage/career-store.ts';
import { CareerCopilotService } from './career-copilot.ts';
import { createTelegramIngress } from '../channels/telegram-ingress.ts';
import { OwnerAuthorization } from '../channels/telegram-auth.ts';
import type { RuntimeConfig } from '../config/runtime.ts';
import { CareerWorkerLifecycle, WorkerWakeSignal, type CareerWorkerLifecycleDependencies } from './career-worker.ts';

export type CareerCopilotRuntimeOverrides = {
  sheetsApi?: SheetsApi;
  store?: CareerStore;
  commandRunner?: CareerWorkerLifecycleDependencies['runner'];
  workerEvents?: CareerWorkerLifecycleDependencies['eventSink'];
  cleanupOwnedResources?: CareerWorkerLifecycleDependencies['cleanupOwnedResources'];
};

export function createCareerCopilotRuntime(config: RuntimeConfig, overrides: CareerCopilotRuntimeOverrides = {}) {
  const store = overrides.store ?? new CareerStore(config.databaseUrl,{terminalObservationRootKey:config.owner.intakeHashKey});
  const authorization = new OwnerAuthorization(() => ({
    resourceId: config.owner.resourceId,
    enabled: config.owner.enabled,
    authorizationRevision: config.owner.authorizationRevision,
    telegram: { userIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds },
    studioEnabled: config.owner.studioEnabled,
    stdioEnabled: config.owner.stdioEnabled,
    apiIdentity: config.owner.apiIdentity,
  }));
  const service = new CareerCopilotService({ authorization, store, intakeHashKey: config.owner.intakeHashKey });
  const ingress = createTelegramIngress({ service });
  let storeClosed = false;
  const closeStore = () => { if (!storeClosed) { storeClosed = true; store.close(); } };
  const workerWakeSignal = new WorkerWakeSignal();
  const worker = overrides.commandRunner ? new CareerWorkerLifecycle({
    leaseOwner: `career-worker:${process.pid}`,
    store,
    bootstrapAttestation: Object.freeze({ configurationValidated: true, storeOpened: true, migrationsVerified: true }),
    wakeSignal: workerWakeSignal,
    runner: overrides.commandRunner,
    eventSink: overrides.workerEvents,
    cleanupOwnedResources: overrides.cleanupOwnedResources,
    closeResources: closeStore,
  }) : undefined;

  // Existing tools remain registered for later worker tasks; transport intake never invokes them.
  const oauth = new GoogleOAuthRefreshProvider(config.sheetsOAuth);
  const sheets = new GoogleSheetsBoundary({
    target: config.sheetsTarget,
    authorize: () => oauth.getAccessToken(),
    api: overrides.sheetsApi ?? new GoogleSheetsHttpApi(),
  });

  return {
    service,
    store,
    worker,
    workerWakeSignal,
    notifyWorker: () => worker?.notifyEnqueued(),
    startWorker: async () => { if (!worker) throw new Error('Worker command runner is not configured.'); if (storeClosed) throw new Error('Career runtime is closed.'); await worker.start(); },
    drainWorker: async () => { await worker?.drain(); },
    waitForWorkerShutdown: async () => { await worker?.waitForShutdown(); },
    shutdown: async () => { await worker?.drain(); await worker?.waitForShutdown(); closeStore(); },
    tools: createGoogleSheetsTools(sheets),
    close: () => { if (worker?.started) throw new Error('Worker-enabled runtime requires awaited shutdown().'); closeStore(); },
    async handleTelegramUpdate(update: unknown, reply: (text: string) => Promise<void> = async () => {}) {
      const result = await ingress.handle(update, reply);
      if (result && typeof result === 'object' && 'outcome' in result && result.outcome === 'enqueued') worker?.notifyEnqueued();
      return result;
    },
  };
}
