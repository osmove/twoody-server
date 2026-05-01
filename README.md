# Twoody Hub (`twoody-server`)

Part of [Twoody Local](https://twoody.com/local) — the open-source, self-hosted edition of Twoody.

Local-first Hub for Twoody installs. The product role is **Twoody Hub**; this
repo and binary remain `twoody-server`.

This package is the Phase 1 OSS split core: it deliberately avoids sharing
Rails code from the private backend while keeping the public device, app, CLI,
MCP, and desktop bridge contracts familiar.

For repository-specific development context, conventions, and architecture
notes, see [AGENTS.md](AGENTS.md).

## Stack

- Node 22
- TypeScript
- Fastify
- SQLite via Drizzle ORM
- Server-Sent Events for `/queries`
- OpenAPI via `@fastify/swagger`

## Run

```bash
npm install
npm run typecheck
npm run dev
```

Install the package globally if you want the `twoody-server` executable in
your shell:

```bash
npm i -g twoody-server
```

Generate the committed OpenAPI contract:

```bash
npm run openapi
```

Run the HTTP smoke test:

```bash
npm run smoke
```

The smoke test boots a throwaway Hub instance with a temporary SQLite data
directory, creates the first local account with the setup token, exercises
signin, pairing, auth, local-first provider routing, members, `/tool_calls`,
and verifies the explicit `bridge_offline` response when no document provider
bridge is connected.

Interactive docs are available at:

- `http://localhost:3000/docs`
- `http://localhost:3000/openapi.json`

By default the server listens on `http://0.0.0.0:3000`.

On first boot, when no local user exists, the Hub writes a setup token to the
data directory and prints it to the logs. Use it with `/auth/signup` or a client
onboarding flow to create the first local account.

For a one-shot 8-character pairing code:

```bash
TWOODY_PAIRING_CODE=A7B9C2D4 npm run dev
```

## Implemented Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | health check |
| `POST` | `/auth/signup` | create first local account with setup token |
| `POST` | `/auth/signin` | create local auth session with email/password |
| `GET` | `/auth/me` | verify auth token |
| `POST` | `/session/cli` | pair CLI via 8-character code |
| `GET` | `/session/me` | verify auth token |
| `GET` | `/providers` | list local/cloud LLM providers |
| `POST` | `/providers/local` | add local OpenAI-compatible provider |
| `PATCH` | `/providers/:id` | update provider |
| `POST` | `/providers/:id/default` | choose default provider |
| `DELETE` | `/providers/:id` | delete provider |
| `POST` | `/queries` | SSE chat stream through the default provider |
| `POST` | `/realtime_sessions` | OpenAI Realtime ephemeral token proxy |
| `POST` | `/devices/pair` | firmware pairing via 8-character code |
| `GET` | `/devices/:id/update_check` | OTA kill-switch stub |
| `POST` | `/devices/:id/update_events` | OTA telemetry log |
| `POST` | `/devices/:id/transcripts` | transcript stub |
| `GET` | `/devices/llm_keys` | local BYOK keys for firmware |
| `POST` | `/devices/stereo_pair` | stereo pairing registration |
| `POST` | `/tool_calls` | local tool execution for voice / realtime sessions |
| `GET` | `/bridge/tasks/next` | Mac Bridge long-poll |
| `PATCH` | `/bridge/tasks/:id` | Bridge task result/progress |
| `GET` | `/bridge/tasks/:id` | poll task completion |
| `POST` | `/bridge/tasks` | enqueue Bridge task |
| `GET` | `/bridge/presence` | Bridge/capability presence for CLI status |
| `GET/POST/PATCH/DELETE` | `/members*` | members + enrollment assets |
| `GET` | `/admin` | minimal local admin page |

## Environment

```bash
PORT=3000
HOST=0.0.0.0
TWOODY_PAIRING_CODE=A7B9C2D4
TWOODY_SETUP_TOKEN=optional-fixed-first-boot-token
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
BRIDGE_LOCAL_LLM_ENDPOINT=http://127.0.0.1:8080/v1
TWOODY_CLOUD_FALLBACK_ENABLED=false
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=...
```

## Docker

```bash
docker compose up --build
```

## Notes

The in-memory Bridge queue is good enough for Phase 1 developer preview.
Moving task state to SQLite or Redis is the next durability step before a
stable v1 contract.

`/queries` is local-first: configure a local OpenAI-compatible provider, or set
`BRIDGE_LOCAL_LLM_ENDPOINT` for the legacy local endpoint. Cloud keys are only
used when `TWOODY_CLOUD_FALLBACK_ENABLED=true`.

Bridge pollers can declare capabilities with `X-Bridge-Capabilities`, using a
comma-separated or JSON array value such as `document-provider,local-llm-provider`.

The stable Bridge v1 task/update/result shapes are now documented in the
desktop monorepo at `../twoody-desktop/shared/bridge-v1.schema.json`. Keep this
server's `/bridge/tasks*` routes aligned with that shared schema.

## License

Twoody Server is licensed under BSL 1.1 with a change date of
2030-04-21, after which the covered version converts to Apache 2.0. See
[LICENSE](LICENSE).
