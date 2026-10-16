import type { FastifyInstance, FastifyRequest } from "fastify";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "../auth.js";
import { ownerRequest } from "../localAccess.js";
import { isLearning, noticesOf } from "../memory/learner.js";
import { isPersonOrOwner } from "../sessionTrust.js";
import { meshRoster } from "../vault/roster.js";
import { db, discussions, messages, sqlite } from "../db.js";
import { generateId } from "../auth.js";
import { publish as publishEvent } from "../events.js";
import { discussionContext } from "./queries.js";
import { readMemoryMode } from "../chatContext.js";
import { discussionTitle } from "../documentBlocks.js";
import { isolatedProjectOf } from "../projects/isolation.js";
import { reachesWalledProjects, walledConversation } from "../projects/walledAccess.js";
import { isThisComputersApp } from "./usage.js";
import { actionsOfMessages } from "../fileActions/store.js";
import { actionView } from "../fileActions/view.js";

// `/discussions` mirrors the cloud's chat-history surface. The RN app
// hits this on chat boot to render the recent-conversations drawer
// and on tapping a row to hydrate the bubble list. Self-hosted mode
// reads straight from SQLite — no Action Cable, no live cursors. The
// inactivity-window resolver in /queries clusters short follow-ups
// into the same discussion, same as cloud DiscussionResolver, so
// the listing matches what the iPhone shows for cloud accounts.
//
// The synchronised history (a conversation with a vault id: the person's
// encrypted history, opened here) is only for this server's owner or one
// of the person's own devices (sessionTrust.ts, however paired, once it
// sent a device-access its vault person device signed): anyone else — a
// household member's phone, a device paired by code that is no member of
// the history, one the console approved, a firmware device — lists, opens,
// deletes and imports only this computer's own conversations.

/// Whether this request may reach the synchronised history.
export async function mayReachHistory(req: FastifyRequest, auth: { sessionId?: string; thisMachine?: boolean }): Promise<boolean> {
  return ownerRequest(req) || (await isPersonOrOwner(req, auth, () => meshRoster().get()));
}

