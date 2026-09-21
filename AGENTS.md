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

## Chat context (`/queries`)

Every turn sends the model a full message list, built by the pure
`src/chatContext.ts` (no DB access, unit-tested in `test/`):

1. One system message: base prompt (or the user's `system_prompt` pref,
   which replaces it when `system_prompt_replace_base` is true), the date
   at day granularity, the user's name, and `user` / `feedback` memories.
2. The discussion history, newest messages first within
   `TWOODY_HISTORY_MAX_MESSAGES` (20) and `TWOODY_HISTORY_MAX_CHARS`
   (16000). Roles always alternate starting with `user`; an unanswered
   prompt is folded into the next one.
3. The current prompt, prefixed with the `project` / `reference`
   memories whose text matches it. `memory_enabled: false` disables both
   memory paths.

Keep anything that changes per turn out of the system message: local
runtimes reuse their KV cache for the unchanged prefix, which is what
makes follow-up turns fast.

Local providers also get `max_tokens` (`TWOODY_LOCAL_MAX_TOKENS`, 2048)
and `chat_template_kwargs.enable_thinking: false`, retried without the
latter on a 400/422. `src/thinkFilter.ts` drops a leading
`<think>…</think>` block from the stream. Not handled yet: templates that
pre-fill `<think>` so only the closing tag reaches the content stream.

Run `npm test` (node:test via tsx) and `npm run smoke`; the smoke test
asserts what a second turn puts on the wire using a fake
OpenAI-compatible server.

## Outbound calls and local-only mode

Never call `fetch` directly in `src/`. Every outbound HTTP call goes through
`outboundFetch` in `src/outbound.ts`; `test/outbound.test.ts` fails on a bare
`fetch(`. With `TWOODY_LOCAL_ONLY=1` that gate refuses any host that does not
resolve to loopback or a private range (RFC 1918, link-local, CGNAT/Tailscale,
IPv6 ULA), and names that do not resolve count as public. Routes whose whole
purpose is a cloud call (`/realtime_sessions`, cloud fallback in `/queries`,
the upstream bridge client) also check `LOCAL_ONLY` up front to return a clean
`local_only` error. The flag is reported by `/capabilities` and `/deployment`.

## Vocabulary: capability vs skill vs built-in capability

Three "capability"-flavoured terms coexist; they describe different
layers and should not be conflated.

- **Skill** (Rails, retiring) — user-facing feature toggle
  (`smart_home`, `memory`, `calendar`). Settled in `app/models/skill.rb`
  and `User#skill_enabled?`. Will eventually be replaced by
  `BuiltInCapability` per Cockpit's D-vocabulary direction.
- **BuiltInCapability** (OSS-bound, canonical) — the cross-stack name
  for the same concept. `src/routes/builtInCapabilities.ts` is the
  Server-side surface; clients consume the static catalog from there.
- **Bridge capability** (this server's runtime layer) — what a bridge
  *worker* declares it can fulfil via `X-Bridge-Capabilities`:
  `document-provider`, `local-llm-provider`, `smart-home-proxy`. It
  drives task routing (`BridgeTask::KIND_CAPABILITY`), not feature
  toggling. A user turning a Skill on does not change which bridge
  capability any worker advertises.

When in doubt, "capability" in this codebase means the routing layer.
Use "skill" / "built-in capability" when talking about user-facing
features.

## Bridge runtime modes

The bridge accepts tasks via `POST /bridge/tasks` and serves them via
`GET /bridge/tasks/next`. Tasks fall in three classes today:

1. **Local-only** (executed in-process unconditionally) —
   `smart_home`, `spotify`, `device_command`, `members_list`,
   `stereo_pair`. Dispatched through `src/tools.ts::executeLocalTool`.
   `smart_home` calls Home Assistant via the env-configured URL/token.
2. **In-process bridge kinds** when `TWOODY_SELF_BRIDGE=1` —
   `search`, `read`, `list_folders`, `list_dir`, `llm_infer`.
   Dispatched through `src/executors/`. Required on headless Linux
   where no Mac Bridge worker exists. The executors are Linux-native:
   ripgrep + find for search, pdftotext for PDF read, OpenAI-compat
   HTTP for LLM (Ollama-friendly).
3. **Worker bridge kinds** (queued for a long-polling external worker)
   — same set as `(2)` plus the macOS-only kinds (`thumbnail`,
   `photos_*`, `app_open`, `shortcut_*`, `ocr_image`,
   `open_document`). Consumed by `twoody-mac` on macOS or by a future
   Windows/Linux worker.

When `TWOODY_SELF_BRIDGE=1` is set, the in-process executors handle
class (2) tasks and the long-poll path filters them out so the same
task isn't claimed twice. macOS-only kinds (class 3 only) still sit
in the queue until a real Mac worker picks them up.

`src/bridgeClient.ts` is the converse: this server long-polls an
*upstream* Twoody backend and runs `smart_home_proxy` + the same
self-bridge kinds against the local LAN. That path turns the server
into a household worker for `api.twoody.com` (or a self-hosted Rails
upstream) without exposing HA / the filesystem publicly.

## Granted folders on Linux

macOS uses NSOpenPanel + security-scoped bookmarks. On Linux the
operator declares grants via `TWOODY_BRIDGE_FOLDERS` (colon-,
comma-, or JSON-encoded list). `src/executors/folders.ts` resolves
the env var, filters out sensitive prefixes (`/etc`, `/root`, `/.ssh`,
…), and caches the parsed result. `src/executors/idCache.ts` keeps a
bounded LRU mapping opaque `doc_*` ids → absolute paths so real
filesystem paths never appear in the wire payload.
