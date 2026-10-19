# Mémoire v2

Status: design, 30/09/2026 (Jimmy: go). Starts after the mesh release.

## 1. Gaps today
G1 profile = 5,000-char dump (~1,400 tok) ordered by a regex (chatContext.ts ~227, 294-300, 698-701) · G2 lexical
retrieval only, any score > 0 passes, fixed 1,500 chars, hard-coded synonyms (~228, 261-267, 637-670) · G3 no memory
embeddings; embed() private to documents/semantic.ts · G4 entity_type/entity_id columns unused · G5 memory_search
advertised (capabilities.ts:46) but not implemented in tools.ts; /queries has no tool loop; messages have no search
index · G6 one global switch, no per-conversation mode, no token cost · G7 learning per message by regex, no
confidence/entities/sensitivity/candidates · G8 duplicates by title only · G9 readContextState drops unknown fields ·
G10 sensitive memories can reach cloud models (untrusted peers already get nothing — keep).

## 2. Prompt layout (cache-safe)
SYSTEM (frozen per conversation, refreshed only at refresh points): base · custom · language · day · name · notes ·
library · summary · PROFILE (tier a, ≤800 tok) · policy « Use the profile only when it bears on the message; never
bring up personal details unprompted. »
TOOLS (frozen in ContextState): search_memory, search_conversations
HISTORY: compact + live messages byte for byte (sent_content)
LAST USER MESSAGE: remembered · formats · doc policy · NEW MEMORIES (≤5, once) · excerpts · RELEVANT MEMORIES
(tier b, grouped by entity) · contacts/events · question. Tier (b) only lands in the last message, stored in
sent_content and replayed unchanged → cache holds. Mode/tool changes are refresh points (one miss).

Tables (db.ts): entities(id, user_id, kind self|person|project|place|org|pet|other, name, note, source, hlc,
vault_event_id, merged_into, …) · entity_aliases · entity_relations(from, to, label, hlc) · memory_entities (local) ·
memory_embeddings(memory_id, model, hash, vector) (local) · memory_candidates(… confidence, sensitive, evidence,
supersedes_id, status) · memory_usage (local) · message_fts (fts5, unicode61 remove_diacritics 2; conversations in
mode « Aucune » never indexed) · discussions += memory_mode, learned_through · messages += memory_json.
Pinned/sensitive = memory tags (already synced). Kinship lexicon (~40 FR/EN phrases, « ma femme » → relation épouse)
in src/memory/entities.ts; nicknames in entity_aliases.
APIs: GET /memories/search · POST /memories/retrieve (dry run, scores, budget) · GET /conversations/search (FTS5
snippets) · /entities CRUD + merge · /memories/candidates accept|reject · PATCH /discussions/:id {memory_mode},
/queries memory_mode · /me memory_mode (memory_enabled:false ⇒ none) · final.memory {mode, profile_tokens,
relevant_tokens, items[{id,title,score}]} stored in messages.memory_json · tools.ts memory_search, search_conversations.

## 3. Retrieval (src/memory/retrieve.ts, async before buildChatTurn)
1 skip small talk / mode ≠ Complète / document-only · 2 pool = active memories − profile − told − facts in last 6
messages · 3 entities from aliases + kinship, query expansion, one hop over relations · 4 H = 0.7·C (cosine, query
instruction « retrieve facts about the user that help answer it ») + 0.3·L (IDF lexical normalised) + E (+0.15 linked
entity) + P (+0.04 manual/pinned, +0.03·exp(−age/180 d)) · 5 admit iff H ≥ τ=0.52 AND (C ≥ 0.45 OR L ≥ 0.6 with a rare
term OR (E>0 AND C ≥ 0.35)) AND H ≥ best − 0.15; lexical-only (no embedding model, e.g. Pi): τ_lex 0.55 on L+E ·
6 dedup cosine > 0.92 (manual, then newest) · 7 budget min(600 tok, 10% ctx), ≤12 items, manual wins ties within
0.05, skip too-long items · 8 output grouped by entity; update memory_usage · 9 ≤300 ms for the query embedding, else
lexical + entities and warm the engine.
Profile (tier a): at refresh points, target 600 / max 800 tok / ≤10% ctx: feedback, pinned, family/work line from the
graph, self core facts, most-used facts; sensitive memories excluded whenever the model isn't local.
Tier (c): tools in « Complète » for tool-capable local models; ≤2 non-streamed tool rounds then stream; results framed
as data; Twoody Code harness registry gains the same tools.
Embeddings: src/embeddings.ts shared (instruction as parameter); memory embeddings on by default when the model files
exist; embed on write and on vault sync, when idle; vectors keyed by model + content hash.

