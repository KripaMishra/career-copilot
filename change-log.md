# Change Log

This log summarizes the five most recent pull requests merged into `master`. Entries describe the shipped product or engineering outcome, not individual file changes.

## 2026-08-20 — [PR #26](https://github.com/KripaMishra/career-copilot/pull/26)

### Scheduled multi-site job discovery

Added a daily code-driven `jobDiscovery` workflow (12:00 PM owner-timezone, guarded read-only browser, strict site order, durable run lease with crash expiry) that persists per-site state and sends one digest. New `/discovery` control commands and `/explore_jobs` on-demand search auto-save qualifying roles through the existing evidence pipeline. Blocked sites fail closed with redacted evidence; qualification is model-reasoned against the canonical profile with no fixed thresholds.

## 2026-08-20 — [PR #25](https://github.com/KripaMishra/career-copilot/pull/25)

### Guarded browser integration MVP

Added a single read-only `browser_read` tool over a shared authenticated Chrome via CDP, with a global mutex, site allowlist, failure classification (transient/blocked/forbidden), bounded connect retry, and redacted evidence. The full AgentBrowser toolset is never exposed to the agent; unsupported hosts and blocked sites fail closed with no bypass and no auto-retry, and no credentials or CDP data are written.

## 2026-08-18 — [PR #19](https://github.com/KripaMishra/career-copilot/pull/19)

### Bounded resume ingestion and PII protection

Added bounded PDF resume ingestion with fail-closed PII redaction, readiness gating, optional Presidio analysis, persistence revalidation, and canary evaluation coverage. Resume downloads and extraction are capped, raw resume data is kept out of downstream agent and storage paths, and unsafe or unavailable processing returns safe user-facing failures.

## 2026-08-15 — [PR #17](https://github.com/KripaMishra/career-copilot/pull/17)

### DB-only storage and reliable report delivery

Moved the application to a database-only persistence model with transactional job completion, exact persisted-report delivery, canonical profile retrieval, and removal of the Google Sheets and legacy import surfaces. The save and recovery paths now use durable report state as their source of truth.

## 2026-08-12 — [PR #15](https://github.com/KripaMishra/career-copilot/pull/15)

### Deterministic evaluation and replay coverage

Strengthened the evaluation harness so it proves tool-call behavior, save-path replay, notification delivery, recovery, timeout handling, fixture isolation, and privacy/security assertions. Contract scenarios now exercise the important runtime boundaries without relying on live providers or network access.