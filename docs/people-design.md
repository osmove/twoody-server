# Proches (the person's people)

Status: design and build, 16/10/2026 (Jimmy: go for a « Proches » screen — the person's people with their relation,
kept and used in conversation).

## 1. Today
Two structures that do not talk to each other:
- **the memory graph** (`src/memory/entities.ts`, docs/memory-v2-design.md §2): entities (kind `self`, `person`,
  `project`…), `entity_aliases`, `entity_relations` (from → to, a free label: Mathieu → Élodie « épouse »), a kinship
  lexicon in French and English, `memory_entities` worked out on each computer. Retrieval follows it (« ma femme » is
  Élodie, one hop over a relation the message says), the profile says it in one line (`graphLine`). Nothing fills it
  but `/entities` by hand and the projects: the learner proposes facts and projects, never people nor relations, and
  no screen shows it.
- **Contacts** (`contacts`, `routes/contacts.ts`, Desktop `ContactsPage.tsx`): cards made by hand (with `relation_type`
  family|partner|friend|colleague|client|other and a free `relation_subtype`) or copied from the Mac's Contacts and
  Outlook (`personalSync.ts`, read only, a stable id per card: `rowId` of its external id). The chat reads them when a
  message names someone (`personalContext.ts`); « dis à maman… » looks in both (`email/recipient.ts`).

## 2. What a person is
**One person = one entity** (kind `person`, or `self` for the person themselves), with its names (the entity's name
and aliases), possibly **several contact cards** (a Mac card and an Outlook one, a manual one), its relation to the
person and its links to the others. The entity is the person; a card is where their details come from — never copied
into the entity, read when needed, so a card the Mac updates is read as it is now.

Tables (migration 10 « people »):
- `entity_relations` += `kind` (one of the fixed kinds below, NULL for a label none says) and `source`
  (`manual` | `learned` | `contact`). Existing rows get their kind from their label (`kindsOfWord`), when it says one.
- `entity_contacts(entity_id, contact_id, how, created_at)`: `how` = `auto` (sure, §3), `confirmed` (the person said
  yes to a proposal), `manual` (linked by hand) or `refused` (unlinked by hand, or a proposal refused: never linked
  again on its own). No foreign key on `contact_id`: a copied card is deleted and written again with the same id at
  every copy (`replaceContacts`); a link to a card that is gone is ignored, not deleted, and works again if it comes
  back.
- « À confirmer » (`memory_candidates`) gains three `candidate_type`s, their `payload` saying what: `relation`
  (`{from_id|null, from_name, to_id|null, to_name, kind, label}`), `person_link` (`{entity_id, contact_id, name,
  contact_name}`) and `person_duplicate` (`{a, b, names}`). Refused, their `norm` (`relation:…`, `link:…`, `dup:…`)
  is never proposed again — the rule of facts and projects.

## 3. Linking a contact and a person (`src/people/links.ts`)
Worked out again when the people are listed, after a copy of contacts and after a change of the graph; never merges
two entities.
- **Sure → linked** (`auto`): the card's full name (at least two words, or two CJK characters) is the entity's name
  or one of its aliases and no other card has that name; or one of the card's addresses is written in the entity's
  note or in a memory linked to it and in no other entity's.
- **Not sure → proposed** (`person_link`, « Nadine est-elle Nadine Douieb (Contacts) ? »): a one-word name (« Nadine »)
  that is the first name of exactly one card; several cards → nothing proposed (the person links by hand).
- **Doublons possibles** for people (`person_duplicate`): two persons linked to the same card, or one whose name is
  the other's alias or first name (« Élo » / « Élodie Garnier » when « Élo » is not already an alias). Merged only on
  the person's yes (`mergeEntities`, its names become aliases there).
- **Manual**: « Lier un contact » / « Délier » on the person's page; « Ajouter à mes proches » on a card of Contacts
  makes a person linked to it (its manual relation type and detail give the relation, `contactRelation`).

