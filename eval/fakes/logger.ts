import type { AppLogger } from '../../src/observability.ts';
import type { LogRecord } from '../assertions.ts';

/**
 * Collecting logger — implements the production AppLogger type. Captures every
 * event with its full data payload (no allowlist filtering here; A-LOG-ALLOWLIST
 * inspects the raw ledger, and the redaction scanner scans it with the log
 * sink). Non-JSON-serializable values are dropped, never coerced.
 */
export function createCollectingLogger(ledger: LogRecord[]): AppLogger {
  return (level, event, data = {}) => {
    let safe: Record<string, unknown> = {};
    try { safe = JSON.parse(JSON.stringify(data)); } catch { safe = {}; }
    ledger.push({ level, event, data: safe });
  };
}
