import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpus, filterCorpus } from './corpus.ts';
import { runScenario, runScenarioDetailed, mergeFixture, type RunnerManifest } from './runner.ts';
import { aggregateOutcomes, exitCodeFor } from './status.ts';
import type { QualityResult, QualityRubricResult, RunResult } from './schemas/run.ts';
import type { Limits } from './schemas/index.ts';
import { createLiveModel, resolveLiveModelConfig, type LiveModel, type LiveModelConfig } from './live-model.ts';
import { pricingTable } from './pricing.ts';
import { buildJudgePayload, runJudge } from './judge.ts';
import type { ScriptedModelLedger } from './fakes/model.ts';
import type { Canary } from './schemas/fixture.ts';

/**
 * eval:quality — manual cross-family quality lane (#13d).
 *
 * Per scenario, in strict order:
 *   1. contract gate: the scripted-model replay; deterministic assertions must
 *      pass (no quality run rescues a deterministic failure).
 *   2. quality replay: the same scenario against the REAL SUT model; its
 *      deterministic assertions must pass; canary scan must be clean.
 *   3. judge: a cross-family model scores the scenario's declared rubrics from
 *      a redacted transcript + evidence ledger.
 *
 * Budgets (issue #13): per scenario 120s wall / 20 SUT calls / 30k in + 8k out
 * SUT tokens / 2 judge calls / 20k in + 4k out judge tokens / USD 0.50; full
 * run 30 min / 500 live calls / 1M tokens / USD 20. Exceeding any budget
 * terminates the scenario as incomplete. Missing usage/cost on any live call
 * is unmetered → incomplete unless --allow-unmetered (which permits
 * completion but never pinning).
 */

const RUNNER_VERSION = '0.2.0';
const RESULTS_DIR = 'eval/results';
const ARTIFACTS_DIR = 'eval/artifacts';

const QUALITY_DEFAULTS: Required<Limits> = { maxTurns: 50, maxWallClockMs: 120_000, maxModelCalls: 20 };
const SUT_TOKEN_BUDGET = { input: 30_000, output: 8_000 };
const JUDGE_CALL_BUDGET = 2;
const JUDGE_TOKEN_BUDGET = { input: 20_000, output: 4_000 };
const SCENARIO_USD_BUDGET = 0.5;
const RUN_WALL_BUDGET_MS = 30 * 60_000;
const RUN_CALL_BUDGET = 500;
const RUN_TOKEN_BUDGET = 1_000_000;
const RUN_USD_BUDGET = 20;

const OPTIONS = {
  'keep-artifacts': { type: 'boolean' as const },
  'allow-unmetered': { type: 'boolean' as const },
  scenario: { type: 'string' as const, multiple: true as const },
};

function lockfileHash(): string {
  try {
    return createHash('sha256').update(readFileSync('package-lock.json')).digest('hex');
  } catch {
    return 'unknown';
  }
}

