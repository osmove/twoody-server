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
| `memoryLearning.ts` | « Retiens que… »: kept as said and at once, no model involved (what is said in passing is learned by `memory/learner.ts`) |
| `personalContext.ts` | the person's contacts and events matching a message, on the last message |
| `uiLabels.ts` | the app's screens and buttons as the person's app names them (« Fähigkeiten → Zuhause », « Ordner hinzufügen »), the Desktop's own words in its ten languages (`test/uiLabels.test.ts` compares them with its dictionaries): said in tool results and notes on the last message only, from the turn's `locale` — never in the system prompt |
| `intentText.ts` | what the detectors of « do it now » share (`fold`, CJK runs, reminder words): home commands, reminders and tasks, file listings, retries, small talk, Google statistics, the bank, « remember that » understand the ten languages of the app (`test/multilingual.test.ts`) |
| `projects/` | projects (`projects.ts`) and the chat's action tools (`actions.ts`) |
| `diagnostics/traces.ts` | one trace per answer; `telemetryOf` = the content-free part that may be shared |
| `diagnostics/installation.ts` | what the installation is, content-free (capabilities on, first launch's answers, providers by family, default model's name, phones paired): `GET /diagnostics/installation`, for the Desktop's daily `installation_active` |
| `documents/` | the document library (§5) |
| `email/` | « E-mails » (Capacités): the mailbox over IMAP — `imap.ts` (the only file that connects to a mail server, through `mailServerDoor` in `outbound.ts`; read-only but for a draft's APPEND), `sync.ts` (INBOX and Sent, the window then by UID, every 10 min; a Graph mailbox goes to `graphMailbox.ts`), `store.ts` (migration 4, FTS; a Graph message's id in `emails.metadata.graph_id`, each folder's round of changes in `email_sources.metadata.graph_folders`: no migration), `credentials.ts` (the password or Microsoft's refresh token of an IMAP mailbox, `email-credentials.json` 0600; `openMailbox`, never for a Graph mailbox), `graphMailbox.ts` (an Outlook.com or Microsoft 365 mailbox read through Microsoft Graph with the link of `microsoft/link.ts` (Mail.ReadWrite), `auth: "graph"` in the mailbox's metadata: Inbox and Sent Items by delta (`microsoft/mail.ts`), the deltaLink kept for the next round, `@removed` hidden as a message flagged deleted (never purged), attachments' names, a draft created in Drafts from the same MIME text as IMAP's APPEND, never sent; « Se reconnecter à Microsoft » moves a 0.13.76 mailbox there, its copy kept, its rows adopted by Message-ID), `microsoft.ts` (« Se connecter avec Microsoft » as Twoody 0.13.76 did it, kept working as it was: the Desktop's main process handed over the refresh token; access tokens got before each session at Microsoft's token endpoint (`microsoft/token.ts`) — the only address `microsoftTokenDoor` in `outbound.ts` opens, while E-mails is on and the mailbox is a Microsoft one — kept in memory, IMAP over XOAUTH2), `chat.ts` (`search_emails` with server-computed periods, `read_email` with its conversation, `draft_email` asked in the chat first; nothing is ever sent), `intent.ts` (a message plainly about e-mails gets the e-mails found with it, `emailsForMessage`, as documents do: `tool_choice: "required"` does not make Qwen3.5 9B on llama.cpp call a tool) |
| `microsoft/` | the link to Microsoft Graph, apart from an IMAP mailbox's sign-in, for every capability that reads Graph (Agenda, Contacts and E-mails: Outlook's or Microsoft 365's calendar, contacts and mailbox) — each declares its paths and methods (`GRAPH_PATHS` in `outbound.ts`: read only, but for E-mails' one write, a draft created at `/me/messages`) and its permissions (`GRAPH_SCOPES` in `link.ts`: Calendars.Read, Contacts.Read, Mail.ReadWrite — never Mail.Send), the link holds the union. `token.ts` (Microsoft's sign-in renewed, for an IMAP mailbox too: an access token per resource kept in memory, the newest refresh token handed back, refusals as codes), `link.ts` (address, permissions granted, refresh token: `microsoft-graph.json` 0600; `releaseGraphPermissions` when the mailbox goes and Agenda or Contacts keep the link), `graph.ts` (`GraphSession`, the one place that sends a request to Graph, through `graphDoor`; `graphRefusal`, the one place Graph's refusals become codes — `no_mailbox` told apart from `gone`, `sync_reset` for a delta Graph can no longer carry on; calendars and each `calendarView`, 30 days back to 365 ahead in UTC; contacts and their folders; `@odata.nextLink`; 429 `Retry-After`), `mail.ts` (the mailbox's folders by well-known name, delta pages with Graph's text (`Prefer: outlook.body-content-type="text"`), attachments' metadata, the draft's POST), `sync.ts` (into `personalSync.ts` as source `microsoft`, every 15 min while the capability is on; turned off, its copy goes; unlinked, both, and the mailbox read with the link stops, its copy kept; `keepMicrosoftLink`: a sign-in from any page becomes the link, the mailbox following it — another account stops it) |
| `google/` | Google's sign-in renewed (`token.ts`, `client.ts`: the Gmail mailbox's and this link's, by the door the caller passes) and Google Analytics and Search Console in the chat (Connecteurs › Google, 08/10/2026): `dataLink.ts` (the link the Desktop hands over after « Se connecter avec Google », purpose « google_data »: address, analytics.readonly and/or webmasters.readonly, refresh token, on/off — `google-data.json` 0600), `dataTools.ts` (six read-only tools by permission — `google_analytics_properties`, `_report`, `_realtime`, `search_console_sites`, `_query`, `_inspect_url` — through `googleDataDoor` in `outbound.ts`, four requests at a time, `Retry-After` honoured, small tables, refusals as codes; offered with the connectors' conditions, left out by `connectors_off: ["google"]`, listed in GET /connectors as the virtual connector `google`) |
| `connectors/` | « Connecteurs » (Capacités): the person's MCP servers — `connectors.ts` (added from this computer's app only, `connectors.json` 0600; tools offered to a model of the person's in this computer's app and, since 08/10/2026, on the person's own devices (`meshRequester`), each call asked on the device that sent the message — SSE `approval`, answered by POST /queries/approval from that very session or this computer's app only), `mcpClient.ts`, `oauth.ts`, `icons.ts` (an http connector's icon from its own origin only, `connectorOriginFetch` in `outbound.ts`: PNG, ICO or a plain SVG, 64 KB, a data URI, at most once a day) |
| `webResearch.ts` | « Recherche Internet » for the person's own devices (08/10/2026): the Desktop's web search asked through its loopback door (`TWOODY_WEB_BRIDGE_URL`, `TWOODY_WEB_BRIDGE_KEY`, `webBridgeFetch` in `outbound.ts`), the pages put before the question as the Mac's app does (`webBlock`); `devices.web` in GET /local_capabilities |
| `personalSync.ts` | the person's contacts and calendar copied from elsewhere, by source (`macos` from the app's `PUT /local_sync/*`, `microsoft` from `microsoft/sync.ts`): each copy replaces only its own rows |
| `projects/isolation.ts` | isolated projects — client files (Twoody Pro, migration 6: `projects.isolated`, `project_notes`, `document_folders.project_id`): a project's documents (its folders, and those granted inside them: `library.ts folderProjects`), conversations (`discussions.project_id`, set when one starts there) and notes (never `memories`) reach nothing outside it — `scopedFolders` leaves its folders out unless asked for that project, `queries.ts` gives its conversations its own documents and notes only (of the person's memory, what they wrote or pinned), leaves e-mails, contacts, the agenda, the bank, the home, connectors and the web out unless `capabilities_on`, answers with a model of this computer or a trusted one only, never synchronises nor learns from them; no entity, no profile line or card, never proposed nor acted on by the learner or the chat's actions; its routes (`routes/projects.ts`) for this computer's app only |
| `bank/` | « Banque » (Capacités): bank statements imported from this computer's app — `parse.ts` (CSV with its layout found or confirmed, OFX/QFX, QIF; fingerprints), `categories.ts` (keyword rules, counterparties), `store.ts` (migration 5; an overlapping statement adds only what is new), `tools.ts` (`bank_accounts`, `search_transactions`, `spending_summary`, for a model of this computer in its app only) |
| `builtin/`, `engine.ts`, `engineJobs.ts`, `localRuntime.ts`, `runtimeSlots.ts`, `cli/runtime.ts` | the built-in llama.cpp engine and « Moteur » (docs/builtin-runtime-design.md) |
| `account/`, `cli/account.ts` | linking this server to a Twoody account (`twoody-server login/logout/approve`), approvals, endorsements, status heartbeat |
| `vault/` | end-to-end encrypted history and memories, trust roster |
| `peers/`, `peerDocuments/`, `peerSessions.ts`, `routes/peer*.ts` | the network of computers (docs/mesh-design.md) |
| `router/` | « Automatique »: which computer of the account answers (docs/multi-computer-design.md) |
| `tunnel/` | encrypted relay tunnel and direct transport to the person's devices |
| `compute/` | sealed compute requests from shared/household devices |
| `shares/` | folder sharing (docs/sharing-design.md, docs/sharing-contracts.md): `store.ts` (migration 8: `folder_shares`, `share_guest_devices`, the audit's share columns; the account can only restrict, `syncShares`), `policy.ts` (the checks of every request, in order; rate limits), `serve.ts` (folders, search, browse, text, paths relative to the shared folder; `serveShareInProcess` for a server running its own bridge client), `parentServe.ts` (the bridge worker asks the Desktop to serve), `guest.ts` (the grantee's side: `share:<uuid>` in a turn's folder ids, calls through the Desktop's port, 4 s); routes `routes/localShares.ts` |
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
  text); no shelling out. `ocr.ts` uses the helper the Desktop provides.
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
- `query.ts` question → FTS5 query; `library.ts` grants
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