## 4. Relations
**Fixed kinds** (`src/people/kinship.ts`, `RELATION_KINDS`), each with its word in the ten languages: family —
mother, father, parent, son, daughter, child, sister, brother, sibling, grandmother, grandfather, grandparent,
grandson, granddaughter, grandchild, aunt, uncle, niece, nephew, cousin, mother/father/sister/brother/son/daughter
-in-law, godparent, godchild, relative; couple — wife, husband, spouse, partner; others — friend, colleague, manager,
employee, client, neighbour, doctor, other. A **label** stays free (« ma grande », « Schwiegermama »): shown as the
person wrote it, the kind for the rest.

A relation reads « to is the <kind> of from »: Jimmy → Nadine `mother`, Nadine → Claire `sister` (« la sœur de
Nadine »). Never an inverse stored: the page of Claire says « Sœur de Nadine », the card says both directions in words
(§6). Between people as from the person.

**The lexicon in ten languages** (`kinship.ts`): for each kind, the words of en, fr, de, es, it, pt, nl, ja, zh, ko
(« Mutter », « madre », « mamma », « mãe », « moeder », « 母 », « 妈妈 », « 엄마 »…) and how one's own is said: after a
possessive (« ma », « my », « meine », « mi », « mia », « minha », « mijn », « 我的 », « 우리 », « 私の »), or alone for the
words that mean one's own (« maman », « Mama », « mamá », « 母 », « 妈妈 », « 엄마 »). A word may say several kinds
(« nipote », « neef », « Freund », « copine »). Never someone else's: not after « de », « of », « von », « di », « van »,
« 的 », « の », « 의 » unless that one is the person (« 我的 », « 私の », « 나의 »); never « grand-mère » for « mère »,
« Schwiegermutter » for « Mutter », « 祖母 » for « 母 ». `entities.ts` takes it: `kinshipIn` (what a memory or a message
says of the person's own relatives) and `kinLabels` (« Mutter » is « mère ») understand the ten languages, so
retrieval, the profile and « dis à maman » do too.

## 5. Learning relations (`src/memory/learner.ts`)
The conversation's JSON gains `people[{name, relation, of, label, evidence, confidence}]`: `relation` a kind, `of`
« me » or the name of whom they are the relation of (« la sœur de Nadine » → of « Nadine »). Always **proposed**,
never kept on their own (family is sensitive: Jimmy, 16/10/2026), and only on the person's own words
(`judgePeople`, same evidence rule as facts):
- the evidence is a PERSON line, word for word, and names the person (`name`; CJK inside the text);
- it says the relation: a word of that kind in one of the ten languages; for `of: me`, as the person's own (§4) —
  « la mère de mon ami Paul s'appelle Sophie » gives Paul (« mon ami Paul ») and Sophie as Paul's mother, never
  Sophie as the person's friend nor mother; for another `of`, that one is named in the evidence too;
- not a hypothesis or a wish (« si j'avais une sœur… », « wenn ich…hätte », « si tuviera », « もし », « 如果 », « 만약 »:
  the ten languages), hedged −0.3, below 0.5 dropped;
- known already (the same kind to the same name) or refused before: dropped.

Accepted (`acceptCandidate`): the person's own entity made if missing (their name), the entity of the name found or
made (kind `person`, source `learned`), the relation written (`source` learned), a sure card linked (§3). The fact
itself (« Ma mère s'appelle Nadine ») stays the learner's fact as before.

## 6. In the chat (`src/people/cards.ts`)
A message that names someone (their name, an alias) or a relation of the person (« ma sœur », « mi madre », « 母 »,
« 우리 엄마 ») gets the **person card** on the last message, like the project cards — never the system prompt, so the
prompt cache holds:
`Nadine Douieb — the user's mother (« maman »). Also: Maman. Birthday 12 March (68 on 12/03/2027). E-mail n@…; phone
…. Links: Claire is Nadine's daughter (the user's sister).` — ≤ ~600 characters (~150 tokens), at most three cards.
« la sœur de ma femme » goes one hop: ma femme → Élodie, « sœur » of Élodie → Claire, both cards. The card is given in
« Complète » only, not for small talk nor a document-only turn, never in a walled-off project's conversation, never to
a model that is not on this computer or a trusted one; its contact details only when Contacts is on for the turn.
« dis à maman… » keeps working (`email/recipient.ts`): the relation's kind and the linked cards' addresses count.

## 7. Screens
**Mac — « Proches »**, in the sidebar next to « Projets », not in place of Contacts: Contacts is the address book (up
to 20 000 cards copied from the Mac and Outlook, a capability with its sources and switches), « Proches » the people
who matter, each linked to their cards. Contacts gains the « Proche » tag and « Ajouter à mes proches ». The page: the
people grouped (famille, couple, amis, travail, autres) with their relation to the person; a person's page with their
relation (kind + label, editable), their links to others (« Sœur de Nadine », add/remove), their cards (details,
« Lier un contact », « Délier »), what Twoody knows (their memories), upcoming birthday and events (agenda: their
card's birthday, events naming them in the next 60 days), « Fusionner avec… » and « Séparer » (an alias or a card
into a person of its own, or a merge undone), and « À confirmer » for people (relations, links, possible duplicates).

**iPhone — « Proches »** (Réglages › Proches), through the computer like the other « à l'ordinateur » paths
(`/people` in `COMPUTER_PATHS`): the list and a person's page to read, and their relation to change (one choice).

Routes (`routes/people.ts`, `requirePerson` like `/entities`): `GET /people`, `GET /people/:id`, `POST /people`,
`PATCH /people/:id` (name, aliases, note, relation {kind, label}), `PUT /people/:id/links` (relations to others),
`POST /people/:id/contacts` {contact_id}, `DELETE /people/:id/contacts/:contact_id`, `POST /people/:id/merge` {into},
`POST /people/:id/split` {alias | contact_id | merged_id}, `GET /people/candidates`.
**« Retirer de vos proches »** (17/10/2026, « rien de définitif », migration 12 `entities.removed_at`, named `archived_at` by migration 14 — hidden but restorable, the account's word; the API
says `archived_at`, and `removed_at` too for one release): `DELETE /people/:id`
keeps the person — names, relations, cards, memories — hidden from « Proches », the chat's cards, the graph the memory
follows, « dis à maman » and the learner (a relation naming them is dropped, `removed`; one pending waits unseen); « Proches
retirés » (`removed` of `GET /people`) with « Rétablir » (`POST /people/:id/restore`); added again under the same name, the
same person comes back.

## 8. What stays apart
- **Walled-off projects**: nothing of theirs reaches the graph — their conversations are never learned
  (`learnDiscussion`), their notes are not memories, their events are left out of a person's page, and no card is given
  in their conversations.
- **Sync**: entities do not travel between computers today (L8 not built: memory-v2 §6); `memory_entities` is worked
  out on each computer. Kept so: the graph, its links to cards and its proposals stay on the computer they are made on;
  the memories travel as before and are linked there. The iPhone reads the graph through its computer.
- **Sensitive**: a relation is kept only on the person's yes; a sensitive memory is never on a card for a model that is
  not the person's.

## 9. Bench (`twoody-bench/scripts/people-bench.mts`)
Conversations that state relations in the ten languages, with gold relations, and traps (« la mère de mon ami »,
« si j'avais un frère », a colleague's wife, « 友達のお母さん »): precision and recall of the proposals with the real
model. Questions on a seeded graph (« Qui est la sœur de ma femme ? », « Wie heißt meine Schwiegermutter? »): the right
name in the answer. Then the regression bench once (`regress.mjs`, exit 0).
