# Twoody Server (`twoody-server`)

The **single-user** edition of **Twoody Self-hosted** — runs as a
Fastify + SQLite Node binary on a single Mac, NAS or Pi. Pairs with
Twoody Desktop, Twoody App, Twoody Watch, Twoody CLI, and the device
firmware over the same HTTP contract that Cloud (api.twoody.com) and
the multi-user Self-hosted edition (Rails Docker) expose.

For multi-user deployments (households, agencies, on-prem teams), run
the multi-user Self-hosted edition (Rails) with `TWOODY_DEPLOYMENT=team`
instead; `ghcr.io/osmove/twoody-server` is the image of this single-user
server (see [Docker](#docker)). This TypeScript binary refuses to
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

## Without the desktop app

Twoody runs without a Mac: on a Raspberry Pi 5, a NAS or any Linux
server. The server has no model of its own (Twoody Desktop ships
llama.cpp; standalone, run [Ollama](https://ollama.com), llama.cpp's
`llama-server` or LM Studio next to it). Three ways to install it:

| | Needs | Command |
|---|---|---|
| Docker (server + Ollama) | Docker with Compose | `docker compose up -d` — see [Docker](#docker) |
| npm | Node.js 22+ | `npm install -g twoody-server`, or `npm install -g twoody` (the Twoody CLI, whose `twoody serve` runs this server) |
| pip | Python 3.9+ and Node.js 22+ | `pip install twoody` (runs the `twoody` npm package through `npx`: `twoody serve`) |

The npm command:

```bash
npm install -g twoody-server
twoody-server --llm http://127.0.0.1:11434/v1 --data-dir ~/.twoody/data
twoody-server --help      # --port, --host, --data-dir, --llm, --pairing-code, --local-only
```

With the CLI (`npm install -g twoody` or `pip install twoody`), `twoody serve`
(alias `twoody server [options]`) takes the same options, and `twoody setup`
then creates the account with the setup token.

Every other setting is an environment variable ([Environment](#environment)).
On first start the server prints a setup token: see
[Pairing a phone](#pairing-a-phone-with-a-server-without-a-mac).

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
| `GET/POST/DELETE` | `/local_documents/folders*` | grant or revoke a folder; index counts and progress |
| `POST` | `/local_documents/reindex` | re-scan the granted folders |
| `GET` | `/local_documents/search` | content and file/folder-name matches; short terms such as CV supported |
| `GET` | `/local_documents/files?folder_id=…&offset=0` | 100 file metadata rows per page, scoped to the authenticated user |
| `GET` | `/admin` | minimal admin page — this machine only, or `TWOODY_ADMIN_TOKEN` from elsewhere |

## Environment

```bash
TWOODY_DATA_DIR=~/.twoody/data   # database, setup token, documents index
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

`docker-compose.yml` runs two services: `twoody-server` (built from this
checkout) and `ollama` (the official multi-architecture `ollama/ollama`
image), wired together with `BRIDGE_LOCAL_LLM_ENDPOINT=http://ollama:11434/v1`.
The same file works on a Raspberry Pi 5 (arm64) and on an amd64 server.

```bash
docker compose up -d --build
# One model to start with — qwen3.5:4b (3.4 GB), or a model of your choice
# from https://ollama.com/library
docker compose exec ollama ollama pull qwen3.5:4b
# The setup token, for the app (also in the data volume, /data/setup-token)
docker compose logs twoody-server | grep "Setup token"
curl http://localhost:3000/health
```

The image (`Dockerfile`):

- `linux/amd64` and `linux/arm64`, on `node:22-alpine`, about 70 MB
  compressed; no compiler, no model.
- runs as the unprivileged `node` user (uid 1000);
- keeps everything in the `/data` volume: the SQLite database, the setup
  token and the documents index (`TWOODY_DATA_DIR=/data`), and under
  `/data/home` the bridge device id, compute keys and whisper models;
- has a `HEALTHCHECK` on `GET /health`;
- starts `twoody-server`, so its options work as the command:
  `docker run ghcr.io/osmove/twoody-server --help`.

To give the server documents, mount them read-only (for example
`/home/pi/Documents:/documents:ro`, commented in the compose file) and
grant `/documents` from the app. A bind mount instead of the named
volume for `/data` must be writable by uid 1000
(`sudo chown -R 1000:1000 ./data`). A volume created by an older image,
which ran as root, needs the same once:
`docker compose run --rm --user root --entrypoint chown twoody-server -R node:node /data`.

Bonjour discovery is off in the image, because multicast does not cross
Docker's bridge network: give the app the address by hand
(`http://<host>.local:3000`), or use `network_mode: host` as explained
in the compose file.

Multi-architecture build (needs buildx; the GitHub workflow
`.github/workflows/docker.yml` does the same and pushes to
`ghcr.io/osmove/twoody-server` when run by hand or on a `v*` tag):

```bash
docker buildx build --platform linux/arm64,linux/amd64 -t twoody-server .
```

A published image replaces `build: .` with
`image: ghcr.io/osmove/twoody-server:latest` in the compose file.

## Linux / Raspberry Pi

### Raspberry Pi 5: what to expect

- **Hardware**: a Raspberry Pi 5 with 16 GB (8 GB works with the small
  models), the active cooler (generation holds the four cores at 100 %),
  and preferably an NVMe SSD rather than a microSD card: a model is read
  from disk every time it loads.
- **System**: a 64-bit OS — Raspberry Pi OS (64-bit, Bookworm or later) or
  Ubuntu Server 24.04 arm64. A 32-bit system cannot run Ollama.
- **Then either** Docker with Compose (`curl -fsSL https://get.docker.com | sh`,
  which also brings buildx) and the [Docker](#docker) setup, **or**
  Node.js 22 with Ollama installed natively (below).

Ollama supports arm64 natively: `curl -fsSL https://ollama.com/install.sh | sh`
installs it as a systemd service listening on `127.0.0.1:11434`, and the
`ollama/ollama` image is multi-architecture. The Pi has no GPU Ollama can
use, so everything runs on the CPU, and speed is set by memory bandwidth.

Models that fit in 16 GB, with rough generation speeds on a Pi 5 CPU (our
estimates, order of magnitude only — measure on your own board):

| Ollama tag | Download | Memory in use | Generation |
|------------|----------|---------------|------------|
| `qwen3.5:0.8b` | 1.0 GB | ~2 GB | 10–20 tokens/s |
| `qwen3.5:2b` | 2.7 GB | ~4 GB | 5–10 tokens/s |
| `qwen3.5:4b` | 3.4 GB | ~5 GB | 2–5 tokens/s |
| `qwen3.5:9b` | 6.6 GB | ~9 GB | 1–2 tokens/s |

(Qwen 3.5 downloads include a vision encoder, hence sizes above the
usual Q4 figure.) Be honest with yourself about the numbers: a 4B model
at Q4 writes **a few tokens per second**, a short answer takes 10–30
seconds, and reading a long prompt (documents, a long conversation) adds
more before the first word — tens of prompt tokens per second, not
thousands. Qwen 3.5 thinks before it answers by default, and that
thinking is generated at the same speed. For quick replies prefer 2B–4B; the
9B is for when quality matters more than time. `/local_llm/catalog`
(used by the apps' model picker) lists smaller Qwen 2.5 / Llama 3.2 tags
as well.

### Pairing a phone with a server without a Mac

The pairing is the same as with Twoody Desktop, without the screen:

1. Find the address: `http://<hostname>.local:3000` (or the Pi's IP). With
   Bonjour on (npm/systemd installs, or Docker with `network_mode: host`)
   the app can find the server on the network by itself.
2. The first device creates the account with the **setup token** the
   server prints at its first start (`journalctl -u twoody-server`,
   `docker compose logs twoody-server`, or the `setup-token` file in the
   data directory). Enter it in the app where it asks for the pairing
   code of your computer.
3. Once the account exists, other devices pair with the **pairing code**
   the server was started with: 8 capital letters and digits, set with
   `TWOODY_PAIRING_CODE` (or `twoody-server --pairing-code`) — the code
   the desktop app would show on its screen. Change it and restart after
   pairing if you like.

From outside the home network, the phone reaches the server through the
relay tunnel once it has been paired on the same network. The tunnel needs
a Twoody account: `TWOODY_TUNNEL=1` with `TWOODY_BACKEND_URL` and
`TWOODY_USER_TOKEN` (see `scripts/twoody-server.env.example`). Without it,
the server answers on the home network only.

### Adding the server to your Twoody account

`twoody-server login` (or « Ajouter à mon compte » in Twoody Desktop, which
finds a new server on the network) makes the server one of your account's
computers, without a keyboard or a screen on it:

1. it prints a code and `https://twoody.com/appareil` on its own console
   (the terminal, or `journalctl -u twoody-server`); enter the code on a
   device signed in to your account (the web page, Twoody Desktop or the
   app). The code is never shown on the network: Twoody Desktop asks you
   to type it. Once linked, the console says which account (masked, e.g.
   `j***@gmail.com`);
2. once approved, it keeps its credentials in `account.json` in the data
   directory (mode 0600), sends its status every 30 s (models, load,
   speed), lends its models to the account and waits at the relay for your
   devices;
3. a device may then use it when it is the one that approved it, when a
   device that approved it vouches for the request (Twoody Desktop's
   « Appareils »), or when you allow it here: `twoody-server approve`.
   Nothing is allowed for merely being signed in to the same account.

`twoody-server logout` takes it out of the account, and says so when the
account could not confirm it (the server then stays linked; `--force` leaves
here anyway). A server removed from the account elsewhere notices at its next
heartbeat and unlinks itself. Twoody Desktop can then
send it questions — by name, or « Automatique », where each answer goes to
the computer of the account that will write it fastest (and says which).

### systemd unit (npm install)

After `sudo npm install -g twoody-server` (Node 22 from NodeSource) and
Ollama's installer, `/etc/systemd/system/twoody-server.service`:

```ini
[Unit]
Description=Twoody Server
After=network-online.target ollama.service
Wants=network-online.target

[Service]
User=pi
EnvironmentFile=-/etc/twoody-server.env
ExecStart=/usr/bin/twoody-server --data-dir /home/pi/.twoody/data --llm http://127.0.0.1:11434/v1
Restart=always
RestartSec=5
NoNewPrivileges=yes
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=/home/pi/.twoody /home/pi/.twoody-server
PrivateTmp=yes

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now twoody-server
journalctl -u twoody-server -f          # the setup token is printed here
ollama pull qwen3.5:4b                  # or a model of your choice
```

(`which twoody-server` gives the path if npm's prefix is not `/usr`.
`/etc/twoody-server.env` takes the variables of
`scripts/twoody-server.env.example`; `TWOODY_PAIRING_CODE=…` goes there.)

### Installer script (from a checkout)

For a headless install from a checkout of this repository (Raspberry Pi
4/5, generic amd64/arm64 box), use the bundled bootstrap script. It installs Node 22, ripgrep, ffmpeg,
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

### Stopping a reply

`POST /queries` aborts its request to the runtime (or to a cloud provider)
when the client closes the connection — the desktop's Stop button, a closed
window. A local runtime would otherwise keep generating, for minutes on a long
answer, and the next question would queue behind it. The text written so far is
stored as the assistant's message, ending with an ellipsis.

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

#### Lending local models to an account

`llm_infer` tasks run a chat completion on a local OpenAI-compatible
runtime. The worker always streams: each piece of text is sent to the
backend as `PATCH {status: "streaming", delta}` while the model writes,
and the task ends with `{response_json, model_used, latency_ms}`, where
`response_json` is an ordinary completion rebuilt from the stream (tool
calls included). A leading `<think>` block is dropped from both.

| Variable | Meaning |
|----------|---------|
| `BRIDGE_LOCAL_LLM_ENDPOINTS` | comma-separated `/v1` roots, in order of preference (`http://127.0.0.1:8080/v1,http://127.0.0.1:11434/v1`). A model is sent to the runtime that lists it; a model none of them lists is refused (`model_not_installed`), so a request from the backend can never start a download. |
| `BRIDGE_LOCAL_LLM_ENDPOINT` | a single root, for existing setups |
| `BRIDGE_LOCAL_LLM_MODEL` | the model to run when the backend sends a placeholder (`local`, `auto`). Without it, the first model a runtime lists. |
| `TWOODY_DEVICE_TOKEN` | the device token of the app whose session `TWOODY_USER_TOKEN` is. The managed backend binds a session to the device that signed in and answers 401 ("Device token required.") to the token alone. |

The first poll after a start or a failure asks for `wait=1`: a long poll
only answers when a task arrives or the wait runs out, so this is how the
worker (and the app that started it) knows within a second whether the
backend accepts it. A refused token is retried every five minutes, not
every few seconds. Streamed pieces are spaced 150 ms apart.

On every poll the worker sends `X-Bridge-Heartbeat` with the chat models
its runtimes hold (`downloaded_models`), the one in use and the machine's
memory. The apps build their list of local models from it.

`node dist/bridgeWorker.js` runs this worker alone — no HTTP server, no
database — for a machine that only lends its models. The desktop app
starts it that way (configured over the utility-process channel rather
than the environment, so the account token is not readable by other
programs) when a user signed in to a cloud account picks a model
installed on the computer.

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


Document search also checks existing file and granted-folder names without
requiring reindexing. A search passage's optional `match` is `content` or
`name` (for file/folder metadata; its snippet is the first extracted passage).
`/local_documents/files` returns `{files, total, offset, limit}`; each file has
`id`, `name`, `path`, `status`, `chars`, `indexed_at`. Both endpoints require
authentication and lose access when the folder grant is revoked. `/queries`
receives a bounded list of the caller's granted folders and index counts so
it can explain its actual document access. This is the local server's library;
it is not the managed API's synced-chat document source.

Document Q&A accepts per-turn `document_access` on `/queries`: `off`, `all`,
`selected` with `folderIds`, or `only` (optionally scoped). JSON requests use
an object; multipart uses a JSON string. Invalid policy returns 422; revoked
grants never supply new passages. File modification metadata and single-file
follow-up retrieval support document selection and summaries.

### Local semantic documents (optional)

Documents can combine lexical matches with Qwen3 Embedding 0.6B Q8_0
(Apache 2.0, 639 MB), downloaded explicitly by Desktop. Embeddings run in a
separate loopback-only llama-server using two CPU threads; document text never
leaves the machine. The worker unloads after two idle minutes. Keyword search
remains available when semantic search is paused or fails.

`GET/POST /local_documents/semantic` reads status or sets `{enabled: boolean}`;
`POST /local_documents/semantic/reindex` resumes indexing. All require auth.
Vectors are scoped to the user and current grants, cached by content hash and
deleted when a document changes or access is revoked. Indexing is bounded at
20,000 passages per user. Suggested categories do not move or alter files.
`GET /local_documents/files` also accepts `sort=name|modified|category` and
returns `modified_at` (filesystem milliseconds) and optional `category`.

`GET /local_documents/personal` previews a broad personal-files grant;
`POST` requires `{confirmed: true}`. This grants supported documents under
the user's home, not unrestricted computer access. Hidden files, symlinks,
application/system directories, caches and known credential filenames are
excluded. The scan is bounded at 20,000 supported files per folder.
These exclusions are not a content-based secret detector. Ordinary folder
grants still reject whole homes and disk roots.

Standalone deployments can set `TWOODY_EMBEDDING_BINARY` and
`TWOODY_EMBEDDING_MODEL` (see the example environment file). Optional real-model
validation: `npm run build`, then `node scripts/smoke-semantic.mjs` with these
two variables and `TWOODY_SEMANTIC_TEST_PARENT` pointing to a disposable fixture
parent outside system directories. The test retains its temporary database
and moves fixture documents into `~/.Trash`.
