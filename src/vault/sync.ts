import { sha256 } from "@noble/hashes/sha2.js";
import { randomBytes as systemRandomBytes } from "@noble/hashes/utils.js";
import { openEvent, sealEvent, toHex, VaultError, type Random, type SealedEvent } from "./crypto.js";
import type { EventsApi } from "./client.js";
import type { VaultStore } from "./store.js";

// Encrypted conversations synchronised through the vault: a port of
// twoody-desktop src/shared/vaultSync.ts (twoody-app utils/vaultSync.js),
// with the conversations part of src/shared/vaultConversations.ts
// (reconcile, sealing this computer's own turns) and the catch-up S4 needs
// (docs/mesh-design.md §3).
//
//   push  a finished exchange, a title or a deletion is sealed ONCE with the
//         newest epoch key and kept in an outbox until the account has it;
//         a retry after a lost answer resends the same bytes, so the account
//         sees a duplicate, never a conflict
//   pull  events come back in the account's order from a saved cursor, are
//         opened with the epoch keys this device holds and merged into a
//         local copy of each conversation ("conversations" stream only:
//         memories are S5's)
//   merge exchanges are keyed by their own ref: two devices writing the same
//         conversation at once both keep their exchange, ordered by date —
//         nothing is overwritten. A deletion (tombstone) hides the
//         conversation on every device.
//   local the opened conversations become this server's own discussions
//         through the idempotent import (src/routes/discussions.ts
//         importVaultConversation); a tombstone deletes the copy here.
//
// The account sees only the routing header: conversation and event ids,
// epoch, kind, date.

export const CONVERSATIONS_STREAM = "conversations";

export type Turn = {
  ref: string; text: string; reply: string; model?: string | null; host?: string | null; sources?: unknown[]; created_at?: string;
  /// Which computer wrote the reply (src/routes/queries.ts AnsweredBy). Older readers ignore it.
  answered_by?: unknown;
};
type StoredTurn = { ref: string; text: string; reply: string; model: string | null; host: string | null; sources: unknown[]; created_at: string; answered_by?: unknown };
/// An event's decrypted payload: a turn, a title or a tombstone, read field by field.
type Payload = { ref?: unknown; text?: unknown; reply?: unknown; model?: string | null; host?: string | null; sources?: unknown; created_at?: string; title?: unknown; deleted?: boolean; answered_by?: unknown } | null | undefined;
type Cache = { cursor: number; conversations: Record<string, { id: string; title: string | null; turns: Record<string, StoredTurn>; deleted: boolean; updated_at: string }> };
const emptyCache = (): Cache => ({ cursor: 0, conversations: {} });

