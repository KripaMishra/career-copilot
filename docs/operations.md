# Operations

The README covers first-run setup. This guide contains complete configuration, deployment, recovery, browser, logging, and troubleshooting details.

## Prerequisites and installation

Use Node.js `>=22.13.0`, npm, a Telegram bot token, one private user ID, one private chat ID, and credentials for the selected model provider. The repository uses `package-lock.json`.

```bash
npm install
cp .env.example .env
```

Use `npm run dev`, `npm run build`, and `npm start`; these scripts are the supported interface to Mastra's CLI.

## Local database

Create an owner-only data directory and configure one absolute file URL:

```bash
mkdir -p "$HOME/.local/share/career-copilot"
chmod 700 "$HOME/.local/share/career-copilot"
```

```dotenv
MASTRA_DATA_DIR=/home/you/.local/share/career-copilot
MASTRA_DATABASE_URL=file:/home/you/.local/share/career-copilot/career-copilot.db
```

Local file URLs must remain inside `MASTRA_DATA_DIR` and must not use `TURSO_AUTH_TOKEN`. Mastra memory, traces, jobs, reports, profile documents, onboarding state, and discovery state share this database.

## Production Turso

Create a database and token with the Turso CLI, then provide only the deployment values:

```bash
turso db create career-copilot
turso db show --url career-copilot
turso db tokens create career-copilot
```

```dotenv
MASTRA_DATABASE_URL=libsql://your-db-your-org.turso.io
TURSO_AUTH_TOKEN=replace-me
```

Remote URLs must be Turso `*.turso.io` hosts without credentials, query strings, or fragments. Production requires the owner, Telegram, and remote database settings. Store tokens only in deployment configuration.

## Runtime configuration

Required owner and Telegram settings:

```dotenv
CAREER_COPILOT_OWNER_RESOURCE_ID=career-owner-v0
CAREER_COPILOT_OWNER_ENABLED=true
TELEGRAM_BOT_TOKEN=replace-me
TELEGRAM_ALLOWED_USER_IDS=123456789
CAREER_COPILOT_PRIVATE_CHAT_IDS=123456789
```

Model settings:

```dotenv
CAREER_COPILOT_MODEL=opencode-go/deepseek-v4-flash
CAREER_COPILOT_MEMORY_MODEL=opencode-go/deepseek-v4-flash
OPENCODE_API_KEY=replace-me
GOOGLE_GENERATIVE_AI_API_KEY=replace-me
```

`CAREER_COPILOT_MEMORY_MODEL` controls the Observational Memory observer/reflector and falls back to the main model. `CAREER_COPILOT_OWNER_ENABLED=false` disables Telegram authorization and recovery delivery. Production currently requires exactly one allowed user and one private chat; development accepts comma-separated numeric IDs.

PII and resume ingestion are disabled unless readiness is configured:

```dotenv
PII_ENABLED=false
PII_PRESIDIO_URL=
PII_PATTERNS=
PII_ANONYMIZE_FORMAT=type
PII_MAX_INPUT_CHARS=200000
PII_READINESS=true
```

The local deterministic engine has zero network egress. `PII_PRESIDIO_URL` opts into the remote Presidio adapter, including NER for names/addresses. Invalid boolean values fail startup; ingestion remains fail-closed when the service is disabled or not ready.

Optional browser and host policy settings:

```dotenv
BROWSER_CDP_URL=http://127.0.0.1:9222
CAREER_COPILOT_ALLOW_ALL_JOB_SITES=false
```

`BROWSER_CDP_URL` points to an externally launched authenticated Chrome with remote debugging enabled. No local Chromium is installed or persisted by Career Copilot. Without it, discovery fails closed. `CAREER_COPILOT_ALLOW_ALL_JOB_SITES=true` relaxes the direct host allowlist but retains HTTPS, credential/port/fragment, DNS, redirect, and fetch controls.

Keep `.env`, `.local-data/`, `.mastra/`, and generated outputs untracked.

