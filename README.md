# Twoody Server (`twoody-server`)

Twoody's local server: one person's chat, memory, documents, projects,
tasks and reminders, in a Fastify + SQLite Node program that never needs
the cloud. It is the server Twoody Desktop embeds on each computer, and
it also runs alone on a Raspberry Pi, a NAS or a Linux box, where the
Twoody app (iPhone) and Twoody Desktop pair with it. Linked to a Twoody
account, it becomes one of the person's computers: it lends its models,
shares encrypted history with their trusted computers and is reachable
through the encrypted relay.

It is **single-user**: it refuses to boot on a publicly bound port when
more than one account exists (`enforceSingleUserGuard` in `src/index.ts`).
It shares no code with the private Rails backend (`twoody-backend`),
whose API shapes it follows where clients use both.

For development context, conventions and architecture, see
[AGENTS.md](AGENTS.md) (and `~/Dev/twoody/AGENTS.md` for the whole
project). Publishing to npm, PyPI and Docker: [PUBLISHING.md](PUBLISHING.md).

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
npm test
npm run dev        # tsx watch, http://0.0.0.0:3000
```

## Without the desktop app

Twoody runs without a Mac: on a Raspberry Pi 5, a NAS or any Linux
server. The server runs its own model engine, llama.cpp's `llama-server`
— the same pinned release and the same GGUF models as Twoody Desktop —
installed when you ask for it and started on the first question (see
[Model engine](#model-engine-moteur)). It can also answer with
[Ollama](https://ollama.com), LM Studio, mlx-lm or any OpenAI-compatible
runtime. Three ways to install it:

| | Needs | Command |
|---|---|---|
| Docker (server with llama.cpp) | Docker with Compose | `docker compose up -d` — see [Docker](#docker) |
| npm | Node.js 22+ | `npm install -g twoody-server`, or `npm install -g twoody` (the Twoody CLI, whose `twoody serve` runs this server) |
| pip | Python 3.9+ and Node.js 22+ | `pip install twoody` (runs the `twoody` npm package through `npx`: `twoody serve`) |

> **Not published yet (1 Oct 2026).** Version 0.2.0 is on none of these
> registries: npm still serves `twoody@0.1.0` (the old CLI) and
> `twoody-server@0.0.1` (April 2026), PyPI has no `twoody` project, and no
> `ghcr.io/osmove/twoody-server` image exists. Today the server is
> installed from a checkout: `docker compose up -d --build`, or
> `scripts/install-linux.sh` ([below](#installer-script-from-a-checkout)).
> The commands above are for the day Jimmy publishes (PUBLISHING.md).

The npm command:

```bash
npm install -g twoody-server
twoody-server runtime install                 # llama.cpp for this computer, checked against its SHA-256
twoody-server models add Qwen3.5-4B-Q4_K_M    # 2.8 GB from Hugging Face, pinned (models list for the others)
twoody-server --data-dir ~/.twoody/data
twoody-server --help      # --port, --host, --data-dir, --llm, --pairing-code, --local-only
```

### Model engine (« Moteur »)

Each computer has an engine preference, kept in `runtime.json` in its data
directory and set from the apps or here:

```bash
twoody-server config get
twoody-server config set runtime=builtin      # or ollama, lmstudio, mlx, auto, http://host:port/v1
twoody-server runtime status                  # which engine answers, the runtime, the models
twoody-server models list | add <id> | rm <id>
```

- **builtin** — llama.cpp run by the server: `llama-server` in router mode
  on `127.0.0.1` only, with a key drawn at each start, `--offline` (it
  never fetches anything by itself), one model in memory at a time. The
  default model is loaded in the background as soon as the server starts
  (`preload=off` to wait for the first question), and kept in memory while
  the server runs when the free memory holds it twice over; otherwise, or
  with `idle_minutes=N`, released after N minutes of silence (30 by
  default; `idle_minutes=never` keeps it, `idle_minutes=default` gives the
  choice back to the server). Not loaded at all when it would not fit in
  the memory available (the chat answers 507 `insufficient_memory`). The runtime is
  `DATA_DIR/runtime/b11146-<platform>-<arch>`, the models `DATA_DIR/models`,
  its output `DATA_DIR/runtime.log`. Linux is CPU only (no Vulkan yet); on
  Linux arm64 it is Osmove's own Clang build of the same llama.cpp commit
  (`scripts/build-llama-arm64.sh`), elsewhere llama.cpp's official release.
- **ollama**, **lmstudio**, **mlx** — the runtime on its usual port
  (Ollama: `TWOODY_OLLAMA_URL` to point elsewhere). **An NVIDIA GPU: use
  Ollama** — there is no official llama.cpp CUDA build for Linux.
- **custom** — any OpenAI-compatible address (`runtime=http://…/v1`).
- **auto** (a new server's default) — the first that has a model: built-in,
  Ollama, LM Studio, mlx-lm.

A server set up before the built-in engine keeps answering as it did: on
its first start, `BRIDGE_LOCAL_LLM_ENDPOINT` on port 11434 becomes
`runtime=ollama`, any other address `runtime=<that address>`.
`TWOODY_RUNTIME` forces the engine whatever the file says. The apps see
the engine as a provider (`id: "engine"` in `/providers`) and manage it
through `/runtime` (the person's own devices only, never another computer
of the account).

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

## Routes

The full, current list is the OpenAPI contract: `openapi.json` in this
repository (regenerate with `npm run openapi`), served live at `/docs` and
`/openapi.json`. The HTTP API answers at the root and under `/api/v1`
(health, docs, admin, `/mcp` and `/ws` stay at the root only). The
families, by file in `src/routes/`:

| Family | Paths | File |
|--------|-------|------|
| Health, capabilities, deployment | `/health`, `/capabilities`, `/deployment` | `health.ts`, `capabilities.ts`, `deployment.ts` |
| Sessions and pairing | `/auth/*`, `/session*`, `/paired_devices*`, `/devices/*` | `session.ts`, `pairedDevices.ts`, `devices.ts` |
| Chat | `/queries` (SSE), `/queries/answer_now`, `/discussions*` | `queries.ts`, `discussions.ts` |
| Providers and engine | `/providers*`, `/runtime*`, `/local_llm/*` | `providers.ts`, `runtime.ts`, `llmModels.ts`, `localLlm.ts` |
| Memory | `/memories*` (candidates, duplicates, import, learn), `/memories/search`, `/memories/retrieve`, `/conversations/search`, `/entities*` | `memories.ts`, `memorySearch.ts`, `entities.ts` |
| Projects, tasks, reminders, notes, events, contacts | `/projects*`, `/tasks*`, `/reminders*`, `/notes*`, `/events*`, `/contacts*`, `/local_sync/*` | `projects.ts`, `tasks.ts`, `reminders.ts`, `notes.ts`, `calendarEvents.ts`, `contacts.ts`, `localSync.ts` |
| Documents | `/local_documents/*` | `localDocuments.ts` |
| E-mails (Capacités) | `/email/status`, `/email/folders`, `/email/recent`, `/email/test`, `/email/account`, `/email/sync`, `/email/kept/:id` — the mailbox read over IMAP (TLS) from this computer, changed from this computer's app only; an Outlook.com or Microsoft 365 mailbox read through Microsoft Graph with the link to Microsoft (`auth: "graph"`: Inbox and Sent Items by delta, a draft created in Drafts, never sent), or, as Twoody 0.13.76 linked it, over IMAP with Microsoft's sign-in (`auth: "microsoft"`, XOAUTH2) | `email.ts` (and `src/email/`) |
| Outlook calendar and contacts (Capacités) | `/microsoft_graph/status`, `/microsoft_graph/account` (POST, DELETE), `/microsoft_graph/sync` — Outlook's or Microsoft 365's calendar and contacts read through Microsoft Graph (GET only) into the Agenda and Contacts tables (source `microsoft`), every 15 minutes while the capability is on; one link for Agenda, Contacts and the E-mails mailbox (the status names the mailbox read with it; removing the link stops it, its copy kept); this computer's app only | `microsoftGraph.ts` (and `src/microsoft/`) |
| Bank (Capacités) | `/bank`, `/bank/transactions*`, `/bank/imports*` (CSV, OFX/QFX, QIF; `/bank/imports/preview` reads without keeping), `/bank/accounts/:id` — statements kept on this computer, read and changed from this computer's app only | `bank.ts` (and `src/bank/`) |
| Account link | `/account/link`, `/account/approvals*` | `accountLink.ts` |
| Other computers (mesh) | `/api/v1/peer/*`, `/api/v1/peers*` | `peer.ts`, `peers.ts`, `peerVault.ts`, `peerDocuments.ts` |
| Usage and diagnostics | `/usage*`, `/diagnostics/turns`, `/diagnostics/telemetry`, `/diagnostics/installation` | `usage.ts`, `diagnostics.ts` |
| Desktop-only gateways | `/api/v1/mobile_agent`, `/code/sessions*` (refused with `desktop_required` / `desktop_unavailable` when the server runs alone) | `mobileAgent.ts`, `remoteCode.ts` |
| Bridge | `/bridge/tasks*`, `/bridge/presence` | `bridge.ts` |
| Voice and household | `/audio/transcriptions`, `/realtime_sessions`, `/tool_calls`, `/members*`, `/voices/*` | `transcriptions.ts`, `realtime.ts`, `toolCalls.ts`, `members.ts`, `voices.ts` |
| Misc | `/me`, `/agents`, `/built_in_capabilities*`, `/tunnel`, `/ws` | `me.ts`, `agents.ts`, `builtInCapabilities.ts`, `tunnelDirect.ts`, `ws.ts` |
| Admin | `/admin` — this machine only, or `TWOODY_ADMIN_TOKEN` from elsewhere | `src/app.ts`, `src/adminAccess.ts` |

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

### Accès par un autre nom

The server answers only to the names it goes by: IP addresses, `localhost`,
local-network names (`.local`, `.lan`, single-label Docker service names…)
and this machine's hostname; any other `Host` gets 421 `host_not_allowed`.
Behind a reverse proxy or on a Tailscale name, list those names:
`TWOODY_ALLOWED_HOSTS=twoody.example.com,pi.tailnet-1234.ts.net` (a leading
dot allows a whole suffix, e.g. `.ts.net`), or set `TWOODY_PUBLIC_URL`. Devices
reaching it that way still need their token.

The console's routes (`/account/link`'s code, `/account/approvals`, `/admin`
without `TWOODY_ADMIN_TOKEN`) are this machine's only when addressed as
`127.0.0.1`, `[::1]` or `localhost`: never under a `.local`/`.lan` name, the
LAN address or `0.0.0.0`, which anyone on the network can point at it. Use
`http://127.0.0.1:<port>/admin`, or the admin token from elsewhere.

