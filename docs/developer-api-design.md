# The developer API and the `twoody` command

30/10/2026, Jimmy: « Sortir twoody en ligne de commande et l'API locale », « rendons Twoody plus developer-friendly »;
the API needs a key, and answers this computer only.

Twoody already runs a model on the person's computer (llama.cpp, MLX on a Mac). This makes that model usable from a
developer's own programs and from the terminal, the way Ollama and LM Studio are, without giving them anything else
of Twoody.

## 1. Endpoints

On the local server (twoody-server: embedded in Twoody Desktop, or `twoody serve`), at the root, OpenAI-compatible:

| Route | What it does |
|---|---|
| `GET /v1/models` | The chat models this computer holds (built-in runtime first, then the local runtimes the person added: LM Studio, Ollama), plus the semantic search model when it is installed. `loaded` says which is in memory. |
| `POST /v1/chat/completions` | Passed to the runtime that holds `model`, streamed (`stream: true`, SSE) or not, and its answer passed back as it comes (`src/runtimeRelay.ts`, the same code as `/api/v1/peer/v1/chat/completions`). At most 512 messages and 128 tools; `max_tokens` capped at 32 768. |
| `POST /v1/embeddings` | The semantic search model (Qwen3 Embedding 0.6B, `src/embeddings.ts`), 1 to 64 texts, normalised vectors of 1 024 dimensions. 404 `model_not_found` when it is not installed. |

Errors are OpenAI's: `{ "error": { "message", "type", "code", "param": null } }` — 401 `invalid_api_key`, 403
`local_only`, 400 `invalid_request`, 404 `model_not_found`, 503 `busy` (another answer is being written: the request
waits up to 30 s for its turn first) or `runtime_unavailable`.

Only `model`, `messages`, `tools`, `tool_choice`, `max_tokens`, `temperature`, `top_p`, `stop`, `stream`,
`stream_options`, `response_format`, `seed` and the runtime's reasoning switches (`chat_template_kwargs`,
`reasoning_effort`, `thinking_budget_tokens`) go to the runtime; anything else is dropped. The request uses the
owner's slot (slot 0 when the computer is shared, `runtimeSlots.ts`) and counts as one chat generation
(`account/inflight.ts`), so it never runs beside an answer of the app on the same slot.

**Raw models only.** The API never touches the person's memory, documents, conversations, projects, people,
reminders, connectors, e-mail, calendar, Home Assistant, the web, nor Twoody's tools or system prompt. Nothing of the
conversation is kept: one usage event per answer (`model_calls`, source « api », client `api:<key name>`), the
tokens and times shown in « Utilisation ».

The keys, for the owner only (§3):

| Route | |
|---|---|
| `GET /api/v1/api_keys` | Name, first 12 characters, created, last used (to the minute), revoked. Never a token. |
| `POST /api/v1/api_keys` `{ name }` | 201 `{ token, api_key }`: the token is shown this once. At most 50 live keys. |
| `DELETE /api/v1/api_keys/:id` | Revoked (`revoked_at`), kept. |

## 2. Where it is: the address

- **Twoody Desktop**: its server listens on 127.0.0.1, port 47821 when free (`twoody-desktop/src/main/localServer.ts`
  `PREFERRED_PORT`). The API is `http://127.0.0.1:47821/v1`.
