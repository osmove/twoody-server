# Project overview (« Synthèse du projet »)

Status: design and first implementation, 27/10/2026 (Jimmy: « go pour les changements des choses manquantes que tu
préconises », after Namestorm's questions — a naming agency in Stuttgart, on Windows and OneDrive).

## 1. What is asked, and what was missing
A firm with a project folder (briefings, meeting notes, e-mails saved as files, shortlists, presentations) wants:
1. Twoody to read the whole folder and **notice changes by itself**;
2. a **coherent overview** across documents — the brief's requirements, the decisions, where it stands, the next
   steps — **each point with its source**;
3. that overview **kept**, and **brought up to date** when documents change, without remaking it.

Before this: the index was brought up to date at launch, when a folder was added and by « Vérifier les changements »
only; the chat cites sources but takes three passages per document; « Agir dans vos dossiers » writes a Word document
from at most 12 documents and 24 000 characters in all; a project keeps a title, status, brief, dates, tasks and
notes, nothing read from its documents.

## 2. Watching the folders (src/documents/watch.ts)
Each granted folder not inside another granted one is watched (`fs.watch` recursive: FSEvents on macOS,
ReadDirectoryChangesW on Windows — OneDrive folders included —, inotify on Linux). A change waits until the folder has
been quiet for 10 s (Office writes temporary files, a sync client writes in bursts), then the ordinary pass runs
(`reindex`: a file is read again only when its size or date changed; the walls as before). Names that are never
indexed (hidden, `~$` locks, `.tmp`) wake nothing. A catch-up pass every 30 min covers what a watch misses (a network
drive, a watch the system refused: too many folders on Linux, `ENOSPC`, `EMFILE`). Documents switched off: nothing is
watched. Nothing new is read anywhere else: watching only says *when* to run the pass that existed.

## 3. The overview (src/projects/overview/)
**Which documents.** A walled-off project: the documents of its folders. Any other project: the documents of the
folder the person chooses for it (`project_overviews.folder`, a granted folder or a folder inside one — chosen with
the system's dialog, granted then if it was not), never a document of another project's walled-off folder
(`folderLayout().projectOf`), plus the documents tied to it (`project_documents`) on this computer. Only indexed
documents with text (`documents.status = 'indexed'`); the others are counted and named (« sans texte » : a scan on
Windows, where there is no OCR yet).

**Read once per document (map).** Each document's text (its chunks, `documentText`) is given to the model of this
computer — never another computer nor a cloud model: the documents never leave it, walled-off or not — in pieces of
12 000 characters, at most 4 pieces (a longer document: read in part, said so). It answers lines:

    decision | Der Name „Velora“ wurde am 12.03. gewählt. | „Wir haben uns für Velora entschieden“

`kind | what the document says, in the overview's language | the document's own words`. Kinds: `brief` (what the
brief asks for), `decision`, `status`, `next_step`, `open_question`. The server keeps an item only when its quote is
found in the document (whitespace, case, quotation marks and dashes folded; else 80 % of its words in a row of the
document): a sentence the model made up has no quote to stand on. Each item keeps its document, the page of its quote
when the text has pages, and the document's date (a date written in it, `fileActions/dates.ts`, else the file's).
Kept in `project_document_digests` with the document's size and date as read: a document unchanged is never read again.

**Written per section (reduce).** One call per section with that section's items, newest document first, as
`[i12] (2026-03-12, Protokoll 3.docx) Der Name „Velora“ wurde gewählt.`, and the other sections' items (the newest
80), to see what a newer document changed elsewhere: an e-mail raising the budget is read as a decision and must
still change the brief's budget; a decision settles an open question; a step done leaves the next steps (first bench,
27/10/2026: the brief kept 18 000 € and 28.02 after the e-mail and the second briefing, and « lumo.com » stayed open
after it was given up). The model writes at most 12 lines, each ending with the items it rests on (`[i12, i3]`, its
own section's or another's); the newer wins and the line says what it replaced. A line without a valid item, or
resting on other sections' items only, is dropped (the brief filled up with the decisions otherwise); the sources of a line are its items' documents (name, page, quote). More items than fit (≈ 60 per call)
are written in rounds, the lines of the previous round given as items of the next.

