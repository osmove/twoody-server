# Twoody Server (`twoody-server`)

The **single-user** edition of **Twoody Self-hosted** — runs as a
Fastify + SQLite Node binary on a single Mac, NAS or Pi. Pairs with
Twoody Desktop, Twoody App, Twoody Watch, Twoody CLI, and the device
firmware over the same HTTP contract that Cloud (api.twoody.com) and
the multi-user Self-hosted edition (Rails Docker) expose.

For multi-user deployments (households, agencies, on-prem teams), run
the Rails image distributed under `ghcr.io/osmove/twoody-server` with
`TWOODY_DEPLOYMENT=team` instead. This TypeScript binary refuses to
boot when more than one account exists on a publicly-bound port; see
the boot guard in `src/index.ts`.

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

The smoke test boots a throwaway Server instance with a temporary SQLite data
directory, creates the first local account with the setup token, exercises
signin, pairing, auth, local-first provider routing, members, `/tool_calls`,
and verifies the explicit `bridge_offline` response when no document provider
bridge is connected.

Interactive docs are available at:

- `http://localhost:3000/docs`
- `http://localhost:3000/openapi.json`

By default the server listens on `http://0.0.0.0:3000`.

On first boot, when no local user exists, the Server writes a setup token to the
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
| `GET` | `/bridge/tasks/next` | Bridge worker long-poll (token required, own user's tasks only) |
| `PATCH` | `/bridge/tasks/:id` | Bridge task result/progress (token required) |
| `GET` | `/bridge/tasks/:id` | poll task completion |
| `POST` | `/bridge/tasks` | enqueue Bridge task |
| `GET` | `/bridge/presence` | Bridge/capability presence for CLI status |
| `GET/POST/PATCH/DELETE` | `/members*` | members + enrollment assets |
| `GET` | `/admin` | minimal admin page — this machine only, or `TWOODY_ADMIN_TOKEN` from elsewhere |

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
TWOODY_LOCAL_ONLY=1
TWOODY_ADMIN_TOKEN=a-long-random-string
HOME_ASSISTANT_URL=http://homeassistant.local:8123
HOME_ASSISTANT_TOKEN=...
```

## Docker

```bash
docker compose up --build
```

## Linux / Raspberry Pi

For a headless install (Raspberry Pi 4/5, generic amd64/arm64 box), use
the bundled bootstrap script. It installs Node 22, ripgrep, ffmpeg,
poppler-utils, avahi-daemon, Ollama, copies the repo to
`/opt/twoody-server`, builds prod deps (compiles `better-sqlite3` for
the target architecture), and registers a systemd unit.

```bash
# On the target host, from a fresh checkout:
sudo bash scripts/install-linux.sh
```

The installer writes a starter env file at `/etc/twoody-server.env` on
first run and leaves it alone on subsequent runs. Edit it to point at
your Home Assistant instance, granted folders, and optional upstream
Twoody backend, then `sudo systemctl restart twoody-server`.

```bash
sudoedit /etc/twoody-server.env
sudo systemctl restart twoody-server
journalctl -u twoody-server -f
```

### In-process bridge mode

A headless Linux deployment has no Mac long-polling
`/bridge/tasks/next`, so set `TWOODY_SELF_BRIDGE=1` to run `search`,
`read`, `list_folders`, `list_dir`, and `llm_infer` in the same Node
process. The executors live under `src/executors/`:

- **`search`** — ripgrep content match + `find` filename match, ranks
  filename hits higher, scoped to `TWOODY_BRIDGE_FOLDERS`.
- **`read`** — text/markdown directly, `pdftotext` for PDFs, 10 MB
  file ceiling.
- **`list_folders` / `list_dir`** — walks the granted folders.
  `..` traversal blocked.
- **`llm_infer`** — proxies the OpenAI-compatible body to
  `BRIDGE_LOCAL_LLM_ENDPOINT` (Ollama at 11434 by default).

`TWOODY_BRIDGE_FOLDERS` lists which paths the executors are allowed to
touch:

```bash
# Colon-separated, optional Name=path label
TWOODY_BRIDGE_FOLDERS=Documents=/home/pi/Documents:Media=/srv/share
```

A small denylist refuses `~/.ssh`, `/etc`, `/root`, `/boot`, etc. even
if the operator lists them explicitly.

The macOS-only bridge task kinds (`thumbnail`, `photos_recent`,
`photos_by_date`, `app_open`, `shortcut_*`, `ocr_image`,
`open_document`) stay queue-only on Linux — there is no equivalent
native API.

### Upstream bridge client

When `TWOODY_BACKEND_URL` + `TWOODY_USER_TOKEN` are set, the server
also long-polls an upstream Twoody backend and claims `smart_home_proxy`
+ the in-process bridge kinds on its behalf. This lets the iPhone/watch
app talk to `api.twoody.com` while a household Pi runs the local-only
tasks behind the user's LAN.

### Mac → Pi document sync

The in-process bridge executors search/read against the Pi's local
filesystem. To make a Mac's `~/Documents` reachable from the Pi
without exposing the Mac to inbound SSH (Remote Login stays off),
push from the Mac via rsync. Templates live in `scripts/macos/`:

- `sync-docs-to-pi.sh` — one-shot push of curated subfolders, intended
  to be run from a Terminal that already has Full Disk Access.
- `com.twoody.doc-sync.plist.example` — launchd UserAgent that runs
  the rsync every 30 minutes. Needs Full Disk Access on
  `/usr/bin/rsync` (System Settings → Privacy & Security → Full Disk
  Access → add `/usr/bin/rsync`).

Configure `TWOODY_BRIDGE_FOLDERS` on the Pi to grant the synced
directories, for example:

```
TWOODY_BRIDGE_FOLDERS=Permanent=/home/pi/mac-share/_Permanent:Osmove=/home/pi/mac-share/Osmove:Hyundai=/home/pi/mac-share/Hyundai
```

## Notes

The in-memory Bridge queue is good enough for Phase 1 developer preview.
Moving task state to SQLite or Redis is the next durability step before a
stable v1 contract.

`/queries` is local-first: configure a local OpenAI-compatible provider, or set
`BRIDGE_LOCAL_LLM_ENDPOINT` for the legacy local endpoint. Cloud keys are only
used when `TWOODY_CLOUD_FALLBACK_ENABLED=true`.

`TWOODY_LOCAL_ONLY=1` goes further: the server refuses every outbound call to
a host that is not this machine or a private-network address, whatever else is
configured. Cloud fallback, `/realtime_sessions`, Spotify and an upstream
bridge backend are all off, `/devices/llm_keys` returns no keys, and
`/capabilities` and `/deployment` report `local_only: true` so clients can show
it. Downloading a model through Ollama is unaffected (Ollama makes that call,
and it carries no user content).

Bridge pollers can declare capabilities with `X-Bridge-Capabilities`, using a
comma-separated or JSON array value such as `document-provider,local-llm-provider`.

The stable Bridge v1 task/update/result shapes are now documented in the
desktop monorepo at `../twoody-desktop/shared/bridge-v1.schema.json`. Keep this
server's `/bridge/tasks*` routes aligned with that shared schema.

## License

Twoody Server is licensed under BSL 1.1 with a change date of
2030-04-21, after which the covered version converts to Apache 2.0. See
[LICENSE](LICENSE).

### Local STT (whisper.cpp)

`POST /audio/transcriptions` proxies multipart audio uploads to a
local `whisper-cli` (whisper.cpp) and returns `{ text: "…" }`. Wire-
compatible with the subset of OpenAI's `POST /v1/audio/transcriptions`
the iPhone / Watch app uses, so swapping the endpoint URL is enough
to keep voice queries on the LAN.

On a Raspberry Pi 5, build whisper.cpp once:

```bash
sudo apt install -y cmake build-essential
git clone --depth 1 https://github.com/ggml-org/whisper.cpp /home/pi/whisper.cpp
cd /home/pi/whisper.cpp
cmake -B build -DGGML_NATIVE=ON
cmake --build build --config Release -j 4
./models/download-ggml-model.sh base       # ~148 MB
```

Then expose the binary + model via env:

```bash
WHISPER_BIN=/home/pi/whisper.cpp/build/bin/whisper-cli
WHISPER_MODEL=/home/pi/whisper.cpp/models/ggml-base.bin
WHISPER_THREADS=4
```

The route returns `503 whisper_not_configured` when either path is
missing, so a vanilla install without whisper.cpp keeps booting.

### Pi state backup

`scripts/macos/backup-pi-state.sh` + the matching launchd plist pull
`/home/pi/.twoody/data/` (the SQLite DB + WAL + setup token) from the
Pi to `~/Library/Twoody/backups/<TIMESTAMP>/` on the Mac every 12 h
and keep the last 14 snapshots. Pair with `latest` symlink for easy
recovery.
