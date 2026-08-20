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

export function resolveDiscoveryTimezone(captured: string | null): string {
  return captured && isValidIanaTimezone(captured) ? captured : DEFAULT_DISCOVERY_TIMEZONE;
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
  const timezone = resolveDiscoveryTimezone(await options.store.capturedTimezone(options.ownerId));
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
