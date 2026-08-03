import { MastraNonRetryableError } from '@mastra/core/error';
import { z } from 'zod';

export const FAILURE_CLASSES = ['transient', 'rate_limited', 'permanent', 'security', 'authorization', 'outcome_unknown'] as const;
export const RETRY_STAGES = ['direct_acquisition', 'browser_connection', 'provider_inference', 'schema_repair', 'external_effect'] as const;
export type FailureClass = typeof FAILURE_CLASSES[number];
export type RetryStage = typeof RETRY_STAGES[number];

export const OPERATION_DEADLINES_MS = Object.freeze({
  database: 5_000,
  directFetch: 30_000,
  browserAcquisition: 120_000,
  modelRequest: 120_000,
  sheetOrFile: 30_000,
  channelSend: 15_000,
  browserMutexWait: 30_000,
  automaticProcessing: 1_800_000,
  humanSuspension: 604_800_000,
} as const);

export const STAGE_REPEAT_CAPS = Object.freeze({
  direct_acquisition: 2,
  browser_connection: 2,
  provider_inference: 1,
  schema_repair: 1,
  external_effect: 0,
} as const satisfies Record<RetryStage, number>);

export const SAFE_FAILURE_DEFINITIONS = Object.freeze({
  temporarily_unavailable: { class: 'transient', stages: ['direct_acquisition', 'browser_connection', 'provider_inference'], detail: 'The operation is temporarily unavailable.' },
  invalid_shape: { class: 'transient', stages: ['schema_repair'], detail: 'The schema needs repair.' },
  temporary: { class: 'transient', stages: ['direct_acquisition', 'browser_connection', 'provider_inference', 'schema_repair'], detail: 'The operation is temporarily unavailable.' },
  network_unavailable: { class: 'transient', stages: ['direct_acquisition', 'browser_connection'], detail: 'The network is unavailable.' },
  rate_limited: { class: 'rate_limited', stages: ['direct_acquisition', 'browser_connection', 'provider_inference'], detail: 'The provider asked us to wait.' },
  request_not_retryable: { class: 'permanent', stages: RETRY_STAGES, detail: 'The request cannot be retried.' },
  commit_timeout: { class: 'outcome_unknown', stages: ['external_effect'], detail: 'The external outcome is unknown.' },
  late: { class: 'outcome_unknown', stages: RETRY_STAGES, detail: 'The operation completed after its deadline.' },
  fixture_retry: { class: 'transient', stages: ['direct_acquisition'], detail: 'The fixture operation is temporarily unavailable.' },
  temporary_failure: { class: 'transient', stages: ['direct_acquisition', 'browser_connection', 'provider_inference', 'schema_repair'], detail: 'The operation is temporarily unavailable.' },
  security_denied: { class: 'security', stages: RETRY_STAGES, detail: 'The request was rejected by security policy.' },
  authorization_revoked: { class: 'authorization', stages: RETRY_STAGES, detail: 'Owner authorization is unavailable.' },
} as const satisfies Record<string, { class: FailureClass; stages: readonly RetryStage[]; detail: string }>);
export type SafeFailureCode = keyof typeof SAFE_FAILURE_DEFINITIONS;
export const SAFE_FAILURE_DETAILS = Object.freeze(Object.fromEntries(
  Object.entries(SAFE_FAILURE_DEFINITIONS).map(([code, definition]) => [code, definition.detail]),
) as { [Code in SafeFailureCode]: typeof SAFE_FAILURE_DEFINITIONS[Code]['detail'] });

const retryAfter = z.string().min(1).max(128);
const failureInput = z.strictObject({
  kind: z.enum([...FAILURE_CLASSES, 'external_timeout_after_start']),
  stage: z.enum(RETRY_STAGES),
  code: z.enum(Object.keys(SAFE_FAILURE_DEFINITIONS) as [SafeFailureCode, ...SafeFailureCode[]]),
  retryAfter: retryAfter.optional(),
});

export type ClassifiedFailure = Readonly<{
  class: FailureClass;
  stage: RetryStage;
  code: SafeFailureCode;
  safeDetail: typeof SAFE_FAILURE_DETAILS[SafeFailureCode];
  retryAfter?: string;
}>;

const issuedFailures = new WeakSet<object>();

export function classifyFailure(input: unknown): ClassifiedFailure {
  const parsed = failureInput.parse(input);
  const failureClass = parsed.kind === 'external_timeout_after_start' ? 'outcome_unknown' : parsed.kind;
  const definition = SAFE_FAILURE_DEFINITIONS[parsed.code];
  if (failureClass !== definition.class || !definition.stages.includes(parsed.stage as never)
    || (parsed.kind === 'external_timeout_after_start') !== (parsed.code === 'commit_timeout')
    || (failureClass === 'rate_limited') !== (parsed.retryAfter !== undefined)) {
    throw new Error('Invalid failure class, code, stage, or Retry-After combination.');
  }
  const failure = Object.freeze({ class: failureClass, stage: parsed.stage, code: parsed.code,
    safeDetail: definition.detail, ...(parsed.retryAfter === undefined ? {} : { retryAfter: parsed.retryAfter }) }) as ClassifiedFailure;
  issuedFailures.add(failure);
  return failure;
}

function revalidateFailure(input: unknown): ClassifiedFailure {
  if (!input || typeof input !== 'object') throw new Error('Invalid classified failure.');
  const row = input as Record<string, unknown>;
  if (Object.keys(row).some((key) => !['class', 'stage', 'code', 'safeDetail', 'retryAfter'].includes(key))) throw new Error('Invalid classified failure.');
  let parsed: ClassifiedFailure;
  try {
    parsed = classifyFailure({ kind: row.code === 'commit_timeout' ? 'external_timeout_after_start' : row.class, stage: row.stage, code: row.code, ...(row.retryAfter === undefined ? {} : { retryAfter: row.retryAfter }) });
  } catch {
    throw new Error('Invalid classified failure.');
  }
  if (row.safeDetail !== parsed.safeDetail) throw new Error('Invalid classified failure.');
  return parsed;
}

