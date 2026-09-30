# Twoody mesh: every trusted computer of an account is client and server

Status: design, 30/09/2026 (Jimmy: « tout le monde peut discuter avec tout le monde »). Follows
docs/multi-computer-design.md (hub-and-spoke: a primary holds data, others lend models).

## 0. Today (what the design relies on)
- Trust is one-way: `account_peers.trusted` (src/db.ts) is kept by the sender and only shapes its prompt;
  a `peer:` session reaches only /api/v1/peer/* (src/auth.ts, src/peerSessions.ts). No computer serves documents.
- Desktop's main process is a vault device (twoody-desktop/src/main/vault.ts) and imports vault turns into its
  embedded server (POST /discussions/import); twoody-server has no vault code → a Pi never sees shared history.
- Passages carry absolute paths (src/documents/library.ts → queries.ts sources): must not leave a computer.
- Vault kinds are turn|title|tombstone (twoody-backend vault_event.rb); older clients' mergeInto creates an
  empty conversation for unknown kinds → memories need their own stream.
- « En direct » turns go with vaultRef null and documentAccess off (twoody-app ChatView.js).
- basePrompt says the conversation stays on that machine (src/chatContext.ts) → « on the user's own computers ».
- Semantic scan uses readFloatLE (src/documents/semantic.ts) → Float32Array view.
- Relay cap 32 sessions per user (tunnel_relay.rb) → 64.

## 1. Trust: a trusted computer is a vault member
- Computer (Pi, Mac mini) enrols as vault device kind `computer`, approved by a person-device (iPhone, Desktop
  with someone at the screen) with the existing v1 approval signature, plus a binding
  `twoody/vault/computer-binding/v1` = [v, user_id, vault_device_id, account_computer_id, tunnel_public_key,
  pairing_public_key, can_approve=false]. Keys read over the pinned tunnel (GET /api/v1/peer/vault/identity).
- « Faire confiance à cet ordinateur » per computer: ON = enrol + wrap epoch keys + binding; OFF = revoke + rotate.
  Household/shared computers stay untrusted (lend models, conversation only).
- Only person-devices approve: clients refuse approvals/envelopes from a device whose binding says can_approve=false.
- A Twoody Desktop stays a person-device (it approves) and names its own computer: `twoody/vault/desktop-binding/v1`
  = [v, user_id, vault_device_id, account_computer_id, tunnel_public_key, pairing_public_key], signed by its OWN
  vault key (test/fixtures/desktop-binding-v1.json), stored as vault_devices.desktop_binding, never in `binding`. It
  counts only on a device the forward walk verified as a person by its signed approval, so it adds no power that
  device lacked; the backend cannot forge, alter or move it, only withhold it. The roster then keys that Desktop by
  account computer + tunnel key like any computer (can_approve true). Its embedded server signs and publishes it
  with the handed keys and the account computer the Desktop hands over (src/vault/service.ts ensureDesktopBinding).
- Roster derived, not stored: each computer verifies GET /vault (devices, approvals, bindings) in
  src/vault/roster.ts, cached 60 s, refreshed on 401/404/410. Serving side: requester_computer_id in the verified
  roster ⇒ may reach /peer/documents/* and /peer/vault/*.
- Automatic links: approvals rule 4 (role peer + requester in roster + key = binding's tunnel key) and rule 5
  (phone signed `twoody/vault/device-access/v1` by a vault person-device). Never on the account token alone.
  src/peers/index.ts requests links to every roster member on change.
- A Desktop pins itself as a computer's anchor (« Faire confiance ») through its embedded server's peer session:
  requestPeer, asking as the Desktop's computer, carries a device-access/v2 signed by the handed vault key (≤12 h);
  the backend takes it with a requester computer only when that person device's desktop-binding names that computer
  and key; the computer lets the session pin iff the statement is signed by the key being pinned and that device's
  desktop-binding (listed, signed by the same key) names the session's requester computer and tunnel key
  (src/sessionTrust.ts peerSessionIsDesktop). Any other peer (a Pi, a household computer) never pins.
- Revocation: vault device revoked + new epoch; DELETE /account_computers/:id revokes its vault device and marks
  needs_rotation (next person-device rotates); sessions/links dropped within 60 s. Already-fetched data can't be
  taken back (UI says so).
- Compromised trusted computer sees: history & memories of its epochs, other computers' documents through search
  (rate-limited, audited), files it fetches. Cannot add devices, read untrusted computers, or read after revocation.
- Keys: no separate document keys (pairwise tunnels). Desktop keeps custody in safeStorage and hands
  {type:"vault", deviceId, keys, epochs} to its embedded server in memory; headless: DATA_DIR/vault.json 0600.

## 2. Distributed document search
Peer API (src/routes/peerDocuments.ts, trusted peers only):
- POST /api/v1/peer/documents/search {q, hint?, scope{mode, folder_ids?}, limit≤8, budget_chars≤10000,
  deadline_ms≤3000} → {computer_id, took_ms, embed_model, index, passages[{source_id "<computer>:<doc>",
  document_id, name, folder (granted root name), rel_path, page, text, snippet, match, rank, cosine?}], files[≤20]}
- GET /peer/documents/folders (names+counts), /files/:id?offset= (indexed text), /files/:id/raw (Range; 25 MB relay,
  32 MB LAN). Reuses retrieveDocuments with absolutePaths:false; caller scope ∩ local grants; folderRisk local;
  semantic skipped while generating; 30 req/min/session; audit shown in « Appareils ».
Fan-out (src/documents/remote.ts, by the computer building the turn): own retrieval + every trusted online peer in
parallel; deadlines 1.5 s LAN / 3 s relay; late ones left out with a note; RRF over N lists (cosine when same
embed model), ≤3 passages/doc, ≥1 per computer above floor, trimmed to contextBudget; sources get computer_id/name,
no path. Citations: twoody://doc/<computer>/<doc>, streamed from that computer (direct tunnel, or through the
answering computer). Pi targets: ≤400 ms p50 / ≤1.6 s p95 added to time-to-first-token on LAN.

## 3. Conversations & memories
- One history in the vault; every trusted computer runs vault sync inside twoody-server (src/vault/{crypto,client,
  sync,memories,roster}.ts, port of twoody-desktop/src/shared/vault*.ts, checked on twoody-app vault vectors);
  local discussions/messages become caches via idempotent import; the answering computer seals its turn
  (answered_by, sources without paths); ContextState/summaries/KV stay local.
- Catch-up: request carries vault_conversation_id + known_refs (last 3); missing → sync pull (≤1 s), else accept
  prior_turns inlined by the phone (≤20 turns, ≤64 KB).
- Memories: own stream (backend `vault_events.stream`, index_events ?stream=), id HKDF(epoch-1,
  "twoody/vault/memories-id/v1"); events memory{id, kind, title, content, tags, source, superseded_by, hlc, device}
  and tombstone{id, hlc}; LWW per id on (HLC, device), tombstone wins ties, manual beats learned same tick; learned
  facts' event_id from sha256(normalised content) → dedup; tombstoned hash never re-learned.
- « Primary » becomes « preferred »: default coordinator for ties, runs scheduled work under a lease (10 min
  failover), still mirrored in legacy fields, owns no data.
- Migration: Desktop migrateToVault; Pi « Réunir l'historique de ce Pi »; memories first upload with content-hash
  ids + « Doublons possibles »; existing trusted peers become a suggestion card, never automatic.

## 4. Answering
Phone picks the coordinator with a JS port of rank() (twoody-app/utils/meshRouting.js, shared fixture tables) fed by
/account_computers status; trusted model holder = coordinator (own + fan-out retrieval + synced memories);
untrusted model host reached through a trusted coordinator (peer_openai, conversation only). Fallback before first
token only, ≤2 tries. Router: linkedPeers filtered by roster, trusted from roster, /providers computers[] gains
mesh, preferred, documents{indexed}. Memory extraction/titles on the coordinator (writes vault events); indexing and
embeddings always local; contacts/calendar stay local in v1.

## 5. UI
« Appareils »: one mesh list (status, load, speed, « Faire confiance », « Préféré », document counts, audit line);
untrusted under « Prête ses modèles ». Picker: « Automatique » + one section per computer, no « En direct ».
Documents: one view with « Sur le Mac » / « Sur le Pi » sections. Footer: model · computer · auto; source badges.

## 6. Security & privacy
Malicious backend can't add members or read; sees metadata; may withhold events (tombstones kept locally).
Stolen Pi SD card: vault.json readable → recommend LUKS, warn on the switch, later « Documents seulement » level.
Excerpts are data; no tool fetches remote files, only citations. Caller identity from session, never body. Host
allowlist/sealed tunnel/CORS unchanged. Rate limits + audit on peer document routes. Privacy policy: memories leave
the computer E2EE; excerpts/files move between the owner's computers possibly via the encrypted relay; headless
computers hold history keys on disk; routing metadata listed; base prompt wording.

## 7. Lots
P0 contracts (fixtures: computer-binding-v1, device-access-v1, memory-event schema, peer-documents-search schema,
rank-table) → B1 backend (vault_devices kind/account_computer_id/binding, vault_events.stream + memory kind,
index_events ?stream=, DELETE revokes vault device + needs_rotation, listing vault_device_id, relay cap 64) ·
S1 vault in server · S2 roster + automatic links · S3 peer documents · S4 fan-out · S5 memories · D1 Desktop vault
re-exports, hand-off, binding, can_approve, trust switch · D2 Documents sections, remote citations, picker ·
A1 app binding/can_approve/device-access, mesh switch · A2 meshRouting, direct to coordinator, no « En direct » ·
A3 unified Documents, remote citations, mesh « Appareils » · M1 migration cards, privacy copy, audit UI.
Acceptance: (1) from the iPhone one question cites a PDF only on the Pi and one only on the Mac, each citation opens
the right file; (2) Mac offline → Pi PDF still cited, Mac noted missing; (3) memory learned on the Pi used by the Mac
within 60 s, deleted on the iPhone → gone everywhere, never back; (4) conversation started on the Mac continued from
the iPhone with the Pi answering, referencing the Mac's turn; (5) Pi made untrusted → 403 on peer documents within
60 s, its new vault events unreadable, still lends models; (6) backend-inserted fake computer gets no link, no
documents; (7) Pi-signed approval refused everywhere; (8) Pi latency gates; (9) old app + new server works, remote
citations show a name only. Rollout: backend → server → Desktop → app OTA.

## 8. Risks / do not
Risks: vault growth on SD cards, clock skew (HLC), 3 MB relay queue for raw files (Range, prefer LAN), 60 s
revocation lag, differently-worded memory duplicates, embeddings slowing a generating Pi.
Do not: replicate indexes/embeddings/files; let the account token or listing decide trust; sync SQLite rows / CRDT
local.db; let headless devices approve; extend the tunnel into a group protocol; send absolute paths; wait for the
slowest computer; switch computers after the first token; sync contacts/calendar/ContextState in v1; give
household/shared computers keys or documents.