export const EVENT_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuidFrom(bytes: Uint8Array): string {
  const b = Uint8Array.from(bytes.slice(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50; // name-based, derived
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = toHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/// A fresh conversation id (random, never an account or server id).
export function newConversationId(random: Random = systemRandomBytes): string {
  const b = random(16);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = toHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/// The same conversation id on every device for a conversation brought in
/// from elsewhere (twoody-desktop derivedConversationId).
export function derivedConversationId(namespace: string, key: string): string {
  return uuidFrom(sha256(new TextEncoder().encode(`twoody/vault/conversation-id/v1\n${namespace}\n${key}`)));
}

/// The same exchange always gets the same event id.
export function eventIdFor(conversationId: string, kind: string, ref: string): string {
  return uuidFrom(sha256(new TextEncoder().encode(`twoody/vault/event-id/v1\n${conversationId}\n${kind}\n${ref}`)));
}

export function createVaultSync({ api, epochKeys, userId, store, random = systemRandomBytes, now = () => new Date().toISOString() }: {
  api: EventsApi; epochKeys: () => Promise<Map<number, Uint8Array>> | Map<number, Uint8Array>; userId: string | number; store: VaultStore; random?: Random; now?: () => string;
}) {
  const keys = {
    outbox: `twoody.vaultOutbox.v1.${userId}`,
    cache: `twoody.vaultConversations.v1.${userId}`,
  };
  let writes: Promise<unknown> = Promise.resolve();

  async function read<T>(key: string, fallback: T): Promise<T> {
    try {
      const raw = await store.get(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }
  function update<T, R>(key: string, fallback: T, fn: (value: T) => R): Promise<R> {
    const run = writes.then(async () => {
      const value = await read(key, fallback);
      const result = fn(value);
      await store.set(key, JSON.stringify(value));
      return result;
    });
    writes = run.catch(() => undefined);
    return run;
  }

  async function seal(conversationId: string, kind: string, ref: string, payload: unknown, createdAt: string) {
    const held = await epochKeys();
    if (!held || held.size === 0) throw new VaultError("not_trusted");
    const epoch = Math.max(...held.keys());
    return sealEvent({
      epochKey: held.get(epoch) as Uint8Array, epoch, userId, conversationId, kind, createdAt, payload, random,
      eventId: eventIdFor(conversationId, kind, ref),
    });
  }

  function mergeInto(cache: Cache, conversationId: string, kind: string, payload: Payload, createdAt: string) {
    // Only what a conversation is made of: an unknown kind (a memory that
    // strayed here) makes no empty conversation.
    if (kind !== "tombstone" && kind !== "title" && kind !== "turn") return;
    const conversation = cache.conversations[conversationId] ||= { id: conversationId, title: null, turns: {}, deleted: false, updated_at: createdAt };
    if (kind === "tombstone") {
      conversation.deleted = true;
      conversation.turns = {};
    } else if (kind === "title") {
      conversation.title = String(payload?.title || "").slice(0, 120) || conversation.title;
    } else if (kind === "turn" && payload?.ref && !conversation.deleted) {
      conversation.turns[String(payload.ref)] = {
        ref: String(payload.ref), text: String(payload.text || ""), reply: String(payload.reply || ""),
        model: payload.model || null, host: payload.host || null, sources: Array.isArray(payload.sources) ? payload.sources.slice(0, 12) : [],
        created_at: payload.created_at || createdAt,
        ...(payload.answered_by && typeof payload.answered_by === "object" ? { answered_by: payload.answered_by } : {}),
      };
      if (!conversation.title) conversation.title = String(payload.text || "").slice(0, 60) || null;
    }
    if (String(createdAt) > String(conversation.updated_at || "")) conversation.updated_at = createdAt;
  }

  async function enqueue(conversationId: string, kind: string, ref: string, payload: Payload) {
    if (!EVENT_UUID.test(conversationId)) throw new VaultError("bad_conversation_id");
    const createdAt = payload?.created_at || now();
    const event = await seal(conversationId, kind, ref, payload, createdAt);
    await update(keys.outbox, [] as SealedEvent[], (outbox) => {
      if (!outbox.some((e) => e.event_id === event.event_id)) outbox.push(event);
    });
    // Shown at once on this device, before the account has it.
    await update(keys.cache, emptyCache(), (cache) => mergeInto(cache, conversationId, kind, payload, createdAt));
    return event.event_id;
  }

  /// A finished exchange of an encrypted conversation.
  const recordTurn = (conversationId: string, turn: Turn) => enqueue(conversationId, "turn", String(turn.ref), {
    ref: String(turn.ref), text: turn.text, reply: turn.reply, model: turn.model || null, host: turn.host || null,
    sources: turn.sources || [], created_at: turn.created_at || now(),
    ...(turn.answered_by ? { answered_by: turn.answered_by } : {}),
  });
  const recordTitle = (conversationId: string, title: string) => enqueue(conversationId, "title", `title:${now()}`, { title });
  const deleteConversation = (conversationId: string) => enqueue(conversationId, "tombstone", "tombstone", { deleted: true });

  let flushing: Promise<{ sent: number; pending: number }> | null = null;
  /// Sends what the account does not have yet, 50 at a time.
  function flush() {
    if (flushing) return flushing;
    flushing = (async () => {
      let sent = 0;
      for (;;) {
        const outbox = await read(keys.outbox, [] as SealedEvent[]);
        if (outbox.length === 0) return { sent, pending: 0 };
        const batch = outbox.slice(0, 50);
        const result = await api.postEvents(batch.map((event) => ({ ...event, stream: CONVERSATIONS_STREAM })));
        if (result?.error === "invalid_event") {
          // One refused event must not hold back the others forever.
          await update(keys.outbox, [] as SealedEvent[], (box) => {
            const i = box.findIndex((e) => e.event_id === result.event_id);
            if (i >= 0) box.splice(i, 1);
            else box.shift();
          });
          continue;
        }
        // Stored, duplicate of what the account has, or a conflict: none of
        // them will change by sending again.
        const done = new Set(batch.map((e) => e.event_id));
        await update(keys.outbox, [] as SealedEvent[], (box) => {
          for (let i = box.length - 1; i >= 0; i -= 1) if (done.has(box[i]!.event_id)) box.splice(i, 1);
        });
        sent += result?.stored || 0;
      }
    })().finally(() => {
      flushing = null;
    });
    return flushing;
  }

  let pulling: Promise<{ received: number; unreadable: number }> | null = null;
  /// Brings in what other devices wrote since the last pull. One at a
  /// time: a second caller waits for the pull under way.
  function pull() {
    if (pulling) return pulling;
    pulling = (async () => {
      const held = await epochKeys();
      let unreadable = 0;
      let received = 0;
      for (;;) {
        const { cursor } = await read(keys.cache, emptyCache());
        const page = await api.events({ after: cursor, limit: 200, stream: CONVERSATIONS_STREAM });
        const events = page?.events || [];
        await update(keys.cache, emptyCache(), (cache) => {
          for (const event of events) {
            if (event.stream && event.stream !== CONVERSATIONS_STREAM) continue;
            try {
              mergeInto(cache, event.conversation_id, event.kind, openEvent(event, held) as Payload, event.created_at);
              received += 1;
            } catch {
              unreadable += 1;
            }
            cache.cursor = Math.max(cache.cursor || 0, Number(event.seq) || 0);
          }
        });
        if (!page?.next_after) return { received, unreadable };
      }
    })().finally(() => {
      pulling = null;
    });
    return pulling;
  }

  async function sync() {
    const pushed = await flush();
    const pulled = await pull();
    return { ...pushed, ...pulled };
  }

  /// The encrypted conversations, newest first.
  async function conversations() {
    const cache = await read(keys.cache, emptyCache());
    return Object.values(cache.conversations)
      .filter((c) => !c.deleted && Object.keys(c.turns).length > 0)
      .map((c) => ({ id: c.id, name: c.title, updated_at: c.updated_at }))
      .sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)));
  }

  /// Its exchanges, oldest first.
  async function conversation(conversationId: string) {
    const cache = await read(keys.cache, emptyCache());
    const found = cache.conversations[conversationId];
    if (!found || found.deleted) return [];
    return Object.values(found.turns).sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)) || a.ref.localeCompare(b.ref));
  }

  async function isDeleted(conversationId: string) {
    const cache = await read(keys.cache, emptyCache());
    return cache.conversations[conversationId]?.deleted === true;
  }

  /// Conversations a device deleted (tombstones): their local copies go too.
  async function deletedConversationIds() {
    const cache = await read(keys.cache, emptyCache());
    return Object.values(cache.conversations).filter((c) => c.deleted).map((c) => c.id);
  }

  async function pending() {
    return (await read(keys.outbox, [] as SealedEvent[])).length;
  }

  /// When this computer leaves the vault: the opened copies and the outbox
  /// go (nothing can seal the outbox again).
  async function forget() {
    await update(keys.cache, emptyCache(), (cache) => {
      cache.cursor = 0;
      cache.conversations = {};
    });
    await update(keys.outbox, [] as SealedEvent[], (outbox) => {
      outbox.splice(0, outbox.length);
    });
  }

  return { recordTurn, recordTitle, deleteConversation, flush, pull, sync, conversations, conversation, isDeleted, deletedConversationIds, pending, forget };
}

