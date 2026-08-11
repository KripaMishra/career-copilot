import type { Canary, CanarySink } from './schemas/fixture.ts';

/**
 * Sink-aware canary scanner (issue #13 privacy section).
 *
 * - Scans UTF-8 decoded strings, NFC-normalized, recursively over objects/arrays.
 * - Exact canary match is a critical hit; configured case-insensitive/token
 *   variants are supported via `variants`.
 * - A canary is allowed in a sink only if its `sinks` classification includes
 *   that sink (or 'all'). Anything else is a hit → gate fails closed.
 */

export type ScanOptions = { caseInsensitive?: boolean };

export type ScanHit = { canary: string; sink: CanarySink; where: string };

function variantsOf(value: string, options: ScanOptions): string[] {
  const variants = [value.normalize('NFC')];
  if (options.caseInsensitive) variants.push(value.toLocaleLowerCase('en'));
  return variants;
}

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function allowedSinks(canary: Canary): Set<CanarySink> {
  const sinks = new Set<CanarySink>();
  for (const sink of canary.sinks) {
    if (sink === 'all') for (const every of ['model', 'reply', 'trace', 'log', 'database', 'report', 'sheet', 'judge'] as const) sinks.add(every);
    else sinks.add(sink);
  }
  return sinks;
}

export function canaryAllowedIn(canary: Canary, sink: CanarySink): boolean {
  return allowedSinks(canary).has(sink);
}

export function scanValue(value: unknown, sink: CanarySink, canaries: Canary[], where = 'root', options: ScanOptions = {}): ScanHit[] {
  const hits: ScanHit[] = [];
  if (value === null || value === undefined) return hits;
  if (typeof value === 'string') {
    const normalized = value.normalize('NFC');
    for (const canary of canaries) {
      if (canaryAllowedIn(canary, sink)) continue;
      if (containsAny(normalized, variantsOf(canary.value, options))) hits.push({ canary: canary.value, sink, where });
    }
    return hits;
  }
  if (typeof value !== 'object') return hits;
  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    hits.push(...scanValue(child, sink, canaries, `${where}.${key}`, options));
  }
  return hits;
}

export type ScanTarget = { name: string; sink: CanarySink; value: unknown };

export function scanTargets(targets: ScanTarget[], canaries: Canary[], options: ScanOptions = {}): { hits: ScanHit[]; scanned: string[] } {
  const hits: ScanHit[] = [];
  const scanned = new Set<string>();
  for (const target of targets) {
    scanned.add(target.sink);
    hits.push(...scanValue(target.value, target.sink, canaries, target.name, options));
  }
  return { hits, scanned: [...scanned] };
}

/** Fail-closed gate: any out-of-scope hit blocks, regardless of anything else. */
export function redactionPassed(hits: ScanHit[]): boolean {
  return hits.length === 0;
}
