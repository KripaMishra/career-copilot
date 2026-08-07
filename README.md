# Career Copilot V0

A local, single-owner conversational Career Copilot built around one Mastra agent with persistent memory and tools:

```text
conversation or /save → profile context → bounded fetch → structured analysis → atomic report → verified Sheets row
```

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `MASTRA_DATABASE_URL` as an absolute local `file:` URL, owner identity, Telegram allowlists, profile/report paths, model credentials, and Google Sheets OAuth/target values. The tracker header row must contain unique `Job ID`, `Status`, `Title`, `Company`, and `Report Path` columns; extra columns are preserved. Never commit `.env` or profile data. Direct fetch is the only V0 acquisition path; browser acquisition is intentionally deferred.

Every authorized private-chat message goes to the same agent and memory thread. `/save <url>` is a prompt shortcut, not a separate execution path; requests such as “save this job” can invoke the same tool. `/job [job-id]` and `/queue` are conversational shortcuts for the agent's status tools. Telegram is one ingress adapter, not a tool dependency.

When the agent asks for personal context, reply normally in Telegram—do not use another slash command. It remembers profile facts and continues the pending save. You may also place owner-only `.md` or `.txt` profile files in `CAREER_COPILOT_PROFILE_DIR`; those are loaded at startup as baseline context. Never send credentials or secrets as profile data.

## Storage and recovery

Application state is one `career_jobs` table in the local career database. Mastra stores conversation history and resource-scoped working memory in the configured local Mastra database; the data directory is forced to owner-only permissions because it contains personal context. Reports are owner-readable files under the configured report root; filenames are job-derived and writes use temp-file/atomic-rename. Sheets rows are keyed by immutable job ID and read back after writes. Automatic processing retries are bounded; ambiguous Sheet writes are read back and never blindly retried. Retry a terminal failed job with a new save request; transport-event deduplication prevents replay of one update, not a new owner request. Completion is stored before Telegram notification, with `notifiedAt`; restart retries one unsent completed result. `/job` remains authoritative.

Existing databases are never deleted or reset automatically. Back up/export the local database and report root manually before an intentional owner reset. Telegram messages and Sheets rows require their provider's own deletion procedures.

## Security bounds

Only HTTPS URLs on the explicit supported-host allowlist are accepted. Every redirect is revalidated; credentials, non-default ports, localhost, private/link-local/reserved addresses, DNS failures, unsupported content types, timeouts, oversized decoded bodies, and overlong model input are rejected. Logs and user-visible errors contain safe summaries only.

Career tools require a trusted, server-created context containing an authenticated actor, conversation, and request ID. Telegram maps its authenticated update to that context. Future stdio or API adapters must authenticate their caller and create the same context at the ingress boundary; clients must never supply it themselves. Mastra Studio has no authenticated Career Copilot ingress, so its direct tool calls are intentionally denied.

## Observability

The dev terminal emits safe lifecycle events without message text, URLs, profile data, credentials, or fetched pages:

- `telegram.poll.*` and `telegram.update.*` show whether Telegram polling received, rejected, or failed an update.
- `job.queued`, `job.started`, `job.succeeded`, and `job.failed` follow work by job ID.
- `recovery.*` and `startup.*` show whether polling was allowed to start.

Open Mastra Studio at `http://localhost:4111`, then use **Observability → Traces** to inspect agent and tool spans, model calls, status, and duration. Trace inputs, outputs, and error payloads are redacted before local persistence. Metrics are intentionally not configured. For user-visible state, `/job <job-id>` is authoritative and `/queue` lists current jobs.

If the agent does not answer, inspect `telegram.update.handled` or `telegram.poll.failed`. A save is durable once `job.queued` appears; correlate later terminal and Studio events using that job ID.

## Development checks

```bash
npm test
npm exec tsc -- --noEmit
npm run build
```

`npm run build` creates disposable `.mastra/` output; it is not source data and should not be committed.

## Layout

```text
src/agents/          one conversational memory-enabled Career Copilot agent
src/channels/        Telegram identity and authorization checks
src/config/          local runtime configuration
src/contracts/       minimal Job/Analysis/Result schemas
src/integrations/    atomic reports and Sheets boundary
src/services/        Telegram prompt shortcuts and serialized agent turns
src/storage/         one career_jobs table
src/tools/           deterministic save tool, URL validation, and bounded direct fetch
test/                compact V0 acceptance checks
```
