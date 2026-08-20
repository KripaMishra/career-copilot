# Roadmap

This page contains future work only. Shipped behavior belongs in the [README](../README.md) and [Architecture](architecture.md).

Every item requires a written contract, focused regression coverage, and updated operational/privacy documentation before implementation.

## Onboarding and documents

- [ ] Support additional safe document formats such as DOCX and images after defining parser, size, metadata, and redaction boundaries.
- [ ] Add OCR for scanned/image-only PDFs only after a bounded, privacy-preserving implementation is proven.
- [ ] Add CSV import with explicit schema, validation, owner scoping, and PII handling.

## Applications and browser actions

- [ ] Add browser-assisted application review without silently submitting anything.
- [ ] If automatic applications are ever introduced, define explicit user confirmation, site-specific authorization, auditability, failure recovery, and a no-bypass policy first.
- [ ] Keep browser navigation, typing, script execution, and form submission separate capabilities; the current browser remains read-only.

## Runtime scale and ingress

- [ ] Support multiple owners with isolated configuration, memory, jobs, profiles, and Telegram authorization.
- [ ] Support multiple runtime instances and distributed coordination/leases.
- [ ] Move long-running or scheduled work behind a general worker/queue architecture where the operational model justifies it.
- [ ] Add an authenticated HTTP or stdio ingress that issues the same trusted request context as Telegram.

## Operations and lifecycle

- [ ] Add scheduled backup and restore procedures for the libSQL/Turso database.
- [ ] Define retention, export, and purge operations for jobs, reports, profile data, memory, and traces.
- [ ] Add external monitoring and alerting without leaking private content.
- [ ] Complete live Turso cutover/export automation and revisit binary artifact storage if text rows are no longer sufficient.

## Conversation and memory

- [ ] Debounce rapid messages per conversation without reordering them or weakening replay/authentication guarantees.
- [ ] Expose safe user-facing activity states such as typing, reading, navigating, and waiting through Telegram.
- [ ] Define a richer compiled owner-scoped career memory with provenance, conflict correction, retention, export, purge, and model-write rules.

## Acquisition and artifacts

- [ ] Add policy-compliant acquisition fallbacks such as self-hosted SearXNG or Firecrawl while preserving supported-site policy, SSRF/redirect controls, attribution, terms, privacy, and deterministic failure reasons.
- [ ] Make persisted report recall user-facing through an owner-authorized summary/full-Markdown command or tool.
