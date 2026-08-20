# Documentation

Use the project README for the product overview and first-run setup. Use these guides for the detailed current behavior.

## Start here

- [Project README](../README.md)
- [Architecture](architecture.md)
- [Operations and troubleshooting](operations.md)
- [Contributing](contributing.md)
- [Roadmap](roadmap.md)

## Specifications and technical reports

- [Onboarding and PII redaction](specs/onboarding-pii-redaction.md)
- [Evaluation harness guide](eval-harness-guide.md)
- [Evaluation harness seams](specs/eval-harness-seams.md)

## Source entry points

- [`src/mastra/index.ts`](../src/mastra/index.ts) — composition root and Mastra registration
- [`src/services/career-runtime.ts`](../src/services/career-runtime.ts) — Telegram routing, onboarding, and recovery
- [`src/discovery/`](../src/discovery/) — scheduled and on-demand discovery
- [`src/storage/career-store.ts`](../src/storage/career-store.ts) — durable application state
