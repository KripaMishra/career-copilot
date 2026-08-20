import type { AnySchedule, CreateWorkflowScheduleInput, Schedules, UpdateWorkflowScheduleInput } from '@mastra/core/schedules';
import type { AppLogger } from '../observability.ts';
import type { CareerStore } from '../storage/career-store.ts';

/** Stable imperative workflow-schedule id (spec D1/D9). `schedule_` is the
 * workflow-schedule prefix in @mastra/core; the slug is lowercase. */
export const JOB_DISCOVERY_SCHEDULE_ID = 'schedule_jobdiscovery';
export const JOB_DISCOVERY_WORKFLOW_ID = 'jobDiscovery';
export const JOB_DISCOVERY_CRON = '0 12 * * *';
export const DEFAULT_DISCOVERY_TIMEZONE = 'Asia/Kolkata';

/** IANA validation mirroring how @mastra/core validates schedule timezones
 * (and Intl), so a captured timezone that is not a real zone falls back. */
export function isValidIanaTimezone(value: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }); return true; }
  catch { return false; }
}

/** The onboarding prompt (D9) accepts a timezone *or a city*; a city is not an
 * IANA zone, so map the common answers before validating. Keys are lowercase. */
const CITY_TIMEZONES: Record<string, string> = {
  // India
  kolkata: 'Asia/Kolkata', bengaluru: 'Asia/Kolkata', bangalore: 'Asia/Kolkata', mumbai: 'Asia/Kolkata',
  bombay: 'Asia/Kolkata', delhi: 'Asia/Kolkata', 'new delhi': 'Asia/Kolkata', hyderabad: 'Asia/Kolkata',
  chennai: 'Asia/Kolkata', pune: 'Asia/Kolkata', gurgaon: 'Asia/Kolkata', noida: 'Asia/Kolkata',
  ahmedabad: 'Asia/Kolkata', jaipur: 'Asia/Kolkata', kochi: 'Asia/Kolkata', lucknow: 'Asia/Kolkata',
  // US
  'new york': 'America/New_York', nyc: 'America/New_York', boston: 'America/New_York',
  philadelphia: 'America/New_York', 'washington dc': 'America/New_York', washington: 'America/New_York',
  miami: 'America/New_York', atlanta: 'America/New_York', detroit: 'America/New_York',
  chicago: 'America/Chicago', austin: 'America/Chicago', houston: 'America/Chicago', dallas: 'America/Chicago',
  'los angeles': 'America/Los_Angeles', 'san francisco': 'America/Los_Angeles', sf: 'America/Los_Angeles',
  seattle: 'America/Los_Angeles', 'san jose': 'America/Los_Angeles', denver: 'America/Denver',
  phoenix: 'America/Phoenix', 'salt lake city': 'America/Denver', honolulu: 'Pacific/Honolulu',
  // Canada
  toronto: 'America/Toronto', ottawa: 'America/Toronto', montreal: 'America/Toronto',
  vancouver: 'America/Vancouver', calgary: 'America/Edmonton',
  // UK / EU
  london: 'Europe/London', dublin: 'Europe/Dublin', paris: 'Europe/Paris', berlin: 'Europe/Berlin',
  amsterdam: 'Europe/Amsterdam', madrid: 'Europe/Madrid', barcelona: 'Europe/Madrid',
  rome: 'Europe/Rome', milan: 'Europe/Rome', brussels: 'Europe/Brussels', vienna: 'Europe/Vienna',
  zurich: 'Europe/Zurich', stockholm: 'Europe/Stockholm', oslo: 'Europe/Oslo', copenhagen: 'Europe/Copenhagen',
  warsaw: 'Europe/Warsaw', prague: 'Europe/Prague', budapest: 'Europe/Budapest', lisbon: 'Europe/Lisbon',
  helsinki: 'Europe/Helsinki',
  // APAC / ME
  singapore: 'Asia/Singapore', 'hong kong': 'Asia/Hong_Kong', tokyo: 'Asia/Tokyo', seoul: 'Asia/Seoul',
  sydney: 'Australia/Sydney', melbourne: 'Australia/Sydney', brisbane: 'Australia/Brisbane',
  perth: 'Australia/Perth', auckland: 'Pacific/Auckland', dubai: 'Asia/Dubai', 'abu dhabi': 'Asia/Dubai',
  'tel aviv': 'Asia/Jerusalem', bangkok: 'Asia/Bangkok', jakarta: 'Asia/Jakarta',
  'kuala lumpur': 'Asia/Kuala_Lumpur', shanghai: 'Asia/Shanghai', beijing: 'Asia/Shanghai',
  taipei: 'Asia/Taipei', manila: 'Asia/Manila', karachi: 'Asia/Karachi', dhaka: 'Asia/Dhaka',
};

