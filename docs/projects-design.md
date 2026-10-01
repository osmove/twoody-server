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
travel|work|health|learning|admin|other, size small|large, status idea|active|paused|done|dropped, brief,
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