- **`twoody serve`**: port 3000 unless `PORT` says otherwise.
- **Either way** the server writes `~/.twoody/local-server.json` once it listens (`src/developerApi/discovery.ts`):
  `{ url, api, kind: "desktop" | "server", pid, version, started_at }`, mode 0600, removed when it stops. The
  Desktop's server wins: a `twoody serve` started while it lives leaves the file to it. The `twoody` command reads
  this file, checks `/health`, then tries 47821 and 3000. `TWOODY_DISCOVERY_FILE` moves it (the bench's fake home);
  `off` writes none.
- Réglages › « Développeurs » in the Desktop shows the address and an example.

## 3. Who may call it

A request to `/v1/*` is answered only when both hold:

1. **It comes from a program of this machine** (`apiCallerHere`): from a loopback address, addressed as `127.0.0.1`,
   `[::1]` or `localhost` (a local-network name, `0.0.0.0` or a rebound domain is refused: anyone on the Wi-Fi can
   point `evil.local` here), not through the tunnel (`x-twoody-via-tunnel`: a phone or another computer), not
   forwarded by a proxy (`X-Forwarded-For`, `Forwarded`, `X-Real-IP`), not sent by a browser from a web page (an
   `Origin` other than the server's own, or `Sec-Fetch-Site` other than `none` / `same-origin`, `webOrigin.ts`). A
   site's own domain never gets that far (`hostGuard`, 421). `TWOODY_API_ALLOW_NETWORK=1` lifts the address rule
   only — for the Docker image, whose port is published on the host's loopback (`-p 127.0.0.1:3000:3000`); the
   tunnel and web pages stay refused.
2. **It carries a live local API key**: `Authorization: Bearer twk_…`. A key is `twk_` and 43 characters of
   base64url (256 bits of randomness), stored as its SHA-256 only (`api_keys`, migration 21, local only in
   `schema/contract.json`); looked up by its digest and compared again in constant time; revoked keys are refused.

A key is not a session: `auth.ts` never finds it (it is in neither `auth_sessions` nor `devices`), so it opens
`/v1/*` and nothing of Twoody's own routes. A session token is not a key: `/v1/*` refuses it.

**Making keys** (`keyOwner`): the owner, from here — this machine's console (a request `localAccess.ts
ownerRequest` accepts: from this machine, no admin token set; or the admin token), or the owner's session from this
machine or through the tunnel of its own key (`sessionTrust.ts ownerHere`, the Desktop's window). Never a phone or
a device paired by code, a peer, a household member, nor anything from a web page. On a fresh `twoody serve` with no
owner yet: 409 `setup_required` (`twoody setup` first; `twoody api-key create` does it for you on this machine).

## 4. Threat model and security review (rule 12)

This adds a way into the computer's models, not into the person's data, and does not change the trust between
devices (`sessionTrust.ts` is unchanged: no new session origin, no new rule).

| Attack | Answer | Test (`test/developerApi.attack.test.ts`) |
|---|---|---|
| A web page in the person's browser posts to `http://127.0.0.1:47821/v1/…` | Refused (Origin / Sec-Fetch-Site), and it has no key; CORS lets no site read an answer | « refused from anywhere but this machine's programs » |
| DNS rebinding (`evil.example` → 127.0.0.1) | 421 by `hostGuard` before any route | same |
| A page served from a local-network name pointed here (`evil.local`) or `0.0.0.0` | 403 `local_only` (not addressed by a loopback name) | same |
| Another device of the network with a stolen key | 403 `local_only` | same |
| A phone or another computer through the tunnel | 403 `local_only` | same |
| A reverse proxy on the same host | 403 `local_only` (forwarding headers) | same |
| A forged, revoked or empty key, a session token as a key, Basic auth | 401 `invalid_api_key` | « no key, a forged key… » |
| A key used on `/api/v1/memories`, `/discussions`, `/me`, documents, or to make more keys | 401 / 403: a key is not a session | « a key opens /v1/* and nothing of Twoody's own » |
| A code-paired phone, a peer, the owner's token through the tunnel or from the network making a key | 401 / 403 | « only the owner here makes keys » |
| A key read from the database | Only its SHA-256 is stored; the list shows 12 characters | « the list never shows a token » |
| The request smuggling Twoody's context (`user`, unknown fields) or receiving the person's | Unknown fields dropped; the runtime gets the messages as sent, no memory, document or system prompt added; nothing kept but a usage event | « a key from this machine… » |

What stays outside the walls, said plainly: **any program of this computer that has the key** can use the models
(that is the point); and, as before this change, a program of this computer without a key can already act as the
owner on the routes that trust this machine's console (`localAccess.ts`, `/admin`, the runtime) — the key does not
make the computer safer against software already running on it as the person, it keeps the browser and the network
out and names who uses the models. A walled-off project is untouched: the API reaches no folder, document or
conversation of any project.

## 5. The `twoody` command (twoody-cli)

- `twoody run <model> [prompt]`: one answer, or a conversation in the terminal, through `/v1/chat/completions`.
- `twoody list`, `twoody ps` (in memory), `twoody pull <model>`, `twoody rm <model>`: through `/api/v1/runtime`
  (`routes/runtime.ts`, owner of this machine — the same console rule as above).
- `twoody api-key create [name] | list | revoke <id>`: through `/api/v1/api_keys`; the key made for the command
  itself is kept in `~/.twoody/api-keys.json` (0600), one per server address; on a fresh `twoody serve` with no
  owner yet, the command makes this user its owner with the setup token the server left in its data folder.
- Server: the one `~/.twoody/local-server.json` names, else 127.0.0.1:47821, else 127.0.0.1:3000; `--server <url>` or
  `TWOODY_SERVER_URL` to choose.

Installed by the Desktop (Réglages › « Développeurs » › « Installer la commande twoody »), Homebrew, npm, pip or
Docker (`twoody-cli/docs/publish-steps-2026-11.md`).
