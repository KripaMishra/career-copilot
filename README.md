# Career Copilot

Career Copilot is a personal job-search assistant built with Mastra. It helps turn a job-search workflow into a repeatable, reviewable process: find relevant roles, prepare application materials, and keep work inside an approval-controlled local workspace.

> **Status:** active V0 implementation. Direct Telegram job review, Google Sheets tracking, local OAuth bootstrap, durable idempotency, guarded local profile/report/topic boundaries, and automated boundary tests are in place. Browser-assisted discovery and application submission remain later V0 slices.

## What it does today

- Runs a **Career Copilot** Mastra agent with persistent memory.
- Uses a local `workspace/` directory for agent-created files.
- Requires approval before workspace writes, edits, deletes, or command execution.
- Fetches web pages with URL validation and response-size limits.
- Starts and pauses recurring agent schedules.
- Persists memory, tasks, and schedules in libSQL/SQLite.
- Records observability data in DuckDB and filters sensitive span output.
- Supports OpenCode model inference and Google web search.
- Keeps runtime data outside the source tree by default.

The project intentionally does not invent qualifications or submit irreversible applications without explicit user approval.

## Quick start

### Requirements

- Node.js `>=22.13.0` with npm
- A Google Generative AI API key for the Mastra agent/search tools
- A Google Cloud project with the Sheets API enabled
- A Telegram bot created through `@BotFather`

### Install

```bash
npm install
cp .env.example .env
```

Set the model values in `.env`:

```dotenv
OPENCODE_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

Use absolute, distinct local paths. The profile directory must contain only approved profile/resume sources:

```dotenv
MASTRA_DATA_DIR=/absolute/path/to/career-copilot-data
MASTRA_DATABASE_URL=file:/absolute/path/to/career-copilot-data/mastra.db
CAREER_COPILOT_PROFILE_DIR=/absolute/path/to/profile
CAREER_COPILOT_REPORTS_DIR=/absolute/path/to/career-copilot-reports
CAREER_COPILOT_TOPICS_DIR=/absolute/path/to/career-copilot-topics
```

### First-run order

1. Configure a Google OAuth Web application with redirect URI `http://127.0.0.1:53682/oauth/callback`, then set `GOOGLE_OAUTH_CLIENT_ID` and `GOOGLE_OAUTH_CLIENT_SECRET`.
2. Run `npm run oauth:google` and approve the Sheets scope. This writes the refresh token to gitignored `.env`.
3. Set the configured Sheet ID if using an existing Sheet, or leave `GOOGLE_SHEETS_SPREADSHEET_ID` empty to create one. The tab names default to:

   ```dotenv
   GOOGLE_SHEETS_TRACKER_TAB=Applications
   GOOGLE_SHEETS_APPLICATION_LOG_TAB=Application Log
   GOOGLE_SHEETS_TOPICS_TAB=Topics
   ```

4. Run `npm run sheets:setup`, review the plan, and type `yes`. It creates/validates the configured tabs and seeds only empty header rows.
5. Create a Telegram bot with `@BotFather`; set `TELEGRAM_BOT_TOKEN`, `TELEGRAM_BOT_USERNAME`, and optionally `TELEGRAM_WEBHOOK_SECRET_TOKEN`.
6. Send `/start` to the bot, then read the latest update from Telegram `getUpdates` to obtain `message.from.id` and `message.chat.id`. Set both allowlists to those numeric private-chat values:

   ```dotenv
   TELEGRAM_ALLOWED_USER_IDS=...
   CAREER_COPILOT_PRIVATE_CHAT_IDS=...
   ```

   Do not commit or share the raw update response.

7. Create the profile directory and add approved source files:

   ```bash
   mkdir -p /absolute/path/to/profile
   ```

8. Start locally:

   ```bash
   npm run dev
   ```

   Local Telegram polling starts automatically. Send `/job https://...` with a supported HTTPS job URL. The bot fetches the page, writes a local review artifact, records the topic and audit trail, updates the Sheet row to `reviewed`, and replies when complete.

