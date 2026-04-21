# Twoody Local Server

Self-hosted mini-backend for local Twoody installs.

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

## Run

```bash
npm install
npm run typecheck
npm run dev
```

By default the server listens on `http://0.0.0.0:3000`.

For a one-shot pairing code:

```bash
TWOODY_PAIRING_CODE=123456 npm run dev
```

## Implemented Routes

| Method | Path | Purpose |
|--------|------|---------|
| `GET` | `/health` | health check |
| `POST` | `/session/ephemeral` | create local auth session |
| `GET` | `/session/me` | verify auth token |
| `POST` | `/queries` | SSE chat stream via OpenAI, Anthropic, Gemini, or mlx-lm |
| `POST` | `/realtime_sessions` | OpenAI Realtime ephemeral token proxy |
| `POST` | `/devices/pair` | firmware pairing via 6-digit code |
| `GET` | `/devices/:id/update_check` | OTA kill-switch stub |
| `POST` | `/devices/:id/update_events` | OTA telemetry log |
| `POST` | `/devices/:id/transcripts` | transcript stub |
| `GET` | `/devices/llm_keys` | local BYOK keys for firmware |
| `POST` | `/devices/stereo_pair` | stereo pairing registration |
| `GET` | `/bridge/tasks/next` | Mac Bridge long-poll |
| `PATCH` | `/bridge/tasks/:id` | Bridge task result/progress |
| `GET` | `/bridge/tasks/:id` | poll task completion |
| `POST` | `/bridge/tasks` | enqueue Bridge task |
| `GET` | `/bridge/presence` | Bridge presence for CLI status |
| `GET` | `/admin` | minimal local admin page |

## Environment

```bash
PORT=3000
HOST=0.0.0.0
TWOODY_PAIRING_CODE=123456
OPENAI_API_KEY=sk-...
ANTHROPIC_API_KEY=sk-ant-...
GEMINI_API_KEY=...
BRIDGE_LOCAL_LLM_ENDPOINT=http://127.0.0.1:8080/v1
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=...
```

## Notes

The in-memory Bridge queue is good enough for Phase 1 developer preview.
Moving task state to SQLite or Redis is the next durability step before a
stable v1 contract.

## License

Twoody Local Server is licensed under BSL 1.1 with a change date of
2030-04-21, after which the covered version converts to Apache 2.0. See
[LICENSE](LICENSE).
