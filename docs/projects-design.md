# Projects

Status: design, 01/10/2026 (Jimmy: « ne faudrait-il pas commencer à implémenter la notion de projet ? »).

## 1. What a project is
Something the person is working towards over days or months: buying a house or a Mac mini, a wedding, a move, a
trip, a job search, a renovation, a product at work. Big or small. It gathers what Twoody knows and does about it:
memories, tasks, reminders, events, conversations, documents.

Today: the memory graph has entities of kind « project » (src/memory/entities.ts) with aliases and relations, but
nothing else hangs off them; reminders have an unused `project_id`; tasks and events have none; the account (Rails)
has a full Project model (status, priority, deadline, budget, brief) linked to tasks, reminders and discussions.

## 2. Data (db.ts, one migration block)
projects(id, user_id, entity_id → entities (kind project, the names and aliases), title, kind purchase|event|home|
travel|work|health|learning|admin|other, size small|medium|large|critical, status idea|active|paused|done|dropped, brief,
started_at, due_at, done_at, budget_cents, currency, source manual|learned|account, hlc, vault_event_id, created_at,
updated_at). Links: tasks.project_id, reminders.project_id (exists), events.project_id, discussions.project_id
(the conversation's main project), memories via memory_entities (already: a memory naming the project's entity),
project_documents(project_id, computer_id, document_id) chosen by the person. Statuses map to Rails' (idea →
active + metadata, dropped → archived) for the day the account shows them.

## 3. Finding them (learner, src/memory/learner.ts)
The conversation's JSON gains `projects[{name, kind, size, status, due?, evidence, confidence}]`. A new project is
always proposed (« À confirmer » : « Nouveau projet : Achat d'un Mac mini ? »), never created on its own; a change
of an existing one (status, due date) follows the fact rules (sure → kept, else proposed). Facts the conversation
gives about a project name its entity, so they link to it. Same evidence check: the person's words only.

## 4. In the chat
- A message that reaches a project (its name, an alias, « le Mac mini ») gets a project card in tier b: status, due
  date, open tasks and next reminders, the last facts (≤ 150 tokens).
- Tools, when the model takes tools (like search_documents): `create_task` / `create_reminder` with an optional
  project, `update_project` (status, due date) — each shown to the person (« Rappel créé : … · Annuler »).
- The profile names the active large projects in one line (« Projets en cours : achat maison, mariage »): stable all
  day, so the prompt cache holds.

## 5. Screens
Mac and iPhone: « Projets » — active first; each with its memories, tasks, reminders, events, conversations,
documents; status, due date, notes; merge two projects; archive. Memories and the chat link to it.

## 6. Sync
Projects travel in the vault like the entities (L8): a project event, LWW per id, tombstones; links travel with the
task/reminder/event they are on.

## 7. Lots
P1 table + API (/projects CRUD, links) + learner proposals + « À confirmer » card · P2 chat card + profile line ·
P3 Projets screens (Mac, iPhone) · P4 tools create_task / create_reminder / update_project · P5 vault sync.
Bench: 10 transcripts that start, advance and finish projects (gold projects, statuses), with traps (a hypothetical
purchase, a friend's wedding).

## 8. Projets cloisonnés (walled-off projects)
Decision of Jimmy, 14/10/2026: bring back the client files of 04–10/10/2026 for law firms, accountants and the like —
each client's file a project whose documents, conversations and memory stay inside it — as an **option of Projects**,
not a product of its own nor a « Dossiers » screen. The engine is the one built then (`projects.isolated`,
`project_notes`, `document_folders.project_id`, `src/projects/isolation.ts`, migration 6) and kept walled when they
were retired (migration 7, which closed those of before and is left as it is: they show in « Projets » archived, and
the person may reopen one).

**Made so, never afterwards.** « Cloisonner ce projet » is a checkbox of « Projets » › « Nouveau projet » (Desktop
`Projects.tsx`), with « Ses documents, conversations et notes restent dans ce projet : rien n'en sort, rien d'autre n'y
entre. Pour un dossier client, par exemple. » `POST /projects {isolated: true, folder_path?}`; `isolated` cannot be
changed (`isolated_fixed`): a project made plain has already been learned from (its memories, entities, cards) and
those would stay outside. « Créer une copie cloisonnée » is left out: copying a project's conversations into a new
walled one would bring the memory already learned from them along, so it would not be the promise.

**What stays inside** (code: `isolation.ts`, `routes/queries.ts`, `routes/projects.ts`, `projects/walledAccess.ts`):
- its documents: the folder chosen for it (and any folder granted inside it) is read in its conversations only.
  Every other reader leaves it out — the general chat and another project's conversations (`scopedFolders`,
  `inProjectScope`), the person's other computers (`/peer/documents/*`), a folder shared with someone
  (`shares/policy.ts isolatedInside`), the phone and any session but this computer's app (`/local_documents/*`), an MCP
  client's `list_files`. Since 14/10/2026 a folder holding it — the firm's general folder — is walked, listed, browsed
  and read by Spotlight **around** it: every granted folder carries the walled-off folders inside it
  (`library.ts listFolders → walled`) and the walkers stop there (`fileListing.ts walledAt`: listings, `list_files`,
  folders found by name, browsing and its raw files, Spotlight's candidates, which would otherwise have been read
  and moved under the general folder);
- its conversations (`discussions.project_id`, set when one starts there and never changed): answered by a model of
  this computer or of a trusted computer of the person's, never a cloud one (`project_local_model_only`); never
  sealed into the encrypted history (`/discussions/import` 409, no `vault_ref`; the Desktop skips them in its
  migration); never learned from (`learner.ts`); never found by the conversations' search; their websocket events,
  traces, tasks and reminders reach this computer's app only (`ws.ts eventReaches`, `diagnostics`, `tasks.ts`,
  `reminders.ts`);
