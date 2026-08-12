# Career Copilot Evaluation Harness — Seam & Decision Report

Status: verified against installed dependencies (2026-08-12). This is the contract for the
S01–S18 corpus work (#13c): every seam named here was exercised or type-checked against the
installed Mastra/Node versions, and every gap is a deliberate, documented boundary.

Canonical requirements: GitHub issue #13 (KripaMishra/career-copilot). Vault plan:
`Projects/mastra-demo/plans/implementation/2026-08-10 Career Copilot Evaluation Harness Plan.md`.

## Verified seams (present in production code)

| Concern | Seam | Location |
|---|---|---|
| Narrow runtime constructor | `createCareerCopilotRuntime(options)` accepts `store`, `respond`, `onboard`, `logger` directly; no DB/network/model construction when injected | `src/services/career-runtime.ts` |
| Agent generation | `createAgentResponder(agent, ownerId, logger)` — `agent` is a structural `{ generate }`; a scripted responder can stand in for the Mastra agent | `src/services/career-runtime.ts` |
| Agent kit model injection | `createCareerAgentKit({ model?: MastraModelConfig, memoryModel?: MastraModelConfig })` — Mastra `Agent({ model })` and observational memory both accept a `LanguageModel` object (`MastraModelConfig = ... \| MastraLanguageModel`), so a scripted fake can be injected with zero network. **Added 2026-08-10.** | `src/agents/agent.ts`, `@mastra/core/llm` types |
| Memory storage | `createCareerAgentKit({ storage?: MastraStorage })` — `Memory` REQUIRES a storage provider when used outside a Mastra instance (the production composition root injects one via `MastraCompositeStore`; the kit alone would throw `Memory requires a storage provider`). The harness passes a `LibSQLStore` on a separate temp file. **Added 2026-08-11.** | `src/agents/agent.ts`, `@mastra/libsql` |
| Deterministic job IDs | `createCareerAgentKit({ uuid?: () => string })` flows into save-job tool (jobId) and `executeSaveJob` (mastraRunId). **Added 2026-08-10.** | `src/agents/agent.ts`, `src/tools/save-job-tool.ts` |
| Fixed clock | `new CareerStore(url, { clock?: () => number })` — every persisted timestamp (`career_jobs`, `career_reports`, `career_profile_documents`, `career_onboarding`) routes through the injected clock; defaults to `Date.now`. **Added 2026-08-10.** | `src/storage/career-store.ts` |
| Fetch/DNS/redirect policy | `acquireJobText(url, { fetch?, resolve?, maxDecodedBytes?, timeoutMs? })` — injectable `fetch` (redirect:'manual') and DNS `resolve`; real policy code (blocklists, redirect limits, content-type gate, size limit) still runs. Also injectable wholesale via `SaveJobDeps.acquire`. | `src/tools/web-fetch-tool.ts` |
| Sheets boundary | `SheetAdapter = { findByJobId, write }` (`upsertSheetRow` adapter). Fake replaces Google HTTP entirely. | `src/integrations/google-sheets.ts` |
| Notification/reply capture | Runtime takes `reply(text)` per update; `recoverUnfinished(reply)` takes reply+sendMessage. The harness's `reply` is a real delivery seam: it attributes each delivery to the job it notifies and honors the fixture `notifications` plan (`ok` / `fail-first`), recording delivered/failed attempts. | `src/services/career-runtime.ts`, `eval/runner.ts` |
| Logger | `AppLogger = (level, event, data?) => void`; terminal logger already accepts `now` + output. A collector fake implements the same type. | `src/observability.ts` |
| Telegram envelope validation | `assertRawTelegramUpdate(raw)` + `deriveTelegramRequest(raw)` — pure functions over raw updates; unauthorized/malformed paths are testable without transport. | `src/channels/telegram-auth.ts` |
| Request identity for tools | `createCareerToolContext({ ownerId, actorId, conversationId, requestId, resumeJobId? })` — tools read identity + capability from `requestContext`; forged/missing capability yields no tools (`parseToolContext`). | `src/tools/career-context.ts` |

## Confirmed no-live-call path for contract mode

- Mastra `Agent` + `Memory` observational model both accept injected `MastraLanguageModel` objects
  (verified in `@mastra/core/llm/model/shared.types.d.ts` and `@mastra/memory/.../observational-memory/types.d.ts`).
  Contract runs must pass the fake model for BOTH the agent and `memoryModel`.
- `analyzeJob(agent, ...)` routes through `agent.generate` → fake model. **Fixed 2026-08-12:**
  the nested analysis generate previously ran without a thread, so the ObservationalMemory input
  processor threw `requires a threadId` before the model was called — every save-path scenario
  (S07/S09–S12/S17/S18) would have been blocked. The save-job tool now passes
  `memory: { resource: ownerId, thread: conversationId }` to `analyzeJob` (a production fix the
  harness exposed; the top-level responder already passed the same shape). Covered by the
  `full save replay` harness test.
- Working-memory extraction uses the agent model → fake. Its prompt says
  "Update working memory … observations you made" — the fake's purpose
  detection keys on that exact phrasing because the agent's system instructions
  also contain the words "working memory".
- Working-memory extraction runs per agent turn and is served by an unlimited
  scripted default (`{}`, a no-op for the markdown template) unless a fixture
  scripts a `memory`-purpose response.
- Tool-call audit: `tool.invoked` log events now carry `url` (+ `resumeJobId` on recovery);
  the harness derives identity from the turn and pairs `jobId` via the same-request
  `job.queued`/`job.started` lifecycle event. The production terminal logger still filters
  these keys out (`safeAppLogKeys`) — URL-free logs are unchanged; only the harness
  collector sees them (A-LOG-ALLOWLIST special-cases the audit event).
- `@mastra/core/test-utils/llm-mock` exists as a reference for a compliant fake; the harness ships
  its own scripted fake (ledger + purpose-keyed responses + usage metadata) because we need
  deterministic structured outputs per scenario.

## Documented gaps (seams that do NOT exist — record `null`, never zero)

| Gap | Handling |
|---|---|
| Provider token/cost/usage metering | `MastraLanguageModel` receives `LanguageModelV2..V4CallOptions`; a fake can return `usage` in `doGenerate`. Production (real provider) usage is NOT surfaced by current code. Harness records `usage: null` when unavailable; quality lane requires `--allow-unmetered` to complete, never to pin. |
| Peak RSS | Not sampled anywhere. Harness instrumentation seam: sample `process.memoryUsage().rss` per scenario (`metrics.peakRssBytes`); no pass/fail threshold claimed until sampling exists. |
| Durable pending-save (`needs_input`) | DB schema has `status='needs_input'` and `career_jobs` is durable, but the runtime/agent never persists a pending save (URL lives in process-local agent working memory). **Decision: bound to the process/thread.** Restart subcases (S09 restart, S18 post-restart replay) are `incomplete`, never silently passed. |
| Durable request/result ledger for post-restart onboarding/reply replay | Same-process replay is supported (runtime `cachedReplies` + `seenUpdates`; scenario turns may pin `updateId` to replay an undelivered update); post-restart reply replay is `incomplete` until a ledger seam exists. |
| Conversational confirmed-profile recall | `profileText()` store seam exists for save-job; conversational recall of the confirmed profile in a NEW conversation needs an explicit current-profile injection seam → staged expected-failure (S15 subcase). |
| Open file handles in the sandbox | The runner scans for unexpected files after every run; handle-level liveness is not inspected (no portable seam). |

## Harness-owned decisions (from issue #13, no open product question)

- Harness-owned judge, NOT Mastra-native scoring: contract lane is deterministic; quality lane is a
  manual cross-family structured judge. `src/mastra/index.ts` is never imported by the harness
  (side-effectful composition root).
- Provider/model revisions + pricing table for quality lane: recorded in run manifest; pinning
  refuses when absent. Concrete judge family selection is deferred to #13d.
- `npm test` stays the implementation-contract suite; `eval:test` is the corpus/gate suite.
- Clock fixed at `2026-01-01T00:00:00Z`; IDs explicit in fixtures, never generated in assertions.

## Verification of this report

- `npm exec tsc -- --noEmit` green.
- `npm test` green (92 tests) after the 2026-08-12 review fixes: full save replay
  (analyzeJob + tool ledger + fail-first delivery), SSRF block capture, per-turn
  timeout, stub-merge conflicts, fixture-sensitive corpus hash.
- Deliverable committed on `feat/evals`; `manifest.sourceRevision` records a
  working-tree hash when the tree is dirty.
- Type evidence: `MastraModelConfig` (incl. `MastraLanguageModel`) exported from `@mastra/core/llm`;
  `MemoryObservationalMemoryOptions.model` accepts `ObservationalMemoryConfig['model']` which is
  `Exclude<AgentConfig['model'], undefined> | ModelByInputTokens` (LanguageModel instance allowed).
