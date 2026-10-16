# AGENTS.md — Twoody Server

What an agent needs before touching this repository. The whole project
(products, other repositories, absolute rules, Desktop and Pi release
procedures, debugging on a copy of real data, known pitfalls) is in
`/Users/jimmy/Dev/twoody/AGENTS.md`: read it first. When this file and the
code disagree, the code wins.

## 1. What this is, and where it runs

`twoody-server` is Twoody's local server: Fastify + SQLite, one person per
server. It holds the chat (`/queries`), memory, documents, projects, tasks
and reminders, and the link to the person's other computers.

It runs in three places, from the same code:

| Where | How | Notes |
|---|---|---|
| Inside Twoody Desktop | copied into `twoody-desktop/resources/server` by `npm run bundle:server`, run in an Electron utility process | `TWOODY_LOCAL_ONLY=1`, bound to `127.0.0.1`; its calls to the account go through the Desktop's main process |
| Jimmy's Raspberry Pi 5 | user service `twoody-next`, port 3031, its own llama.cpp engine | update procedure: root AGENTS.md §6 « Pi » |
| Any Linux box, NAS, Docker | `scripts/install-linux.sh`, `docker compose`, or the npm package once published | see README.md and PUBLISHING.md |

Consequence: a change here ships in the next Desktop build and the next Pi
update. **Do not change this checkout while a Desktop build is running**
(root AGENTS.md rule 5): the build takes the tree as it is at
`bundle:server` time (`resources/server/BUNDLE.json` records the commit).

## 2. Commands

```bash
npm ci
npm run typecheck        # tsc --noEmit
npm test                 # node:test via tsx, test/*.test.ts (~650 tests, a few minutes)
npm run build            # tsc → dist/
npm run smoke            # boots a throwaway server against a fake OpenAI-compatible runtime
npm run smoke:builtin    # downloads the pinned llama.cpp + a 1 MB test model (CI job "builtin-engine")
npm run openapi          # regenerates the committed openapi.json
npm run dev              # tsx watch src/index.ts, port 3000
```

