import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseScenario, type Scenario } from './schemas/scenario.ts';
import { parseFixture, type Fixture } from './schemas/fixture.ts';

export type CorpusError = { file: string; message: string };

export type LoadedScenario = { scenario: Scenario; file: string; staged: boolean };
export type LoadedFixture = { fixture: Fixture; file: string };

export type Corpus = {
  scenarios: LoadedScenario[];
  staged: LoadedScenario[];
  fixtures: Map<string, LoadedFixture>;
  errors: CorpusError[];
  /** sha256 over canonical serialization of the live corpus (content-sensitive). */
  hash: string;
};

const SCENARIO_DIR = 'eval/scenarios';
const FIXTURE_DIR = 'eval/fixtures';

async function walk(dir: string): Promise<string[]> {
  const all = await readdir(dir, { recursive: true }).catch(() => []);
  return all
    .filter((entry) => !all.some((other) => other !== entry && other.startsWith(entry + '/')))
    .map((entry) => path.join(dir, entry))
    .sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'variant' }));
}

function readYaml(file: string): unknown {
  const source = readFileSync(file, 'utf8');
  return parseYaml(source, { strict: true, maxAliasCount: 100 });
}

function scenarioIdFromFile(file: string): string {
  return path.basename(file).replace(/\.yaml(?:\.staged)?$/, '');
}

function canonicalScenarioJson(scenario: Scenario): string {
  return JSON.stringify(scenario);
}

/** Canonical serialization of a parsed (defaults-applied) fixture. */
function canonicalFixtureJson(fixture: Fixture): string {
  return JSON.stringify(fixture);
}

export function corpusHashOf(scenarios: LoadedScenario[], fixtures?: Map<string, LoadedFixture>): string {
  const parts = scenarios
    .map(({ scenario }) => scenario.id + ':' + canonicalScenarioJson(scenario))
    .sort();
  // fixtures referenced by the selected scenarios are part of run semantics:
  // scripted model responses, DB rows, fetch plans, and notification plans
  // must invalidate baselines when they change (issue #13)
  if (fixtures) {
    const needed = new Set<string>();
    for (const { scenario } of scenarios) {
      needed.add(scenario.fixture);
      for (const stub of scenario.stubs ?? []) needed.add(stub);
    }
    for (const id of [...needed].sort()) {
      const entry = fixtures.get(id);
      parts.push(`fixture:${id}:${entry ? canonicalFixtureJson(entry.fixture) : '<missing>'}`);
    }
  }
  return createHash('sha256').update(parts.join('\n'), 'utf8').digest('hex');
}

export async function loadCorpus(baseDir = process.cwd()): Promise<Corpus> {
  const errors: CorpusError[] = [];
  const scenarios: LoadedScenario[] = [];
  const staged: LoadedScenario[] = [];
  const fixtures = new Map<string, LoadedFixture>();

  for (const file of await walk(path.join(baseDir, FIXTURE_DIR))) {
    if (!file.endsWith('.yaml')) continue;
    const id = scenarioIdFromFile(file);
    try {
      const fixture = parseFixture(readYaml(file));
      if (fixture.id !== id) throw new Error(`fixture id "${fixture.id}" does not match filename "${id}"`);
      if (fixtures.has(fixture.id)) errors.push({ file, message: `duplicate fixture id "${fixture.id}"` });
      else fixtures.set(fixture.id, { fixture, file });
    } catch (error) {
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }

  for (const file of await walk(path.join(baseDir, SCENARIO_DIR))) {
    const stagedFile = file.endsWith('.yaml.staged');
    if (!stagedFile && !file.endsWith('.yaml')) continue;
    const id = scenarioIdFromFile(file);
    try {
      const scenario = parseScenario(readYaml(file));
      if (scenario.id !== id) throw new Error(`scenario id "${scenario.id}" does not match filename "${id}"`);
      const entry = { scenario, file, staged: stagedFile };
      (stagedFile ? staged : scenarios).push(entry);
    } catch (error) {
      errors.push({ file, message: error instanceof Error ? error.message : String(error) });
    }
  }

  // duplicates (live corpus only)
  const seen = new Map<string, string>();
  for (const { scenario, file } of scenarios) {
    if (seen.has(scenario.id)) errors.push({ file, message: `duplicate scenario id "${scenario.id}" (also in ${seen.get(scenario.id)})` });
    else seen.set(scenario.id, file);
  }

  // reference validation: fixture + stubs must resolve; persona/stub references checked
  for (const { scenario, file } of scenarios) {
    if (!fixtures.has(scenario.fixture)) errors.push({ file, message: `scenario references unknown fixture "${scenario.fixture}"` });
    for (const stub of scenario.stubs ?? []) {
      if (!fixtures.has(stub)) errors.push({ file, message: `scenario references unknown stub fixture "${stub}"` });
    }
  }

  // stub merge conflicts: sheets failure modes and notification delivery plans
  // must agree across the fixture and its stubs (mergedFixture semantics)
  for (const { scenario, file } of scenarios) {
    const base = fixtures.get(scenario.fixture)?.fixture;
    const stubFixtures = (scenario.stubs ?? []).map((id) => fixtures.get(id)?.fixture).filter((entry): entry is Fixture => entry !== undefined);
    const sheetFailures = new Set<string>();
    if (base?.sheets.failure) sheetFailures.add(base.sheets.failure);
    for (const stub of stubFixtures) if (stub.sheets.failure) sheetFailures.add(stub.sheets.failure);
    if (sheetFailures.size > 1) errors.push({ file, message: `stub merge conflict: sheets failure modes ${[...sheetFailures].join(', ')}` });
    const deliveries = new Map<string, string>();
    for (const plan of [base, ...stubFixtures].flatMap((entry) => entry?.notifications ?? [])) {
      const prior = deliveries.get(plan.jobId);
      if (prior && prior !== plan.deliver) errors.push({ file, message: `stub merge conflict: notification plan for ${plan.jobId} has conflicting delivery modes ${prior}/${plan.deliver}` });
      deliveries.set(plan.jobId, plan.deliver);
    }
  }

  const sortedScenarios = scenarios.sort((a, b) => a.file.localeCompare(b.file, 'en', { sensitivity: 'variant' }));
  return { scenarios: sortedScenarios, staged, fixtures, errors, hash: corpusHashOf(sortedScenarios, fixtures) };
}

export function filterCorpus(corpus: Corpus, ids: string[]): { corpus: Corpus; excluded: string[] } {
  if (ids.length === 0) return { corpus, excluded: [] };
  const wanted = new Set(ids);
  const included = corpus.scenarios.filter(({ scenario }) => wanted.has(scenario.id));
  const excluded = corpus.scenarios.filter(({ scenario }) => !wanted.has(scenario.id)).map(({ scenario }) => scenario.id);
  const missing = ids.filter((id) => !wanted.has(id) && !included.some(({ scenario }) => scenario.id === id));
  if (missing.length > 0) throw new Error(`unknown scenario id(s): ${missing.join(', ')} (live corpus only)`);
  return { corpus: { ...corpus, scenarios: included, hash: corpusHashOf(included, corpus.fixtures) }, excluded };
}
