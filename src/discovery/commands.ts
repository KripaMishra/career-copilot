import type { Schedules } from '@mastra/core/schedules';
import type { AppLogger } from '../observability.ts';
import type { CareerStore } from '../storage/career-store.ts';
import { buildDiscoveryDigest } from './digest.ts';
import { JOB_DISCOVERY_SCHEDULE_ID, resolveDiscoveryTimezone } from './schedule.ts';

export type DiscoveryCommandAction = 'status' | 'on' | 'off';
export type DiscoveryCommandInput = { kind: 'discovery'; action: DiscoveryCommandAction };
export type DiscoveryCommandHandler = (command: DiscoveryCommandInput) => Promise<string>;

function formatFireTime(epochMs: number, timezone: string): string {
  const formatted = new Intl.DateTimeFormat('en-GB', { timeZone: timezone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }).format(new Date(epochMs));
  return `${formatted} (${timezone})`;
}

const notRegistered = 'The daily discovery schedule is not registered yet.';

/** /discovery control surface (spec D8): status shows the schedule state,
 * next fire in the captured timezone, and the latest run summary; on/off
 * resume/pause the schedule row via mastra.schedules. No run-now, no extra
 * alerts (owner-confirmed). */
export function createDiscoveryCommandHandler(options: {
  schedules: Pick<Schedules, 'get' | 'pause' | 'resume'>;
  store: CareerStore;
  ownerId: string;
  logger?: AppLogger;
}): DiscoveryCommandHandler {
  const log: AppLogger = (level, event, data) => { try { options.logger?.(level, event, data); } catch { /* logging cannot break commands */ } };
  return async (command) => {
    const schedule = await options.schedules.get(JOB_DISCOVERY_SCHEDULE_ID);
    if (command.action === 'status') {
      if (!schedule) return notRegistered;
      const timezone = resolveDiscoveryTimezone(schedule.timezone ?? null);
      const header = `Discovery schedule: ${schedule.status === 'active' ? 'active' : 'paused'} · next fire ${formatFireTime(schedule.nextFireAt, timezone)}`;
      const run = await options.store.latestDiscoveryRun();
      if (!run) return `${header}\n\nNo discovery runs yet.`;
      const sites = await options.store.listDiscoverySites(run.runId);
      log('info', 'discovery.command.status', { action: 'status', scheduleStatus: schedule.status, runStatus: run.status });
      return `${header}\n\n${buildDiscoveryDigest({ run, sites })}`;
    }
    if (!schedule) return notRegistered;
    if (command.action === 'on') {
      try {
        const resumed = await options.schedules.resume(JOB_DISCOVERY_SCHEDULE_ID);
        const effective = resolveDiscoveryTimezone(resumed.timezone ?? schedule.timezone ?? null);
        log('info', 'discovery.command.on', { scheduleStatus: resumed.status });
        return `Discovery schedule enabled. Daily discovery set for 12:00 PM local (${effective}); the digest will arrive here.`;
      } catch (error) { log('warn', 'discovery.command.on.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); return 'Could not enable the discovery schedule. Please try again.'; }
    }
    try {
      const paused = await options.schedules.pause(JOB_DISCOVERY_SCHEDULE_ID);
      log('info', 'discovery.command.off', { scheduleStatus: paused.status });
      return 'Discovery schedule disabled. Send /discovery on to re-enable.';
    } catch (error) { log('warn', 'discovery.command.off.failed', { errorName: error instanceof Error ? error.name : 'UnknownError' }); return 'Could not disable the discovery schedule. Please try again.'; }
  };
}
