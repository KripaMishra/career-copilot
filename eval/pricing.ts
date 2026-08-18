import { createHash } from 'node:crypto';

/**
 * Versioned pricing table for quality-lane cost metering (issue #13).
 *
 * Prices are USD per 1,000,000 tokens (input / output), keyed by
 * `provider/modelId` (bare model ids collide across providers). The table is
 * empty by default: no fabricated prices. `EVAL_PRICING` (JSON env) supplies
 * real prices, e.g.
 *   EVAL_PRICING='{"opencode-go/deepseek-v4-flash":{"inputPerMTok":0.14,"outputPerMTok":0.28}}'
 * An env table's version is a content hash of the raw JSON (`env:<sha12>`),
 * so materially different price tables produce distinguishable manifests.
 * A live call whose provider/model has no entry records cost null
 * (unmetered) — quality then requires --allow-unmetered to complete, and
 * unmetered runs can never be pinned (#13e).
 */

export type ModelPrice = { inputPerMTok: number; outputPerMTok: number };
export type PricingTable = { version: string; models: Record<string, ModelPrice> };

const BUILTIN: PricingTable = { version: '1', models: {} };

function parseEnvPricing(): PricingTable | null {
  const raw = process.env.EVAL_PRICING;
  if (!raw?.trim()) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const models: Record<string, ModelPrice> = {};
    for (const key of Object.keys(parsed)) {
      // keys are `provider/modelId`; bare ids are rejected (provider collisions)
      if (!key.includes('/')) throw new Error(`EVAL_PRICING keys must be "provider/modelId", got "${key}"`);
      const entry = parsed[key] as { inputPerMTok?: unknown; outputPerMTok?: unknown };
      const inputPerMTok = Number(entry.inputPerMTok);
      const outputPerMTok = Number(entry.outputPerMTok);
      if (!Number.isFinite(inputPerMTok) || inputPerMTok < 0 || !Number.isFinite(outputPerMTok) || outputPerMTok < 0) throw new Error(`EVAL_PRICING: ${key} needs non-negative inputPerMTok/outputPerMTok`);
      models[key] = { inputPerMTok, outputPerMTok };
    }
    const version = `env:${createHash('sha256').update(raw).digest('hex').slice(0, 12)}`;
    return { version, models };
  } catch (error) {
    throw new Error(`EVAL_PRICING must be valid JSON of {"provider/modelId": {inputPerMTok, outputPerMTok}}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

let cached: PricingTable | null = null;

/** test seam: clear the cached table so EVAL_PRICING changes take effect */
export function resetPricingCache(): void {
  cached = null;
}

export function pricingTable(): PricingTable {
  if (!cached) cached = parseEnvPricing() ?? BUILTIN;
  return cached;
}

/** Cost in USD for one call; null when the provider/model has no pricing entry. */
export function callCostUsd(provider: string, modelId: string, inputTokens: number | null, outputTokens: number | null): number | null {
  if (inputTokens === null || outputTokens === null) return null;
  const price = pricingTable().models[`${provider}/${modelId}`];
  if (!price) return null;
  return (inputTokens / 1_000_000) * price.inputPerMTok + (outputTokens / 1_000_000) * price.outputPerMTok;
}
