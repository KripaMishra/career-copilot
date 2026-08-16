import { createLayeredPii, type PiiProcessor } from '@kripamishra/mastra-pii';
import type { PiiRuntimeConfig } from '../config/runtime.ts';

/**
 * PII redaction service: owns the LayeredPii singleton and the fail-closed
 * readiness gate.
 *
 * - Analyzer: the local deterministic engine by default (zero network egress);
 *   when a Presidio URL is configured, it is supplied to the package's remote
 *   Presidio adapter at init (spaCy NER + Indian ad_hoc recognizers).
 * - `ready` flips only after `warmup()` resolves; until then (and while
 *   disabled) every redaction call fails closed. With a Presidio URL this
 *   means a down analyzer keeps ingestion disabled.
 * - `redactText`/`redactDocument` are the pre-agent trust-boundary functions;
 *   the ingestion surfaces gate on `ready` before calling them.
 * - `processor` is the defense-in-depth Mastra processor wired on the agent's
 *   inputProcessors/outputProcessors.
 */
export type PiiService = {
  readonly id: string;
  readonly enabled: boolean;
  readonly ready: boolean;
  readonly processor: PiiProcessor;
  readonly warmup: () => Promise<void>;
  readonly redactText: (text: string, options?: { layers?: readonly ('deterministic' | 'ner' | 'model')[] }) => Promise<string>;
  readonly redactDocument: (value: unknown) => Promise<unknown>;
};

export function createPiiService(config: PiiRuntimeConfig): PiiService {
  const pii = createLayeredPii({ patterns: [...config.patterns], anonymize: { format: config.anonymizeFormat }, ...(config.presidio ? { presidio: config.presidio } : {}) });
  let warmed = false;
  const unavailable = (): never => { throw new Error('PII redaction is unavailable.'); };
  return {
    id: pii.id,
    enabled: config.enabled,
    // readiness is part of the gate: the explicit PII_READINESS=false deployment
    // toggle holds ingestion disabled even when the engine warms successfully
    get ready() { return config.enabled && config.readiness && warmed; },
    processor: pii.processor,
    warmup: async () => {
      if (!config.enabled) { warmed = false; return; }
      await pii.warmup();
      warmed = true;
    },
    redactText: async (text, options) => {
      if (!config.enabled || !config.readiness || !warmed) return unavailable();
      if (config.maxInputChars > 0 && text.length > config.maxInputChars) throw new Error('PII redaction input is too large.');
      return pii.redactText(text, options);
    },
    redactDocument: async (value) => {
      if (!config.enabled || !config.readiness || !warmed) return unavailable();
      return pii.redactDocument(value);
    },
  };
}