## 7. The Bridge (legacy contract, still used)

The Bridge lets a worker run tasks for a backend by long-polling
`/bridge/tasks/next`. Today it matters mainly for one thing: a computer
lending its models to the person's account. `src/bridgeWorker.ts` runs
`bridgeClient.ts` alone (no Fastify, no SQLite — keep it free of `db.js`
imports); the Desktop forks it and configures it by message.

- Task kinds (`routes/bridge.ts`): `search`, `read`, `list_folders`,
  `list_dir`, `open_document`, `thumbnail`, `llm_infer`, `photos_recent`,
  `photos_by_date`, `app_open`, `shortcut_run`, `shortcut_list`,
  `ocr_image`, `transcribe`; local-only kinds run in-process by
  `tools.ts::executeLocalTool`: `smart_home`, `spotify`, `device_command`,
  `members_list`, `list_household_members`, `stereo_pair`.
- With `TWOODY_SELF_BRIDGE=1` the in-process executors (`src/executors/`)
  run `search`, `read`, `list_folders`, `list_dir`, `llm_infer`,
  `transcribe`, `ocr_image` (Linux tools: ripgrep, find, pdftotext,
  whisper, tesseract). Granted folders on Linux come from
  `TWOODY_BRIDGE_FOLDERS` (`executors/folders.ts`, denylist of system
  paths); `executors/idCache.ts` keeps real paths off the wire.
- Capabilities a worker declares (`X-Bridge-Capabilities`):
  `document-provider`, `local-llm-provider`, `voice-device`.
- `llm_infer` contract (the Rails backend depends on it): stream, PATCH
  `{status: "streaming", delta}` in order, finish with
  `{response_json, model_used, latency_ms}`. A model no runtime lists is
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
| `docs/projects-design.md` | projects found by the learner, used in chat, screens, sync | lots P1–P4 built (`src/projects/`); P5 (sync between computers) not yet |

Other docs in this repository: `README.md` (running and configuring the
server), `PUBLISHING.md` (npm, PyPI, Docker — not published yet),
`SECURITY.md`, `CONTRIBUTING.md`, `LICENSE` (BUSL-1.1), `TRADEMARK.md`.

## 10. Working in this checkout

- Everything on `main`, no branches, worktrees or `git stash`; other
  sessions share the checkout. `git status` and `git diff --cached` before
  every commit; stage only your files; push fast-forward only.
- Commit messages in English, no AI attribution line.
- Code and comments in English; French UI strings quoted with « ».
- After changing routes, regenerate `openapi.json` (`npm run openapi`) and
  update README.md's route table.
