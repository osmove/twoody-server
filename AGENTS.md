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

Which conversation a turn belongs to is decided by the pure
`src/discussionWindow.ts` (same rule and table as the cloud backend's
`DiscussionResolver`): the one named by `discussion_id`; otherwise a new
one — a text surface owns its thread state, so naming none means "new
conversation". Only voice surfaces continue the latest conversation
without naming it (`device` for one minute, `watch` for ten), and
`force_new_discussion: true` starts over everywhere. Do not bring back a
blanket reuse window: it made "New conversation" in the desktop chat keep
writing into the previous thread, and handed that thread to the model as
history.

A local runtime may ask for an API key: the one the desktop app ships is
started with a key generated at each launch, because anything on the
computer — a web page included — can reach a loopback port. The app hands
the key over (`TWOODY_RUNTIME_KEYS`, a JSON map of base URL to key, for the
embedded server; the `runtimeKeys` field of the worker's messages) and
`src/runtimeAuth.ts` attaches it to the calls made to that runtime only.
A key is never stored, and never accepted for an address that is not
loopback.

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

## Document Q&A (`src/documents/`)

The user grants folders; the server indexes what is under them and
`/queries` answers from it with citations. Nothing leaves the SQLite file.

- `extract.ts` — pure-JS text extraction (unpdf for PDF page by page, fflate
  for .docx / .odt, RTF, HTML, plain text with a Windows-1252 fallback). No
  shelling out: a stock Mac has neither `pdftotext` nor `ripgrep`. The older
  `src/executors/` search/read tasks still do, for the Linux bridge.
- `chunk.ts` — ~1200-character passages cut on paragraphs, then sentences,
  with a short overlap; a PDF page boundary always starts a new passage.
- `query.ts` — question → FTS5 MATCH: stopwords dropped (including common
  two-letter words), short subjects like CV retained, terms OR-ed, long
  words matched as a crude stem prefix, user-typed operators neutralised.
- `library.ts` — folder grants (`canonicalFolder` refuses `/`, system roots,
  a whole home directory, `~/Library` and hidden paths; symlinks are not
  followed), incremental indexing keyed on size + mtime, one file at a time,
  and `searchPassages` (BM25, passages far behind the best one dropped, at
  most three per document). Search also checks filenames and granted-folder
  relative paths, without reindexing. `listDocuments` pages authenticated
  file metadata under `/local_documents/files`.
- Storage: `document_folders`, `documents`, and the FTS5 table
  `document_chunks` (`unicode61 remove_diacritics 2`, so "delai" finds
  "délai"). Scans use the configured OCR helper when available; files with
  no extractable text end up `status = "empty"`.
- `/queries` numbers the passages on the last user message, tells the model
  in the system prompt to cite them as [1], [2] and to say when they do not
  contain the answer, returns them as `sources` in the `final` event and
  stores them in `messages.sources_json`.
- Routes live under `/local_documents/*`, not `/documents`, which is the
  Google Drive browser on the managed backend. `/capabilities` reports
  `has_document_index`.

### Per-turn document access

`/queries` accepts `document_access` (object in JSON, JSON string in multipart):
`{mode: "off"|"all"|"selected"|"only", folderIds?: string[]}`. Missing preserves
legacy all-folder access; invalid values are 422. Empty/unknown/revoked scopes
retrieve nothing. The Desktop remembers this per local conversation. `only`
turns suppress memories and instruct document-grounded answers; Desktop also
disables web research. Previously shared history is not erased.

`documents/retrieval.ts` provides file modification metadata and rereads a
single explicitly referenced file for follow-up summaries. Source IDs from
history are revalidated against current grants and scope. Multiple variants
are not arbitrarily reduced to one file. Modification dates do not establish
the document's authored date. Summaries may use partial coverage (six chunks).

## Outbound calls and local-only mode

Never call `fetch` directly in `src/`. Every outbound HTTP call goes through
`outboundFetch` in `src/outbound.ts`; `test/outbound.test.ts` fails on a bare
`fetch(`. With `TWOODY_LOCAL_ONLY=1` that gate refuses any host that does not
resolve to loopback or a private range (RFC 1918, link-local, CGNAT/Tailscale,
IPv6 ULA), and names that do not resolve count as public. Routes whose whole
purpose is a cloud call (`/realtime_sessions`, cloud fallback in `/queries`,
the upstream bridge client) also check `LOCAL_ONLY` up front to return a clean
`local_only` error. The flag is reported by `/capabilities` and `/deployment`.

## Access control

- Every route that touches user data calls `requireAuth`. That includes the
  bridge worker routes (`GET /bridge/tasks/next`, `PATCH /bridge/tasks/:id`):
  task args carry search terms and full `llm_infer` prompts. A worker presents
  the session from `/auth/pair` or a paired-device token, and only sees tasks
  enqueued by that same user; bridge presence is per user as well. Task ids
  come from `generateId()`.
- `/mcp` requires auth too: the adapter behind it acts with the user's token.
  Only the MCP transport headers are forwarded upstream, never the caller's
  bearer.
- `/admin` (`src/adminAccess.ts`): loopback only by default; with
  `TWOODY_ADMIN_TOKEN` set, every request needs the token (Bearer,
  `X-Admin-Token`, or `/admin?token=…` once, which sets an HttpOnly cookie
  holding a digest and redirects). Cross-site requests are refused because
  CORS reflects any origin. `/docs`, `/openapi.json` and `/health` stay open.
- Routes that check a secret (`/auth/signup`, `/auth/signin`, `/auth/pair`,
  `/session/cli`, `/devices/pair`, the admin token) go through
  `allowSecretAttempt` in `src/rateLimit.ts`: 10 attempts per address and
  route per 5 minutes (`TWOODY_AUTH_ATTEMPTS_LIMIT`), in memory.
- The data directory is chmod 0700 and the SQLite files 0600 on every boot.

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

`llm_infer` follows the contract of the macOS and firmware workers, and
the Rails side depends on it (`LocalLlmService.chat_via_bridge` reads
`result["response_json"]`): stream from the runtime, PATCH each batch of
text as `{status: "streaming", delta}` in order, finish with
`{response_json, model_used, latency_ms}`. The pieces live in
`src/executors/`: `completionStream.ts` (pure: SSE splitting, rebuilding
the completion and its tool calls, relaying deltas at the pace of the link), `localModels.ts`
(which runtime holds which model, placeholder → default model) and
`llmInfer.ts`. The poll loop does not wait for a completion to finish:
backend presence lasts 90 s and is only renewed by polling.

`src/bridgeWorker.ts` is a second entry point that runs only this client
(no Fastify, no SQLite). It must stay free of `db.js` imports. The
desktop app forks it and configures it with a `configure` message.

## Granted folders on Linux

macOS uses NSOpenPanel + security-scoped bookmarks. On Linux the
operator declares grants via `TWOODY_BRIDGE_FOLDERS` (colon-,
comma-, or JSON-encoded list). `src/executors/folders.ts` resolves
the env var, filters out sensitive prefixes (`/etc`, `/root`, `/.ssh`,
…), and caches the parsed result. `src/executors/idCache.ts` keeps a
bounded LRU mapping opaque `doc_*` ids → absolute paths so real
filesystem paths never appear in the wire payload.

### Semantic document retrieval

`src/documents/semantic.ts` manages an opt-in, local embedding worker and cached
vectors. Never send document text to external embedding APIs. Revalidate current
grants on every query and before persisting asynchronously computed vectors.
Revocation and text changes invalidate vectors and suggested labels. The desktop
supplies pinned model/binary paths; standalone settings are documented in
`scripts/twoody-server.env.example`. Use `scripts/smoke-semantic.mjs` for real-model
validation, and the normal smoke for auth, access scopes and referent continuity.
The explicit personal-files grant excludes application data, hidden files and
symlinks; it does not confer write access or unrestricted disk access.