Open [http://localhost:4111](http://localhost:4111) for the local Mastra editor. Never expose it publicly without authentication.

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Mastra development server with `src/` as the application directory |
| `npm run build` | Build the Mastra application |
| `npm start` | Start the built application |
| `npm test` | Run the Node test suite |
| `npm run oauth:google` | Authorize Google Sheets locally and persist the refresh token in `.env` |
| `npm run sheets:setup` | Confirm and initialize the configured Sheet, tabs, and headers |
| `npm exec tsc -- --noEmit` | Type-check the source without emitting files |

## Project layout

```text
src/
├── agents/       # Career Copilot agent configuration
├── channels/     # Telegram adapter, ingress, and authorization
├── config/       # Runtime paths and environment validation
├── integrations/ # Google Sheets and local filesystem boundaries
├── services/     # Career Copilot flow and runtime composition
├── storage/      # Durable idempotency and reconciliation state
├── tools/        # Web fetching, URL validation, and schedules
└── index.ts      # Mastra instance, storage, editor, and observability

test/             # Boundary and behavior tests
workspace/        # Agent working files (created at runtime)
```

## Runtime configuration

Copy `.env.example` and keep secrets out of source control.

| Variable | Purpose |
| --- | --- |
| `OPENCODE_API_KEY` | OpenCode model provider authentication |
| `GOOGLE_GENERATIVE_AI_API_KEY` | Google Search tool authentication |
| `MASTRA_DATA_DIR` | Absolute directory for database and workspace state |
| `MASTRA_DATABASE_URL` | Absolute `file:` URL, `libsql:` URL, or HTTPS database URL |
| `TURSO_AUTH_TOKEN` | Authentication when using a remote Turso/libSQL database |

The Telegram, Google Sheets/OAuth, and private-path variables in `.env.example` are required when the Mastra entrypoint starts. Keep `.env` local and gitignored; use a managed secret store or protected environment file for deployment.

## Google Sheets OAuth

The detailed operational guide is maintained in the vault at `Projects/career-copilot/Guides/Google Sheets OAuth Setup.md`.

For this single-owner application, use the local one-time authorization command:

1. Create or select a Google Cloud project, enable the Google Sheets API, and configure its OAuth consent screen.
2. Create a **Web application** OAuth client with this authorized redirect URI:

   ```text
   http://127.0.0.1:53682/oauth/callback
   ```

3. Put only the new client credentials in the local `.env`:

   ```dotenv
   GOOGLE_OAUTH_CLIENT_ID=...
   GOOGLE_OAUTH_CLIENT_SECRET=...
   ```

4. Run `npm run oauth:google`, approve the Sheets permission in the browser, and return to the terminal.

The command validates the callback state, exchanges the single-use code locally, writes `GOOGLE_OAUTH_REFRESH_TOKEN` and `GOOGLE_OAUTH_SCOPE` to `.env`, sets the file mode to `0600`, and never prints tokens. The application exchanges the refresh token for short-lived access tokens at runtime; access tokens are not persisted.

Refresh tokens are bound to the OAuth client and Google account; use separate OAuth clients for unrelated projects or environments. A consent screen left in **Testing** normally expires grants and refresh tokens after seven days, so use testing only for temporary development and follow Google's publishing/verification requirements for longer-lived use.

Never commit `.env`. Revoke and repeat authorization if a refresh token is exposed or Google returns an authorization failure.

## Google Sheets first-run setup

After OAuth succeeds, run:

```bash
npm run sheets:setup
```

The command shows its plan and requires typing `yes` before any Sheet mutation. If `GOOGLE_SHEETS_SPREADSHEET_ID` is absent, it creates a **Career Copilot** spreadsheet. If an ID is present, it validates that spreadsheet and adds only missing tabs. It seeds headers only when row 1 is empty and refuses to overwrite a different existing header row.

The required tabs are configurable through `.env` and default to `Applications`, `Application Log`, and `Topics`. A newly created spreadsheet ID and all tab names are persisted to the gitignored `.env` with mode `0600`.

## Telegram

Local development uses Telegram polling automatically, so no public URL is needed. Production should use an HTTPS webhook with `TELEGRAM_WEBHOOK_SECRET_TOKEN`; keep the token, webhook secret, and allowlist values in deployment secrets. The verified local private chat is documented in the vault guide, not in this repository.

`/start` is not a supported Career Copilot command yet. The V0 direct-review command is:

```text
/job <supported HTTPS job URL>
```

Supported hosts currently include LinkedIn, Foundit, Cutshort, Naukri, and Indeed. The current flow reviews and tracks the job; it never submits an application.

## Safety boundaries

- Treat the workspace as a controlled working area, not an operating-system sandbox.
- Review approval prompts before allowing file changes or commands.
- Do not expose the development server publicly without authentication.
- Keep API keys, bot tokens, OAuth credentials, and personal profile data outside Git.
- Pause recurring schedules when they are no longer needed; scheduled runs consume model tokens.
- Review generated application content before sending or submitting it.

## Development notes

The Mastra entrypoint is `src/index.ts`. Change the agent behavior in `src/agents/agent.ts`, add or modify tools in `src/tools/`, and keep runtime path validation in `src/config/runtime.ts`.

Before opening a change for review, run:

```bash
npm test
npm exec tsc -- --noEmit
npm run build
```