export async function discussionRoutes(app: FastifyInstance) {
  await deleteDiscussion(app);
  await importDiscussion(app);
  await patchDiscussion(app);
  app.get<{
    Querystring: { q?: string; limit?: string; before?: string; project?: string; outside_isolated?: string };
  }>("/discussions", {
    schema: {
      tags: ["session"],
      summary: "List the user's recent discussions (with optional search + pagination)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      querystring: {
        type: "object",
        properties: {
          q:      { type: "string", description: "Substring match against title and any message body" },
          limit:  { type: "string", description: "Max rows to return (default 50, capped at 200)" },
          before: { type: "string", description: "ISO8601 cursor — return rows whose last_activity_at is strictly before this" },
          project: { type: "string", description: "A project's id: its conversations (an isolated project's: this computer's app only)" },
          outside_isolated: { type: "string", description: "« 1 »: only the conversations outside the isolated projects (client files)" },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? "50", 10) || 50));
      const before = req.query.before ? new Date(req.query.before) : null;
      const queryStr = (req.query.q ?? "").trim().toLowerCase();

      // Pull every discussion for this user. Self-hosted volumes
      // are tiny (a power user has hundreds, not millions), so an
      // in-memory filter is far simpler than building proper SQL
      // for the LIKE-or-message-match-or-cursor combo. Pagination
      // is best-effort cursor-based: `before` skips rows past the
      // cursor, then we slice up to `limit`. When the user scrolls
      // beyond the cap they fall through to an empty page rather
      // than a 4xx — same shape the iPhone expects.
      let rows = db
        .select()
        .from(discussions)
        .where(eq(discussions.userId, auth.userId))
        .all();
      if (rows.some((row) => row.vaultId) && !(await mayReachHistory(req, auth))) rows = rows.filter((row) => !row.vaultId);
      // A walled-off project's conversations: this computer's app's and the
      // person's own devices' only (projects/walledAccess.ts); the app asks
      // for the ones outside them, or one project's.
      const walled = new Set((sqlite.prepare("SELECT id FROM projects WHERE user_id = ? AND isolated = 1").all(auth.userId) as Array<{ id: string }>).map((row) => row.id));
      const isolatedRow = (row: { projectId: string | null }) => !!row.projectId && walled.has(row.projectId);
      if (req.query.outside_isolated === "1" || (walled.size && !(await reachesWalledProjects(req, auth)))) rows = rows.filter((row) => !isolatedRow(row));
      if (req.query.project) rows = rows.filter((row) => row.projectId === req.query.project);

      if (queryStr) {
        // Title hits are free (already in `rows`). For body hits we
        // pull the content of every matching message in one shot
        // and bucket by discussion_id, so the loop stays O(n) in
        // total messages instead of O(discussions × messages).
        const titleHits = new Set(
          rows
            .filter((row) => (row.title ?? "").toLowerCase().includes(queryStr))
            .map((row) => row.id),
        );
        // Drizzle has no built-in `LIKE`, but a raw `%substring%` via
        // `sql` would do the same job. We stay JS-side for now —
        // self-hosted message volumes are small (thousands at most),
        // and switching to SQL means accepting injection-safe SQL
        // composition. Worth doing once we hit perf trouble.
        const allMessages = db
          .select({
            discussionId: messages.discussionId,
            content:      messages.content,
          })
          .from(messages)
          .all();
        const bodyHits = new Set<string>();
        for (const row of allMessages) {
          if (row.content.toLowerCase().includes(queryStr)) {
            bodyHits.add(row.discussionId);
          }
        }
        rows = rows.filter((row) => titleHits.has(row.id) || bodyHits.has(row.id));
      }

      // Most recent first. Timestamps have one-second resolution: two
      // conversations active within the same second are told apart by
      // insertion order (the table scan returns rows oldest first), so
      // the one started last still comes first.
      const position = new Map(rows.map((row, index) => [row.id, index]));
      rows = rows.sort(
        (a, b) =>
          b.lastActivityAt.getTime() - a.lastActivityAt.getTime() ||
          (position.get(b.id) ?? 0) - (position.get(a.id) ?? 0),
      );
      if (before) {
        rows = rows.filter((row) => row.lastActivityAt.getTime() < before.getTime());
      }
      const page = rows.slice(0, limit);

      reply.send({
        discussions: page.map((row) => ({
          id:               row.id,
          title:            row.title ?? null,
          // "question" (the first question's, for now), "model" (written
          // by the model), "given" (set on purpose); null for older ones.
          title_source:     row.titleSource ?? null,
          channel:          row.channel,
          vault_id:         row.vaultId ?? null,
          memory_mode:      readMemoryMode(row.memoryMode),
          // The project it is about; `isolated` when that one is a client
          // file (src/projects/isolation.ts).
          project_id:       row.projectId ?? null,
          isolated:         isolatedRow(row),
          created_at:       row.createdAt.toISOString(),
          last_activity_at: row.lastActivityAt.toISOString(),
        })),
        // Cursor for the next page — null when we've reached the
        // tail. The client uses this verbatim as `?before=`.
        next_before:        page.length === limit
          ? page[page.length - 1].lastActivityAt.toISOString()
          : null,
        total_unfiltered:   queryStr ? rows.length : null,
      });
    },
  });

  // What was learned from this conversation (« Mémoire enregistrée »), and
  // whether it is being read now: asked again by the app after an answer
  // until it is not (learner.ts learnAfterAnswer).
  app.get<{ Params: { id: string } }>("/discussions/:id/memory_notices", {
    schema: { tags: ["discussions"], summary: "What was learned from this conversation", security: [{ bearerAuth: [] }, { userTokenAuth: [] }] },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [discussion] = db.select().from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId))).limit(1).all();
      if (!discussion || !(await mayReachHistory(req, auth)) || (walledConversation(discussion.id) && !(await reachesWalledProjects(req, auth)))) return reply.code(404).send({ error: "not_found" });
      reply.send({ notices: noticesOf(auth.userId, discussion.id), learning: isLearning(discussion.id) });
    },
  });

  app.get<{ Params: { id: string } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Discussion + ordered messages",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: {
        type: "object",
        required: ["id"],
        properties: { id: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const [discussion] = db
        .select()
        .from(discussions)
        .where(and(
          eq(discussions.id, req.params.id),
          eq(discussions.userId, auth.userId),
        ))
        .limit(1)
        .all();
      const isolated = discussion ? isolatedProjectOf(discussion.id, auth.userId) : null;
      if (!discussion || (discussion.vaultId && !(await mayReachHistory(req, auth))) || (isolated && !(await reachesWalledProjects(req, auth)))) {
        return reply.code(404).send({ error: "not_found" });
      }

      const rows = db
        .select()
        .from(messages)
        .where(eq(messages.discussionId, discussion.id))
        .all()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());

      // A compaction: where its summary stops, and what the model is given
      // of the conversation now (the gauge under the composer).
      const context = discussionContext(auth.userId, discussion.id);
      // Which memories an answer was given is the person's to read (like
      // /memories): counted for anyone else, not listed.
      const listsMemories = rows.some((row) => row.memoryJson) && (await mayReachHistory(req, auth));
      // The actions proposed in it (« Agir dans vos dossiers », fileActions/):
      // their cards, for the person only — never a path.
      const person = isThisComputersApp(auth) || (await mayReachHistory(req, auth));
      const actions = person ? actionsOfMessages(auth.userId, rows.filter((row) => row.provider === "twoody").map((row) => row.id)) : new Map();
      const actionViewer = { sessionId: auth.sessionId ?? null, thisComputersApp: isThisComputersApp(auth) };
      reply.send({
        id:               discussion.id,
        title:            discussion.title ?? null,
        title_source:     discussion.titleSource ?? null,
        channel:          discussion.channel,
        vault_id:         discussion.vaultId ?? null,
        // Its own memory mode (Mémoire v2); null follows the person's (/me).
        memory_mode:      readMemoryMode(discussion.memoryMode),
        // The isolated project (client file) it is in: its title, for the
        // chat (src/projects/isolation.ts).
        isolated_project: isolated,
        // What was learned from it (« Mémoire mise à jour »): the person's.
        memory_notices:   (await mayReachHistory(req, auth)) ? noticesOf(auth.userId, discussion.id) : [],
        summary:          context.summary,
        summary_through:  context.summaryThrough,
        context_tokens_estimate: context.tokensEstimate,
        created_at:       discussion.createdAt.toISOString(),
        last_activity_at: discussion.lastActivityAt.toISOString(),
        messages: rows.map((row) => ({
          id:         row.id,
          role:       row.role,
          content:    row.content,
          provider:   row.provider,
          model:      row.model,
          // A device never gets this computer's paths (a walled-off
          // project's sources kept with an answer asked from the app).
          sources:    isolated && !isThisComputersApp(auth) ? withoutPaths(parseSources(row.sourcesJson)) : parseSources(row.sourcesJson),
          reasoning:  row.reasoning ?? null,
          reasoning_ms: row.reasoningMs ?? null,
          prompt_tokens: row.promptTokens ?? null,
          completion_tokens: row.completionTokens ?? null,
          tokens_estimated: row.tokensEstimated ?? null,
          // Which of the account's computers wrote it (router/, /queries).
          answered_by: parseAnsweredBy(row.answeredByJson),
          // « recording » for a question said aloud.
          channel:    row.channel ?? null,
          // What an answer was given of the memories (/queries final.memory).
          memory:     memoryOf(row.memoryJson, listsMemories),
          ...(actions.has(row.id) ? { file_action: actionView(actions.get(row.id)!, actionViewer) } : {}),
          created_at: row.createdAt.toISOString(),
        })),
      });
    },
  });
}

