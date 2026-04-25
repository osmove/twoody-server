# AGENTS.md - Twoody Server

## Purpose

`twoody-server` is the self-hosted mini-backend for Twoody Local. It deliberately avoids sharing Rails code from the private backend while preserving the public contracts used by firmware, MCP, CLI, app local mode, and the Mac bridge.

## Stack

- Node 22
- TypeScript
- Fastify
- SQLite with Drizzle ORM
- Server-Sent Events for streaming query responses

## API Scope

Keep the Phase 1 API focused:

- `/health`
- `/session/*`
- `/queries`
- `/realtime_sessions`
- `/devices/*`
- `/bridge/tasks/*`
- `/admin`

Future routes should be versioned or covered by an OpenAPI/conformance test before public release.

## Conventions

- No Rails imports, generated code, or private backend coupling.
- Store local data under the configured data directory, not the repo.
- Treat the Bridge protocol as a public contract.
- The current shared source of truth for Bridge v1 is
  `../twoody-desktop/shared/bridge-v1.schema.json`. Keep `src/routes/bridge.ts`
  aligned with that schema's task kinds and stable wire shapes.
- Keep `twoody-mcp` and `twoody-cli` aligned with this server's real route
  surface; this repo is the backend contract, not just one implementation detail.
- Do not log secrets, user LLM keys, auth tokens, or local filesystem paths unnecessarily.
