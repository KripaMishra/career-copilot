import type { AppLogger } from '../../src/observability.ts';

/**
 * Collecting logger — implements the production AppLogger type. Captures every
 * event with its full data payload (no allowlist filtering here; A-LOG-ALLOWLIST
 * inspects the raw ledger, and the redaction scanner scans it with the log
 * sink). Non-JSON-serializable values are dropped, never coerced.
 */

export type CollectedLog = { level: 'info' | 'warn' | 'error'; event: string; data: Record<string, unknown> };

export function createCollectingLogger(ledger: CollectedLog[]): AppLogger {
  return (level, event, data = {}) => {
    let safe: Record<string, unknown> = {};
    try { safe = JSON.parse(JSON.stringify(data)); } catch { safe = {}; }
    ledger.push({ level, event, data: safe });
  };
}

export type TraceSpan = { name: string; input?: unknown; output?: unknown };

/** Trace collector — contract runs wire no Mastra observability, so spans are
 *  captured only when the harness itself records them (vacuous scan otherwise). */
export function createTraceCollector(ledger: TraceSpan[]) {
  return {
    span(name: string, data: { input?: unknown; output?: unknown } = {}) {
      ledger.push({ name, input: data.input, output: data.output });
    },
  };
}