- its memory: its notes (`project_notes`) — written on its page or asked in one of its conversations (« Retiens
  que… » becomes a note, never a memory); of the person's own memory, only what they wrote or pinned and how they
  like answers (`ownWords`); no entity in the graph, no line in « Projets en cours », no card elsewhere, never named by
  the chat's actions of another conversation;
- what reaches outside (e-mails, agenda, contacts, bank, home, connectors, the web) is left out of its conversations
  unless switched on for one in « Outils » (`capabilities_on`; the Desktop never sends them as `capabilities_off`
  there, never remembers the choice);
- nothing of it is shared with the account: the diagnostics (`/diagnostics/telemetry`, `/diagnostics/full`) skip its
  traces (`traces.ts WALLED`: its conversations', and its start read ahead, marked `isolated`), and the read-ahead
  seeds kept on disk (`warm-seeds.json`) never hold it, not even its id (`saveWarmSeed`).

**Who reaches it** (`walledAccess.ts reachesWalledProjects`): this computer's app, and since phase 2 (same day,
docs/walled-projects-phone-review.md) the person's own devices — exactly whom `meshRequester` names: a device-access
signed by a person device of the verified roster, not expired, through the tunnel of the session's own key. Their
iPhone lists, opens and continues them (its own screens, sealed to this computer only, nothing kept on the phone);
making one, its folder, export, renaming, archiving, deleting, and switching on what reaches outside it stay with
this computer's app. To anyone else — another computer, a household member's device, a device paired by code that is
no member of the history, a browser on the network, the account — a walled-off project does not exist.

**Tests**: `test/isolatedProjects.test.ts` (the conversation's own walls), `test/walledProjects.test.ts` (attack
tests: the general chat and its `list_files`, another walled-off project, the phone, the websocket, a trusted peer,
the diagnostics shared, the seeds, a shared folder), `test/walledProjectsPhone.test.ts` (the person's iPhone, and
every attack of the phone's security review), Desktop `test/walledProjects.test.mjs`. **Bench**:
`twoody-bench/scripts/walled-projects-bench.mts` (the fictive client file « Tessane », real model; figures in the root
AGENTS.md §5).