/// A conversation's memory mode (Mémoire v2, L4a): « Complète » ("full"),
/// « Profil seulement » ("profile"), « Aucune » ("none"), or null to follow
/// the person's (/me). Its next turn freezes the memories again for it.
async function patchDiscussion(app: FastifyInstance) {
  app.patch<{ Params: { id: string }; Body: { memory_mode?: unknown } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Change a discussion's memory mode",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
      body: { type: "object", properties: { memory_mode: { type: ["string", "null"] } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const [owned] = db
        .select({ id: discussions.id, vaultId: discussions.vaultId, memoryMode: discussions.memoryMode })
        .from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
        .limit(1)
        .all();
      if (!owned || (owned.vaultId && !(await mayReachHistory(req, auth))) || (walledConversation(owned.id) && !(await reachesWalledProjects(req, auth)))) return reply.code(404).send({ error: "not_found" });
      const body = req.body ?? {};
      let memoryMode = readMemoryMode(owned.memoryMode);
      if ("memory_mode" in body) {
        if (body.memory_mode !== null && !readMemoryMode(body.memory_mode)) return reply.code(422).send({ error: "invalid_memory_mode" });
        memoryMode = readMemoryMode(body.memory_mode);
        db.update(discussions).set({ memoryMode }).where(eq(discussions.id, owned.id)).run();
      }
      reply.send({ id: owned.id, memory_mode: memoryMode });
    },
  });
}

