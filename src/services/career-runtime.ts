import { GoogleOAuthRefreshProvider, GoogleSheetsBoundary, GoogleSheetsHttpApi, createGoogleSheetsTools, type SheetsApi } from '../integrations/google-sheets.ts';
import { CareerStore } from '../storage/career-store.ts';
import { CareerCopilotService } from './career-copilot.ts';
import { createTelegramIngress } from '../channels/telegram-ingress.ts';
import { OwnerAuthorization } from '../channels/telegram-auth.ts';
import type { RuntimeConfig } from '../config/runtime.ts';

export type CareerCopilotRuntimeOverrides = { sheetsApi?: SheetsApi; store?: CareerStore };

export function createCareerCopilotRuntime(config: RuntimeConfig, overrides: CareerCopilotRuntimeOverrides = {}) {
  const store = overrides.store ?? new CareerStore(config.databaseUrl);
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
    tools: createGoogleSheetsTools(sheets),
    close: () => store.close(),
    async handleTelegramUpdate(update: unknown, reply: (text: string) => Promise<void> = async () => {}) {
      return ingress.handle(update, reply);
    },
  };
}
