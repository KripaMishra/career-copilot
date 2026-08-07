import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertSafeWorkspaceRoots } from '../integrations/local-files.ts';
import { SHEETS_SCOPE } from '../integrations/google-sheets.ts';
export type RuntimeConfig = { dataDir: string; databaseUrl: string; profilePath: string; reportsPath: string; owner: { resourceId: string; enabled: boolean }; telegram: { botToken: string; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string> }; sheetsTarget: { spreadsheetId: string; trackerTab: string; auditTab: string; topicsTab: string }; sheetsOAuth: { clientId: string; clientSecret: string; refreshToken: string; scope: string } };
type Input = { env?: Record<string, string | undefined>; dataDir?: string; databaseUrl?: string; profileDir?: string; reportsDir?: string; requireDeployment?: boolean };
function ids(value: string | undefined, name: string, deployment: boolean) {
  if (!value?.trim()) { if (deployment) throw new Error(`${name} is required.`); return new Set<string>(); }
  const values = value.split(',').map((item) => item.trim());
  if (values.some((item) => !/^\d+$/.test(item))) throw new Error(`${name} must contain numeric IDs.`);
  const result = new Set(values); if (deployment && result.size !== 1) throw new Error(`${name} must contain exactly one ID.`); return result;
}
function required(env: Record<string, string | undefined>, name: string) { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
export function assertOperationalDatabaseUrl(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Database URL must be an absolute local file URL.'); }
  if (!value.startsWith('file:/') || url.protocol !== 'file:' || (url.hostname && url.hostname !== 'localhost') || !isAbsolute(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('Database URL must be an absolute local file URL.');
  return value;
}
export function resolveRuntimeConfig(input: Input = {}): RuntimeConfig {
  const env = input.env ?? process.env; const requiredDeployment = input.requireDeployment === true; const dataDir = resolve(input.dataDir ?? env.MASTRA_DATA_DIR ?? join(process.cwd(), '.mastra', 'career-copilot')); mkdirSync(dataDir, { recursive: true }); chmodSync(dataDir, 0o700);
  const databaseUrl = assertOperationalDatabaseUrl(input.databaseUrl ?? env.MASTRA_DATABASE_URL ?? `file:${join(dataDir, 'mastra.db')}`); const databasePath = fileURLToPath(databaseUrl); const databaseTarget = existsSync(databasePath) ? realpathSync(databasePath) : join(realpathSync(dirname(databasePath)), basename(databasePath)); const databaseRelative = relative(realpathSync(dataDir), databaseTarget); if (databaseRelative === '..' || databaseRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(databaseRelative)) throw new Error('Database must be inside the protected data directory.'); const ownerId = requiredDeployment ? required(env, 'CAREER_COPILOT_OWNER_RESOURCE_ID') : (env.CAREER_COPILOT_OWNER_RESOURCE_ID ?? 'career-owner-v0');
  const profilePath = resolve(input.profileDir ?? env.CAREER_COPILOT_PROFILE_DIR ?? join(dataDir, 'profile')); const reportsPath = resolve(input.reportsDir ?? env.CAREER_COPILOT_REPORTS_DIR ?? join(dataDir, 'reports')); const topicsPath = resolve(join(dataDir, 'topics')); mkdirSync(reportsPath, { recursive: true }); assertSafeWorkspaceRoots(profilePath, reportsPath, topicsPath);
  const allowedUserIds = ids(env.TELEGRAM_ALLOWED_USER_IDS, 'TELEGRAM_ALLOWED_USER_IDS', requiredDeployment);
  const privateChatIds = ids(env.CAREER_COPILOT_PRIVATE_CHAT_IDS, 'CAREER_COPILOT_PRIVATE_CHAT_IDS', requiredDeployment);
  const sheetsTarget = { spreadsheetId: requiredDeployment ? required(env, 'GOOGLE_SHEETS_SPREADSHEET_ID') : (env.GOOGLE_SHEETS_SPREADSHEET_ID ?? ''), trackerTab: env.GOOGLE_SHEETS_TRACKER_TAB ?? 'Applications', auditTab: env.GOOGLE_SHEETS_APPLICATION_LOG_TAB ?? 'Application Log', topicsTab: env.GOOGLE_SHEETS_TOPICS_TAB ?? 'Topics' };
  const sheetsOAuth = { clientId: requiredDeployment ? required(env, 'GOOGLE_OAUTH_CLIENT_ID') : (env.GOOGLE_OAUTH_CLIENT_ID ?? ''), clientSecret: requiredDeployment ? required(env, 'GOOGLE_OAUTH_CLIENT_SECRET') : (env.GOOGLE_OAUTH_CLIENT_SECRET ?? ''), refreshToken: requiredDeployment ? required(env, 'GOOGLE_OAUTH_REFRESH_TOKEN') : (env.GOOGLE_OAUTH_REFRESH_TOKEN ?? ''), scope: SHEETS_SCOPE };
  return { dataDir, databaseUrl, profilePath, reportsPath, owner: { resourceId: ownerId, enabled: env.CAREER_COPILOT_OWNER_ENABLED !== 'false' }, telegram: { botToken: requiredDeployment ? required(env, 'TELEGRAM_BOT_TOKEN') : (env.TELEGRAM_BOT_TOKEN ?? ''), allowedUserIds, privateChatIds }, sheetsTarget, sheetsOAuth };
}