**Kept, never replaced by itself.** `project_overviews` holds the overview the person sees; every version is in
`project_overview_versions` (nothing is deleted). The first one is made when the person asks (« Faire la synthèse »).
After that, when documents of the project change (the watch, a pass, « Vérifier les changements »), the changed
documents only are read again; when the items changed, every section is written again from its lines as they stand,
to be kept word for word where their items still say it (an item of one section may change another's). The result is a **proposal** (« Mise à jour proposée »):
the documents new, changed or gone, and per section the lines added and removed; « Appliquer » makes it the overview,
« Ignorer » keeps the one there (the next change proposes again, from the overview kept). Never written over while the
person reads it.

**When.** One project at a time, behind every answer: before each model call the computer must be answering nothing
(`inflight() === 0`), and an answer starting aborts the call under way (`onChatGeneration`), which is asked again
later. Progress is kept per document, so a restart resumes. Started by the person (first build, « Mettre à jour
maintenant ») or by a change (at most once per 2 minutes per project, after the pass).

**The walls.** A walled-off project's overview, its digests and versions are its own: reached as the project is
(`reachesWalledProjects`; to anyone else, « not found »), never in the diagnostics shared, never on the account
(`schema/contract.json`: the three tables local only, whatever the project). Its export as a Word document is this
computer's app's, like the project's export.

**Languages.** The overview is written in the language the app gives when it is made (`language`), kept with it; the
section names are the app's (ten languages).

## 4. API (routes/projectOverview.ts)
- `GET /projects/:id/overview` → `{overview: {state, language, folder?, built_at, sections: [{kind, lines: [{text,
  sources: [{document_id, name, page, quote}]}]}], documents: {read, unreadable: [...], partial: [...]}, proposal:
  {documents: {added, changed, removed}, sections: [{kind, added: [...], removed: [...]}]} | null, progress: {stage,
  done, total, current} | null}}`; `null` overview when none was made. A device never gets paths.
- `POST /projects/:id/overview {language, folder?}` → make it (or remake it from nothing: `fresh: true`).
- `POST /projects/:id/overview/refresh` → look for changes now (a pass, then a proposal if anything changed).
- `POST /projects/:id/overview/proposal/apply`, `…/proposal/ignore`.
- `PUT /projects/:id/overview/folder {path}` → the folder of a project that is not walled off (this computer's app).
- `GET /projects/:id/overview/document` → the overview as a Word document (sources as footnotes-like lines).

## 5. Data (migration 17)
- `project_overviews` (id, user_id, project_id unique, folder, language, sections json, state, built_at,
  documents json, created_at, updated_at, deleted_at)
- `project_overview_versions` (id, overview_id, sections json, documents json, changes json, status
  proposed|applied|ignored, created_at, decided_at)
- `project_document_digests` (id, user_id, project_id, document_id, name, size, mtime_ms, document_at, items json,
  pieces, partial, model, language, created_at, updated_at; unique project_id + document_id)

## 6. Measures before it ships (twoody-bench scripts/project-overview-bench.mts)
A made-up project folder of a naming agency in German (briefing and its second version, workshop and meeting notes,
e-mails saved as .txt, a shortlist in Excel, a presentation, a legal check in PDF; a requirement changed by the
second briefing, a decision taken then reversed), Qwen3.5 9B: gold points per section found, lines without a valid
source (must be 0), lines saying what no document says, items dropped for a quote not found, time per document and in
all; then two documents changed and one added: the proposal names them and carries the change, unchanged sections
untouched.

## 7. Not in this lot
- OneDrive files « online only » (not on the disk): read by Windows on demand, which downloads them; to be checked on
  a real PC before saying anything.
- OCR on Windows and Linux (scans without text).
- The overview in the chat of a project's conversations, and on the iPhone.

## 8. Measured (27/10/2026, Qwen3.5 9B Q4_K_M, M5 24 Go on mains, twoody-bench scripts/project-overview-bench.mts)
14 documents (docx, xlsx, pdf, md, txt, an empty template), then two e-mails added. Temperature 0: two passes of one
version gave the same overview.
- First version (each section its own items only): 156 s for 14 documents and 5 sections; 12/16 gold points in their
  section (15 anywhere); **2 stale** (the brief kept 18 000 € and the 28.02 deadline, changed by an e-mail and the
  second briefing, both read as decisions); the update named the two e-mails and wrote only 3 sections, but « lumo.com »
  stayed an open question after it was given up.
- With the other sections' items and every section rewritten on an update (kept, server ab945e3 + this change):
  first overview 200–280 s, 14–15/16 gold points in their section (16 anywhere), **0 stale**, 0 line without a
  source, every quote found again in its document (38–63), nothing from the empty template, no date absent from its
  documents; the update 90–130 s (2 documents read, 5 sections written), DPMA filing and the EUIPO date in, the
  « lumo.com » question gone or turned into a fact.
- Still wrong, the model's: a step already done kept in « Prochaines étapes » (the linguistic check of 03.03), a
  deadline taken from an e-mail's own date (« Logo-Skizzen bis 12.03. »), a fact or a request in « Questions
  ouvertes » (« Bedenkzeit bis Mitte März »), a conclusion of its own now and then (« implizit bestätigt »), an item
  id left in a line's text (« gestützt durch die Entscheidung i1 »). Instructions written for each made it worse (an
  invented deadline from the newest document's date, 20+ lines dropped): kept out.
