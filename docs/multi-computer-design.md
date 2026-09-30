# Twoody — headless computers and several computers per device (design, 29/09/2026)

Approved by Jimmy on 29/09/2026: (A) a headless computer (Raspberry Pi, server without the Desktop app, no camera/keyboard) joins the account and household; (B) one device uses several computers, with a router sending each request to the best one (task-level, never splitting a model).

## 1. Reused, and where the single-computer assumption lives

Reused:
- Account pairing: twoody-backend `account_computers_controller.rb` (`request_access`, `pending`, `decide`, `result`, `consume`; only the host's `X-Computer-Credential` approves). Desktop: `src/main/accountPairing.ts`, `accountPairingCrypto.ts` (`sealPairing`, X25519+HKDF+AES-GCM); app opens it in `utils/accountPairing.js`. Payload built in Desktop `main.ts` ~810-818 by calling the local server's `/auth/pair` with a `tunnel_public_key`.
- Device-code precedent: `devices#pre_pair`, `pre_pair_status`, `pre_pair_claim`.
- Tunnel: twoody-server `src/tunnel/*`; rendezvous per key pair (`channel.ts:rendezvousId`) so one device can talk to several computers; `client.ts` gives a fetch-like `request` usable from a server; `index.ts` one host link per peer. Backend `TunnelRelay`/`TunnelChannel` scoped by `user_id`; `MAX_SESSIONS_PER_USER = 4` must become 16.
- The Pi already appears through the bridge: `src/bridgeClient.ts` → `bridge_tasks_controller#sync_mac_bridge_device!` creates a `Device` (`client_kind: "mac_bridge"`), heartbeat of models, `BridgePresence`; `ComputeGrant` / `compute_grants_controller#own_computers` accept it → sharing the Pi only needs UI.
- Usage: `src/routes/usage.ts`, `usageStore.ts`. Samples come only from the Desktop today → a headless Pi records no load (add a self-sampler).
- Bonjour: server `src/bonjour.ts`, Desktop browse `main.ts` ~710. Shared computers in the app picker: `utils/sharedComputers.js` (`shared:<hostId>`).

Single-computer assumption (app): `contexts/SettingsContext.js`, `utils/settingsStore.js` (scalars `localServerUrl`, `localServerToken`, `computerTunnelKey`); `utils/pairing.js` (`withPairing`/`isPaired`); `utils/localRoute.js` (module singleton); `constants/Api.js` `rewriteForLocalServer`; `App.js` ~81-82, ~334-349; `utils/computerModels.js` `COMPUTER_PROVIDER_ID='local'`; screens keyed on `settings.localServerUrl` (CodeSession, LocalDocuments, MobileAgent, ChatView, `conversationSync.syncKey`).

Decision: keep a **primary** computer that owns conversations, memories and documents, mirrored into the legacy scalar fields (≈20 call sites untouched). Other computers are extra targets, reached by the primary's router, or directly by the phone for status/usage.

## 2. Data model and API contracts

### Backend (`/api/v1`, all additive)
Migration:
- `account_computers`: + `kind` ("desktop"|"server"), `platform`, `bridge_device_uuid`, `status` jsonb (≤ 4 KB), `approver_keys` (string[] hex).
- `computer_authorizations`: + `role` ("device"|"peer", default "device"), `endorsements` jsonb (≤ 5).
- new `computer_logins`: `device_code_digest`, `user_code` (unique), `name`, `platform`, `public_key`, `device_token`, `state`, `expires_at`, `user_id`, `approver_key`, `approver_kind`, `account_computer_id`, `session_delivered_at`.

Device-code login (RFC 8628 shape):
```
POST /computer_logins                (no auth; 5 per IP per 15 min)
 {name, platform:"linux", public_key:<64hex pairing key>, device_token}
→201 {device_code, user_code:"WDJB-MJHT", verification_uri:"https://twoody.com/appareil",
      verification_uri_complete:"…/appareil?code=WDJB-MJHT", expires_in:600, interval:5}
POST /computer_logins/poll {device_code}
→200 {state:"pending"} | 429 {error:"slow_down"} | 403 {error:"denied"} | 410 {error:"expired"}
→200 {state:"approved", account_id, user_token, computer:{id,name,public_key}, credential,
      approver:{kind:"computer"|"phone"|null, public_key|null, name}}   (once, then 410)
GET  /computer_logins/:user_code            (user auth) → {name, platform, expires_at, fingerprint}
POST /computer_logins/:user_code/approve    (user auth) {approver:{kind, public_key, proof?}?} → 204
     proof: login-approver/v1 (vault/contracts.ts), the HMAC keyed by the one-time secret the computer's console
     shows with the code (never sent to the account) over the approver key, the computer's tunnel key and the code.
     The computer pins the approver key the poll hands back (approver.proof with it) only when the proof holds.
POST /computer_logins/:user_code/deny       (user auth) → 204
```
Approving creates an `AccountComputer` `kind:"server"` with the Pi's `public_key`, issues an `AuthSession` `client_kind:"server"` bound (via `auth_surface_device_for`) to the Pi's device token, sets `approver_keys=[approver.public_key]`. `user_code`: 8 chars from the existing unambiguous alphabet; wrong codes limited to 10 per user per hour. `GET /appareil`: HTML sign-in + approve page like `/pair`; approving from the web pins no approver.

Listing: existing `GET /account_computers` gains fields (old clients ignore them):
```
{account_id, computers:[{id, name, public_key, online, kind, platform, host_id:<bridge uuid|null>,
  last_seen_at, approval:"host"|"delegated", approver_keys:[hex],
  status:{app_version, models:[{id, loaded}], load:{cpu_pct, gpu_pct, ram_used_pct, at},
          tps:{"<model>":23.4}, inflight:0, accepts:["chat","background"], tools:true}}]}
```
`POST /account_computers/:id/heartbeat {status}` validates/stores status (empty body still valid for the Desktop). `DELETE /account_computers/:id` (user auth) revokes it and its AuthSessions.

Delegated approval:
```
GET  /account_computers/delegated_requests?approver_key=<hex>   (user auth)
→ {requests:[{host_id, host_name, id, name, role, public_key, expires_at}]}
POST /account_computers/:id/authorizations/:rid/endorse {approver_key, endorsement}  → 204
```
`pending` (host credential) returns each request's `role` and `endorsements`; `request_access` accepts optional `role`; `TunnelRelay::MAX_SESSIONS_PER_USER` → 16.

Who approves on a headless host — never auto-approve for the same account (a leaked bearer token or a household member would get the Pi's local data). The Pi approves only when:
1. the requester's key is a pinned approver key (the sealed envelope only opens with that private key) → the device that typed the code is paired immediately;
2. the request carries a valid endorsement from a pinned approver (the Mac's « Appareils » shows « iPhone de Claire veut accéder au Raspberry Pi »);
3. `twoody-server approve` on the Pi's console.

Endorsement v1:
```
key = HKDF-SHA256(X25519(approver_priv, host_pub), salt="twoody-endorse-v1:"+rid, info="approval endorsement", 32)
msg = "twoody-endorse-v1\n"+host_id+"\n"+rid+"\n"+requester_key+"\n"+expires_at
endorsement = base64(HMAC-SHA256(key, msg))
```
`host_id` is the host's **AccountComputer id** (the id login/poll returns for it, the `:id` of `/account_computers/:id/…/endorse`, `delegated_requests[].host_id`) — not the bridge uuid the listing calls `host_id`. `rid` and `host_id` are sent as decimal strings; `expires_at` is the request's string exactly as the backend serialised it.
Test vectors: `twoody-server/test/fixtures/endorsement-v1.json` (copied into Desktop and app tests). Status object: `test/fixtures/computer-status.schema.json`.

### Server (twoody-server, headless)
- `DATA_DIR/account.json` (0600): `{backend_url, account_id, user_token, device_token, computer:{id, credential}, pairing_key:{priv, pub}, approvers:[…]}`; env `TWOODY_USER_TOKEN`/`TWOODY_BACKEND_URL` take precedence.
- Once linked: heartbeat (30 s, with `status`); approval loop (15 s; rules 1–3; calls `/auth/pair` internally; seals with a port of `sealPairing`; payload `{localServerUrl, localServerToken, computerTunnelKey, computerName, computerId, kind}`); bridge client (`llm_infer`, so « Partager » works); tunnel.
- `role:"peer"` requests get a session `peer:<name>` limited to `/api/v1/peer/*`.
- Local link routes (loopback or admin token): `GET /account/link` → `{state:"unlinked"|"pending"|"linked", user_code?, verification_uri?, expires_at?, account_computer_id?}`; `POST /account/link` starts a new code. The `user_code` is served on the LAN only while the server is fresh (no local user, no granted folder).
- Bonjour TXT + `account=unlinked|linked`, `fp=<8 hex of pairing pub>`.
- `src/machineSampler.ts`: CPU/RAM/GPU every 15 s when there is no Desktop parent.

### Phone settings
```
settings.computers: [{id:<account computer id|"lan:"+key8>, name, kind, url, tunnelKey, primary:bool, pairedAt}]
secure: twoody.computerSession.<tunnelKey[0..16]>
```
`withPairing` adds/updates an entry; the primary is mirrored into `localServerUrl`/`localServerToken`/`computerTunnelKey`; migration turns a legacy triple into `computers[0]` primary (idempotent). `localRoute.js` → `Map<tunnelKey,{direct, relay, directFailedAt}>`, `configureTunnels(list, common)`, `routeFetch(url, init, {computerKey})` defaulting to the primary.

## 3. Router — server side, in the primary's `/queries`
Context (history, memories, passages, personal data) is built where the data lives. The Mac's own chat gets routing through the same code. The phone only does failover: if the primary is unreachable, a banner offers « Continuer avec le Raspberry Pi » (switches the primary).

Peer protocol (server to server over the sealed tunnel; `src/tunnel/client.ts`, LAN `/tunnel` directly else the relay):
- `GET /api/v1/peer/status` → the heartbeat `status` object.
- `POST /api/v1/peer/v1/chat/completions` — OpenAI-compatible passthrough (model, messages ≤ 64, tools?, max_tokens ≤ 4096, stream, `x_purpose:"chat"|"background"`). Errors 404 `no_model`, 503 `busy` (above max_concurrent: 1 chat + 1 background). The peer stores nothing but a usage event (`source:"peer"`, `client` = calling computer).
- On the primary a peer is a provider kind `peer_openai` (computerId, model) whose fetchImpl is the tunnel; streamFromProvider/thinkFilter/usage/tool loop reused. `onThisComputer()` widened to own peers; other people's shared computers stay explicit only (existing sealed ComputeGrant path), never picked automatically.
- `GET/POST/DELETE /api/v1/peers` (Desktop only). `POST {computer_id}` runs `request_access` `role:"peer"` with the server's tunnel key and returns `{request_id}` for the Desktop to endorse.

Scoring (`src/router/score.ts`, pure):
1. candidates: self + enabled peers with status < 60 s old, holding the exact model (or, for « Automatique », their loaded model), `tools:true` if the turn uses tools;
2. exclude `inflight ≥ max`, or RAM > 90 % when the model is not loaded;
3. `est = tokens/tps_p50(model, computer) + (loaded ? 0 : 10 s) + inflight × 15 s`, ×1.5 when CPU or GPU > 85 % in the last two samples; unmeasured prior 10 tok/s Linux ARM, 30 elsewhere;
4. stickiness: the previous turn's computer keeps it unless another is ≥ 30 % better; self wins ties within 20 %.
Fallbacks: failure before the first token (handshake 2.5 s LAN / 8 s relay, 503, network) → next candidate, max 2 tries; after the first token the error is shown, never switched silently; an explicit `computer:<id>` gets no automatic fallback (the error offers « Répondre avec le Mac ? »).
UI: `/providers` gains `auto:true` and `computers:[{id, name, kind, self, online, models:[{id, loaded, tps}]}]`; picker: « Automatique », one section per computer (offline greyed), shared computers, cloud; provider id `computer:<id>`. `final` and `messages` store `answered_by:{computer_id, computer_name, model, routed:"auto"|"explicit"|"fallback"}`; footer « qwen3:8b · Raspberry Pi · auto ».
Background offload v1: the primary's job runner (memory extraction, titles) calls `router.pick({purpose:"background"})`, preferring the computer set in « Tâches de fond » (automatique / ce Mac / le Pi) when idle (inflight 0, CPU < 50 %), else local or postponed. Transcription and indexing not offloaded in v1.

## 4. Lots (contracts above; endorsement vectors; status schema)
1. Backend: migrations, ComputerLoginsController + `/appareil`, extended index/heartbeat, delegated requests + endorse, DELETE, relay cap. Tests: poll pending→slow_down→approved once→410, denied, expired; user_code rate limit; approver key format; credential once; other accounts never in delegated_requests; endorse of another account refused; index backward compatible; DELETE revokes sessions; relay accepts 16.
2. Server + CLI: link state machine + account.json, loops, `/account/link`, Bonjour TXT, approval rules, peer-limited sessions, `/peer/*`, `/peers`, `peer_openai`, router, sampler, `answered_by`, `twoody-server login|approve|logout`; CLI `twoody login` offers « Lier ce serveur ». Tests: device code vs fake backend; account.json 0600; rules 1–2 with vectors, forged/expired stay pending; peer session on a non-peer route → 403; table-driven scoring, fallback before first token, stickiness; smoke with two servers on loopback, one via `/tunnel`.
3. Desktop: « Appareils » lists the account's computers (state, load, speed, « Partager » per computer via the Pi's `host_id` and `/compute_grants`); delegated requests with endorse/deny; Bonjour « Ajouter à mon compte » (one click when fresh, else a code field) approving with the Desktop's pairing key as approver, then `POST /peers` and automatic endorsement; `computerId` in the tunnel message; per-computer picker; « Tâches de fond » setting. Tests: endorsement vectors, Bonjour TXT parsing, Appareils fixtures, add→peer chain (mocked).
4. App: settings migration, multi-computer localRoute, « Ajouter un ordinateur » code entry (approves with the phone's tunnel key, then request_access auto-approved), per-computer « Appareils » (usage through each computer's tunnel), picker sections + « Automatique », `answered_by` footer, failover banner, endorsing in « Appareils ». Tests: migration idempotence, two keys → two clients with primary default, removal closes its client, picker with an offline computer, footer, full code flow with a fake API.
Deployment: backend first (additive) → server npm/Docker → Desktop release → app OTA (behaves as today when `/providers` has no `computers`).

## 5. Risks and deferred
Risks: backend introduces the approver key once (TOFU; later: compare fingerprints); LAN neighbour adopting a fresh Pi (one-click only when fresh); relay load (one wait per peer; Redis 25 MB); losing the KV cache when routing away (stickiness); model names differ between runtimes (exact names only in v1); speed/load cross the backend (bounded fields).
Deferred: splitting a model across computers; offloading transcription/indexing (v1.1, LAN only: 3 MB relay limit); automatic routing to others' shared computers; phone-side per-request routing; history merged across computers (vault); approvers UI; model alias table.

## 6. Lot 2 as built (twoody-server, 29/09/2026)
- `src/account/`: `store.ts` (account.json), `link.ts` (device code, poll interval from the backend, +5 s on slow_down, denied/expired end it), `approvals.ts` (rules 1–2 pure in `judge`, loop every 15 s, `twoody-server approve` for rule 3), `pairingSeal.ts` (port of the Desktop's `sealPairing`, cross-checked with an envelope the Desktop sealed: `test/fixtures/account-pairing-v1.json`), `service.ts` (heartbeat with `status`, `platform`, `bridge_device_uuid`; bridge; tunnel), `statusSource.ts`.
- `GET /account/link` also returns `fresh` and `fp` (= `fingerprint`, 8 hex of the pairing key, as Bonjour's `fp` and the backend's login `fingerprint`). `POST /account/link` is accepted from the LAN **while the server is fresh** (the code is shown there anyway), so Desktop's one click can start a code; otherwise loopback or admin token. Requests through the tunnel are marked `x-twoody-via-tunnel` and are never "this machine".
- Twoody Desktop gives the embedded server its account with `{type:"account"|"tunnel", backendUrl, userToken, deviceToken, computerId, computerName}` (the `account` message works without `TWOODY_TUNNEL`); without `computerId`, the server calls itself `self` in `/providers` and `answered_by`.
- `/queries`: `provider:"auto"` (model optional) or `provider:"computer:<id>"` (model optional); anything else behaves as before. `answered_by = {computer_id, computer_name, model, routed, auto}`; an explicit computer that fails before its first word ends with `error: computer_unavailable, fallback:{computer_id, computer_name}` (this computer). Up to 2 fallbacks for « Automatique ».
- `/providers` `computers[]` entries also carry `peer` (linked as a peer, so selectable). `/me` has `background_computer` ("auto" | "self" | "computer:<id>").
- Peer protocol errors: 404 `no_model`, 503 `busy`, 422 `invalid_request`; `max_tokens` is cut to 4096, not refused. Usage events on the answering computer have `source:"peer"`; the asking computer records none for that answer.


## 7. Review fixes (twoody-server, 29/09/2026)
- A `peer:` session is refused by `authenticate()` itself outside `/api/v1/peer/*`, whatever carries the token (header, `/ws?token=`).
- `GET /account/link` from the network answers `{state, fp}` only, fresh or not; the code is printed on the server's console and shown by `twoody-server login`, and the Desktop asks the person to type it. At most one live code: `POST` while one is pending answers with it (200). From the network a new code only once the previous one would have expired and at most one attempt every 3 min (429 `code_recently_asked`, `Retry-After`). Once linked, the console says which account: e-mail or name masked (`j***@gmail.com`) from the poll answer (`account`/`user` `{email, name}` if the backend adds them), else `account <id>`; kept as `account_label` in account.json.
- Sessions record how they were given (`auth_sessions.origin`: `owner` = signup/signin/setup token, `code`, `account`). `/api/v1/peers` and the Desktop's usage/sync reports require `owner` (or this machine / the admin token), never a name.
- Heartbeat refused (401/403) twice in a row: the server unlinks itself (account.json keeps `pairing_key` and `device_token`, 0600), stops its loops and drops the `account` sessions. `twoody-server logout` keeps account.json when the backend did not confirm (502 `leave_unconfirmed`), `--force` leaves anyway; leaving drops the `account` sessions too.
- The sender looks at `GET /account_computers` every 5 min and on 401/404/410: a peer no longer listed becomes `removed`, one answering 401 `revoked`; neither is routed to.
- `account_peers.trusted` (false by default; `PATCH /api/v1/peers/:id {trusted}`, owner only, answers 200 with the peer): an untrusted peer is given the conversation only (no memories, contacts/calendar, excerpts, document list, custom prompt, name; earlier prompts as typed). `trusted` in `/api/v1/peers`, `/providers` `computers[]` (true for this computer) and in `answered_by` for a peer's answer. Memory extraction goes only to a trusted peer.
- With account.json's session, account.json's `device_token` always (`TWOODY_DEVICE_TOKEN` only beside `TWOODY_USER_TOKEN`), since the backend binds the session to the token given at `POST /computer_logins`.
- Owner routes: the admin token is compared in constant time; `X-Forwarded-For` / `Forwarded` / `X-Real-IP` make a loopback request not this machine's (behind a reverse proxy, set `TWOODY_ADMIN_TOKEN`).

## 8. Second review fixes (twoody-server, 29/09/2026)
- Host allowlist for every request (`src/webOrigin.ts`, 421 `host_not_allowed`): any IP address, `localhost`/`*.localhost`, single-label names (Docker service names), `.local`, `.lan`, `.home`, `.home.arpa`, `.internal`, `.localdomain`, this machine's hostname, the host of `TWOODY_PUBLIC_URL`, and `TWOODY_ALLOWED_HOSTS` (comma-separated, `.suffix`, `*` to turn it off). A refused WebSocket upgrade has its socket closed.
- CORS answers only `null` (the Desktop's `file://` window), `app://twoody`, `http://localhost|127.0.0.1|[::1]:*` and `TWOODY_CORS_ORIGINS`.
- "This machine" (`fromThisMachine`, `/admin`) also requires no Origin other than the server's own and `Sec-Fetch-Site` absent, `none` or `same-origin`; `/admin` refuses what the tunnel served (relay or LAN `/tunnel`). `POST /account/link` from another page is 403 `cross_site_forbidden`.
- Third review: "this machine" (`fromThisMachine`, `/admin` without the token, hence `/account/link`'s owner view, `/account/approvals`, the owner fallback of `/api/v1/peers`) also requires the Host to be exactly `127.0.0.1`, `[::1]` or `localhost` (any port): a `.local`/`.lan`/single-label name anyone on the LAN can rebind, the LAN address and `0.0.0.0` are the network's view. The allowlist above still serves token traffic under those names.
- Unlink only on 403 `computer_revoked` or 401 `session_revoked`/`session_expired`, twice in a row; 403 `invalid_computer_credential` is logged once.
- Pending requests: `requester_kind`, `requester_computer_id`, `requester_name`, `requester_computer {id, name, public_key}`. A computer (role `peer`, `requester_kind:"computer"` or a requester computer id) always gets a `peer:` session, named `requester_computer.name`. `/auth/pair` takes `requester_computer_id` too (peer session). `auth_sessions.requester_computer_id` is kept; when the account's list (5 min, or on 401/404/410) no longer has that computer, its sessions and tunnel keys go — unless the list does not name this computer itself.
- `GET`/`PATCH /api/v1/peers`: the owner, or any non-peer session not given to a computer (the iPhone); `POST`/`DELETE` stay the Desktop's.
- Bridge: `X-Bridge-Device-Id` on every call; 400 `bridge_device_required`, 409 `bridge_device_mismatch`/`bridge_device_taken` said once, polled again after 5 min, compute key offered again after 1 h.

## 9. Two Twoody Desktops (twoody-desktop, 30/09/2026)
A Desktop signs in as its person, so its session is no computer to the backend. When it asks another Desktop of the account (« Utiliser ses modèles »), it says which computer asks: `POST /api/v1/peers {computer_id, requester_computer_id, requester_credential}` on its own server, which sends `request_access` (role `peer`, its tunnel key) with `requester_computer_id` and the header `X-Requester-Computer-Credential` — the credential the Desktop got when it registered as an account computer, kept in its safeStorage; the server keeps it nowhere. Both or neither (422 otherwise).
The backend (twoody-backend 5202f76b) checks it like `X-Computer-Credential` (digest, constant time, an active computer of the same user). If it holds, the request is that computer's, as for a headless computer's session: `role:"peer"`, `requester_kind:"computer"`, `requester_computer {id, name, public_key}`, named after the account, not to itself (`self_request`), two pending per host. If it does not — wrong, revoked, another account's, one half only, or a headless session naming another computer — 403 `invalid_requester_credential`, never a device's request; the server passes that 403 on.
The asked Desktop trusts only those `requester_*` fields, as for a Raspberry Pi: named from the account's listing (id and key), its own dialog (« L'ordinateur <A> de votre compte veut utiliser les modèles de ce Mac… », never automatic), a `peer:` session with `requester_computer_id`, taken back when the account stops listing it. A request with `role:"peer"` that names no computer is denied without asking.