/** "New York, USA" → "New York"; "Asia/Kolkata, India" → "Asia/Kolkata". */
function normalizeTimezoneBase(raw: string): string {
  return raw.split(',')[0]!.trim();
}

export function resolveDiscoveryTimezone(captured: string | null): string {
  if (!captured) return DEFAULT_DISCOVERY_TIMEZONE;
  const base = normalizeTimezoneBase(captured);
  if (isValidIanaTimezone(base)) return base;
  return CITY_TIMEZONES[base.toLowerCase()] ?? DEFAULT_DISCOVERY_TIMEZONE;
}

export type JobDiscoveryScheduleRegistration = { schedule: AnySchedule; timezone: string; reRegistered: boolean };

/** Idempotent schedule registration (spec D1/D9): create the single workflow
 * schedule row, or update it in place when the effective timezone/cron changed
 * since the last boot (the schedule follows the onboarding-captured owner
 * timezone, falling back to Asia/Kolkata; re-registering on change keeps the
 * next fire at 12:00 PM in the owner's timezone). */
export async function ensureJobDiscoverySchedule(options: {
  schedules: Pick<Schedules, 'get' | 'create' | 'update'>;
  store: CareerStore;
  ownerId: string;
  cron?: string;
  logger?: AppLogger;
}): Promise<JobDiscoveryScheduleRegistration> {
  const log: AppLogger = (level, event, data) => { try { options.logger?.(level, event, data); } catch { /* logging cannot break registration */ } };
  const cron = options.cron ?? JOB_DISCOVERY_CRON;
  const captured = await options.store.capturedTimezone(options.ownerId);
  const timezone = resolveDiscoveryTimezone(captured);
  // A captured city that maps to a real zone is fine; one that maps to nothing
  // falls back silently and would fire at the wrong local time — make it loud.
  if (captured && !isValidIanaTimezone(normalizeTimezoneBase(captured)) && CITY_TIMEZONES[normalizeTimezoneBase(captured).toLowerCase()] === undefined) {
    log('warn', 'discovery.schedule.timezone_fallback', { captured, timezone: DEFAULT_DISCOVERY_TIMEZONE });
  }
  const id = JOB_DISCOVERY_SCHEDULE_ID;
  const existing = await options.schedules.get(id);
  if (!existing) {
    const schedule = await options.schedules.create({ id, workflowId: JOB_DISCOVERY_WORKFLOW_ID, cron, timezone, status: 'active' } satisfies CreateWorkflowScheduleInput);
    log('info', 'discovery.schedule.created', { id, workflowId: JOB_DISCOVERY_WORKFLOW_ID, cron, timezone });
    return { schedule, timezone, reRegistered: false };
  }
  if (existing.cron !== cron || (existing.timezone ?? undefined) !== timezone) {
    const schedule = await options.schedules.update(id, { cron, timezone } satisfies UpdateWorkflowScheduleInput);
    log('info', 'discovery.schedule.reRegistered', { id, cron, timezone });
    return { schedule, timezone, reRegistered: true };
  }
  return { schedule: existing, timezone, reRegistered: false };
}
