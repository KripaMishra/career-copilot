# Change Log

This log summarizes the five most recent pull requests merged into `master`. Entries describe the shipped product or engineering outcome, not individual file changes.

## 2026-08-18 — [PR #19](https://github.com/KripaMishra/career-copilot/pull/19)

### Bounded resume ingestion and PII protection

Added bounded PDF resume ingestion with fail-closed PII redaction, readiness gating, optional Presidio analysis, persistence revalidation, and canary evaluation coverage. Resume downloads and extraction are capped, raw resume data is kept out of downstream agent and storage paths, and unsafe or unavailable processing returns safe user-facing failures.

## 2026-08-15 — [PR #17](https://github.com/KripaMishra/career-copilot/pull/17)

### DB-only storage and reliable report delivery

Moved the application to a database-only persistence model with transactional job completion, exact persisted-report delivery, canonical profile retrieval, and removal of the Google Sheets and legacy import surfaces. The save and recovery paths now use durable report state as their source of truth.

## 2026-08-12 — [PR #15](https://github.com/KripaMishra/career-copilot/pull/15)

### Deterministic evaluation and replay coverage

Strengthened the evaluation harness so it proves tool-call behavior, save-path replay, notification delivery, recovery, timeout handling, fixture isolation, and privacy/security assertions. Contract scenarios now exercise the important runtime boundaries without relying on live providers or network access.

## 2026-08-10 — [PR #14](https://github.com/KripaMishra/career-copilot/pull/14)

### Guided onboarding and profile activation

Shipped the guided onboarding flow as a separate stateful path from normal agent conversations. It supports structured career-draft collection, review and explicit confirmation, optimistic persistence, cancellation and restart, and activation of a versioned canonical profile.

## 2026-08-09 — [PR #12](https://github.com/KripaMishra/career-copilot/pull/12)

### PII integration roadmap update

Updated the privacy roadmap and onboarding specification to use the separately published `mastra-pii` package for future resume redaction. This PR established the integration direction and fail-closed requirements; the bounded resume implementation shipped later in PR #19.
