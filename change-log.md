# Change Log

This log summarizes pull requests from #19 through the current PR merged into `master`. Entries describe the shipped product or engineering outcome, not individual file changes.

## 2026-08-20 — [PR #26](https://github.com/KripaMishra/career-copilot/pull/26)

### Scheduled multi-site job discovery

Added a daily code-driven `jobDiscovery` workflow (12:00 PM owner-timezone, guarded read-only browser, strict site order, durable run lease with crash expiry) that persists per-site state and sends one digest. New `/discovery` control commands and `/explore_jobs` on-demand search auto-save qualifying roles through the existing evidence pipeline. Blocked sites fail closed with redacted evidence; qualification is model-reasoned against the canonical profile with no fixed thresholds.

## 2026-08-20 — [PR #25](https://github.com/KripaMishra/career-copilot/pull/25)

### Guarded browser integration MVP

Added a single read-only `browser_read` tool over a shared authenticated Chrome via CDP, with a global mutex, site allowlist, failure classification (transient/blocked/forbidden), bounded connect retry, and redacted evidence. The full AgentBrowser toolset is never exposed to the agent; unsupported hosts and blocked sites fail closed with no bypass and no auto-retry, and no credentials or CDP data are written.

## 2026-08-19 — [PR #23](https://github.com/KripaMishra/career-copilot/pull/23)

### Onboarding workflow commands and ignore cleanup

Registered the onboarding workflow slash-command aliases and tidied `.gitignore` (closes issue #22). Small integration PR; no behavioral change to existing flows.

## 2026-08-18 — [PR #21](https://github.com/KripaMishra/career-copilot/pull/21)

### Evaluation quality lane with cross-family judge

Added `npm run eval:quality` on top of the deterministic contract harness: per-scenario contract gate, then a cross-family model judge applying rubrics (onboarding discipline, conversational quality, and the rest of the evaluation matrix). Supports scenario IDs, `--allow-unmetered`, and `--keep-artifacts`.

## 2026-08-18 — [PR #20](https://github.com/KripaMishra/career-copilot/pull/20)

### Recent-merges changelog

Introduced this change log (`change-log.md`) to summarize shipped PR outcomes — the document you are reading.

## 2026-08-18 — [PR #19](https://github.com/KripaMishra/career-copilot/pull/19)

### Bounded resume ingestion and PII protection

Added bounded PDF resume ingestion with fail-closed PII redaction, readiness gating, optional Presidio analysis, persistence revalidation, and canary evaluation coverage. Resume downloads and extraction are capped, raw resume data is kept out of downstream agent and storage paths, and unsafe or unavailable processing returns safe user-facing failures.
