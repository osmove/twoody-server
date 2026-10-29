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
- A conversation started in a project (29/10/2026: « Nouvelle conversation dans ce projet » on its page, Desktop;
  `project_id` on the first message, `discussions.project_id`; `projectOfConversation`): the project's card on every
  message of it, named or not, first of the two — with « Mémoire » off too, without what was learned of it (the
  person chose the project); a task or a reminder that names no known project is the project's; `GET
  /discussions/:id` says `project`. A dropped project is no conversation's any more. Nothing is walled off (§8).

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

**The Agent and Twoody Code** (16/10/2026, Jimmy's go; twoody-desktop `src/main/code/walledFolders.ts`). They work in
folders the person opens for them, with tools that read files directly — outside this server's walls. The rule, the
simplest that keeps the promise:
- a walled-off project's documents folder, or a folder inside it, is never opened for the Agent, and for Twoody Code
  only once the person switched on « Autoriser Twoody Code dans ce projet » on the project's page (off by default, its
  date shown; kept by the Desktop, never from the iPhone, a model of this computer only, no MCP server); a folder that
  holds one (the firm's general folder) opens, the walled-off folders inside it invisible to their tools and said once
  in the session (16/10/2026, twoody-desktop docs/code-harness-design.md « W1 »; a8cce6b refused it);
- every request is checked again before it runs (`WorkspaceStore.touch`, called by `CodeService.send`): a folder opened
  before its project was walled off, or still among the recent folders, is refused too;
- which folders are walled off is this server's word, asked by the Desktop's main process with this computer's app
  session: `GET /local_documents/folders`, the folders whose `project_id` is set, compared with a folder every way
  either may be written (`src/documents/samePath.ts`, copied into the Desktop: as written, case and what Windows drops
  folded; as the system resolves it, 8.3 short names, the disk's own case, a drive's real place; by identity). When the
  server cannot answer and walled-off projects may exist on this
  computer (a count kept by the Desktop, never a path), the answer is no (« Twoody n'a pas pu vérifier… ») — the last
  list given in the run is used meanwhile;
- a link inside an allowed folder that leads elsewhere (into a walled-off folder, say) is neither listed nor read by
  their file tools (`walk`, `documentsUnder`: only links that stay inside the folder);
- they never get a walled-off project's notes or conversations: they ask this server nothing, the chat's Agent is off in
  a walled-off conversation (Desktop `Chat.tsx`), and a conversation handed to the Agent (`sourceDiscussion`) is refused
  when this server says it is a walled-off one (`GET /discussions/:id` → `isolated_project`).
- every program Code starts (its commands, MCP servers, ripgrep, git) runs in the system's sandbox (twoody-desktop
  `src/main/code/sandbox.ts`): Seatbelt on macOS, bubblewrap on Linux — the other walled-off folders and Twoody's data
  neither read nor written, writes only in the opened folder, temporary folders and caches, the programs outside the
  sandbox that would act for it closed (Apple Events, `open`, launchd, Docker…); on Windows, or on Linux without
  bubblewrap, no command runs while walled-off projects exist.
Not covered, and said so in the help: a program already running outside Twoody that takes orders from a command (an
SSH server, Docker over the network, an editor), what a command leaves for the person to run themselves, what an
allowed command sends over the network, and the files stay ordinary files that other applications open.

**Spellings** (16/10/2026): two grants may name one place two ways — « Z:\Cabinet » and the share it stands for, a
short name, another case, a link — and Node's JavaScript realpath, which `canonicalFolder` uses, keeps what it is
given. So the walls are compared the way of `src/documents/samePath.ts` everywhere (`library.ts folderLayout`: which
folder holds which, the project of each, every spelling of each walled-off folder from each folder holding it — in
`walled`, in the index pass's skipped folders, in `isolatedInside`, in the file actions' walls), each granted folder's
place asked of the system once and again in the background after a minute. Before, a walled-off folder granted
under another spelling than the general folder holding it was indexed under the general folder and found by its chat
(`test/walledSpellings.test.ts`, 5 attacks, all failing on the code of 811dbd3).

**Moved outside Twoody** (16/10/2026, Jimmy's go; `src/documents/wallPlaces.ts`, `wallIdentity.ts`, migration 16).
A walled-off folder was known by its path only: renamed in place, its parent renamed, or moved under the firm's
general folder in the Finder, the Explorer or by a sync client, it was listed and acted on from the general folder at
once, indexed under it at the next pass — found by the general chat, the phone, the other computers, a shared folder —
and its project lost its documents (`test/walledMoved.test.ts`, three attacks, all failing on the code of d7c7c92).
Now each one is also known:
- by its identity (device and file number, `document_folders.identity`, with the root of its disk, `volume`), kept
  as last seen at its path — the same file number on another device counts when its disk was mounted again. Every
  walk leaves out a folder that is one of another project's, whatever it is called and wherever it is: the index
  pass (`walk.ts` `walls`), the listings and `list_files`, browsing, Spotlight's candidates, « Agir dans vos
  dossiers », a share, another computer (`fileListing.ts walledAt`: `walledIds`, the folders on the way asked what
  they are). So the walls hold at once, before Twoody has noticed anything. The index pass, which looks for it
  along its own walk only (never elsewhere on the disk), follows it: the project's folder takes its new path, the
  folders granted inside it move with it, its index is kept as it is (nothing read again) — when its documents are
  there too (`documentsThere`: an identity alone is not enough, a disk may give a deleted folder's number to
  another), never onto a folder granted on its own nor into or around another project's walled-off folder (then
  walled where it is, `elsewhere`, and the project's page asks). A folder made afterwards under the old name stays
  the project's: a folder at a walled-off project's path never becomes an ordinary one by itself;
- by its documents (the name, size and date of what was indexed of it, to two seconds): not at its path, a
  walled-off folder whose documents turn up somewhere — moved to another disk, a copy then the original removed;
  recreated by a sync client — is taken to be where most of them are (as many as two, or all it had): walled
  there, proposed on the project's page (`elsewhere`, `found_by: "documents"`), never followed alone. Meanwhile
  none of its documents is listed, browsed or read into another folder's index, wherever it lies (`walledPrints`).
  A copy made while the original is at its path is an ordinary folder, as before.
Found nowhere while its disk is connected (`missing`), it may be anywhere: until the person finds it again on the
project's page (« Retrouver le dossier », `PUT /projects/:id/folders/:folder_id {path}`, this computer's app only;
a folder that is neither the same one — its identity, or its file number on a disk mounted again — nor holds its
documents answers `409 folder_not_same`, and is linked only with `confirm: true` once the person, told so, says it
is the one: a wrong folder linked would end the pause while the real one, a copy say, lies in a general folder)
or takes it out of the project, nothing new is read in any folder outside its project — the index pass reads no
new file there, the listings say so to the model without naming anything (`pausedNote`), browsing answers
`folder_paused`, « Agir dans vos dossiers » answers in the person's language, a share serves nothing — what was
indexed before stays searchable, and its own index stays with the project (a pass no longer drops it). Its disk not
connected (`unreachable`: a NAS out of the office, a USB disk out), nothing of it can be walked: nothing waits, and
its documents stay out of the other folders all the same. `GET /local_documents/folders` asks where the walls are
before it answers and gives this computer's app each walled-off folder's `state`, `found`, `found_by` and
`identity` (never to a device), and `paused` on the folders that wait; the project's page gets `state`, `found`
and `found_by` (a device never `found`). A pass is started as soon as a request finds a walled-off folder away
from its path. Not covered, and said so: during a copy to another disk, the copy is an ordinary folder until the
original is removed; a disk without stable file numbers (FAT, exFAT) loses the identity on a move, so the folder
is `missing` there. The screens and the Desktop's Agent and Code (18/10/2026): twoody-desktop
`WalledProjectPage.tsx` (« Dossier introuvable », « Retrouvé ailleurs » with where and how, « Disque non branché »;
« Retrouver le dossier » asking again with `confirm` on `folder_not_same`, « C'est bien lui », « Retirer du projet »),
« Projets », Documents' banner while the folders wait and a chip on each, browsing a folder that waits, the « Agir »
card's `paused` reason; twoody-app's walled-off project page, « Projets » and Documents (read only: found again on the
computer); the Agent and Code take `identity`, `state` and `found` (`walledFolders.ts`): a walled-off folder hidden
from their file tools by its identity wherever it is (on any device while it is away), a folder inside it refused at
its new place, one that cannot be placed — missing, not where this server says, its found place gone — pausing their
requests, tool calls and commands outside its project, its found place masked for commands. A sandbox masks paths:
a command already running when the Finder moves such a folder keeps the mask it started with.

**Tests**: `test/isolatedProjects.test.ts` (the conversation's own walls), `test/walledProjects.test.ts` (attack
tests: the general chat and its `list_files`, another walled-off project, the phone, the websocket, a trusted peer,
the diagnostics shared, the seeds, a shared folder), `test/walledMoved.test.ts` (a walled-off folder renamed, its
parent renamed, moved under the general folder, copied then removed, out of the granted folders, on a disk not
connected, on a disk mounted again, into another walled-off project's folder — each before and after the next
pass), `test/walledProjectsPhone.test.ts` (the person's iPhone, and
every attack of the phone's security review), Desktop `test/walledProjects.test.mjs` and `test/walledCodeFolders.test.mjs`
(the Agent and Twoody Code: the folder itself, inside, holding, a link to it, the iPhone's grants and folders, a folder
opened before, a walled-off conversation handed over, the server out of reach), `test/walledMovedCode.test.mjs` (the
folder renamed in place, moved in, its parent renamed, renamed in case only, a link or a junction to it, moved while
Code is open, the server silent, copied then removed, its disk mounted again; the commands' mask list, the real
Seatbelt and bubblewrap) and `test/walledMovedScreens.test.mjs`; twoody-app `test/screens/WalledMoved.test.js`. **Bench**:
`twoody-bench/scripts/walled-projects-bench.mts` (the fictive client file « Tessane », real model; figures in the root
AGENTS.md §5).
