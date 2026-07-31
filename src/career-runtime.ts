import crypto from 'node:crypto';
import { assertJobUrl, assertSameJobSite } from './job-url.ts';
import { createCareerFilesystemBoundaries } from './local-files.ts';
import { GoogleOAuthRefreshProvider, GoogleSheetsBoundary, GoogleSheetsHttpApi, createGoogleSheetsTools, type SheetsApi } from './google-sheets.ts';
import { SqliteIdempotencyStore } from './idempotency.ts';
import { CareerCopilotService, type CareerCopilotDependencies, type CareerJob } from './career-copilot.ts';
import { createTelegramIngress } from './telegram-ingress.ts';
import type { RuntimeConfig } from './runtime-config.ts';

export type CareerCopilotRuntimeOverrides = Partial<CareerCopilotDependencies> & {
  sheetsApi?: SheetsApi;
  fetchJob?: (url: string) => Promise<CareerJob>;
};

async function fetchUntrustedJob(url: string): Promise<CareerJob> {
  const jobUrl = assertJobUrl(url);
  const response = await fetch(jobUrl, { headers: { 'user-agent': 'Career Copilot/1.0', accept: 'text/html,text/plain' }, signal: AbortSignal.timeout(15_000) });
  const finalUrl = assertSameJobSite(jobUrl, response.url);
  const description = await response.text();
  return {
    url: finalUrl.toString(),
    company: '', title: '', location: '',
    description: description.slice(0, 100_000),
    sourceHash: crypto.createHash('sha256').update(description).digest('hex'),
  };
}

export function createCareerCopilotRuntime(config: RuntimeConfig, overrides: CareerCopilotRuntimeOverrides = {}) {
  const filesystem = createCareerFilesystemBoundaries({ profile: config.profilePath, reports: config.reportsPath, topics: config.topicsPath });
  const idempotency = overrides.idempotency ?? new SqliteIdempotencyStore(config.databaseUrl);
  const oauth = new GoogleOAuthRefreshProvider(config.sheetsOAuth);
  const concreteSheets = new GoogleSheetsBoundary({
    target: config.sheetsTarget,
    authorize: () => oauth.getAccessToken(),
    api: overrides.sheetsApi ?? new GoogleSheetsHttpApi(),
  });
  const sheets = overrides.sheets ?? concreteSheets;
  const dependencies: CareerCopilotDependencies = {
    allowlist: { userIds: config.telegram.allowedUserIds, privateChatIds: config.telegram.privateChatIds },
    audit: { append: (row) => sheets.appendAudit(row) },
    fetchJob: overrides.fetchJob ?? fetchUntrustedJob,
    idempotency,
    sheets: sheets as CareerCopilotDependencies['sheets'],
    profile: overrides.profile ?? filesystem.profile,
    report: overrides.report ?? filesystem.report,
    topics: overrides.topics ?? filesystem.topic,
    alert: overrides.alert ?? (async () => {}),
  };
  const service = new CareerCopilotService(dependencies);
  const ingress = createTelegramIngress({ service });

  return {
    service,
    sheets,
    tools: createGoogleSheetsTools(concreteSheets),
    async handleTelegramUpdate(update: unknown, reply: (text: string) => Promise<void> = async () => {}) {
      const result = await ingress.handle(update, reply);
      if (result && typeof result === 'object' && 'outcome' in result) {
        const outcome = (result as { outcome: string }).outcome;
        if (outcome === 'rejected') await reply('Request rejected.');
        else if (outcome === 'duplicate') await reply('Previously seen job recorded.');
        else if (outcome === 'reviewed') await reply('Job review completed.');
      }
      return result;
    },
  };
}
