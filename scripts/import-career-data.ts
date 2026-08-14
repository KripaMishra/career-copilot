import { createHash } from 'node:crypto';
import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createClient, type Row } from '@libsql/client';
import { SafeResultSchema, JobStatusSchema, type Job } from '../src/contracts/v0.ts';
import { resolveDatabaseConfig } from '../src/config/runtime.ts';
import { readProfile } from '../src/integrations/local-files.ts';
import { CareerStore, assertSafeTextContent } from '../src/storage/career-store.ts';

type Args = { sourceDb?: string; targetDb?: string; profileDir?: string; reportDir?: string; ownerId?: string; dataDir?: string };
type Stats = { jobs: number; jobDuplicates: number; reports: number; reportDuplicates: number; profiles: number; profileDuplicates: number; skippedReports: number };
type ReportImport = { reportId: string; ownerId: string; jobId: string; content: string; createdAt: number };

function usage() { return 'Usage: npm run import:career -- --source-db <career.db|file:url> [--target-db <url>] [--owner-id <owner>] [--profile-dir <dir>] [--report-dir <dir>]'; }
function argValue(argv: string[], index: number) { const value = argv[index + 1]; if (!value || value.startsWith('--')) throw new Error(`${argv[index]} requires a value.`); return value; }
function parseArgs(argv: string[]) { const args: Args = {}; for (let i = 0; i < argv.length; i++) { const flag = argv[i]; if (flag === '--source-db') args.sourceDb = argValue(argv, i++); else if (flag === '--target-db') args.targetDb = argValue(argv, i++); else if (flag === '--owner-id') args.ownerId = argValue(argv, i++); else if (flag === '--profile-dir') args.profileDir = argValue(argv, i++); else if (flag === '--report-dir') args.reportDir = argValue(argv, i++); else if (flag === '--data-dir') args.dataDir = argValue(argv, i++); else throw new Error(`Unknown argument: ${flag}. ${usage()}`); } return args; }
function localFileUrl(value: string) { if (value.startsWith('file:')) return value; if (!isAbsolute(value)) throw new Error('Source database must be an absolute path or file: URL.'); return pathToFileURL(value).href; }
function hash(content: string) { return createHash('sha256').update(content).digest('hex'); }
function stableReportId(jobId: string, content: string) { return `import-${jobId.replace(/[^A-Za-z0-9_.-]/g, '_')}-${hash(content).slice(0, 16)}`.slice(0, 500); }
function safeResult(row: Row) { if (!row.safe_result) return null; const parsed = JSON.parse(String(row.safe_result)) as Record<string, unknown>; return SafeResultSchema.parse({ ...parsed, reportId: parsed.reportId ?? (row.report_id ? String(row.report_id) : null) }); }
function jobFromRow(row: Row): Job { const now = Date.now(); return { jobId: String(row.job_id), userId: row.user_id === null || row.user_id === undefined ? null : String(row.user_id), ownerId: String(row.owner_id), chatId: String(row.chat_id), transportEventId: String(row.transport_event_id), originalUrl: String(row.original_url), canonicalUrl: String(row.canonical_url), status: JobStatusSchema.parse(row.status), mastraRunId: row.mastra_run_id ? String(row.mastra_run_id) : null, attempts: Number(row.attempts ?? 0), reportId: row.report_id ? String(row.report_id) : null, reportPath: row.report_path ? String(row.report_path) : null, sheetReference: row.sheet_reference ? String(row.sheet_reference) : null, safeResult: safeResult(row), safeError: row.safe_error ? String(row.safe_error) : null, notifiedAt: row.notified_at === null || row.notified_at === undefined ? null : Number(row.notified_at), createdAt: Number(row.created_at ?? now), updatedAt: Number(row.updated_at ?? now) }; }
function jobWithReport(job: Job, report: ReportImport | null): Job {
  const sheetReference = job.sheetReference ?? null;
  if (!report) return { ...job, reportPath: null, sheetReference, safeResult: job.safeResult ? SafeResultSchema.parse({ ...job.safeResult, reportId: job.safeResult.reportId ?? null }) : null };
  return { ...job, reportId: report.reportId, reportPath: null, sheetReference, safeResult: job.safeResult ? SafeResultSchema.parse({ ...job.safeResult, reportId: job.safeResult.reportId ?? report.reportId }) : null };
}
function escaped(root: string, candidate: string) { const rel = relative(root, candidate); return rel === '..' || rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(rel); }
async function contained(root: string, candidate: string) { const [base, target] = await Promise.all([realpath(root), realpath(candidate)]); if (escaped(base, target)) throw new Error('Report file resolves outside report directory.'); }
async function reportCandidate(root: string, reportPath: string) { const base = await realpath(root); const candidate = isAbsolute(reportPath) ? resolve(reportPath) : resolve(base, reportPath); if (escaped(base, candidate)) throw new Error('Report file resolves outside report directory.'); return candidate; }
async function reportFile(job: Job, reportDir?: string) { if (!reportDir) return null; const root = resolve(reportDir); const fallback = join(root, `${job.jobId.replace(/[^A-Za-z0-9_.-]/g, '_')}.md`); const direct = job.reportPath ? await reportCandidate(root, job.reportPath) : undefined; const file = direct && existsSync(direct) ? direct : existsSync(fallback) ? fallback : undefined; if (!file) return null; await contained(root, file); const stat = lstatSync(file); if (!stat.isFile() || stat.isSymbolicLink() || extname(file) !== '.md' || basename(file).startsWith('.')) throw new Error(`unsafe report file is rejected: ${file}`); return file; }

