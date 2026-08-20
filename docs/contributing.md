# Contributing

Keep implementation changes at the owning boundary, preserve the security invariants, and add focused regression coverage for non-trivial behavior.

## Required checks

```bash
npm test
npm exec tsc -- --noEmit
npm run build
npm run eval:test
git diff --check
```

Tests use Node's built-in test runner and TypeScript type stripping. They must not call paid models, Telegram, Google, or live job sites. Inject boundary fakes instead. Every feature change should include an evaluation scenario when the behavior belongs in the contract harness; see the [evaluation harness guide](eval-harness-guide.md).

## Change the correct boundary

| Change | Primary location |
|---|---|
| Mastra registration and dependency wiring | `src/mastra/index.ts` |
| Agent behavior, memory, tools, and analysis | `src/agents/agent.ts` |
| Telegram envelope authorization | `src/channels/telegram-auth.ts` |
| Telegram polling, delivery, and file download | `src/channels/telegram-transport.ts` |
| Command mapping, onboarding, serialization, and recovery | `src/services/career-runtime.ts` |
| Discovery workflow and site processing | `src/mastra/workflows/`, `src/discovery/` |
| Browser/CDP policy | `src/browser/` |
| Trusted tool context | `src/tools/career-context.ts` |
| Save orchestration and retry boundaries | `src/tools/save-job-tool.ts` |
| Supported hosts and URL syntax | `src/tools/job-url.ts` |
| DNS, SSRF, redirects, and response limits | `src/tools/web-fetch-tool.ts` |
| Jobs, reports, profiles, onboarding, and discovery state | `src/storage/career-store.ts` |
| Runtime environment validation | `src/config/runtime.ts` |
| Trace redaction/export | `src/observability.ts` |
| Persisted schemas and safe errors | `src/contracts/` |
| Acceptance and regression coverage | `test/`, `eval/` |

Do not add a generic repository layer, queue framework, workflow abstraction, or second implementation for hypothetical future use.

## Security invariants

1. Authorize before agent, browser, file, or network execution.
2. Issue trusted identity context server-side; never accept it from client payloads.
3. Scope memory and job reads to the configured owner and conversation.
4. Reauthorize persisted recovery identity against current configuration.
5. Keep URLs and redirects HTTPS and within the supported-site policy.
6. Resolve DNS and reject private, reserved, link-local, metadata, and invalid targets.
7. Treat fetched pages as untrusted data, never as instructions.
8. Keep profile, reports, databases, and traces private by default.
9. Persist completion and reports before notification; notification failure cannot erase work.
10. Keep logs, traces, persisted errors, and replies free of secrets and raw fetched/resume content.
11. Keep browser actions read-only: no typing, form submission, scripts, or site mutation.
12. Keep resume ingestion bounded, redacted before model access, and revalidated before persistence.

Adding an ingress is an authentication/authorization change. Adding a site is a security-policy change and requires redirect/DNS tests. Changing persistence requires recovery and existing-database tests.

## Mastra API discipline

Mastra APIs change quickly. Before modifying Mastra code:

1. Inspect exact installed versions in `package.json`.
2. Read installed docs under `node_modules/@mastra/*/dist/docs/`.
3. Inspect installed declarations/source when docs are incomplete.
4. Use remote documentation only after installed evidence.
5. Run typecheck, tests, build, and the evaluation harness.

Use the npm scripts rather than invoking the underlying Mastra commands directly. Register all agents, workflows, and scorers from `src/mastra/index.ts`.

## Coding-agent checklist

- Read the repository instructions and the relevant skill before editing.
- Check `git status` and preserve unrelated work.
- Use the code-review graph before broad search when analyzing cross-cutting changes.
- Distinguish shipped code from specs and deferred roadmap items.
- Make the smallest boundary-correct change.
- Add one focused regression check for non-trivial logic.
- Run all required checks and update the relevant docs.
