import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { loadCorpus, filterCorpus } from './corpus.ts';
import { runScenario, type RunnerManifest } from './runner.ts';
import { aggregateOutcomes, exitCodeFor } from './status.ts';
import type { RunResult } from './schemas/run.ts';

const RUNNER_VERSION = '0.1.0';
const RESULTS_DIR = 'eval/results';

const OPTIONS = { 'keep-artifacts': { type: 'boolean' as const }, scenario: { type: 'string' as const, multiple: true as const } };

function parseArgsCLI(argv: string[]): { scenarioIds: string[]; keepArtifacts: boolean } {
  const { values } = parseArgs({ args: argv, options: OPTIONS });
  return { scenarioIds: values.scenario ?? [], keepArtifacts: Boolean(values['keep-artifacts']) };
}

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
    // dirty working trees can't be identified by HEAD alone (issue #13 provenance)
    const dirty = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (!dirty) return head;
    const diff = execFileSync('git', ['diff'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return `${head}+dirty:${createHash('sha256').update(diff, 'utf8').digest('hex').slice(0, 12)}`;
  } catch {
    return 'unknown';
  }
}

function manifestFor(fixtureClock: string): RunnerManifest {
  return {
    sourceRevision: sourceRevision(),
    runnerVersion: RUNNER_VERSION,
    nodeVersion: process.version,
    lockfileHash: lockfileHash(),
    seed: fixtureClock,
    clock: fixtureClock,
    model: 'scripted/career-copilot-contract-model',
    judge: null,
    retry: 'none',
  };
}

async function main() {
  const args = parseArgsCLI(process.argv.slice(2));
  const corpus = await loadCorpus();
  if (corpus.errors.length > 0) {
    for (const error of corpus.errors) console.error(`invalid corpus: ${error.file}: ${error.message}`);
    process.exit(1);
  }
  const { corpus: selected, excluded } = filterCorpus(corpus, args.scenarioIds);
  if (excluded.length > 0) console.log(`filter: excluding ${excluded.length} scenario(s): ${excluded.join(', ')} (filtered runs are not comparable/pinnable)`);

  const contractScenarios = selected.scenarios.filter((entry) => entry.scenario.kind === 'contract');
  for (const { scenario, file } of selected.scenarios.filter((entry) => entry.scenario.kind !== 'contract')) {
    console.log(`skip: ${scenario.id} (${file}): kind: quality — eval:test is the contract lane; quality runs land with #13d`);
  }

  if (selected.scenarios.length === 0) {
    console.log('eval:test: no live scenarios in the corpus (S01–S18 land with #13c); validation passed.');
    process.exit(0);
  }
  if (contractScenarios.length === 0) {
    console.log('eval:test: only quality-kind scenarios selected; nothing to run in the contract lane.');
    process.exit(0);
  }

  const results: RunResult[] = [];
  for (const { scenario, file } of contractScenarios) {
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
    const runId = `${scenario.id}-${Date.now().toString(36)}`;
    console.log(`running ${scenario.id} (fixture ${scenario.fixture}) ...`);
    const result = await runScenario({
      scenario,
      fixture: fixtureEntry.fixture,
      stubs,
      manifest: manifestFor(fixtureEntry.fixture.clock),
      keepArtifacts: args.keepArtifacts,
      corpusHash: selected.hash,
      runId,
    });
    results.push(result);
    const failedAssertions = result.assertions.filter((assertion) => assertion.status === 'failed');
    console.log(`  ${result.status}: ${result.transcript.events.length} events, ${result.assertions.length} assertions, ${failedAssertions.length} failed`);
    for (const assertion of failedAssertions) console.log(`    FAIL ${assertion.id}: ${assertion.evidence}`);
  }

  const aggregate = aggregateOutcomes(results.map((result) => ({ scenarioId: result.scenarioId, status: result.status, assertionFailures: result.assertions.filter((a) => a.status === 'failed').length, incomplete: result.status === 'incomplete' })));
  console.log(`\nsummary: ${aggregate.passed} passed, ${aggregate.failed} failed, ${aggregate.incomplete} incomplete, ${aggregate.skipped} skipped`);
  await mkdir(RESULTS_DIR, { recursive: true });
  const aggregateFile = path.join(RESULTS_DIR, `run-${Date.now()}.json`);
  await writeFile(aggregateFile, JSON.stringify({ aggregate, runs: results.map((result) => ({ runId: result.runId, scenarioId: result.scenarioId, status: result.status, corpusHash: result.corpusHash, manifest: result.manifest, metrics: result.metrics, assertions: result.assertions, redaction: result.redaction })), corpusHash: selected.hash }, null, 2));
  console.log(`artifact: ${aggregateFile} (redacted aggregate; raw transcripts stay local)`);
  process.exit(exitCodeFor(aggregate, contractScenarios.length));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
