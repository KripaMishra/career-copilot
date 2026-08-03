import fs from 'node:fs';
import path from 'node:path';

export type RuntimeEnvironment = Record<string, string | undefined>;

export type RuntimeConfigInput = {
  dataDir?: string;
  databaseUrl?: string;
  profileDir?: string;
  reportsDir?: string;
  topicsDir?: string;
  requireDeployment?: boolean;
  env?: RuntimeEnvironment;
};

export type RuntimeConfig = {
  dataDir: string;
  workspacePath: string;
  profilePath: string;
  reportsPath: string;
  topicsPath: string;
  databaseUrl: string;
  telegram: {
    botToken: string;
    secretToken?: string;
    allowedUserIds: ReadonlySet<string>;
    privateChatIds: ReadonlySet<string>;
  };
  sheetsTarget: {
    spreadsheetId: string;
    trackerTab: string;
    auditTab: string;
    topicsTab: string;
  };
  sheetsOAuth: {
    clientId: string;
    clientSecret: string;
    refreshToken: string;
    scope: string;
  };
};

export function assertOperationalDatabaseUrl(databaseUrl: string): string {
  let url: URL;
  try {
    url = new URL(databaseUrl);
  } catch {
    throw new Error('MASTRA_DATABASE_URL must use one absolute local file: database URL.');
  }
  if (
    !databaseUrl.startsWith('file:/')
    || url.protocol !== 'file:'
    || (url.hostname !== '' && url.hostname !== 'localhost')
    || !path.isAbsolute(url.pathname)
    || url.pathname === '/:memory:'
    || url.search !== ''
    || url.hash !== ''
  ) throw new Error('MASTRA_DATABASE_URL must use one absolute local file: database URL.');
  return databaseUrl;
}

function numericIds(value: string | undefined, name: string, required: boolean) {
  if (!value?.trim()) {
    if (required) throw new Error(`${name} is required.`);
    return new Set<string>();
  }
  const ids = value.split(',').map((id) => id.trim());
  if (ids.some((id) => !/^\d+$/.test(id))) throw new Error(`${name} must contain numeric IDs.`);
  return new Set(ids);
}

function requiredValue(env: RuntimeEnvironment, name: string) {
  const value = env[name]?.trim();
  if (!value) throw new Error(`${name} is required.`);
  return value;
}

function assertNonOverlappingRoots(profile: string, reports: string, topics: string) {
  const roots = [profile, reports, topics].map((root) => path.resolve(root));
  for (let i = 0; i < roots.length; i += 1) {
    for (let j = i + 1; j < roots.length; j += 1) {
      const relative = path.relative(roots[i], roots[j]);
      if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw new Error('Profile, report, and topic roots must not overlap.');
      }
    }
  }
}

