# Career Copilot

Career Copilot is a personal job-search assistant built with Mastra. It helps turn a job-search workflow into a repeatable, reviewable process: find relevant roles, prepare application materials, and keep work inside an approval-controlled local workspace.

> **Status:** active early-stage project. The core agent, workspace controls, web fetching, scheduling, persistence, and automated boundary tests are in place. Browser-assisted applications, Telegram delivery, and application tracking are being added incrementally.

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

- Node.js with npm
- An OpenCode API key
- A Google Generative AI API key for Google Search

### Install

```bash
npm install
cp .env.example .env
```

Set at least these values in `.env`:

```dotenv
OPENCODE_API_KEY=...
GOOGLE_GENERATIVE_AI_API_KEY=...
```

`MASTRA_DATA_DIR` and `MASTRA_DATABASE_URL` are optional. If omitted, runtime state is stored under `.mastra/career-copilot/` in the project directory.

### Run locally

```bash
npm run dev
```

Open [http://localhost:4111](http://localhost:4111) to use the local Mastra editor.

Useful prompts:

- `Find software engineering roles that match my experience.`
- `Tailor my resume for this job description without inventing qualifications.`
- `Help me prepare this application and ask before making any irreversible change.`

## Commands

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start the Mastra development server with `src/` as the application directory |
| `npm run build` | Build the Mastra application |
| `npm start` | Start the built application |
| `npm test` | Run the Node test suite |
| `npm exec tsc -- --noEmit` | Type-check the source without emitting files |

## Project layout

```text
src/
├── agents/       # Career Copilot agent configuration
├── channels/     # Channel-specific authentication boundaries
├── config/       # Runtime paths and database configuration
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

The example file also documents planned channel, tracker, and private-profile settings. They are not required for the local Mastra agent and should only be configured when their corresponding integrations are enabled.

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
