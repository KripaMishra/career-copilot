import type { ObservabilityExporter, SpanOutputProcessor } from '@mastra/core/observability';
import { MastraStorageExporter } from '@mastra/observability';

export const redactTracePayloads: SpanOutputProcessor = {
  name: 'career-copilot-redact-payloads',
  process: (span) => {
    if (!span) return undefined;
    span.input = undefined; span.output = undefined;
    if (span.errorInfo) span.errorInfo = { name: span.errorInfo.name, message: 'Operation failed.' };
    return span;
  },
  shutdown: async () => {},
};

export function createTraceStorageExporter(): ObservabilityExporter {
  const storage = new MastraStorageExporter();
  return {
    name: 'mastra-storage-traces',
    __setLogger: (logger) => storage.__setLogger(logger),
    init: (options) => storage.init(options),
    onTracingEvent: (event) => storage.onTracingEvent(event),
    exportTracingEvent: (event) => storage.exportTracingEvent(event),
    flush: () => storage.flush(),
    shutdown: () => storage.shutdown(),
  };
}

export type AppLogLevel = 'info' | 'warn' | 'error';
export type AppLogger = (level: AppLogLevel, event: string, data?: Record<string, unknown>) => void;

const safeAppLogKeys = new Set([
  'attempt', 'chunkCount', 'command', 'durationMs', 'errorName', 'eventName', 'fieldKeys', 'jobId', 'missingFields', 'outcome', 'phase', 'readyForReview', 'reason', 'recovery', 'reportId', 'requestId', 'status', 'toolId', 'unfinishedJobs', 'updateId', 'version',
]);
export { safeAppLogKeys };

const maxLogStringLength = 120;
const clipLogString = (value: unknown) => String(value).replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, maxLogStringLength);

function safeLogValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)).map(clipLogString).slice(0, 50);
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return clipLogString(value);
  if (typeof value === 'boolean' || value === null) return value;
  return undefined;
}

export function createTerminalAppLogger(now = () => new Date().toISOString(), output: Pick<Console, 'log' | 'error' | 'warn'> = console): AppLogger {
  return (level, event, data = {}) => {
    try {
      const safe: Record<string, unknown> = { ts: now(), level, event };
      for (const [key, value] of Object.entries(data)) if (safeAppLogKeys.has(key)) {
        const sanitized = safeLogValue(value);
        if (sanitized !== undefined) safe[key] = sanitized;
      }
      const line = JSON.stringify(safe);
      if (level === 'error') output.error(line); else if (level === 'warn') output.warn(line); else output.log(line);
    } catch { /* logging must never break app work */ }
  };
}