## Run and build

```bash
npm run dev
```

Studio runs at `http://localhost:4111`. For production:

```bash
npm run build
NODE_ENV=production npm start
```

The build output in `.mastra/` is disposable and is not source data.

## Browser and discovery operations

Launch an authenticated Chrome profile with CDP enabled, set `BROWSER_CDP_URL`, and restart the app. Discovery uses the browser only for bounded read-only navigation and accessibility snapshots.

The daily schedule is registered idempotently as `0 12 * * *` in the onboarding-captured timezone, falling back to `Asia/Kolkata`. Use:

```text
/discovery status
/discovery on
/discovery off
/explore_jobs
/explore_jobs "platform engineer"
```

A scheduled run reads LinkedIn, Foundit, Cutshort, Naukri, and Indeed in that order. A site blocked by authentication, CAPTCHA, MFA, consent, redirect, timeout, or DOM ambiguity is reported and does not stop other sites. An overlapping scheduled run is skipped; a stale lease older than 48 hours is expired. `/explore_jobs` uses a non-lease pass and can run independently.

For a development-only immediate scheduled run:

```bash
node --experimental-strip-types -e "const m = await import('./src/mastra/index.ts'); await m.triggerDiscoveryRun();"
```

This is not a Telegram command.

## Recovery and data safety

Recovery runs before Telegram polling. It reauthorizes persisted identity against current allowlists, resumes interrupted `queued`/`running` jobs, and retries successful jobs that have no `notified_at`. A notification failure does not roll back completed work.

The current schema is authoritative and has no migration path from obsolete local databases. Before first use of a version that changed the schema, stop the process and remove old development databases such as `.local-data/mastra.db` and `.local-data/career.db`. Obsolete `.local-data/reports/*.md` files are not used by production storage.

Do not edit durable rows manually. Inspect a backup or stop the process before investigating recovery-sensitive state. `/reset` commands operate only on the documented CareerStore scope; conversation history and Task Tool state remain preserved.

Automatic backup, retention, export, purge, and external monitoring are not implemented.

## Logs and Studio

Watch `npm run dev` for one-line JSON events. Useful event families include startup, Telegram polling, commands, agent/tools, jobs, recovery, notifications, onboarding, and discovery. Empty polls and intentional stop aborts are intentionally quiet.

Use generated job IDs to correlate terminal events with Studio traces. Logs and trace payloads intentionally omit owner/chat identities, messages, URLs, profile/resume text, fetched pages, reports, credentials, and raw errors.

## Troubleshooting

| Symptom | Check |
|---|---|
| Bot does not respond | `telegram.poll.started`, token, user allowlist, and private-chat allowlist. |
| Update is rejected | `telegram.update.handled` reason; malformed, edited, forwarded, bot, channel, replayed, and non-private updates are rejected. |
| Agent asks for context | Complete onboarding or provide career facts; an active profile is required for meaningful save analysis. |
| Studio tool call is unauthorized | Expected: Studio is not an authenticated Career Copilot ingress. |
| URL is rejected | HTTPS, supported host, no credentials/port/fragment, public DNS, and same-site redirects. |
| Discovery saves nothing | Configure `BROWSER_CDP_URL`, confirm the authenticated browser can read the site, and inspect the per-site digest outcome. |
| Fetch fails | Content type, 15-second timeout, 1 MB body limit, redirects, DNS policy, or remote HTTP status. |
| Resume is rejected | Confirm active onboarding, PDF MIME/name/signature, PII readiness, text extraction, and size/page/time bounds. |
| Notification fails after success | `/job` remains authoritative; restart retries a successful row without `notified_at`. |
| Production startup fails | Check all required owner, Telegram, model, and Turso values. |
| Database path is rejected | Use an absolute local `file:` URL inside `MASTRA_DATA_DIR`, or a valid Turso remote with token. |

For architecture and security boundaries, see [Architecture](architecture.md).