function sourceRevision(): string {
  try {
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || 'unknown';
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!dirty) return head;
    const diff = execFileSync('git', ['diff', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const untracked = execFileSync('git', ['ls-files', '--others', '--exclude-standard'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
      .split('\n')
      .map((file) => file.trim())
      .filter((file) => file && !file.startsWith('eval/results/') && !file.startsWith('eval/artifacts/') && !file.startsWith('.code-review-graph/'))
      .map((file) => `${file}:${createHash('sha256').update(readFileSync(file)).digest('hex')}`)
      .join('\n');
    return `${head}+dirty:${createHash('sha256').update(diff + '\n' + untracked, 'utf8').digest('hex').slice(0, 12)}`;
  } catch {
    return 'unknown';
  }
}

function qualityManifest(clock: string, sut: LiveModelConfig, judge: LiveModelConfig, allowUnmetered: boolean): RunnerManifest {
  const pricing = pricingTable();
  return {
    sourceRevision: sourceRevision(),
    runnerVersion: RUNNER_VERSION,
    nodeVersion: process.version,
    lockfileHash: lockfileHash(),
    clock,
    model: `${sut.provider}/${sut.modelId}`,
    provider: sut.provider,
    apiBase: sut.apiBase,
    revision: null,
    judgeModel: `${judge.provider}/${judge.modelId}`,
    judgeProvider: judge.provider,
    judgeApiBase: judge.apiBase,
    judgeRevision: null,
    pricingTableVersion: pricing.version,
    retry: { maxAttempts: (sut.maxRetries ?? 1) + 1, backoffMs: sut.retryBackoffMs ?? 500 },
    allowUnmetered,
  };
}

type Cumulative = { wallMs: number; calls: number; tokens: number; costUsd: number | null };

function cumulativelyUnmetered(cumulative: Cumulative): boolean {
  return cumulative.costUsd === null;
}

function sumCost(calls: { costUsd?: number | null }[]): number | null {
  if (calls.length === 0) return 0;
  if (!calls.every((call) => typeof call.costUsd === 'number')) return null;
  return calls.reduce((sum, call) => sum + (call.costUsd ?? 0), 0);
}

function tokensOf(calls: { inputTokens?: number | null; outputTokens?: number | null }[]): { input: number | null; output: number | null } {
  if (calls.length === 0) return { input: 0, output: 0 };
  const input = calls.every((call) => typeof call.inputTokens === 'number') ? calls.reduce((sum, call) => sum + (call.inputTokens ?? 0), 0) : null;
  const output = calls.every((call) => typeof call.outputTokens === 'number') ? calls.reduce((sum, call) => sum + (call.outputTokens ?? 0), 0) : null;
  return { input, output };
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options: OPTIONS });
  const scenarioIds = values.scenario ?? [];
  const allowUnmetered = Boolean(values['allow-unmetered']);
  const keepArtifacts = Boolean(values['keep-artifacts']);

  const corpus = await loadCorpus();
  if (corpus.errors.length > 0) {
    for (const error of corpus.errors) console.error(`invalid corpus: ${error.file}: ${error.message}`);
    process.exit(1);
  }
  const { corpus: selected, excluded } = filterCorpus(corpus, scenarioIds);
  if (excluded.length > 0) console.log(`filter: excluding ${excluded.length} scenario(s): ${excluded.join(', ')} (filtered runs are not comparable/pinnable)`);

  const eligible = selected.scenarios.filter((entry) => (entry.scenario.rubrics?.length ?? 0) > 0);
  for (const { scenario, file } of selected.scenarios.filter((entry) => (entry.scenario.rubrics?.length ?? 0) === 0)) {
    console.log(`skip: ${scenario.id} (${file}): no rubrics declared — contract-only (C), not quality-eligible`);
  }
  if (eligible.length === 0) {
    console.log('eval:quality: no rubric-declaring scenarios selected; nothing to run.');
    process.exit(0);
  }

  const sutConfig = resolveLiveModelConfig(process.env.CAREER_COPILOT_MODEL, 'CAREER_COPILOT');
  const judgeConfig = resolveLiveModelConfig(process.env.EVAL_JUDGE_MODEL, 'EVAL_JUDGE');
  // cross-family gate (issue #13): the judge family must differ from the SUT
  // family; aliases (opencode / opencode-go) are the same family
  const FAMILY_ALIASES: Record<string, string> = { opencode: 'opencode', 'opencode-go': 'opencode' };
  const sutFamily = FAMILY_ALIASES[sutConfig.provider] ?? sutConfig.provider;
  const judgeFamily = FAMILY_ALIASES[judgeConfig.provider] ?? judgeConfig.provider;
  if (sutFamily === judgeFamily) {
    console.error(`cross-family gate: judge family "${judgeFamily}" must differ from SUT family "${sutFamily}" — pick a different EVAL_JUDGE_MODEL`);
    process.exit(1);
  }
  console.log(`SUT:   ${sutConfig.provider}/${sutConfig.modelId} @ ${sutConfig.apiBase} (family ${sutFamily})`);
  console.log(`judge: ${judgeConfig.provider}/${judgeConfig.modelId} @ ${judgeConfig.apiBase} (family ${judgeFamily})`);
  if (!allowUnmetered) console.log('metering: required — any live call without usage/cost makes the scenario incomplete (use --allow-unmetered to relax; unmetered runs can never be pinned)');
  else console.log('metering: --allow-unmetered set — unmetered runs complete but can never be pinned');

  const cumulative: Cumulative = { wallMs: 0, calls: 0, tokens: 0, costUsd: 0 };
  const runStartedAt = Date.now();
  const results: RunResult[] = [];
  const scenarioOutcomes: { scenarioId: string; status: RunResult['status']; assertionFailures: number; incomplete: boolean }[] = [];

  for (const { scenario, file } of eligible) {
    if (cumulative.wallMs >= RUN_WALL_BUDGET_MS || cumulative.calls >= RUN_CALL_BUDGET || cumulative.tokens >= RUN_TOKEN_BUDGET || (cumulative.costUsd !== null && cumulative.costUsd >= RUN_USD_BUDGET)) {
      console.log(`incomplete: ${scenario.id}: full-run budget exhausted (${RUN_WALL_BUDGET_MS / 60000}min/${RUN_CALL_BUDGET} calls/${RUN_TOKEN_BUDGET} tokens/USD ${RUN_USD_BUDGET})`);
      scenarioOutcomes.push({ scenarioId: scenario.id, status: 'incomplete', assertionFailures: 0, incomplete: true });
      continue;
    }
    const fixtureEntry = corpus.fixtures.get(scenario.fixture);
    if (!fixtureEntry) {
      console.error(`missing fixture ${scenario.fixture} for ${scenario.id} (${file})`);
      process.exit(1);
    }
    const stubs = (scenario.stubs ?? []).map((stubId) => {
      const entry = corpus.fixtures.get(stubId);
      if (!entry) throw new Error(`missing stub fixture ${stubId} for ${scenario.id}`);
      return entry.fixture;
    });
    const merged = mergeFixture(fixtureEntry.fixture, stubs);
    const canaries: Canary[] = merged.canaries;
    const mergedFixture = merged.fixture;
    const runId = `${scenario.id}-${Date.now().toString(36)}`;
    const fixtureClock = fixtureEntry.fixture.clock;
    console.log(`\n== ${scenario.id} (fixture ${scenario.fixture}, rubrics: ${(scenario.rubrics ?? []).join(', ')}) ==`);
    const scenarioStartedAt = Date.now();
    let quality: QualityResult;
    const sutLedger: ScriptedModelLedger = { calls: [] };
    let judgeLedger: ScriptedModelLedger = { calls: [] };
    let judgeTokens = { input: 0, output: 0 };
    let judgeCost: number | null = 0;
    let judgeCalls = 0;
    let sutTokens = { input: 0, output: 0 };
    let sutCost: number | null = 0;

    // 1. contract gate — scripted replay; deterministic failures block judging
    const gateResult = await runScenario({
      scenario,
      fixture: fixtureEntry.fixture,
      stubs,
      manifest: { sourceRevision: sourceRevision(), runnerVersion: RUNNER_VERSION, nodeVersion: process.version, lockfileHash: lockfileHash(), clock: fixtureClock, model: 'scripted/career-copilot-contract-model' },
      keepArtifacts,
      corpusHash: selected.hash,
      runId: `${runId}-gate`,
    });
    let baseResult: RunResult = gateResult;
    if (gateResult.status === 'failed') {
      console.log(`  gate: failed — deterministic contract replay failed; quality not run`);
      quality = { status: 'failed', rubrics: [], reason: `contract gate failed: ${gateResult.assertions.filter((a) => a.status === 'failed').map((a) => a.id).slice(0, 5).join(', ')}` };
    } else if (gateResult.status === 'incomplete') {
      console.log(`  gate: incomplete — deterministic contract replay did not complete; quality not run`);
      quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'contract gate incomplete' })), reason: `contract gate incomplete (see transcript)` };
    } else {
      console.log(`  gate: passed (${gateResult.assertions.length} assertions)`);

      // 2. quality replay — real SUT model
      const sutModel = createLiveModel(sutConfig, sutLedger);
      const qualityLimits: Limits = {
        ...(scenario.limits ?? {}),
        maxWallClockMs: Math.min(scenario.limits?.maxWallClockMs ?? QUALITY_DEFAULTS.maxWallClockMs, QUALITY_DEFAULTS.maxWallClockMs),
        maxModelCalls: Math.min(scenario.limits?.maxModelCalls ?? QUALITY_DEFAULTS.maxModelCalls, QUALITY_DEFAULTS.maxModelCalls),
      };
      const replay = await runScenarioDetailed({
        scenario,
        fixture: fixtureEntry.fixture,
        stubs,
        manifest: qualityManifest(fixtureClock, sutConfig, judgeConfig, allowUnmetered),
        keepArtifacts,
        corpusHash: selected.hash,
        runId,
        liveModel: sutModel,
        limits: qualityLimits,
      });
      baseResult = replay.result;
      const replayResult = replay.result;
      sutTokens = tokensOf(replay.qualityData.modelCalls);
      sutCost = sumCost(replay.qualityData.modelCalls);

      if (replayResult.status === 'incomplete') {
        quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'quality replay incomplete' })), reason: `quality replay incomplete: ${replayResult.redaction.canariesFound.length > 0 ? `canary hits: ${replayResult.redaction.canariesFound.join(', ')}` : replayResult.transcript.events.filter((e) => e.type === 'error').map((e) => String((e.payload as { message?: unknown }).message ?? '')).slice(-1).join('; ') || 'see transcript'}` };
      } else if (replayResult.status === 'failed') {
        quality = { status: 'failed', rubrics: [], reason: `quality replay failed deterministic assertions: ${replayResult.assertions.filter((a) => a.status === 'failed').map((a) => a.id).slice(0, 5).join(', ')}` };
      } else {
        // metering: usage AND cost on every live SUT call
        const unmetered = replay.qualityData.modelCalls.length > 0 && (sutTokens.input === null || sutTokens.output === null || sutCost === null);
        if (unmetered && !allowUnmetered) {
          quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'unmetered' })), reason: 'unmetered: live SUT calls lack usage or cost (use --allow-unmetered)' };
        } else if ((sutTokens.input ?? 0) > SUT_TOKEN_BUDGET.input || (sutTokens.output ?? 0) > SUT_TOKEN_BUDGET.output) {
          quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'SUT token budget exceeded' })), reason: `SUT token budget exceeded: ${sutTokens.input}/${SUT_TOKEN_BUDGET.input} in, ${sutTokens.output}/${SUT_TOKEN_BUDGET.output} out` };
        } else if (sutCost !== null && sutCost > SCENARIO_USD_BUDGET) {
          quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'cost budget exceeded' })), reason: `SUT cost ${sutCost.toFixed(4)} USD exceeds ${SCENARIO_USD_BUDGET} USD` };
        } else {
          // 3. judge — one logical call = one HTTP request (maxRetries 0); the
          // fixed judge retry owns the second request, so the 2-call budget is
          // a hard 2-request ceiling. Request timeout bounded by the scenario
          // wall budget remaining after the replay.
          judgeLedger = { calls: [] };
          const remainingWallMs = Math.max(5_000, QUALITY_DEFAULTS.maxWallClockMs - (Date.now() - scenarioStartedAt));
          const judgeModel = createLiveModel({ ...judgeConfig, maxRetries: 0, requestTimeoutMs: Math.min(30_000, remainingWallMs) }, judgeLedger);
          const rawResponses: string[] = [];
          // the judge sees the SAME merged fixture surface the replay ran
          // against (stub-provided job pages included)
          quality = await runJudge({ scenario, fixture: mergedFixture, canaries, qualityData: replay.qualityData, model: judgeModel }, (raw) => rawResponses.push(raw));
          judgeTokens = tokensOf(judgeLedger.calls);
          judgeCost = sumCost(judgeLedger.calls);
          judgeCalls = judgeLedger.calls.length;
          const totalCost = sutCost !== null && judgeCost !== null ? sutCost + judgeCost : null;
          const judgeUnmetered = judgeCalls > 0 && (judgeTokens.input === null || judgeTokens.output === null || judgeCost === null);
          if (judgeUnmetered && !allowUnmetered) {
            quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'judge unmetered' })), reason: 'unmetered: judge calls lack usage or cost (use --allow-unmetered)' };
          } else if (judgeCalls > JUDGE_CALL_BUDGET || (judgeTokens.input ?? 0) > JUDGE_TOKEN_BUDGET.input || (judgeTokens.output ?? 0) > JUDGE_TOKEN_BUDGET.output) {
            quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'judge budget exceeded' })), reason: `judge budget exceeded: ${judgeCalls}/${JUDGE_CALL_BUDGET} calls, ${judgeTokens.input}/${JUDGE_TOKEN_BUDGET.input} in, ${judgeTokens.output}/${JUDGE_TOKEN_BUDGET.output} out` };
          } else if (totalCost !== null && totalCost > SCENARIO_USD_BUDGET) {
            quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'cost budget exceeded' })), reason: `total cost ${totalCost.toFixed(4)} USD exceeds ${SCENARIO_USD_BUDGET} USD` };
          }
          // local redacted artifacts (gitignored, mode 0600)
          await mkdir(ARTIFACTS_DIR, { recursive: true });
          const payload = buildJudgePayload({ scenario, fixture: mergedFixture, canaries, qualityData: replay.qualityData, model: judgeModel });
          const artifact = {
            runId,
            scenarioId: scenario.id,
            status: quality.status,
            quality,
            metrics: replayResult.metrics,
            sutCalls: sutLedger.calls.map((call) => ({ purpose: call.purpose, model: call.model, inputTokens: call.inputTokens, outputTokens: call.outputTokens, costUsd: call.costUsd ?? null, retries: call.retries ?? 0, revision: call.revision ?? null })),
            judgeCalls: judgeLedger.calls.map((call) => ({ inputTokens: call.inputTokens, outputTokens: call.outputTokens, costUsd: call.costUsd ?? null })),
            judgePayload: payload,
            judgeRawResponses: rawResponses,
            redactedTranscript: replayResult.transcript.events,
          };
          const artifactFile = path.join(ARTIFACTS_DIR, `${runId}.json`);
          await writeFile(artifactFile, JSON.stringify(artifact, null, 2));
          await chmod(artifactFile, 0o600);
          console.log(`  artifact: ${artifactFile} (local, gitignored, mode 0600)`);
        }
      }

      // scenario wall-clock budget (replay + judge phases)
      if (quality.status !== 'failed' && Date.now() - scenarioStartedAt > QUALITY_DEFAULTS.maxWallClockMs) {
        quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'scenario wall-clock budget exceeded' })), reason: `scenario exceeded ${QUALITY_DEFAULTS.maxWallClockMs}ms wall clock` };
      }
    }

    // full-run cumulative budgets: wall always advances; live calls/tokens/cost
    // only exist when the replay ran. A crossing scenario is demoted to
    // incomplete (the cap was exceeded on ITS watch); later scenarios stop.
    cumulative.wallMs = Date.now() - runStartedAt;
    const liveCalls = sutLedger.calls.length + judgeLedger.calls.length;
    const liveTokens = (sutTokens.input ?? 0) + (sutTokens.output ?? 0) + (judgeTokens.input ?? 0) + (judgeTokens.output ?? 0);
    const liveCost = sutCost !== null && judgeCost !== null ? sutCost + judgeCost : null;
    cumulative.calls += liveCalls;
    cumulative.tokens += liveTokens;
    if (liveCost !== null) cumulative.costUsd = (cumulative.costUsd ?? 0) + liveCost;
    else cumulative.costUsd = null;
    const crossedBudget =
      cumulative.wallMs >= RUN_WALL_BUDGET_MS || cumulative.calls >= RUN_CALL_BUDGET || cumulative.tokens >= RUN_TOKEN_BUDGET || (cumulative.costUsd !== null && cumulative.costUsd >= RUN_USD_BUDGET);
    if (crossedBudget && quality.status === 'passed') {
      quality = { status: 'incomplete', rubrics: (scenario.rubrics ?? []).map((id) => ({ id, status: 'incomplete', score: null, evidence: [], criticalFailure: false, note: 'full-run budget exhausted' })), reason: 'full-run budget exhausted on this scenario' };
    }

    const status: RunResult['status'] = quality.status === 'passed' ? 'passed' : quality.status === 'failed' ? 'failed' : 'incomplete';
    // honest result row: real gate/replay transcript, state, assertions, and
    // redaction (never fabricated); quality block carries rubric results plus
    // combined SUT/judge metering; manifest gets post-run provenance.
    const sutRevision = [...sutLedger.calls].reverse().find((call) => call.revision != null)?.revision ?? null;
    const judgeRevision = [...judgeLedger.calls].reverse().find((call) => call.revision != null)?.revision ?? null;
    const totalCostUsd = liveCost;
    const metering = {
      sutCalls: sutLedger.calls.length,
      sutInputTokens: sutTokens.input,
      sutOutputTokens: sutTokens.output,
      sutCostUsd: sutCost,
      judgeCalls,
      judgeInputTokens: judgeTokens.input,
      judgeOutputTokens: judgeTokens.output,
      judgeCostUsd: judgeCost,
      totalCostUsd,
      budget: crossedBudget ? `exceeded (${cumulative.calls}/${RUN_CALL_BUDGET} calls, ${cumulative.tokens}/${RUN_TOKEN_BUDGET} tokens, ${cumulative.costUsd === null ? 'unmetered' : `USD ${cumulative.costUsd.toFixed(2)}/${RUN_USD_BUDGET}`}, ${Math.round(cumulative.wallMs / 1000)}s/${RUN_WALL_BUDGET_MS / 60_000}min)` : 'within',
    };
    const result: RunResult = {
      ...baseResult,
      runId,
      status,
      corpusHash: selected.hash,
      manifest: {
        ...baseResult.manifest,
        model: `${sutConfig.provider}/${sutConfig.modelId}`,
        provider: sutConfig.provider,
        apiBase: sutConfig.apiBase,
        revision: sutRevision,
        judgeModel: `${judgeConfig.provider}/${judgeConfig.modelId}`,
        judgeProvider: judgeConfig.provider,
        judgeApiBase: judgeConfig.apiBase,
        judgeRevision,
        pricingTableVersion: pricingTable().version,
        retry: { maxAttempts: (sutConfig.maxRetries ?? 1) + 1, backoffMs: sutConfig.retryBackoffMs ?? 500 },
        allowUnmetered,
      },
      quality: { ...quality, metering },
    };
    results.push(result);
    scenarioOutcomes.push({ scenarioId: scenario.id, status, assertionFailures: 0, incomplete: status === 'incomplete' });
    const rubricLine = quality.rubrics.length > 0 ? `, rubrics: ${quality.rubrics.map((rubric) => `${rubric.id}=${rubric.score ?? 'n/a'}${rubric.criticalFailure ? '!' : ''}`).join(' ')}` : '';
    console.log(`  quality: ${quality.status}${rubricLine}${quality.reason ? ` — ${quality.reason}` : ''}`);
    if (cumulativelyUnmetered(cumulative)) console.log('  note: run is unmetered (cost unknown) — can never be pinned');
  }

  const aggregate = aggregateOutcomes(scenarioOutcomes);
  const summary: QualityRubricResult[] = results.flatMap((result) => result.quality?.rubrics ?? []);
  console.log(`\nsummary: ${aggregate.passed} passed, ${aggregate.failed} failed, ${aggregate.incomplete} incomplete, ${aggregate.skipped} skipped; ${summary.length} rubric scores`);
  await mkdir(RESULTS_DIR, { recursive: true });
  const aggregateFile = path.join(RESULTS_DIR, `quality-${Date.now()}.json`);
  await writeFile(aggregateFile, JSON.stringify({ aggregate, corpusHash: selected.hash, pricingTableVersion: pricingTable().version, runs: results.map((result) => ({ runId: result.runId, scenarioId: result.scenarioId, status: result.status, corpusHash: result.corpusHash, manifest: result.manifest, metrics: result.metrics, quality: result.quality })) }, null, 2));
  console.log(`artifact: ${aggregateFile} (redacted aggregate; raw transcripts stay local)`);
  process.exit(exitCodeFor(aggregate));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