export type VaultSync = ReturnType<typeof createVaultSync>;

// ── this server's own discussions ────────────────────────────────────────

/// What the sync needs of this server's discussions (src/vault/localHistory.ts
/// over SQLite; a stand-in in tests).
export interface LocalHistory {
  import(body: { vault_id: string; title?: string; turns: Array<{ ref: string; text: string; reply: string; model?: string | null; created_at?: string; answered_by?: unknown; sources?: unknown[] }> }): { id: string; added: number; created: boolean } | { error: string };
  deleteByVaultId(vaultId: string): number;
  /// The discussion holding this vault conversation, and the refs it has.
  byVaultId(vaultId: string): { id: string; refs: Set<string> } | null;
  /// A discussion's vault id, if it is synchronised.
  vaultIdOf(discussionId: string): string | null;
  /// One exchange of a discussion that this computer answered itself, by its
  /// question's vault ref: null when it has none, several, or one imported.
  turn(discussionId: string, ref: string): { text: string; reply: string; model: string | null; created_at: string; sources: unknown[]; answered_by: unknown } | null;
}

/// A source as it may leave this computer: what a citation shows, never a
/// path (docs/mesh-design.md §0, §3).
export function pathlessSource(source: unknown, computerId: string | null): Record<string, unknown> | null {
  if (!source || typeof source !== "object") return null;
  const s = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ["n", "document_id", "name", "page", "snippet", "source_id", "folder", "rel_path", "computer_name"]) {
    const value = s[key];
    if (typeof value === "string" || typeof value === "number") out[key] = value;
  }
  // A relative path that climbs, or anything that looks absolute, is dropped.
  if (typeof out.rel_path === "string" && (/^([a-z]:)?[\\/]/i.test(out.rel_path) || out.rel_path.split(/[\\/]/).includes(".."))) delete out.rel_path;
  if (typeof out.name === "string" && /[\\/]/.test(out.name)) out.name = out.name.split(/[\\/]/).pop() ?? "";
  const computer = typeof s.computer_id === "string" ? s.computer_id : computerId;
  if (computer) out.computer_id = computer;
  return Object.keys(out).length ? out : null;
}

