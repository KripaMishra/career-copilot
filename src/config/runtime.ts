import { chmodSync, existsSync, mkdirSync, realpathSync } from 'node:fs';
import { resolve, join, isAbsolute, relative, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { PII_ENTITY_NAMES } from '@kripamishra/mastra-pii';

export type PiiPatternConfig = { name: string; regex: RegExp; entity?: string };
export type PiiRuntimeConfig = { enabled: boolean; patterns: ReadonlyArray<PiiPatternConfig>; anonymizeFormat: 'type' | 'uniform'; maxInputChars: number; readiness: boolean };
export type RuntimeConfig = { dataDir: string; databaseUrl: string; databaseAuthToken?: string; memoryModel: string; owner: { resourceId: string; enabled: boolean }; telegram: { botToken: string; allowedUserIds: ReadonlySet<string>; privateChatIds: ReadonlySet<string> }; pii: PiiRuntimeConfig };
type Input = { env?: Record<string, string | undefined>; dataDir?: string; databaseUrl?: string; databaseAuthToken?: string; requireDeployment?: boolean; pii?: Partial<PiiRuntimeConfig> };
function ids(value: string | undefined, name: string, deployment: boolean) {
  if (!value?.trim()) { if (deployment) throw new Error(`${name} is required.`); return new Set<string>(); }
  const values = value.split(',').map((item) => item.trim());
  if (values.some((item) => !/^\d+$/.test(item))) throw new Error(`${name} must contain numeric IDs.`);
  const result = new Set(values); if (deployment && result.size !== 1) throw new Error(`${name} must contain exactly one ID.`); return result;
}
function required(env: Record<string, string | undefined>, name: string) { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required.`); return value; }
function isLocalFileUrl(value: string, url: URL) { return value.startsWith('file:/') && url.protocol === 'file:'; }
function assertNoUrlSecrets(url: URL) { if (url.username || url.password || url.search || url.hash) throw new Error('Database URL must not contain credentials, query, or fragment.'); }
export function resolveDatabaseConfig(value: string, authToken: string | undefined, dataDir: string, options: { requireRemote?: boolean } = {}) {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Database URL must be an absolute file:, libsql:, or https: URL.'); }
  assertNoUrlSecrets(url); const token = authToken?.trim() || undefined;
  if (isLocalFileUrl(value, url)) {
    if (options.requireRemote) throw new Error('Production requires a remote Turso database URL.');
    if ((url.hostname && url.hostname !== 'localhost') || !isAbsolute(url.pathname)) throw new Error('Local database URL must be an absolute local file URL.');
    if (token) throw new Error('TURSO_AUTH_TOKEN must not be set for a local file database.');
    mkdirSync(dataDir, { recursive: true }); chmodSync(dataDir, 0o700);
    const databasePath = fileURLToPath(value); const databaseTarget = existsSync(databasePath) ? realpathSync(databasePath) : join(realpathSync(dirname(databasePath)), basename(databasePath)); const databaseRelative = relative(realpathSync(dataDir), databaseTarget);
    if (databaseRelative === '..' || databaseRelative.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(databaseRelative)) throw new Error('Database must be inside the protected data directory.');
    return { url: value };
  }
  if (!['libsql:', 'https:'].includes(url.protocol)) throw new Error('Database URL must be an absolute file:, libsql:, or https: URL.');
  if (!url.hostname.toLowerCase().endsWith('.turso.io')) throw new Error('Remote database URL must be a Turso host.');
  if (!token) throw new Error('TURSO_AUTH_TOKEN is required for remote Turso databases.');
  return { url: value, authToken: token };
}
export function assertOperationalDatabaseUrl(value: string) {
  let url: URL; try { url = new URL(value); } catch { throw new Error('Database URL must be an absolute local file URL.'); }
  if (!isLocalFileUrl(value, url) || (url.hostname && url.hostname !== 'localhost') || !isAbsolute(url.pathname) || url.search || url.hash || url.username || url.password) throw new Error('Database URL must be an absolute local file URL.');
  return resolveDatabaseConfig(value, undefined, dirname(fileURLToPath(value))).url;
}
export function resolveRuntimeConfig(input: Input = {}): RuntimeConfig {
  const env = input.env ?? process.env; const requiredDeployment = input.requireDeployment === true; const dataDir = resolve(input.dataDir ?? env.MASTRA_DATA_DIR ?? join(process.cwd(), '.mastra', 'career-copilot'));
  const configuredDatabaseUrl = input.databaseUrl ?? env.MASTRA_DATABASE_URL;
  if (requiredDeployment && !configuredDatabaseUrl?.trim()) throw new Error('MASTRA_DATABASE_URL is required.');
  const database = resolveDatabaseConfig(configuredDatabaseUrl ?? `file:${join(dataDir, 'career-copilot.db')}`, input.databaseAuthToken ?? env.TURSO_AUTH_TOKEN, dataDir, { requireRemote: requiredDeployment }); const ownerId = requiredDeployment ? required(env, 'CAREER_COPILOT_OWNER_RESOURCE_ID') : (env.CAREER_COPILOT_OWNER_RESOURCE_ID ?? 'career-owner-v0');
  const allowedUserIds = ids(env.TELEGRAM_ALLOWED_USER_IDS, 'TELEGRAM_ALLOWED_USER_IDS', requiredDeployment);
  const privateChatIds = ids(env.CAREER_COPILOT_PRIVATE_CHAT_IDS, 'CAREER_COPILOT_PRIVATE_CHAT_IDS', requiredDeployment);
  const mainModel = env.CAREER_COPILOT_MODEL?.trim() || 'opencode-go/deepseek-v4-flash';
  const memoryModel = env.CAREER_COPILOT_MEMORY_MODEL?.trim() || mainModel;
  return { dataDir, databaseUrl: database.url, ...(database.authToken ? { databaseAuthToken: database.authToken } : {}), memoryModel, owner: { resourceId: ownerId, enabled: env.CAREER_COPILOT_OWNER_ENABLED !== 'false' }, telegram: { botToken: requiredDeployment ? required(env, 'TELEGRAM_BOT_TOKEN') : (env.TELEGRAM_BOT_TOKEN ?? ''), allowedUserIds, privateChatIds }, pii: resolvePiiConfig(env, input.pii) };
}

const piiEntityAllowlist = PII_ENTITY_NAMES as readonly [string, ...string[]];
const piiPatternInputSchema = z.object({ name: z.string().trim().min(1).max(120), regex: z.string().trim().min(1).max(500), entity: z.enum(piiEntityAllowlist).optional() }).strict();
const piiConfigSchema = z.object({
  enabled: z.boolean(),
  patterns: z.array(piiPatternInputSchema).max(50).default([]),
  anonymizeFormat: z.enum(['type', 'uniform']).default('type'),
  maxInputChars: z.number().int().min(0).max(1_000_000).default(200_000),
  readiness: z.boolean().default(true),
}).strict();

function strictBoolean(value: string | undefined, name: string, fallback: boolean): boolean {
  if (value === undefined || value.trim() === '') return fallback;
  const normalized = value.trim().toLowerCase();
  if (normalized === 'true') return true;
  if (normalized === 'false') return false;
  throw new Error(`${name} must be true or false.`);
}

function parsePiiPatterns(value: string | undefined) {
  if (!value?.trim()) return [];
  let parsed: unknown;
  try { parsed = JSON.parse(value); } catch { throw new Error('PII_PATTERNS must be a JSON array of { name, regex, entity? } entries.'); }
  if (!Array.isArray(parsed)) throw new Error('PII_PATTERNS must be a JSON array of { name, regex, entity? } entries.');
  return parsed;
}

export function resolvePiiConfig(env: Record<string, string | undefined>, override?: Partial<PiiRuntimeConfig>): PiiRuntimeConfig {
  const maxInputChars = env.PII_MAX_INPUT_CHARS?.trim() ? Number(env.PII_MAX_INPUT_CHARS) : undefined;
  const base = {
    enabled: strictBoolean(env.PII_ENABLED, 'PII_ENABLED', false),
    patterns: parsePiiPatterns(env.PII_PATTERNS),
    anonymizeFormat: env.PII_ANONYMIZE_FORMAT?.trim() as 'type' | 'uniform' | undefined,
    maxInputChars,
    readiness: strictBoolean(env.PII_READINESS, 'PII_READINESS', true),
  };
  const parsed = piiConfigSchema.safeParse({ ...base, ...override });
  if (!parsed.success) throw new Error(`Invalid PII configuration: ${parsed.error.issues.map((issue) => issue.path.join('.') || 'config').join(', ')}`);
  const compiled = parsed.data.patterns.map((pattern) => {
    let regex: RegExp;
    try { regex = new RegExp(pattern.regex); } catch { throw new Error(`PII pattern "${pattern.name}" has an invalid regular expression.`); }
    return { name: pattern.name, regex, ...(pattern.entity ? { entity: pattern.entity } : {}) };
  });
  return { enabled: parsed.data.enabled, patterns: compiled, anonymizeFormat: parsed.data.anonymizeFormat, maxInputChars: parsed.data.maxInputChars, readiness: parsed.data.readiness };
}