/// Deletes a discussion and its messages — what "Supprimer" in the
/// desktop's sidebar does, as in ChatGPT and Claude.
async function deleteDiscussion(app: FastifyInstance) {
  app.delete<{ Params: { id: string } }>("/discussions/:id", {
    schema: {
      tags: ["session"],
      summary: "Delete a discussion and its messages",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: { type: "object", required: ["id"], properties: { id: { type: "string" } } },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const owned = db
        .select({ id: discussions.id, vaultId: discussions.vaultId })
        .from(discussions)
        .where(and(eq(discussions.id, req.params.id), eq(discussions.userId, auth.userId)))
        .limit(1)
        .all();
      // A walled-off project's conversation: deleted from this computer's app only.
      if (owned.length === 0 || (owned[0]!.vaultId && !(await mayReachHistory(req, auth))) || (walledConversation(owned[0]!.id) && !(await reachesWalledProjects(req, auth)))) return reply.code(404).send({ error: "not_found" });
      db.transaction((tx) => {
        tx.delete(messages).where(eq(messages.discussionId, req.params.id)).run();
        tx.delete(discussions).where(eq(discussions.id, req.params.id)).run();
      });
      publishEvent({ kind: "discussion.touched", userId: auth.userId, discussionId: req.params.id, lastActivityAt: new Date().toISOString() });
      reply.code(204).send();
    },
  });
}

/// Sources without the absolute path this computer's own app may see.
function withoutPaths(sources: unknown[]): unknown[] {
  return sources.map((source) => {
    if (!source || typeof source !== "object") return source;
    const { path: _path, ...kept } = source as Record<string, unknown>;
    return kept;
  });
}

