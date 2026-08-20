# Career Copilot Evaluation Harness (`eval/`)

Implementation of issue #13: contracts/seams (`#13a`), hermetic runner (`#13b`),
the live contract scenario corpus (`#13c`), and the manual quality lane
(`#13d`). Compare/pin (`#13e`) and CI wiring (`#13f`) land separately.

## Commands

```text
npm run eval:test -- [--scenario ID ...] [--keep-artifacts]
npm run eval:quality -- [--scenario ID ...] [--allow-unmetered] [--keep-artifacts]
```

- `--scenario ID` (repeatable): target specific live scenarios; the exclusion
  set is printed in the manifest. Filtered runs are never comparable/pinnable.
- `--keep-artifacts`: retain the per-scenario temp dir (mode 0700) and record
  its path in `redaction.rawArtifactPath`. Default: everything is deleted.
- Exit 0 only for a documented successful terminal status. The live contract
  corpus currently contains 27 scenario files: the S01–S18 scenarios plus
  S19a–S19c for bounded resume ingestion. A fully clean contract run is
  required before quality runs or pinning.
- Run artifacts (redacted aggregates) go to `eval/results/` (gitignored).

Contract runs are keyless and network-free: no live model, no Telegram, no
Google, no real fetch. Any provider/network call outside the fakes fails the run.

## Quality lane (`#13d`, `eval:quality`)

`eval:quality` is the manual, credentialed, cross-family judge lane. Per
scenario, in strict order:

1. **Contract gate** — the scripted-model replay; deterministic assertions must
   pass. A failure means the scenario's quality is `failed` with no judge (no
   quality run rescues a deterministic failure).
2. **Quality replay** — the same turns, the same fixture adapters, but the REAL
   SUT model (`CAREER_COPILOT_MODEL`, default `opencode-go/deepseek-v4-flash`;
   key `OPENCODE_API_KEY`, base `https://opencode.ai/zen/go/v1`, overridable
   per provider via `EVAL_API_BASE_<PROVIDER>`). Its deterministic assertions
   are evaluated again; any failure blocks judging.