export function resolveRuntimeConfig(input: RuntimeConfigInput = {}): RuntimeConfig {
  const env = input.env ?? process.env;
  const requireDeployment = input.requireDeployment === true;
  const configuredDatabaseUrl = input.databaseUrl ?? env.MASTRA_DATABASE_URL;
  if (requireDeployment && !configuredDatabaseUrl) throw new Error('MASTRA_DATABASE_URL is required.');

  const dataDir = input.dataDir ?? env.MASTRA_DATA_DIR ?? path.join(process.cwd(), '.mastra', 'career-copilot');
  const absoluteDataDir = path.resolve(dataDir);
  fs.mkdirSync(absoluteDataDir, { recursive: true });

  if (requireDeployment && !input.profileDir && !env.CAREER_COPILOT_PROFILE_DIR) throw new Error('CAREER_COPILOT_PROFILE_DIR is required.');
  if (requireDeployment && !input.reportsDir && !env.CAREER_COPILOT_REPORTS_DIR) throw new Error('CAREER_COPILOT_REPORTS_DIR is required.');
  if (requireDeployment && !input.topicsDir && !env.CAREER_COPILOT_TOPICS_DIR) throw new Error('CAREER_COPILOT_TOPICS_DIR is required.');
  const profilePath = path.resolve(input.profileDir ?? env.CAREER_COPILOT_PROFILE_DIR ?? path.join(dataDir, 'profile'));
  const reportsPath = path.resolve(input.reportsDir ?? env.CAREER_COPILOT_REPORTS_DIR ?? path.join(dataDir, 'reports'));
  const topicsPath = path.resolve(input.topicsDir ?? env.CAREER_COPILOT_TOPICS_DIR ?? path.join(dataDir, 'topics'));
  assertNonOverlappingRoots(profilePath, reportsPath, topicsPath);
  fs.mkdirSync(reportsPath, { recursive: true });
  fs.mkdirSync(topicsPath, { recursive: true });

  const databaseUrl = assertOperationalDatabaseUrl(
    configuredDatabaseUrl ?? `file:${path.join(absoluteDataDir, 'mastra.db')}`,
  );
  const spreadsheetId = requireDeployment
    ? requiredValue(env, 'GOOGLE_SHEETS_SPREADSHEET_ID')
    : env.GOOGLE_SHEETS_SPREADSHEET_ID ?? '';
  const trackerTab = requireDeployment ? requiredValue(env, 'GOOGLE_SHEETS_TRACKER_TAB') : env.GOOGLE_SHEETS_TRACKER_TAB ?? 'Applications';
  const auditTab = requireDeployment ? requiredValue(env, 'GOOGLE_SHEETS_APPLICATION_LOG_TAB') : env.GOOGLE_SHEETS_APPLICATION_LOG_TAB ?? 'Application Log';
  const topicsTab = requireDeployment ? requiredValue(env, 'GOOGLE_SHEETS_TOPICS_TAB') : env.GOOGLE_SHEETS_TOPICS_TAB ?? 'Topics';
  const botToken = requireDeployment ? requiredValue(env, 'TELEGRAM_BOT_TOKEN') : env.TELEGRAM_BOT_TOKEN ?? '';
  const allowedUserIds = numericIds(env.TELEGRAM_ALLOWED_USER_IDS, 'TELEGRAM_ALLOWED_USER_IDS', requireDeployment);
  const privateChatIds = numericIds(env.CAREER_COPILOT_PRIVATE_CHAT_IDS, 'CAREER_COPILOT_PRIVATE_CHAT_IDS', requireDeployment);
  const sheetsOAuth = {
    clientId: requireDeployment ? requiredValue(env, 'GOOGLE_OAUTH_CLIENT_ID') : env.GOOGLE_OAUTH_CLIENT_ID ?? '',
    clientSecret: requireDeployment ? requiredValue(env, 'GOOGLE_OAUTH_CLIENT_SECRET') : env.GOOGLE_OAUTH_CLIENT_SECRET ?? '',
    refreshToken: requireDeployment ? requiredValue(env, 'GOOGLE_OAUTH_REFRESH_TOKEN') : env.GOOGLE_OAUTH_REFRESH_TOKEN ?? '',
    scope: env.GOOGLE_OAUTH_SCOPE ?? 'https://www.googleapis.com/auth/spreadsheets',
  };

  if (requireDeployment && !trackerTab) throw new Error('GOOGLE_SHEETS_TRACKER_TAB is required.');
  if (requireDeployment && !auditTab) throw new Error('GOOGLE_SHEETS_APPLICATION_LOG_TAB is required.');
  if (requireDeployment && !topicsTab) throw new Error('GOOGLE_SHEETS_TOPICS_TAB is required.');

  return {
    dataDir: absoluteDataDir,
    workspacePath: path.join(absoluteDataDir, 'workspace'),
    profilePath,
    reportsPath,
    topicsPath,
    databaseUrl,
    telegram: { botToken, secretToken: env.TELEGRAM_WEBHOOK_SECRET_TOKEN, allowedUserIds, privateChatIds },
    sheetsTarget: { spreadsheetId, trackerTab, auditTab, topicsTab },
    sheetsOAuth,
  };
}