CI (`.github/workflows/ci.yml`) runs typecheck, tests, build and smoke on
Node 22 and 24, plus the built-in engine smoke. Other workflows:
`docker.yml` (image, manual or `v*` tag), `gitleaks.yml`,
`llama-runtime-arm64.yml` (Osmove's arm64 llama.cpp build).

For any change to what the model is given (prompt, memory, tools,
documents), also measure with a real model (root AGENTS.md §5, §7):
`twoody-bench`, or `scripts/prefix-cache-replay.ts` for the prompt cache.

## 3. Map of `src/`

| Path | What |
|---|---|
| `index.ts` | boot: single-user guard, setup token, Bonjour, account service, tunnel |
| `app.ts` | `buildApp()`: plugins, every route (root paths and `/api/v1` aliases), `/admin`, `/mcp` |
| `db.ts` | Drizzle schema and its in-place migrations (`CREATE TABLE IF NOT EXISTS`, `ALTER TABLE`), chmod 0700/0600 on boot |
| `routes/` | one file per route family (table in README.md « Routes ») |
| `routes/queries.ts`, `chatContext.ts` | the chat turn (§4) |
| `discussionWindow.ts` | which conversation a turn belongs to |
| `memory/` | memory v2: `learner.ts`, `retrieve.ts`, `search.ts`, `rank.ts`, `entities.ts`, `embeddings.ts`, `similar.ts`, `changes.ts` |
| `people/` | « Proches » (16/10/2026, docs/people-design.md): `kinship.ts` (the fixed kinds of relation — mother, sister_in_law, colleague… — their words in the ten languages, and how one's own relative is said: « ma mère », « meine Mutter », « 母 », « 우리 엄마 », never « la mère de Paul », « 友達の母 », « grand-mère » for « mère »; `entities.ts` `kinshipIn`/`kinLabels` read it), `people.ts` (a person = one entity, its contact cards in `entity_contacts` — migration 10: sure → `auto`, a first name → « À confirmer », refused never again —, relation to the person and links between people with `entity_relations.kind`, merge and split, « Doublons possibles » for people; « Retirer de vos proches » hides, never deletes — `entities.archived_at`, migration 12, renamed by 14, « Rétablir »), `learn.ts` (the learner's `people` — always proposed, on the person's own words, hypotheses of the ten languages dropped), `cards.ts` (the person card on the last message, one hop: « la sœur de ma femme ») |
| `memoryLearning.ts` | « Retiens que… »: kept as said and at once, no model involved (what is said in passing is learned by `memory/learner.ts`) |
| `personalContext.ts` | the person's contacts and events matching a message, on the last message: the days named (`dateWindow`) and the agenda's words in the ten languages, names in Japanese, Chinese and Korean found inside the text |
| `dateWords.ts` | the days and periods a message names in the ten languages (« morgen », « el viernes pasado », « 来週の金曜 », « 다음 달 », « seit Montag »), shared by `personalContext.ts` and the e-mails' periods (`email/chat.ts periodSpanIn`); « hier » is not yesterday among German or Dutch words (`test/multilingualAgendaMail.test.ts`) |
| `promptExamples.ts` | the examples the system prompt quotes (« rappelle-moi… », « cette semaine », « dis à X que… », « Factures ») in the conversation's frozen language — French when none, so the prompt stays the same for a conversation and the cache holds |
| `uiLabels.ts` | the app's screens and buttons as the person's app names them (« Fähigkeiten → Zuhause », « Ordner hinzufügen »), the Desktop's own words in its ten languages (`test/uiLabels.test.ts` compares them with its dictionaries): said in tool results and notes on the last message only, from the turn's `locale` — never in the system prompt |
| `intentText.ts` | what the detectors of « do it now » share (`fold`, CJK runs, reminder words): home commands, reminders and tasks, file listings, retries, small talk, Google statistics, the bank, « remember that » understand the ten languages of the app (`test/multilingual.test.ts`) |
| `projects/` | projects (`projects.ts`) and the chat's action tools (`actions.ts`) |
| `diagnostics/traces.ts` | one trace per answer; `telemetryOf` = the content-free part that may be shared |
| `diagnostics/installation.ts` | what the installation is, content-free (capabilities on, first launch's answers, providers by family, default model's name, phones paired): `GET /diagnostics/installation`, for the Desktop's daily `installation_active` |
| `documents/` | the document library (§5) |
| `email/` | « E-mails » (Capacités): the mailbox over IMAP — `imap.ts` (the only file that connects to a mail server, through `mailServerDoor` in `outbound.ts`; read-only but for a draft's APPEND), `sync.ts` (INBOX and Sent, the window then by UID, every 10 min; a Graph mailbox goes to `graphMailbox.ts`), `store.ts` (migration 4, FTS; a Graph message's id in `emails.metadata.graph_id`, each folder's round of changes in `email_sources.metadata.graph_folders`: no migration), `credentials.ts` (the password or Microsoft's refresh token of an IMAP mailbox, `email-credentials.json` 0600; `openMailbox`, never for a Graph mailbox), `graphMailbox.ts` (an Outlook.com or Microsoft 365 mailbox read through Microsoft Graph with the link of `microsoft/link.ts` (Mail.ReadWrite), `auth: "graph"` in the mailbox's metadata: Inbox and Sent Items by delta (`microsoft/mail.ts`), the deltaLink kept for the next round, `@removed` hidden as a message flagged deleted (never purged), attachments' names, a draft created in Drafts from the same MIME text as IMAP's APPEND, never sent; « Se reconnecter à Microsoft » moves a 0.13.76 mailbox there, its copy kept, its rows adopted by Message-ID), `microsoft.ts` (« Se connecter avec Microsoft » as Twoody 0.13.76 did it, kept working as it was: the Desktop's main process handed over the refresh token; access tokens got before each session at Microsoft's token endpoint (`microsoft/token.ts`) — the only address `microsoftTokenDoor` in `outbound.ts` opens, while E-mails is on and the mailbox is a Microsoft one — kept in memory, IMAP over XOAUTH2), `chat.ts` (`search_emails` with server-computed periods, `read_email` with its conversation, `draft_email` asked in the chat first — a new e-mail without a subject gets its first words; refused, the tool result says « NOT SAVED » with the sentence in the person's language and an answer that still says saved or sent is replaced by it, `answerAfterRefusal` held to the end of the turn in `routes/queries.ts`; nothing is ever sent), `recipient.ts` (whom « dis à maman que… » goes to once the person said yes: the relative's words in the ten languages (« Mama », « ママ », « 엄마 », not « grand-mère » nor « la mère de Paul »), the entity graph's relation from the person, the memories that name them with an address, Contacts and the e-mails' correspondents by name — one address given with the yes and put in place of none, a name or a made-up one; several or none, the model asks, `test/draftRecipient.test.ts`), `intent.ts` (a message plainly about e-mails gets the e-mails found with it, `emailsForMessage`, as documents do: `tool_choice: "required"` does not make Qwen3.5 9B on llama.cpp call a tool; « dis à maman que… » asked first and the « oui » after it — all in the ten languages since 10/10/2026) |
| `microsoft/` | the link to Microsoft Graph, apart from an IMAP mailbox's sign-in, for every capability that reads Graph (Agenda, Contacts and E-mails: Outlook's or Microsoft 365's calendar, contacts and mailbox) — each declares its paths and methods (`GRAPH_PATHS` in `outbound.ts`: read only, but for E-mails' one write, a draft created at `/me/messages`) and its permissions (`GRAPH_SCOPES` in `link.ts`: Calendars.Read, Contacts.Read, Mail.ReadWrite — never Mail.Send), the link holds the union. `token.ts` (Microsoft's sign-in renewed, for an IMAP mailbox too: an access token per resource kept in memory, the newest refresh token handed back, refusals as codes), `link.ts` (address, permissions granted, refresh token: `microsoft-graph.json` 0600; `releaseGraphPermissions` when the mailbox goes and Agenda or Contacts keep the link), `graph.ts` (`GraphSession`, the one place that sends a request to Graph, through `graphDoor`; `graphRefusal`, the one place Graph's refusals become codes — `no_mailbox` told apart from `gone`, `sync_reset` for a delta Graph can no longer carry on; calendars and each `calendarView`, 30 days back to 365 ahead in UTC; contacts and their folders; `@odata.nextLink`; 429 `Retry-After`), `mail.ts` (the mailbox's folders by well-known name, delta pages with Graph's text (`Prefer: outlook.body-content-type="text"`), attachments' metadata, the draft's POST), `sync.ts` (into `personalSync.ts` as source `microsoft`, every 15 min while the capability is on; turned off, its copy goes; unlinked, both, and the mailbox read with the link stops, its copy kept; `keepMicrosoftLink`: a sign-in from any page becomes the link, the mailbox following it — another account stops it) |
| `google/` | Google's sign-in renewed (`token.ts`, `client.ts`: the Gmail mailbox's and this link's, by the door the caller passes) and Google Analytics and Search Console in the chat (Connecteurs › Google, 08/10/2026): `dataLink.ts` (the link the Desktop hands over after « Se connecter avec Google », purpose « google_data »: address, analytics.readonly and/or webmasters.readonly, refresh token, on/off — `google-data.json` 0600), `dataTools.ts` (six read-only tools by permission — `google_analytics_properties`, `_report`, `_realtime`, `search_console_sites`, `_query`, `_inspect_url` — through `googleDataDoor` in `outbound.ts`, four requests at a time, `Retry-After` honoured, small tables, refusals as codes; offered with the connectors' conditions, left out by `connectors_off: ["google"]`, listed in GET /connectors as the virtual connector `google`) |
| `reservedFeatures.ts`, `reservedWithdrawal.ts` | what Twoody keeps for the accounts Osmove chooses (16/10/2026, Jimmy: not offered to everyone at the public launch, a v2): « email » (E-mails) and « google_data » (Google Analytics and Search Console). The account says who may (twoody-backend `ReservedFeatures`, /me `email_capability`, `google_data`); inside Twoody Desktop the Desktop says it — `TWOODY_RESERVED_FEATURES` at start (what it last knew), then the message `{type: "reserved-features", email, google_data, final}`; on its own (Pi, `twoody serve`, tests, the bench) only `TWOODY_RESERVED_FEATURES` (`email`, `google_data`, `all`); unset: neither. Not offered: E-mails reads as off in `localCapabilities` (so the tools, the sync, the routes and the phones follow) and cannot be switched on (`reserved_feature`), the Google link reads as off (`dataLink.ts`), is not listed in /connectors nor linked; the person's switches are kept until a `final` word (the account answered, or no account), then switched off, data kept, `withdrawn` in GET /local_capabilities for the app to say once (DELETE /local_capabilities/withdrawn). Tests that use them set `TWOODY_RESERVED_FEATURES=all` (`test/reservedFeatures.test.ts` for the gate) |
| `connectors/` | « Connecteurs » (Capacités): the person's MCP servers — `connectors.ts` (added from this computer's app only, `connectors.json` 0600; tools offered to a model of the person's in this computer's app and, since 08/10/2026, on the person's own devices (`meshRequester`), each call asked on the device that sent the message — SSE `approval`, answered by POST /queries/approval from that very session or this computer's app only; « Toujours autoriser » only for a tool whose MCP annotations say `readOnlyHint` and not `destructiveHint`, `mayAlwaysAllow`, 11/10/2026), `mcpClient.ts`, `oauth.ts`, `icons.ts` (an http connector's icon from its own origin only, `connectorOriginFetch` in `outbound.ts`: PNG, ICO or a plain SVG, 64 KB, a data URI, at most once a day) |
| `fileActions/`, `routes/fileActions.ts` | « Agir dans vos dossiers » (16/10/2026, twoody-desktop `docs/agent-in-chat.md`): `intent.ts` (sort, rename, Word, Excel, delete — ten languages, without the model; advice, questions and the past are no order), `plan.ts` (the folder by `folderAtPath` inside the granted folders of no walled-off project, never one that is, holds or lies in one; each file's date from `dates.ts`, else its own), `store.ts` (`file_actions`, migration 11), `run.ts` (all checked again at approval; a move is a hard link then the old name's removal, or a rename once the destination is free; documents `wx`; never a delete; the Word and Excel writers are copies of the Desktop's, `wordFile.ts`, `spreadsheetFile.ts`; one call to a model of this computer for their content, `setFileActionModel`), `chat.ts` (the turn: a proposal, a refusal, how to switch it on, or a typed « oui »/« non » — written here, the model not asked), `view.ts` (the card: never a path). Routes `GET /file_actions/:id`, `POST …/approve|decline|undo` (the session that asked or this computer's app), `GET …/path` (this computer's app only); `GET /discussions/:id` gives a proposal's message its `file_action` |
| `webResearch.ts` | « Recherche Internet » for the person's own devices (08/10/2026): the Desktop's web search asked through its loopback door (`TWOODY_WEB_BRIDGE_URL`, `TWOODY_WEB_BRIDGE_KEY`, `webBridgeFetch` in `outbound.ts`), the pages put before the question as the Mac's app does (`webBlock`); `devices.web` in GET /local_capabilities |
| `personalSync.ts` | the person's contacts and calendar copied from elsewhere, by source (`macos` from the app's `PUT /local_sync/*`, `microsoft` from `microsoft/sync.ts`): each copy replaces only its own rows |
| `projects/isolation.ts`, `projects/walledAccess.ts` | walled-off projects — « Cloisonner ce projet » in Projects, chosen when one is made (14/10/2026, docs/projects-design.md §8; the client files of 04/10/2026 brought back as an option; migration 6: `projects.isolated`, `project_notes`, `document_folders.project_id`): a project's documents (its folders, and those granted inside them: `library.ts folderProjects`), conversations (`discussions.project_id`, set when one starts there) and notes (never `memories`) reach nothing outside it — `scopedFolders` leaves its folders out unless asked for that project, `queries.ts` gives its conversations its own documents and notes only (of the person's memory, what they wrote or pinned), leaves e-mails, contacts, the agenda, the bank, the home, connectors and the web out unless `capabilities_on`, answers with a model of this computer or a trusted one only, never synchronises nor learns from them; no entity, no profile line or card, never proposed nor acted on by the learner or the chat's actions; a folder holding its folder is walked around it (`library.ts listFolders → walled`, `fileListing.ts walledAt`); its tasks, reminders, websocket events and traces for this computer's app only, never in the diagnostics shared nor the warm-up seeds; who reaches it is `walledAccess.ts reachesWalledProjects` (this computer's app, and the person's own devices as `meshRequester` names them — docs/walled-projects-phone-review.md); making one, its folder, export, renaming, archiving, deleting and `capabilities_on` stay with this computer's app (`routes/projects.ts` desktop_app_only) |
| `documents/wallPlaces.ts`, `documents/wallIdentity.ts` | a walled-off project's folder renamed or moved outside Twoody (16/10/2026, docs/projects-design.md §8 « Moved outside Twoody », migration 16: `document_folders.identity`, `volume`): known by its identity (device and file number) — every walk leaves it out wherever it is (`fileListing.ts walledAt` `walledIds`, `walk.ts` `walls`), the index pass follows it there when its documents are there too (`library.ts moveWall`) — and by its documents' name, size and date when it is no longer at its path (walled where they are, proposed, never followed alone; `walledPrints`); found nowhere with its disk connected (`missing`), nothing new is read outside its project (`paused`) until « Retrouver le dossier » (`PUT /projects/:id/folders/:folder_id`) or it is taken out of the project; its disk not connected (`unreachable`), nothing waits. States asked of the system at most every 2 s in the background (`wallPlaces`), afresh by the pass and `GET /local_documents/folders`; attack tests `test/walledMoved.test.ts` |
| `bank/` | « Banque » (Capacités): bank statements imported from this computer's app — `parse.ts` (CSV with its layout found or confirmed, OFX/QFX, QIF; fingerprints), `categories.ts` (keyword rules, counterparties), `store.ts` (migration 5; an overlapping statement adds only what is new), `tools.ts` (`bank_accounts`, `search_transactions`, `spending_summary`, for a model of this computer in its app only) |
| `builtin/`, `engine.ts`, `engineJobs.ts`, `localRuntime.ts`, `runtimeSlots.ts`, `cli/runtime.ts` | the built-in llama.cpp engine and « Moteur » (docs/builtin-runtime-design.md); the model catalogue is data verified against Hugging Face (`builtin/catalogData.ts`, 57 entries with their MLX folders, written by `scripts/model-catalog.mjs` — `--check` re-verifies, never edit by hand) and `builtin/memory.ts` says what a model needs in memory (one formula with the site's calculator, design doc §9) |
| `visionStandIn.ts` | an image the chosen local model cannot read (Twoody Desktop's MLX engine answers `vision_unavailable`) goes to a model of this computer's llama.cpp that reads images, the same model's GGUF first; `vision_stand_in` in the final event (15/10/2026) |
| `account/`, `cli/account.ts` | linking this server to a Twoody account (`twoody-server login/logout/approve`), approvals, endorsements, status heartbeat |
| `vault/` | end-to-end encrypted history and memories, trust roster |
| `peers/`, `peerDocuments/`, `peerSessions.ts`, `routes/peer*.ts` | the network of computers (docs/mesh-design.md) |
| `router/` | « Automatique »: which computer of the account answers (docs/multi-computer-design.md) |
| `tunnel/` | encrypted relay tunnel and direct transport to the person's devices; key confirmation is the first frame that opens (`channel.ts`). The permanent key (`identity.ts`): a 0600 file `DATA_DIR/tunnel-identity` on its own, sealed by the Desktop's safeStorage and handed over at start inside Twoody Desktop (`desktopKeyStore.ts`, `TWOODY_TUNNEL_KEY_STORE=desktop`; "locked": never replaced, what needs it fails) |
| `dbCipher.ts`, `dbKeyHandOver.ts`, `dbOpen.ts`, `dbCipherWorker.ts` | local.db encrypted at rest inside Twoody Desktop (12/10/2026, docs/encrypted-storage.md « Inside Twoody Desktop »): the driver is `better-sqlite3-multiple-ciphers` (SQLite3 Multiple Ciphers, SQLCipher 4 scheme: AES-256-CBC + HMAC-SHA512 per page, raw 256-bit key), typed as better-sqlite3 (`src/types/`); the key asked of the Desktop by message before db.ts opens the file (`TWOODY_DB_KEY_STORE=desktop`: `db-key-request` → `db-key` ok/unavailable/locked/lost), never in the environment or a file; a clear database encrypted once at start, in a worker thread whose steps go to the Desktop (`db-encryption` running/phase, « Chiffrement de vos données… ») (copy with its header set to rollback mode, rekey with no journal, quick_check and every table's rows compared, then swapped; the clear file put aside for the Desktop to Trash, `db-trash`; resumable), the migration backups earlier versions wrote in clear encrypted in a worker thread; an encrypted database without its key: exit 78, never a new one in its place. On its own (Pi, `twoody serve`): clear, as before. `GET /health` `database`; `scripts/db-encryption-bench.ts` measures the cost; `db-state` then `db-cleanup-done` once the clear copies are moved (the Desktop says once what is in the Trash) |
| `secretFile.ts` | the secret files next to the database sealed inside Twoody Desktop (12/10/2026, docs/encrypted-storage.md « Secret files »): `connectors.json`, `email-credentials.json`, `google-data.json`, `microsoft-graph.json`, `account.json`, `warm-seeds.json` — HKDF-SHA256 of the database key with an info per file, AES-256-GCM, the name as associated data; every reader and writer of those files goes through `readSecretFile` / `secretFileContent` / `writeSecretFile` / `removeSecretFile`; clear files of an earlier version sealed in place at start from db.ts (sealed, read back, the clear file into `secrets.unsealed-<date>/` for the Desktop's Trash); a sealed file this run cannot open is never written over. Without a key (on its own): 0600 files as before. Same format as twoody-desktop `src/main/secretFile.ts` (shared test vector) |
| `dataAtRest.ts`, `dataGuard.ts` | whether DATA_DIR is on an encrypted volume (LUKS/dm-crypt, ecryptfs/gocryptfs, fscrypt, FileVault; else "unknown"): warned at start on its own, `/health` `data_at_rest`, `/peer/status` for the person's other computers (never the heartbeat); `TWOODY_DATA_ENCRYPTION=require` refuses to start elsewhere (exit 78) — `docs/encrypted-storage.md` |
| `compute/` | sealed compute requests from shared/household devices |
| `shares/` | folder sharing (docs/sharing-design.md, docs/sharing-contracts.md): `store.ts` (migration 8: `folder_shares`, `share_guest_devices`, the audit's share columns; the account can only restrict, `syncShares`), `policy.ts` (the checks of every request, in order; rate limits), `serve.ts` (folders, search, browse, text, paths relative to the shared folder; `serveShareInProcess` for a server running its own bridge client), `parentServe.ts` (the bridge worker asks the Desktop to serve), `guest.ts` (the grantee's side: `share:<uuid>` in a turn's folder ids, calls through the Desktop's port, 4 s); routes `routes/localShares.ts` |
| `sync/walls.ts` | what may leave this computer, for the synchronisation to come (schema/contract.json `never_leave`): only rows of shared tables, never a walled-off project's (`leavingWhere`, `mayLeave`); its tests run `test/helpers/walls.ts` `assertWallsHold` with what they would send |
| `bridgeClient.ts`, `bridgeWorker.ts`, `executors/`, `routes/bridge.ts` | the Bridge (§7) |
| `mobileAgentBridge.ts`, `remoteCodeBridge.ts` | IPC to the parent Desktop for the phone's Agent and Twoody Code; absent when run alone |
| `outbound.ts`, `runtimeAuth.ts`, `adminAccess.ts`, `rateLimit.ts`, `localAccess.ts`, `sessionTrust.ts`, `webOrigin.ts` | security gates (§6) |

**Modules the Desktop copies.** `twoody-desktop` keeps byte-for-byte
copies of `src/builtin/*` (`scripts/sync-builtin.mjs`) and of parts of
`src/vault/*` (`scripts/sync-vault.mjs`); its tests
(`builtinShared.test.mjs`, `vaultShared.test.mjs`) fail when they drift.
After changing those files here, run `node scripts/sync-builtin.mjs` /
`sync-vault.mjs` in twoody-desktop and commit the copies there.

## 4. The chat turn (`/queries`)

Root AGENTS.md §3 has the overview; the rules that matter when editing:

- **Prompt cache first.** The system message holds only what does not move
  during a conversation: base prompt (or the `system_prompt` pref), the
  day, and the person's profile (`composeProfile`, frozen at the start of
  a conversation and refreshed only at refresh points of `ContextState`).
  Relevant memories, project cards, document excerpts, contacts and events
  ride on the last user message. Anything per-turn in the system message
  breaks the runtime's KV-cache reuse — check `cached_tokens` before and
  after. The long comment at the top of `src/chatContext.ts` is the
  reference.
- When the prefix changes, the start of the next conversation is read
  ahead in the background (`warmNewConversation` in `routes/queries.ts`).
- **History**: `TWOODY_HISTORY_MAX_MESSAGES` (40) and
  `TWOODY_HISTORY_MAX_CHARS` (16 000), scaled to the model's context
  window. Roles alternate starting with `user`.
- **Memory mode** per conversation: `full` | `profile` | `none`
  (`discussions.memory_mode`, set by `PATCH /discussions/:id` or the
  turn's `memory_mode`, else `/me`; `memory_enabled: false` means `none`).
  The `final` event's `memory` (stored in `messages.memory_json`) says what
  the turn was given.
- **Documents** are read up front only when the message clearly asks about
  them; otherwise the model has the `search_documents` tool. A question
  about files themselves gets a file listing with the message
  (`fileListing.ts`, a follow-up that only names a folder included), and
  the model has `list_files` for any folder inside the granted ones.
- **Acting in a folder** (« Agir dans vos dossiers », `src/fileActions/chat.ts`): asked before the model, after the
  person's message is kept; a request to sort, rename or write in a folder is answered by the server itself (a
  proposal and its `file_action`, or why not), and a « oui » / « non » right after a proposal by the session that
  asked agrees or refuses — the model is not asked for either.
- **Action tools** `create_reminder`, `create_task`, `update_project`
  (`src/projects/actions.ts`) act only on the person's say; an explicit
  request (« rappelle-moi… ») forces a short, silent turn that must call
  the tool. Keep the guards (forced turn, weekday computed by the server):
  Qwen3.5 9B claims actions it did not take otherwise.
- **Reasoning effort**: `fast` | `think` | `deep` (`THINKING_BUDGET`,
  `THINKING_TIME_MS`); local runtimes get `chat_template_kwargs.enable_thinking`
  and `reasoning_effort`; « Répondre maintenant » (`/queries/answer_now`)
  cuts the reasoning. `src/thinkFilter.ts` drops a leading `<think>` block.
  Local providers get `max_tokens` = `TWOODY_LOCAL_MAX_TOKENS` (2048).
- **Which conversation** (`src/discussionWindow.ts`): the one named by
  `discussion_id`, else a new one. Only voice surfaces continue the latest
  without naming it (`device` one minute, `watch` ten);
  `force_new_discussion: true` starts over. Do not bring back a blanket
  reuse window: it made « Nouvelle conversation » write into the previous
  thread.
- **Stopping**: a closed client connection aborts the runtime request and
  stores the partial answer.
- **Runtime keys**: the Desktop's runtime requires a per-launch key; it is
  handed over in `TWOODY_RUNTIME_KEYS` (embedded server) or the worker's
  `runtimeKeys` message, attached by `src/runtimeAuth.ts` to loopback
  calls only, never stored.

## 5. Documents (`src/documents/`)

The person grants folders; the server indexes them into SQLite and answers
with citations. Nothing leaves the SQLite file.

- `extract.ts` pure-JS extraction (unpdf, fflate for .docx/.odt, RTF, HTML,
  text); no shelling out. `ocr.ts` uses the helper the Desktop provides
  (Vision detects the language; `TWOODY_OCR_PREFER` the app's language
  first, `TWOODY_OCR_LANGUAGES` a fixed list).
  Spreadsheets (.xlsx/.xlsm/.ods, and CSV/TSV that are tables) and
  presentations (.pptx/.pptm/.ppsx/.odp, speaker notes included) are read
  part by part from the zip (`zipParts.ts`: pictures never inflated, a
  sheet streamed and capped at 10,000 rows): `spreadsheet.ts` writes each
  sheet as blocks of rows that start with `[Sheet "name", rows a–b of n]`
  and the header row, cells as shown (`numberFormat.ts`: formulas'
  results, dates, decimals, no thousands grouping); `presentation.ts`
  gives one section per slide (`page` = slide number). `location.ts`
  derives a citation's place (page, slide, or sheet and rows) from a
  passage's name, page and first line — sources carry it as `location`.
- `chunk.ts` ~1200-character passages; a PDF page or a slide starts a new
  one; a spreadsheet's block is kept whole.
- `query.ts` question → FTS5 query (French and English stopwords and
  stems; `languages.ts` those of German, Spanish, Italian, Portuguese and
  Dutch, for a question whose small words are theirs: plurals met through
  a prefix, « rechnung* », « factu* »); `cjk.ts` Japanese, Chinese and Korean
  (10/10/2026): unicode61 does not cut them into words, so their runs are
  also indexed as overlapping pairs of characters in `document_grams`
  (migration 9, rowid = the passage's rowid in `document_chunks`, written
  and deleted with it in `library.ts`), a question's runs cut at particles
  and function words; the other languages' expressions are unchanged
  (`test/cjkSearch.test.ts`). The conversations' and e-mails' indexes have
  SQL triggers, which cannot cut text: a question in those scripts is
  looked for there by LIKE on the pairs. `library.ts` grants
  (`folderRisk.ts`/`canonicalFolder` refuse roots, a whole home, `~/Library`,
  hidden paths; symlinks not followed), incremental indexing, BM25 search
  including file and folder names.
- `semantic.ts` optional local embeddings (Qwen3 Embedding 0.6B, loopback
  llama-server). Never send document text to an external embedding API;
  revalidate grants on every query and before storing vectors.
- `retrieval.ts` follow-up rereads of one named file; `remote.ts`,
  `remoteListing.ts` search on trusted peers.
- `fileListing.ts` the files of a folder for a message (« le plus récent de
  mes téléchargements »); `folderListing.ts` the chat's `list_files`: what
  any folder inside the granted ones holds, named « Bureau »,
  « jimmy/Desktop/Projets » or « Factures », found by its real path (iCloud
  Drive's Desktop is a link to ~/Desktop when « Bureau et Documents » is
  synced), the walk's rules applied.
- Per-turn `document_access` `{mode: off|all|selected|only, folderIds?}`;
  invalid → 422; revoked scopes retrieve nothing.
- Routes live under `/local_documents/*` (not `/documents`, which is the
  account's Google Drive browser). Passages carry absolute paths: they must
  never leave the computer (peers get ids, see docs/mesh-design.md §2).
- `POST /local_documents/context` (question, explicit `document_access`,
  at most 20 history turns) returns bounded context and numbered sources,
  without local paths or memories; `GET /local_documents/files/:id?offset=`
  reads indexed text 20 passages at a time. Ids are rechecked against
  ownership and current grants on every request; no arbitrary path is ever
  opened. Coverage: `test/documentLibraryApi.test.ts`.
- The personal-files grant (`/local_documents/personal`, `{confirmed: true}`)
  covers supported files under the home folder, never hidden files,
  application data, caches, symlinks or known credential files; read-only.

The phone's Agent goes through `/api/v1/mobile_agent`, an authenticated
IPC gateway to the parent Desktop (`mobileAgentBridge.ts`), not a shell on
the server: it needs a `pair:` session, derives the principal from the
session, never from the request, and needs a stable `requestId` so a
request retried over the relay does not run twice. No folder grant or
runtime URL can be passed through it.

## 6. Security rules

- **No bare `fetch`** in `src/`: every outbound call goes through
  `outboundFetch` (`src/outbound.ts`); `test/outbound.test.ts` fails
  otherwise. With `TWOODY_LOCAL_ONLY=1` it refuses any host that is not
  loopback or private (RFC 1918, link-local, CGNAT/Tailscale, IPv6 ULA).
  Cloud-only routes check the flag up front and return `local_only`.
- Every route that touches user data calls `requireAuth`, bridge worker
  routes and `/mcp` included. Bridge tasks are scoped to the user who
  enqueued them.
- `/admin` (`adminAccess.ts`): this machine only (addressed as
  `127.0.0.1`/`[::1]`/`localhost`), or `TWOODY_ADMIN_TOKEN`.
- Secret-checking routes go through `allowSecretAttempt` (`rateLimit.ts`):
  10 tries per address and route per 5 minutes
  (`TWOODY_AUTH_ATTEMPTS_LIMIT`).
- Unknown `Host` headers get 421 (`TWOODY_ALLOWED_HOSTS`, `TWOODY_PUBLIC_URL`).
- Single-user guard (`index.ts`): refuses to boot bound publicly with more
  than one account.
- Trust between computers (vault roster, safety codes, binding secrets):
  any change needs a security review with attack tests; the account server
  is treated as potentially malicious (root AGENTS.md rule 12).
- Sensitive memories (health, money, beliefs, justice, identity, address)
  are never kept without consent and never sent to a model that is not the
  person's own.
- Do not log secrets, LLM keys, tokens or local paths.
- The database key (dbKeyHandOver.ts) comes by message only: never in the
  environment, a file, a log or a message back to the Desktop. A new file of
  the person's secrets in DATA_DIR goes through `secretFile.ts` (and into
  `SECRET_FILES` if an earlier version wrote it in clear). Never make a
  new database, nor a new key, in front of an encrypted one that does not
  open; never delete a clear copy (the Desktop moves it to the Trash).

## 7. The Bridge (legacy contract, sealed requests only)

The Bridge lets a worker run tasks for a backend by long-polling
`/bridge/tasks/next`. Since 11/10/2026 the account's bridge carries only
sealed requests: another person's turn on a computer shared with them
(`llm_infer` with a compute grant's principal and a `sealed_request`) and a
request on a folder shared from here (`share_request`). `bridgeClient.ts`
refuses every task in clear before it runs — the person's own unsealed
`llm_infer`, `search`, `read`, `list_*`, `transcribe`, `ocr_image`,
`smart_home_proxy` — with `bridge_plaintext_refused:<kind>`, declares
`local-llm-provider` and `folder-share-provider` only, and no longer pushes
Home Assistant's states to the account (`test/bridgePlaintext.test.ts`).
`src/bridgeWorker.ts` runs `bridgeClient.ts` alone (no Fastify, no SQLite —
keep it free of `db.js` imports); the Desktop forks it and configures it by
message.

- Task kinds (`routes/bridge.ts`): `search`, `read`, `list_folders`,
  `list_dir`, `open_document`, `thumbnail`, `llm_infer`, `photos_recent`,
  `photos_by_date`, `app_open`, `shortcut_run`, `shortcut_list`,
  `ocr_image`, `transcribe`; local-only kinds run in-process by
  `tools.ts::executeLocalTool`: `smart_home`, `spotify`, `device_command`,
  `members_list`, `list_household_members`, `stereo_pair`.
- With `TWOODY_SELF_BRIDGE=1` the in-process executors (`src/executors/`)
  serve this server's own `/bridge` routes (never the account's tasks) and
  run `search`, `read`, `list_folders`, `list_dir`, `llm_infer`,
  `transcribe`, `ocr_image` (Linux tools: ripgrep, find, pdftotext,
  whisper, tesseract). Granted folders on Linux come from
  `TWOODY_BRIDGE_FOLDERS` (`executors/folders.ts`, denylist of system
  paths); `executors/idCache.ts` keeps real paths off the wire.
- Capabilities the bridge client declares (`X-Bridge-Capabilities`):
  `local-llm-provider`, `folder-share-provider`; `TWOODY_BRIDGE_CAPABILITIES`
  can only narrow them.
- Sealed `llm_infer` contract: PATCH `{status: "streaming", delta}` with
  sealed lines in order (`compute/computeHost.ts runSealedTurn`), then
  `{status: "done", result: {sealed: true}}`. A model no runtime lists is
  refused (`model_not_installed`): the backend can never trigger a download.
  The poll loop must not wait for a completion (presence lasts 90 s).
- The task queue is in memory (`taskMap` in `routes/bridge.ts`).
- The JSON schema written for the macOS worker,
  `bridge-v1.schema.json`, lives in the dormant `twoody-mac` repository
  (`twoody-mac/shared/`, unchanged since April 2026). Nothing here
  validates against it: `routes/bridge.ts` and `executors/` are the
  authority now.

## 8. Vocabulary

- **Bridge capability**: what a bridge worker declares (routing layer, §7).
- **Built-in capability** (`routes/builtInCapabilities.ts`,
  `/built_in_capabilities`): the user-facing feature catalogue clients read.
- **Skill**: the Rails backend's older name for a user-facing feature
  toggle; in the Desktop, « skills » are also Twoody Code's instruction
  files. Say which one you mean.

## 9. Design documents (`docs/`)

Read the one that concerns your task before writing code. They are dated
plans; the code says what was built.

| Document | Subject | State in the code (1 Oct 2026) |
|---|---|---|
| `docs/builtin-runtime-design.md` | llama.cpp run by the server, « Moteur » setting, Pi | built: `src/builtin/`, `routes/runtime.ts`, `smoke:builtin` in CI |
| `docs/multi-computer-design.md` | headless computers in the account, routing between computers | built (lots and review fixes recorded in §6–9 of the doc): `src/account/`, `src/router/` |
| `docs/mesh-design.md` | trusted computers as vault members; distributed document search | built: `src/vault/`, `src/peerDocuments/`, `routes/peer*.ts` |
| `docs/memory-v2-design.md` | profile, hybrid retrieval, entities, learner, « À confirmer » | largely built (`src/memory/`); open items in root AGENTS.md §10 |
| `docs/people-design.md` | « Proches »: one person = one entity with their cards, relations in ten languages, learned relations proposed, the person card in the chat | built 16/10/2026 (`src/people/`, `routes/people.ts`, migration 10) |
| `docs/projects-design.md` | projects found by the learner, used in chat, screens, sync; §8 walled-off projects (« Cloisonner ce projet ») | lots P1–P4 built (`src/projects/`); P5 (sync between computers) not yet; §8 built 14/10/2026 (`isolation.ts`, `walledAccess.ts`), its folder followed when moved outside Twoody 16/10/2026 (`documents/wallPlaces.ts`; the screens not yet) |

Other docs in this repository: `README.md` (running and configuring the
server), `PUBLISHING.md` (npm, PyPI, Docker — not published yet),
`SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (BUSL-1.1), `TRADEMARK.md`.

## 10. Working in this checkout

- Everything on `main`, no branches, worktrees or `git stash`; other
  sessions share the checkout. `git status` and `git diff --cached` before
  every commit; stage only your files; push fast-forward only.
- Commit messages in English, no AI attribution line.
- Schema: a new table or column follows root AGENTS.md rule 14 and is classified in `schema/contract.json` (copied to
  `twoody-backend/config/schema_contract.json`) in the same commit.
- Code and comments in English; French UI strings quoted with « ».
- After changing routes, regenerate `openapi.json` (`npm run openapi`) and
  update README.md's route table.