## Docker

`docker-compose.yml` runs one service, `twoody-server` (built from this
checkout), with llama.cpp in its image. The same file works on a Raspberry
Pi 5 (arm64) and on an amd64 server.

```bash
docker compose up -d --build
# One model to start with (2.8 GB, into the data volume)
docker compose exec twoody-server twoody-server models add Qwen3.5-4B-Q4_K_M
# The setup token, for the app (also in the data volume, /data/setup-token)
docker compose logs twoody-server | grep "Setup token"
curl http://localhost:3000/health
```

With an NVIDIA GPU, or to keep Ollama and its models, the `ollama` service
runs under a profile:

```bash
docker compose --profile ollama up -d
docker compose exec ollama ollama pull qwen3.5:4b
docker compose exec twoody-server twoody-server config set runtime=ollama
```

The image (`Dockerfile`):

- `linux/amd64` and `linux/arm64`, on `node:22-trixie-slim` (glibc, which
  llama.cpp's Linux builds need); no compiler, no model;
- carries the pinned `llama-server` for its architecture in
  `/opt/twoody/runtime` (`TWOODY_RUNTIME_DIR`), checked against its
  SHA-256 at build time — the build fails if it or a CPU variant it loads
  misses a library (`ldd`); the compose file runs it with `init: true` so
  the runtime is reaped and stopped with the server;
- runs as the unprivileged `node` user (uid 1000);
- keeps everything in the `/data` volume: the SQLite database, the setup
  token, the documents index (`TWOODY_DATA_DIR=/data`), the models
  (`/data/models`) and the engine preference (`/data/runtime.json`), and under
  `/data/home` the bridge device id, compute keys and whisper models;
- has a `HEALTHCHECK` on `GET /health`;
- starts `twoody-server`, so its options work as the command:
  `docker run ghcr.io/osmove/twoody-server --help`, and has the command
  for `docker exec` (`twoody-server models add …`).

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

- **Hardware**: a Raspberry Pi 5 with 16 GB (8 GB works with the 4B
  model), the active cooler (generation holds the cores at 100 %), and
  preferably an NVMe SSD rather than a microSD card: a model is read from
  disk every time it loads.
- **System**: a 64-bit OS — Raspberry Pi OS (64-bit, Bookworm or later) or
  Ubuntu Server 24.04 arm64.
- **Then either** Docker with Compose (`curl -fsSL https://get.docker.com | sh`,
  which also brings buildx) and the [Docker](#docker) setup, **or**
  Node.js 22 natively (below), then:

```bash
twoody-server runtime install                 # llama.cpp, ~9 MB
twoody-server models add Qwen3.5-4B-Q4_K_M    # 2.8 GB
```

The built-in engine on a Pi is Osmove's own build of llama.cpp (Clang,
every ARM CPU generation chosen at run time, so a Pi 4 runs it too; no
OpenMP): the official arm64 build read prompts at 0.73× Ollama's speed on a
Pi 5, this one as fast as Ollama. It runs with the settings measured best
on a Pi 5 — 3 threads writing and 4 reading (`cores − 1`, `cores`),
batches of 128 tokens, the model read into memory rather than mapped
(`--load-mode none`: 3.8–4.1 GB in use instead of 6.1 GB) and an 8k
context. `config set threads=… ctx=…` changes them.

Everything runs on the CPU, and speed is set by memory bandwidth. Measured
on a Pi 5 (16 GB, microSD card), Qwen3.5 4B Q4_K_M, reasoning off
(30/09/2026):

| | |
|---|---|
| Reading the prompt | ~22 tokens/s |
| Writing | ~3.8 tokens/s |
| First question after a start | ~13 s to the first word (7 s of it loading the model) |
| Next questions | ~1.2–1.6 s to the first word (the conversation's start is kept in cache) |
| Memory in use | ~3.7 GB |

Be honest with yourself about the numbers: a short answer takes several
seconds, and reading a long prompt (documents, a long conversation) adds
more before the first word — tens of prompt tokens per second, not
thousands. The first question after a start or after 30 minutes of
silence also loads the model (a few seconds from an SSD, more from a
microSD card). The 9B (`models add Qwen3.5-9B-Q4_K_M`, 16 GB boards) is
for when quality matters more than time.

Ollama remains an option (`runtime=ollama`): `curl -fsSL
https://ollama.com/install.sh | sh` installs it as a service on
`127.0.0.1:11434`. A Pi set up with Ollama before the built-in engine keeps
using it until you switch (`config set runtime=builtin`, then `models add`;
the apps may offer to remove Ollama's models, never on their own).

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

After `sudo npm install -g twoody-server` (Node 22 from NodeSource),
`/etc/systemd/system/twoody-server.service`:

```ini
[Unit]
Description=Twoody Server
After=network-online.target
Wants=network-online.target

[Service]
User=pi
EnvironmentFile=-/etc/twoody-server.env
ExecStart=/usr/bin/twoody-server --data-dir /home/pi/.twoody/data
Restart=always
RestartSec=5
# The built-in engine runs in the unit's control group: stopped with it.
KillMode=control-group
TimeoutStopSec=10
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
twoody-server --data-dir /home/pi/.twoody/data runtime install
twoody-server --data-dir /home/pi/.twoody/data models add Qwen3.5-4B-Q4_K_M
```

(`which twoody-server` gives the path if npm's prefix is not `/usr`.
`/etc/twoody-server.env` takes the variables of
`scripts/twoody-server.env.example`; `TWOODY_PAIRING_CODE=…` goes there.)

### Installer script (from a checkout)

For a headless install from a checkout of this repository (Raspberry Pi
4/5, generic amd64/arm64 box), use the bundled bootstrap script. It installs Node 22, ripgrep, ffmpeg,
poppler-utils, avahi-daemon, copies the repo to `/opt/twoody-server`,
installs the production dependencies (`better-sqlite3`'s prebuilt
binary, nothing compiled), links the `twoody-server` command, installs the
built-in engine (`twoody-server runtime install`) and registers a systemd
unit. Then `twoody-server models add Qwen3.5-4B-Q4_K_M`.
`TWOODY_WITH_OLLAMA=1` installs Ollama too.

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

To update such an install from a laptop that has a checkout,
`scripts/upgrade-linux.sh [user@host] [remote path]` rebuilds `dist/`,
rsyncs it to `/opt/twoody-server` and restarts `twoody-server.service`
(defaults and overrides in the script's header).

Jimmy's own Pi does not use either path: it runs the server as the user
service `twoody-next` (port 3031, data in `~/twoody-next/data`), installed
from an `npm pack` tarball; the procedure is in `~/Dev/twoody/AGENTS.md`
§6.

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

Bridge tasks are kept in memory (`routes/bridge.ts`): a restart loses the
queue.

`/queries` is local-first: a stored local OpenAI-compatible provider, else
this computer's engine ([Model engine](#model-engine-moteur)), else
`BRIDGE_LOCAL_LLM_ENDPOINT`. Cloud keys are only used when
`TWOODY_CLOUD_FALLBACK_ENABLED=true`.

`TWOODY_LOCAL_ONLY=1` goes further: the server refuses every outbound call to
a host that is not this machine or a private-network address, whatever else is
configured. Cloud fallback, `/realtime_sessions`, Spotify and an upstream
bridge backend are all off, `/devices/llm_keys` returns no keys, and
`/capabilities` and `/deployment` report `local_only: true` so clients can show
it. Downloading a model through Ollama is unaffected (Ollama makes that call,
and it carries no user content). So are the downloads the person asks for
for the built-in engine (`runtime install`, `models add`, the apps'
« Modèles »): to their pinned hosts only (GitHub's release hosts or
downloads.twoody.com for the runtime, Hugging Face for the models), checked
against their SHA-256, and said in the log.

Bridge pollers can declare capabilities with `X-Bridge-Capabilities`, using a
comma-separated or JSON array value such as `document-provider,local-llm-provider`
(known: `document-provider`, `local-llm-provider`, `voice-device`).

The task kinds and their wire shapes are defined by `src/routes/bridge.ts`
and `src/executors/`. The JSON schema once written for the macOS worker
(`bridge-v1.schema.json`) lives in the dormant `twoody-mac` repository
(`twoody-mac/shared/`) and is no longer kept in step.

### Local STT (whisper.cpp)

`POST /audio/transcriptions` proxies multipart audio uploads to a
local `whisper-cli` (whisper.cpp) and returns `{ text: "…" }`. Wire-
compatible with the subset of OpenAI's `POST /v1/audio/transcriptions`
the iPhone app uses, so swapping the endpoint URL is enough
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
recovery. The script reads the default data directory: the `twoody-next`
service on Jimmy's Pi keeps its data in `~/twoody-next/data` instead
(`--data-dir`), which it does not cover as written.


## Documents

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

## License

Twoody Server is licensed under BSL 1.1 with a change date of
2030-04-21, after which the covered version converts to Apache 2.0. See
[LICENSE](LICENSE).