export async function runImport(argv = process.argv.slice(2), env: Record<string, string | undefined> = process.env) {
  const args = parseArgs(argv); if (!args.sourceDb) throw new Error(`--source-db is required. ${usage()}`);
  const targetUrl = args.targetDb ?? env.MASTRA_DATABASE_URL; if (!targetUrl?.trim()) throw new Error('--target-db or MASTRA_DATABASE_URL is required.');
  const localTargetDir = targetUrl.startsWith('file:') ? dirname(fileURLToPath(targetUrl)) : undefined;
  const dataDir = args.dataDir ?? (args.targetDb ? undefined : env.MASTRA_DATA_DIR) ?? localTargetDir ?? process.cwd();
  const target = resolveDatabaseConfig(targetUrl, env.TURSO_AUTH_TOKEN, dataDir);
  const source = createClient({ url: localFileUrl(args.sourceDb) }); const store = new CareerStore(target); const stats: Stats = { jobs: 0, jobDuplicates: 0, reports: 0, reportDuplicates: 0, profiles: 0, profileDuplicates: 0, skippedReports: 0 };
  try {
    await store.ready(); const rows = (await source.execute('SELECT * FROM career_jobs ORDER BY created_at, job_id')).rows; const jobs = rows.map(jobFromRow); const reports = new Map<string, ReportImport>(); const importJobs: Job[] = [];
    for (const job of jobs) { const file = await reportFile(job, args.reportDir); if (!file) { stats.skippedReports++; importJobs.push(jobWithReport(job, null)); continue; } const content = readFileSync(file, 'utf8'); assertSafeTextContent(content); const report = { reportId: job.reportId ?? stableReportId(job.jobId, content), ownerId: job.ownerId, jobId: job.jobId, content, createdAt: job.updatedAt }; reports.set(job.jobId, report); importJobs.push(jobWithReport(job, report)); }
    for (const job of importJobs) { const result = await store.importJob(job); if (result.imported) stats.jobs++; else stats.jobDuplicates++; }
    for (const report of reports.values()) { const result = await store.importReport(report); if (result.imported) stats.reports++; else stats.reportDuplicates++; }
    if (args.profileDir) { if (!args.ownerId && !env.CAREER_COPILOT_OWNER_RESOURCE_ID) throw new Error('--owner-id or CAREER_COPILOT_OWNER_RESOURCE_ID is required when importing profiles.'); const ownerId = args.ownerId ?? env.CAREER_COPILOT_OWNER_RESOURCE_ID!; for (const [name, content] of Object.entries(readProfile(args.profileDir))) { const result = await store.importProfileDocument({ ownerId, name, content }); if (result.imported) stats.profiles++; else stats.profileDuplicates++; } }
    return stats;
  } finally { source.close(); await store.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) runImport().then((stats) => console.log(JSON.stringify({ ok: true, stats }, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; });
