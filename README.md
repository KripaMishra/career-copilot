# Career Copilot V0

A local, single-owner job saver built with Mastra. One process runs one `saveJobWorkflow` at a time:

```text
/save <HTTPS job URL> → bounded fetch → one structured analysis → atomic report → verified Sheets row
```

## Run

```bash
npm install
cp .env.example .env
npm run dev
```

Configure `MASTRA_DATABASE_URL` as an absolute local `file:` URL, owner identity, Telegram allowlists, profile/report paths, model credentials, and Google Sheets OAuth/target values. Never commit `.env` or profile data. Direct fetch is the only V0 acquisition path; browser acquisition is intentionally deferred.

Commands are deterministic and private-chat owner-only:

- `/save <url>` accepts work and returns a job ID.
- `/job [job-id]` reads authoritative status/result.
- `/queue` lists jobs.

The primary agent is free-form and read-only. It cannot enqueue jobs or write reports/Sheets.

## Storage and recovery

Application state is one `career_jobs` table in the local career database. Mastra owns workflow snapshots separately. Reports are owner-readable files under the configured report root; filenames are job-derived and writes use temp-file/atomic-rename. Sheets rows are keyed by immutable job ID and read back after writes. Automatic processing retries are bounded; ambiguous Sheet writes are read back and never blindly retried. Retry a terminal failed job by sending a new `/save <url>` command; transport-event deduplication prevents replay of one update, not a new owner command. Completion is stored before Telegram notification, with `notifiedAt`; restart retries one unsent completed result. `/job` remains authoritative.

Existing databases are never deleted or reset automatically. Back up/export the local database and report root manually before an intentional owner reset. Telegram messages and Sheets rows require their provider's own deletion procedures.

## Security bounds

Only HTTPS URLs on the explicit supported-host allowlist are accepted. Every redirect is revalidated; credentials, non-default ports, localhost, private/link-local/reserved addresses, DNS failures, unsupported content types, timeouts, oversized decoded bodies, and overlong model input are rejected. Logs and user-visible errors contain safe summaries only.

## Development checks

```bash
npm test
npm exec tsc -- --noEmit
npm run build
```

`npm run build` creates disposable `.mastra/` output; it is not source data and should not be committed.

## Layout

```text
src/agents/          primary and structured analysis agents
src/channels/        Telegram identity and authorization checks
src/config/          local runtime configuration
src/contracts/       minimal Job/Analysis/Result schemas
src/integrations/    atomic reports and Sheets boundary
src/services/        deterministic commands and one-process runtime
src/storage/         one career_jobs table
src/tools/           URL validation and bounded direct fetch
src/workflows/       registered saveJobWorkflow
test/                compact V0 acceptance checks
```
