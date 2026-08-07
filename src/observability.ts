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