function parseRetryAfter(value: string, now: number): number {
  if (/^\d+$/.test(value)) {
    const seconds = Number(value);
    if (!Number.isSafeInteger(seconds) || seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1_000)) throw new Error('Invalid Retry-After delta.');
    return seconds * 1_000;
  }
  const match = /^(Mon|Tue|Wed|Thu|Fri|Sat|Sun), (\d{2}) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) (\d{4}) (\d{2}):(\d{2}):(\d{2}) GMT$/.exec(value);
  if (!match) throw new Error('Invalid Retry-After date.');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const [, , dayText, monthText, yearText, hourText, minuteText, secondText] = match;
  const [day, month, year, hour, minute, second] = [Number(dayText), months.indexOf(monthText), Number(yearText), Number(hourText), Number(minuteText), Number(secondText)];
  const date = new Date(0);
  date.setUTCFullYear(year, month, day);
  date.setUTCHours(hour, minute, second, 0);
  const dueAt = date.getTime();
  if (!Number.isFinite(dueAt) || date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day
    || date.getUTCHours() !== hour || date.getUTCMinutes() !== minute || date.getUTCSeconds() !== second || date.toUTCString() !== value) {
    throw new Error('Invalid Retry-After date.');
  }
  return Math.max(0, dueAt - now);
}

export type RetrySchedule =
  | Readonly<{ retry: true; delayMs: number; attempt: number; calculatedAt: number; policyTargetAt: number; source: 'jitter'; retryAfter?: never }>
  | Readonly<{ retry: true; delayMs: number; attempt: number; calculatedAt: number; policyTargetAt: number; source: 'retry_after'; retryAfter: string }>
  | Readonly<{ retry: false; reason: 'permanent' | 'security' | 'authorization' | 'outcome_unknown' | 'deadline' }>;
export type RetryPolicyResult = Extract<RetrySchedule, { retry: true }>;

export function computeRetrySchedule(input: Readonly<{
  failure: ClassifiedFailure;
  attempt: number;
  processingDeadlineAt: number;
  clock: () => number;
  rng: () => number;
}>): RetrySchedule {
  if (!input || typeof input !== 'object'
    || Object.keys(input).some((key) => !['failure', 'attempt', 'processingDeadlineAt', 'clock', 'rng'].includes(key))
    || !Number.isSafeInteger(input.attempt) || input.attempt < 1
    || !Number.isSafeInteger(input.processingDeadlineAt) || typeof input.clock !== 'function' || typeof input.rng !== 'function') {
    throw new Error('Invalid retry schedule input.');
  }
  const failure = revalidateFailure(input.failure);
  if (failure.class === 'permanent' || failure.class === 'security' || failure.class === 'authorization' || failure.class === 'outcome_unknown') {
    return { retry: false, reason: failure.class };
  }
  const now = input.clock();
  const random = input.rng();
  if (!Number.isSafeInteger(now) || random < 0 || random >= 1 || !Number.isFinite(random)) throw new Error('Invalid injected clock or RNG value.');
  if (now >= input.processingDeadlineAt) return { retry: false, reason: 'deadline' };
  const ceiling = Math.min(60_000, 2_000 * (2 ** (input.attempt - 1)));
  const delayMs = failure.retryAfter === undefined ? Math.floor(random * (ceiling + 1)) : parseRetryAfter(failure.retryAfter, now);
  if (!Number.isSafeInteger(delayMs) || now + delayMs >= input.processingDeadlineAt) return { retry: false, reason: 'deadline' };
  const policyTargetAt = now + delayMs;
  return failure.retryAfter === undefined
    ? { retry: true, delayMs, attempt: input.attempt, calculatedAt: now, policyTargetAt, source: 'jitter' }
    : { retry: true, delayMs, attempt: input.attempt, calculatedAt: now, policyTargetAt, source: 'retry_after', retryAfter: failure.retryAfter };
}

export function toMastraNonRetryableError(failure: ClassifiedFailure): MastraNonRetryableError {
  if (!failure || typeof failure !== 'object' || !issuedFailures.has(failure)) throw new Error('Invalid classified failure.');
  const validated = revalidateFailure(failure);
  if (!['permanent', 'security', 'authorization'].includes(validated.class)) throw new Error('Only permanent, security, or authorization failures are non-retryable.');
  return new MastraNonRetryableError(`${validated.code}: ${validated.safeDetail}`);
}

export class OperationDeadlineExceededError extends Error {
  constructor() { super('The operation deadline expired.'); this.name = 'OperationDeadlineExceededError'; }
}

export function withOperationDeadline<T>(operation: (signal: AbortSignal) => Promise<T> | T, deadlineMs: number): Promise<T> {
  if (typeof operation !== 'function' || !Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 2_147_483_647) {
    return Promise.reject(new Error('Invalid operation deadline.'));
  }
  const controller = new AbortController();
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      controller.abort(new OperationDeadlineExceededError());
      reject(controller.signal.reason);
    }, deadlineMs);
    Promise.resolve().then(() => operation(controller.signal)).then(
      (value) => { if (!settled) { settled = true; clearTimeout(timer); resolve(value); } },
      (error) => { if (!settled) { settled = true; clearTimeout(timer); reject(error); } },
    );
  });
}