/// Document excerpts an assistant reply was given, so its [1], [2]…
/// citations still resolve when the discussion is reopened.
function parseSources(raw: string | null): unknown[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

const VAULT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// An encrypted conversation brought to this computer (twoody-app
// utils/vaultSync.js, twoody-desktop src/shared/vaultSync.ts): the client
// opened its exchanges with its own keys and hands them over so that the
// conversation can go on here, with its history. Idempotent: the
// conversation is found by its vault id, an exchange by its ref; importing
// again adds only what is new. Only for the signed-in owner of this
// server — nothing here comes from or goes to the account.
async function importDiscussion(app: FastifyInstance) {
  app.post<{ Body: { vault_id: string; discussion_id?: string; title?: string; turns: Array<{ ref: string; text: string; reply: string; model?: string | null; created_at?: string }> } }>("/discussions/import", {
    schema: {
      tags: ["session"],
      summary: "Create or extend a conversation from its decrypted exchanges",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        required: ["vault_id", "turns"],
        properties: {
          vault_id: { type: "string", maxLength: 36 },
          // A conversation already here that starts being synchronised:
          // it takes the vault id, so later imports extend it.
          discussion_id: { type: "string", maxLength: 100 },
          title: { type: "string", maxLength: 200 },
          turns: {
            type: "array", maxItems: 500,
            items: {
              type: "object", required: ["ref", "text", "reply"],
              properties: {
                ref: { type: "string", minLength: 1, maxLength: 200 },
                text: { type: "string", maxLength: 100000 },
                reply: { type: "string", maxLength: 200000 },
                model: { type: ["string", "null"], maxLength: 200 },
                created_at: { type: "string", maxLength: 40 },
              },
            },
          },
        },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      if (!(await mayReachHistory(req, auth))) return reply.code(403).send({ error: "person_device_required" });
      const vaultId = req.body.vault_id.toLowerCase();
      if (!VAULT_ID.test(vaultId)) return reply.code(422).send({ error: "invalid_vault_id" });

      const result = importVaultConversation(auth.userId, { ...req.body, vault_id: vaultId });
      if ("error" in result) return reply.code(result.error === "unknown_discussion" ? 404 : 409).send({ error: result.error });
      reply.send({ discussion_id: result.id, added: result.added, created: result.created });
    },
  });
}

export type ImportedTurn = {
  ref: string; text: string; reply: string; model?: string | null; created_at?: string;
  /// Kept with the reply when the vault carries them (src/vault/sync.ts): who
  /// answered, and the excerpts it cited (never a path).
  answered_by?: unknown; sources?: unknown[];
  /// « recording » for a question said aloud.
  channel?: unknown;
};
export type ImportBody = { vault_id: string; discussion_id?: string; title?: string; turns: ImportedTurn[] };

/// POST /discussions/import's work, for this computer's own vault sync too
/// (src/vault/sync.ts): the same conversation by its vault id, the same
/// exchange by its ref, so importing again adds only what is new.
export function importVaultConversation(userId: string, body: ImportBody): { error: "unknown_discussion" | "already_synchronised" | "invalid_vault_id" | "isolated_conversation" } | { id: string; added: number; created: boolean } {
  const vaultId = body.vault_id.toLowerCase();
  if (!VAULT_ID.test(vaultId)) return { error: "invalid_vault_id" };
  const run = sqlite.transaction(() => {
    let found = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").get(userId, vaultId) as { id: string } | undefined;
    if (found && body.discussion_id && found.id !== body.discussion_id) return { error: "already_synchronised" as const };
    if (!found && body.discussion_id) {
      const own = sqlite.prepare("SELECT id, vault_id FROM discussions WHERE user_id = ? AND id = ?").get(userId, body.discussion_id) as { id: string; vault_id: string | null } | undefined;
      if (!own) return { error: "unknown_discussion" as const };
      // An isolated project's conversation is never synchronised
      // (src/projects/isolation.ts).
      if (isolatedProjectOf(own.id, userId)) return { error: "isolated_conversation" as const };
      if (own.vault_id && own.vault_id !== vaultId) return { error: "already_synchronised" as const };
      sqlite.prepare("UPDATE discussions SET vault_id = ? WHERE id = ?").run(vaultId, own.id);
      found = { id: own.id };
    }
    const nowMs = Date.now();
    const id = found?.id ?? generateId();
    let retitled: string | null = null;
    // A title the vault only made from the first question (no device sealed
    // one: src/vault/sync.ts mergeInto) is no title given on purpose.
    const firstAsked = (sqlite.prepare("SELECT content FROM messages WHERE discussion_id = ? AND role = 'user' ORDER BY rowid LIMIT 1").get(id) as { content: string } | undefined)?.content;
    const firstTurn = [...body.turns].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")))[0]?.text;
    const derived = (title: string) => [firstAsked, firstTurn].some((text) => text != null && (title === text.slice(0, 60) || title === discussionTitle(text)));
    if (!found) {
      const title = body.title?.slice(0, 200) || body.turns[0]?.text.slice(0, 60) || null;
      sqlite.prepare("INSERT INTO discussions (id, user_id, channel, title, title_source, created_at, last_activity_at, vault_id) VALUES (?, ?, 'vault', ?, ?, ?, ?, ?)")
        .run(id, userId, title, title === null ? null : body.title && !derived(body.title) ? "given" : "question", nowMs, nowMs, vaultId);
    } else if (body.title) {
      const title = body.title.slice(0, 200);
      const here = sqlite.prepare("SELECT title, title_source FROM discussions WHERE id = ?").get(id) as { title: string | null; title_source: string | null };
      const auto = derived(title);
      // The model's title here, or one given, is not replaced by the first
      // question's.
      if (here.title !== title && !(auto && (here.title_source === "model" || here.title_source === "given"))) {
        sqlite.prepare("UPDATE discussions SET title = ?, title_source = ? WHERE id = ?").run(title, auto ? (here.title_source ?? "question") : "given", id);
        retitled = title;
      }
    }
    const known = new Set((sqlite.prepare("SELECT vault_ref FROM messages WHERE discussion_id = ? AND vault_ref IS NOT NULL").all(id) as Array<{ vault_ref: string }>).map((row) => row.vault_ref));
    const insert = sqlite.prepare("INSERT INTO messages (id, discussion_id, user_id, role, content, provider, model, vault_ref, created_at, sources, answered_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
    let added = 0;
    let latest = 0;
    const turns = [...body.turns].sort((a, b) => String(a.created_at ?? "").localeCompare(String(b.created_at ?? "")));
    const adopt = sqlite.prepare("SELECT id, rowid AS position FROM messages WHERE discussion_id = ? AND id = ? AND role = 'user' AND vault_ref IS NULL");
    const replyAfter = sqlite.prepare("SELECT id FROM messages WHERE discussion_id = ? AND role = 'assistant' AND vault_ref IS NULL AND rowid > ? ORDER BY rowid LIMIT 1");
    const setRef = sqlite.prepare("UPDATE messages SET vault_ref = ? WHERE id = ?");
    // The same question asked here moments before, without a ref (a phone
    // that did not name its exchange: Jimmy, 03/10/2026, a spoken question
    // shown twice, its copy from the vault added beside it).
    const sameQuestion = sqlite.prepare("SELECT id, rowid AS position FROM messages WHERE discussion_id = ? AND role = 'user' AND vault_ref IS NULL AND content = ? AND created_at BETWEEN ? AND ? ORDER BY rowid DESC LIMIT 1");
    for (const turn of turns) {
      if (known.has(turn.ref)) continue;
      // An exchange already here, now being synchronised (its ref is the
      // question's message id, or the same words asked a moment before):
      // it takes the ref instead of a copy.
      const asked = Date.parse(turn.created_at ?? "") || Date.now();
      const existing = (adopt.get(id, turn.ref) ?? sameQuestion.get(id, turn.text, asked - 600_000, asked + 600_000)) as { id: string; position: number } | undefined;
      if (existing) {
        setRef.run(turn.ref, existing.id);
        const answer = replyAfter.get(id, existing.position) as { id: string } | undefined;
        if (answer) setRef.run(`${turn.ref}#reply`, answer.id);
        known.add(turn.ref);
        continue;
      }
      const at = Date.parse(turn.created_at ?? "") || Date.now();
      const sources = Array.isArray(turn.sources) && turn.sources.length > 0 ? JSON.stringify(turn.sources.slice(0, 12)) : null;
      const answeredBy = turn.answered_by && typeof turn.answered_by === "object" ? JSON.stringify(turn.answered_by) : null;
      const questionId = generateId();
      insert.run(questionId, id, userId, "user", turn.text, null, null, turn.ref, at, null, null);
      if (turn.channel === "recording") sqlite.prepare("UPDATE messages SET channel = 'recording' WHERE id = ?").run(questionId);
      insert.run(generateId(), id, userId, "assistant", turn.reply, "vault", turn.model ?? null, `${turn.ref}#reply`, at, sources, answeredBy);
      known.add(turn.ref);
      latest = Math.max(latest, at);
      added += 1;
    }
    if (latest) sqlite.prepare("UPDATE discussions SET last_activity_at = MAX(last_activity_at, ?) WHERE id = ?").run(latest, id);
    return { id, added, created: !found, retitled };
  });
  const outcome = run();
  if ("error" in outcome) return outcome;
  const { retitled, ...result } = outcome;
  if (result.created) publishEvent({ kind: "discussion.created", userId, discussionId: result.id, title: body.title ?? null });
  else if (result.added > 0) publishEvent({ kind: "discussion.touched", userId, discussionId: result.id, lastActivityAt: new Date().toISOString() });
  // Another device's title for it: the lists show it.
  if (retitled !== null) publishEvent({ kind: "discussion.updated", userId, discussionId: result.id, title: retitled });
  return result;
}

/// A conversation deleted on another device (a vault tombstone): its copy
/// here goes, as DELETE /discussions/:id does. Returns how many went.
export function deleteVaultConversation(userId: string, vaultId: string): number {
  const rows = sqlite.prepare("SELECT id FROM discussions WHERE user_id = ? AND vault_id = ?").all(userId, vaultId.toLowerCase()) as Array<{ id: string }>;
  for (const row of rows) {
    db.transaction((tx) => {
      tx.delete(messages).where(eq(messages.discussionId, row.id)).run();
      tx.delete(discussions).where(eq(discussions.id, row.id)).run();
    });
    publishEvent({ kind: "discussion.touched", userId, discussionId: row.id, lastActivityAt: new Date().toISOString() });
  }
  return rows.length;
}

function parseJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

function memoryOf(json: string | null, listed: boolean): unknown {
  const memory = parseJson(json);
  if (!memory || typeof memory !== "object" || listed) return memory;
  return { ...(memory as Record<string, unknown>), items: [] };
}

function parseAnsweredBy(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}