## 4. Learning v2 (src/memory/learner.ts)
« retiens que… » saves immediately. Per-message learnFromMessage removed. At once when the person starts a new
conversation (learnSoon, once nothing is generating — Jimmy 01/10: no delay before the next one knows). Every 5 min: discussions idle ≥10 min with
new user messages after learned_through (not « Aucune »/private); runs on pickBackground (trusted idle peers) or this
computer's runtime — on the owner's slot 0 when it has two (a computer shared with someone, from 24 GB: the guests'
slot 1 is never used for it, builtin/slots.ts, runtimeSlots.ts). Input = user messages only (assistant turns ≤300 chars, « context, do not extract »), documents
and web blocks stripped. JSON-schema output {facts[{text, kind, entities, category, supersedes?, confidence,
evidence}], entities[{name, kind, aliases, relation_to_user}]}. Drop if evidence isn't verbatim in a user message;
+0.15 explicit first-person, −0.3 hedging; drop restatements (normalised or cosine > 0.9). ≥0.8 non-sensitive
non-contradiction → saved « appris »; 0.5–0.8 → candidate; <0.5 dropped. Sensitive categories (health, finances,
religion, politics, sexuality, legal, IDs, precise address) always candidates. Contradictions → candidate with
supersedes_id. Learned entity id = HKDF(epoch-1, "entity\n"+kind+norm(name)).

## 5. UI
Desktop: footer « mémoire : 420 tokens » (click → memories used, Oublier/Modifier); composer « Mémoire : Complète /
Profil seulement / Aucune » (private = Aucune); global selector in Account; Memories: « À confirmer » (sensitive
badge), « Personnes & projets » (aliases, relations, merge), « Épingler », origin « appris ». iPhone: same.

## 6. Mesh sync
Facts as today + entity{id, kind, name, aliases, relations, merged_into, hlc, device} + tombstone in the memories
stream (older readers ignore unknown types); candidate events in phase 2. Embeddings, memory_entities, memory_usage,
message_fts recomputed per computer. Entities LWW per id (tombstone wins ties); aliases/relations union within one
tick; merged_into redirects; deleted entity name hash never re-learned. New fixtures in memory-lww-vectors.json.

## 7. Bench (twoody-bench/memory/)
persona 120 facts / 15 entities / 8 sensitive / 20 distractors, seeded via /memories/import + /entities in a temp
DATA_DIR. 60 questions: 25 need memory, 8 multi-hop, 5 supersede, 17 generic, 5 traps (« Quel âge a la tour
Eiffel ? »). 15 learning transcripts with gold facts (incl. assistant restating a memory → must learn nothing).
Modes: --retrieval-only (/memories/retrieve, no LLM), --sweep tau, --config <model> end to end.
Targets: recall ≥0.92 · tier-b precision ≥0.6 · accuracy ≥0.85 (9B) / ≥0.75 (4B) · pollution ≤10% · leakage ≤2% ·
relevant tokens median ≤250, p95 ≤10% ctx · profile ≤800 tok · warm retrieval p95 ≤150 ms · cache ratio no worse ·
learning precision ≥0.85, recall ≥0.7 · 0 sensitive auto-saved · 0 facts learned from restatements (hard gates).

## 8. Lots
Wave 1: L0 bench suite + baseline · L1 shared embeddings + memory_embeddings · L2 entities + kinship + /entities ·
L4a modes + memory_json + final.memory + PATCH /discussions. Wave 2: L3 retrieval v2 + compact profile + ContextState
(G9) · L5a message_fts + search APIs + tools.ts · L6 learner + candidates. Wave 3: L4b Desktop UI · L4c iPhone UI ·
L7 Memories screens v2 · L8 vault entity events · L5b chat tool loop + Twoody Code tools. queries.ts regions merged in
order L3, L4a, L5b, L6; one db.ts migration block per lot.

## 9. Risks
Profile shrink could regress the age question (bench gate, keep memoryRecall test) · embedding model missing/cold
(lexical fallback, warm-up, never wait >300 ms) · Pi CPU contention (embed when idle, 2 threads) · 4B tool calls
(offer tools only where the bench shows a gain) · model change (vectors keyed by model) · confidence calibration
(evidence check, sensitive gate) · phase-1 candidates only on the coordinator · alias edit races · privacy: « Aucune »
never indexed, sensitive never to cloud, untrusted peers nothing.

## 10. People (16/10/2026)
The graph's people, their contact cards, relations of a fixed kind in ten languages, the learner's relation
proposals and the person card in the chat: docs/people-design.md.