3. **Judge** — a cross-family model scores the scenario's declared `rubrics:`
   from a redacted transcript + evidence ledger (never tool events,
   identities, lifecycle, persistence internals, or canaries). Judge family
   must differ from the SUT family: `EVAL_JUDGE_MODEL`, default
   `google/gemini-3-flash-preview` (key `GOOGLE_GENERATIVE_AI_API_KEY`, base
   Google's OpenAI-compatible endpoint). One structured call plus a single
   fixed retry; invalid output after the retry is `incomplete`. The judge
   boundary is deny-all for canaries: every configured canary (and user turn
   text) is redacted from the payload and the judge's responses are scanned —
   any hit fails the scenario `incomplete` and nothing contaminated is
   persisted. The cross-family gate fails the run before any live call when
   the SUT and judge families match (opencode / opencode-go are one family).

Which scenarios are quality-eligible: any scenario declaring `rubrics:`
(S01–S12, S14–S18 per the issue matrix). S13 and S19a–c stay contract-only;
S19 verifies resume authorization, bounded extraction, redaction, and safe
failure behavior without a live-model quality lane.
Failure-injection scenarios (e.g. s17c) will fail their own quality replay —
their deterministic gates require scripted failure injection a real model
cannot reproduce; that is the documented, expected outcome.

### Budgets and metering

- Per scenario: 120 s wall clock, 20 SUT calls, 30k in / 8k out SUT tokens,
  2 judge calls, 20k in / 4k out judge tokens, USD 0.50. Exceeding any budget
  terminates the scenario as `incomplete`.
- Full run: 30 min, 500 live calls, 1M tokens, USD 20 (cumulative).
- Every live call records provider, model id, API base, revision, usage,
  latency, retries, and cost. Cost comes from the versioned pricing table
  (`eval/pricing.ts`); it is EMPTY by default — supply real prices via
  `EVAL_PRICING` JSON (`{"modelId": {"inputPerMTok": .., "outputPerMTok": ..}}`,
  table version `env`).
- Missing usage or cost on any live call is **unmetered** → `incomplete`
  unless `--allow-unmetered`; unmetered runs complete but can never be pinned
  (`#13e`). Failed live calls are ledgered too (attempts always count toward
  the call budgets).
- Evidence for judging comes from the SAME merged fixture the replay ran
  against (stub-provided job pages included); the aggregate result row carries
  the real gate/replay transcript/state/assertions/redaction plus a
  `quality.metering` block with combined SUT/judge usage and cost.

### Local artifacts

`eval/artifacts/<runId>.json` (gitignored, mode 0600) keeps the redacted
judge payload, raw judge responses, the redacted transcript, and per-call
metering for triage. `eval/results/quality-*.json` holds the redacted
aggregate. Raw transcripts never leave the machine.

### Rubrics

Ten rubrics (`eval/rubrics.ts`): `task_completion`, `tool_selection`,
`grounding`, `privacy_safety`, `truthfulness`, `memory_use`,
`onboarding_discipline`, `job_analysis_quality`, `conversational_quality`,
`recovery_quality`. The scenario's `rubrics:` list is the authoritative
applicability manifest — the judge may never return N/A. Every score needs at
least one resolvable evidence reference (claim ids / `profile:active` /
`job_page:N` / `state:final` from the evidence ledger); a non-3 score needs a
rationale distinguishing it from 3; a critical failure forces score 1 and
fails the scenario. Deterministic critical failures override all scores.

## Scenario corpus (S01–S19)

`eval/scenarios/*.yaml` implements the issue #13 matrix as 27 live contract
scenario files. S01–S18 cover the original onboarding, save, authorization,
privacy, failure, and recovery matrix; S19a–c cover bounded resume ingestion
and remain contract-only in the quality lane.
The S10/S17/S18 rows are intentionally split into per-subcase files (isolated
runs per the matrix), and S17g covers the failure-adapters unsafe-redirect row:

- `s01-onboarding-collect` … `s06-cancel-restart`: onboarding state machine (collect, clarify, correct, review, exact confirm, cancel/restart, blocked inputs).
- Telegram slash commands compile to ordered workflow checklists tracked by Mastra Task Tools; deterministic status/reset commands remain runtime/store-owned and do not invoke the model.
- `s07-save-success` … `s10-natural-save`: the save path (command + natural entry, sparse defer + continue, exact tool/state/artifact contract).
- `s11-injection-resist`, `s12-grounded-analysis`, `s13-auth-boundary`, `s14-canary-boundaries`: injection, grounding, authorization, and canary sink boundaries.
- `s15-profile-after-new-chat`, `s16-conversation-scope`: profile recall across authorized conversations and owner/conversation scoping.
- `s17a`–`s17c`, `s17g`: fetch unsafe/5xx/redirect, analysis schema failure — safe failed state, no fabricated success.
- `s18a`–`s18c`: startup recovery of queued jobs (persisted identity, exactly once), fail-first delivery + cached-reply replay + duplicate rejection, and revoked-identity recovery skip.

Production defects found by the corpus and fixed at their owning boundaries:
`safeErrorMessage` now classifies HTTP-status fetch failures and the "not
supported" host message (S17b/S17g), with a focused regression test in
`test/minimal-v0.test.ts`.

## Layout

| Path | Purpose |
|---|---|
| `eval/scenarios/*.yaml` | Live scenario corpus (strict v1 schema). `*.yaml.staged` are excluded from live discovery/hash and can only be targeted explicitly. |
| `eval/fixtures/*.yaml` | Synthetic fixtures (strict v1 schema). |
| `eval/schemas/` | Zod v1 schemas: scenario, fixture, assertion, run artifact. Unknown keys fail validation. |
| `eval/corpus.ts` | Recursive POSIX-ordered discovery, duplicate/ID/filename checks, content-sensitive corpus hash (SHA-256 over canonical scenario + referenced-fixture JSON). |
| `eval/assertions.ts` | The 26 catalog gates (A-*) plus value operators (eq, member, count, prefix, order, path, absent). |
| `eval/redaction.ts` | Sink-aware canary scanner (NFC-normalized, recursive, fail-closed). |
| `eval/fakes/` | Scripted model (raw V3 `MastraLanguageModel`), fetch/DNS fake, collecting logger. |
| `eval/runner.ts` | Hermetic per-scenario runner: temp dir 0700, fresh libSQL DB + memory store, fixed clock/IDs, scripted turns, ledgers, state projection, redaction scan, cleanup. |
| `eval/status.ts` | passed/failed/incomplete/skipped semantics and run aggregation. |
| `eval/rubrics.ts` | The 10 quality rubrics with scoring/critical-failure manifests. |
| `eval/live-model.ts` | Harness-owned OpenAI-compatible live model (raw v3 shape) for quality replay + judge, with usage/identity/retry/cost capture. |
| `eval/pricing.ts` | Versioned pricing table (empty by default; `EVAL_PRICING` env). |
| `eval/judge.ts` | Redacted judge payload builder, evidence ledger, canary fail-closed scan, judge call + fixed retry + validation. |
| `eval/quality-cli.ts` | `eval:quality` entry point (gate → real replay → judge; budgets, metering, artifacts). |
| `eval/cli.ts` | `eval:test` entry point. |

## Scenario format

```yaml
schemaVersion: 1
id: onboarding-confirmation        # ^[a-z0-9][a-z0-9-]{2,80}$ and equals filename
kind: contract                     # contract | quality
persona: P03                       # P01..P18
fixture: onboarding-review         # must resolve in eval/fixtures/
turns:
  - id: t1
    channel: telegram
    input: { kind: text, text: "looks good" }
    actorId: "1001"                # raw principal id; must be in fixture.users to be authorized
    conversationId: "telegram:2001" # scoped id; chat id must be in fixture.chats
    expected: accepted             # accepted | rejected
    envelope: forwarded            # optional: malformed|forwarded|edited|group|bot (P11)
    timeoutMs: 10000               # optional per-turn budget; expiry = incomplete
    updateId: 9001                 # optional fixed Telegram update id (replay turns: repeat the id of the turn being replayed)
stubs: [onboarding-review-default] # optional additional fixtures (later rows win on conflicts; notification plans must agree across fixture+stubs)
assertions:                        # catalog IDs and/or value assertions
  - A-ONBOARDING-STATE
  - { id: A-JOB-STATE, path: "state.jobs", op: count, value: 0 }
tools:                             # optional A-TOOLS-EXACT expectations
  require: []
  forbid: []
  counts: { save-job: 0 }
limits: { maxTurns: 2, maxWallClockMs: 30000, maxModelCalls: 4 }
rubrics: [onboarding_discipline, conversational_quality]  # optional (#13d): declared rubrics make the scenario quality-eligible
```

Value operators: `eq` (deep equality), `member` (array contains), `count`
(array length), `prefix` (ordered prefix), `order` (partial order over event
kinds), `path` (resolves), `absent` (path missing). Paths address the run
context view: `state.*` (incl. `state.onboarding[0]` — onboarding is a list,
one row per conversation), `metrics.*`, `toolCalls`, `modelCalls`,
`lifecycle`, `replies`, `notifications`, `logs`, `redactionHits`,
`transcriptComplete`.

Turn outcomes are checked per turn as synthetic assertions
(`turn.<id>.outcome`); an accepted turn must also have produced a reply (or a
recorded simulated delivery failure). Replies are attributed to their turn.

## Fixture format

```yaml
schemaVersion: 1
id: active-profile
ownerId: career-owner-v0
users: ["1001"]                    # authorized principals (raw ids)
chats: ["2001"]                    # authorized private chats (raw ids)
clock: "2026-01-01T00:00:00Z"      # fixed clock; all persisted timestamps equal this
db:
  onboarding: [{ ownerId, conversationId, status, version, draft }]
  profiles:  [{ ownerId, name, content, active, version }]
  jobs:      [full job rows]
  reports:   [{ reportId, ownerId, jobId, content, version }]
profileText: "..."                 # overrides the active profile document
fetch:                             # real URL/DNS/redirect policy runs against this transport
  - url: "https://linkedin.com/jobs/view/1"
    dns: ["93.184.216.34"]         # private/reserved answers exercise A-SSRF-BLOCK
    redirect: { status: 301, location: "https://linkedin.com/jobs/view/2" }  # chains = plan graph
    status: 200
    contentType: "text/html"
    body: "..."
    timeout: false                 # hangs until the policy aborts
    abort: false
model:
  responses:                       # consumed in order; one per expected call
    - purpose: memory              # onboarding|analysis|chat|memory
      match: "Senior backend"      # optional prompt substring
      object: { reply: "...", draftPatch: {...}, readyForReview: false }
      text: "plain text reply"     # for chat/analysis text
      toolCalls: [{ toolName: "save-job", args: { url: "...", profileContext: "..." } }]
      usage: { inputTokens: 100, outputTokens: 20 }   # null/absent = unmetered
      throws: "provider exploded"  # simulated provider failure
      malformed: true              # invalid JSON back (schema validation failure)
notifications: [{ jobId: "job-001", deliver: "ok" }]
# deliver: ok | fail-first — a REAL delivery seam: the runtime's reply callback
# is the transport. fail-first throws on attempt 1 (simulated transport
# failure); notified_at must only be set after a successful delivery, so the
# SUT must leave it unset until the same update is replayed and delivered.
canaries:
  - { value: "CANARY_SECRET", sinks: [model] }  # allowed sinks: all|model|reply|trace|log|database|report|judge
```

Notes for `#13c` authors:

- **Memory responses are unlimited by default.** Working-memory extraction runs
  per agent turn and consumes a `memory`-purpose response; an explicit one is
  consumed first, otherwise a no-op `{}` is synthesized. Script only `memory`
  responses when the extraction content itself matters.
- **The fixture default model plan is an inert memory no-op**, never a chat
  response — a chat default polluted the scripted queue and stole
  onboarding/analysis responses (S01 regression).
- **Purpose detection checks `^Job text:` first.** Analysis prompts may contain
  the "Career onboarding profile" marker via production profile text
  (`buildOnboardingProfileText`); the specific analysis marker must win over
  the broader onboarding heuristics.
- **Production job rows use scoped identities** (`telegram:…` user/chat ids).
  Fixtures must match — an unscoped `userId` makes recovery reauth fail closed
  (S18a regression).
- **Startup recovery runs in the harness** (S18): fixture jobs in
  `queued`/`running` state are resumed via `recoverUnfinished` before the
  first turn, with tool-call identity paired from the persisted job.
- **`analyzeJob` runs inside the harness.** The save-job tool passes the owner
  resource + conversation thread to the nested analysis generate (production
  fix, 2026-08-12); a full save replay works end to end against the scripted
  model.
- **Tool calls are audited, not guessed.** `tool.invoked` log events carry the
  tool id + URL + resumeJobId; the runner derives identity from the turn and
  pairs jobId via the same-request `job.queued` lifecycle event. The ledger is
  non-destructive — exact-count gates see every call.
- **Isolation is enforced.** After every run the sandbox dir is scanned for
  files beyond the harness's own DB/memory artifacts; anything the SUT created
  is an `unexpected-file` failure (incomplete).
- **Purpose detection** is prompt-heuristic: onboarding prompts contain the
  structured draft JSON, analysis prompts start with `Job text:`, memory
  prompts say `Update working memory`. Use `match` for anything ambiguous.
- **Fetch redirect chains** are a plan graph: the plan for URL A carries one
  `redirect` to URL B, whose plan carries the next hop or the final body. The
  production policy enforces same-site and the 3-hop limit.
- **Production-caught errors are outcomes, not incompleteness.** A model throw
  during onboarding becomes the safe retry reply (P12); the run can still pass
  if that is what the scenario asserts. Uncaught errors, budget breaches,
  wall-clock timeouts, redaction hits, and adapter leaks are `incomplete`.
- **Durable `needs_input`/reply ledger seams do not exist yet** (issue #13
  decision: bound to the process). Restart-replay subcases are `incomplete`,
  never silently passed.

## Status semantics

- `passed`: replay complete, every deterministic assertion passed.
- `failed`: replay complete, ≥ 1 assertion failure (turn outcomes included).
- `incomplete`: setup/timeout/model/adapter/capture/redaction prevented a
  complete result — always with an explicit reason in the transcript.
- `skipped`: explicit filter exclusion (or `kind: quality` in the contract
  lane); never compares/pins.
- Run: passed iff all selected contract scenarios passed; failed if any failed;
  incomplete if none failed but any incomplete; skipped only if none executed.
- `eval:test` runs the contract lane only: `kind: quality` scenarios are
  skipped with a notice (quality runs land with #13d).

## Redaction

Canaries are scanned across replies, logs, database state,
model-call ledgers, and notifications. An exact (NFC-normalized) match in any
sink the canary is not classified for blocks the run (`incomplete`). Fixture
canaries that intentionally enter the model sink (injection tests) must be
declared with `sinks: [model]` — the allow-direction is real (dangling-else
regression covered in `test/eval-harness.test.ts`). Raw transcripts never
leave the machine; `eval/results/` contains only redacted aggregates.

## Self-tests

`test/eval-harness.test.ts` (runs inside plain `npm test`) covers strict
schema rejection, discovery failures, hash sensitivity, end-to-end hermetic
replay with a scripted model, isolation/cleanup, redaction fail-closed AND
the sink allow-direction, incomplete statuses, value operators, and turn
outcomes. `test/minimal-v0.test.ts` carries the production regression tests
for defects the corpus surfaced.

## Known stderr noise (benign)

- `s01`: two `Error in agent stream { error: TypeError: this[#model].doStream is
  not a function ...` lines — Mastra's internal stream path probes `doStream`;
  the scripted model implements `doGenerate` only. Runs pass.
- `s17c`: one `STRUCTURED_OUTPUT_SCHEMA_VALIDATION_FAILED` — the expected
  reaction to the scenario's injected malformed analysis response; `A-SAFE-ERROR`
  asserts the safe-failure contract it exercises.

Both are harmless; exit codes stay 0.