export function createConversationBridge({ sync, local, userId, trusted, self }: {
  sync: VaultSync;
  local: LocalHistory;
  /// The local user the conversations belong to (this server's owner).
  userId: string;
  /// Whether this computer holds epoch keys now.
  trusted: () => Promise<boolean> | boolean;
  /// This computer, as it signs its turns.
  self: () => { id: string | null; name: string | null };
}) {
  const counts = new Map<string, number>();

  /// Brings the opened conversations into this server: a conversation is
  /// imported again only when it has more exchanges than the last time
  /// (twoody-desktop syncLocalConversations), a deleted one is removed.
  async function reconcile() {
    let brought = 0;
    for (const row of await sync.conversations()) {
      const turns = await sync.conversation(row.id);
      if (turns.length === 0 || turns.length <= (counts.get(row.id) || 0)) continue;
      const imported = local.import({
        vault_id: row.id, ...(row.name ? { title: row.name } : {}),
        turns: turns.map(({ ref, text, reply, model, created_at, answered_by, sources }) => ({ ref, text, reply, model, created_at, answered_by, sources })),
      });
      if ("error" in imported) continue;
      counts.set(row.id, turns.length);
      brought += 1;
    }
    let removed = 0;
    for (const vaultId of await sync.deletedConversationIds()) {
      removed += local.deleteByVaultId(vaultId);
      counts.delete(vaultId);
    }
    return { brought, removed };
  }

  /// What the minute's work does: push, pull, bring in.
  async function run() {
    if (!(await trusted())) return { trusted: false as const };
    const synced = await sync.sync();
    const reconciled = await reconcile();
    return { trusted: true as const, ...synced, ...reconciled, pending: await sync.pending() };
  }

  /// This computer answered a turn of a synchronised conversation: sealed
  /// with who answered and its sources without paths, then sent.
  async function sealOwnTurn(discussionId: string, ref: string) {
    if (!(await trusted())) return { sealed: false as const, reason: "not_trusted" };
    const vaultId = local.vaultIdOf(discussionId);
    if (!vaultId) return { sealed: false as const, reason: "not_synchronised" };
    const turn = local.turn(discussionId, ref);
    if (!turn || !turn.text || !turn.reply) return { sealed: false as const, reason: "no_turn" };
    const me = self();
    const eventId = await sync.recordTurn(vaultId, {
      ref, text: turn.text, reply: turn.reply, model: turn.model, host: me.name,
      sources: turn.sources.map((source) => pathlessSource(source, me.id)).filter((s): s is Record<string, unknown> => !!s),
      created_at: turn.created_at,
      ...(turn.answered_by ? { answered_by: turn.answered_by } : {}),
    });
    // It is here already: the next reconcile has nothing to add for it.
    counts.set(vaultId, (await sync.conversation(vaultId)).length);
    await sync.flush().catch(() => null);
    return { sealed: true as const, eventId, pending: await sync.pending() };
  }

  /// Catch-up (docs/mesh-design.md §3, for S4): a question comes for vault
  /// conversation `vaultConversationId`, whose sender knows the exchanges
  /// `knownRefs` (its last three). When some are not here, one pull is
  /// tried within `timeoutMs`; the caller then answers with what is here,
  /// or asks for prior_turns inlined.
  async function ensureConversation(vaultConversationId: string, knownRefs: string[], timeoutMs = 1000): Promise<{
    status: "complete" | "missing" | "deleted" | "unavailable";
    discussionId: string | null;
    missing: string[];
  }> {
    const id = String(vaultConversationId || "").toLowerCase();
    if (!EVENT_UUID.test(id)) throw new VaultError("bad_conversation_id");
    const refs = [...new Set((knownRefs || []).filter((r) => typeof r === "string" && r))].slice(0, 20);
    const check = () => {
      const here = local.byVaultId(id);
      const missing = refs.filter((ref) => !here?.refs.has(ref));
      return { discussionId: here?.id ?? null, missing };
    };
    let state = check();
    if (state.missing.length === 0 && (state.discussionId || refs.length === 0)) return { status: "complete", ...state };
    if (!(await trusted())) return { status: "unavailable", ...state };
    let timer: NodeJS.Timeout | undefined;
    const deadline = new Promise<"late">((resolve) => {
      timer = setTimeout(() => resolve("late"), Math.max(0, timeoutMs));
      timer.unref?.();
    });
    const pulled = await Promise.race([sync.pull().then(() => reconcile()).then(() => "done" as const), deadline]).catch(() => "failed" as const);
    if (timer) clearTimeout(timer);
    if (pulled === "done" && (await sync.isDeleted(id))) return { status: "deleted", discussionId: null, missing: refs };
    state = check();
    return { status: state.missing.length === 0 && state.discussionId ? "complete" : "missing", ...state };
  }

  return { reconcile, run, sealOwnTurn, ensureConversation };
}

export type ConversationBridge = ReturnType<typeof createConversationBridge>;
