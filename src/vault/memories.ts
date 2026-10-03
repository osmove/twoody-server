import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { sqlite as localSqlite } from "../db.js";
import {
  compareMemoryEvents, hlcReceive, hlcTick, learnedMemoryId, memoriesStreamId, memoryContentHash, memoryEventId, mergeMemories,
  normaliseMemoryContent, parseHlc, readMemoryEvent, MEMORY_KINDS, type MemoryEvent, type MemorySource, type MemoryStreamEvent,
} from "./contracts.js";
import { openEvent, sealEvent, type Random, type SealedEvent } from "./crypto.js";
import type { EventsApi } from "./client.js";
import { vaultContext, vaultEpochKeys, vaultIdentity } from "./service.js";
import { memoriesChanged } from "../memory/changes.js";

// Memories through the vault (docs/mesh-design.md §3, lot S5): every
// trusted computer holds the same memories, end-to-end encrypted in the
// vault's own « memories » stream — never the conversations stream, whose
// older readers would make an empty conversation of them.
//
//   push   a memory written here — by hand (src/routes/memories.ts), learned
//          from a conversation (src/memoryLearning.ts) or imported — or
//          deleted becomes a memory or tombstone event (P0 contract,
//          src/vault/contracts.ts): stamped with this device's hybrid
//          logical clock and vault device id, kept in memory_vault_events,
//          sealed once, sent until the account has it
//   pull   the others' events, opened with the epoch keys this computer
//          holds, join the same table; the account's copy of an event_id
//          replaces this computer's own (it is the one everybody reads)
//   merge  the memories are the contract's fold of every event held here
//          (mergeMemories: last writer wins on (HLC, device), a tombstone
//          wins a tie, manual beats learned on the same tick, a learned
//          fact is keyed by its content, content deleted is never learned
//          again). This computer's own tombstones stay in the table, so a
//          backend that withholds them brings nothing back.
//   first  the memories from before are uploaded once, under content-hash
//          ids (the same memory on the Mac and on the Pi becomes one); the
//          ones with the same title but not the same content are listed
//          as « Doublons possibles » (possibleDuplicates) for the screens.
//
// Only while this computer is a trusted vault member holding epoch keys
// (S1: headless with its own keys, or inside Twoody Desktop with the keys it
// handed over). Otherwise the memories stay on this computer as before.

export const MEMORIES_STREAM = "memories";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/// vault_event_id of a memory that cannot travel (longer than a memory
/// event may be, like the whole answer kept by an import).
export const LOCAL_ONLY = "local";
const TICK_MS = 60_000;
const FIRST_TICK_MS = 8_000;
const SOON_MS = 1_500;

export type MemoryVaultAccess = { api: EventsApi; userId: string; deviceId: string; epochKeys: Map<number, Uint8Array> };
type Context = MemoryVaultAccess & { epochOne: Uint8Array; streamId: string };

type Row = {
  id: string; user_id: string; kind: string; title: string | null; content: string; tags: string; source: string;
  superseded_by_id: string | null; hlc: string | null; vault_event_id: string | null; created_at: number; updated_at: number;
};
type LogRow = { event_id: string; stream_id: string; memory_id: string; payload: string; own: number; sealed: string | null; sent: number; seq: number | null; stored_at: number | null };

/// A memory as the vault calls its source; « conversation » is what
/// memoryLearning.ts writes for a learned fact.
export const contractSource = (local: string): MemorySource =>
  local === "conversation" || local === "learned" ? "learned" : local === "import" ? "import" : "manual";
const localSource = (source: MemorySource) => (source === "learned" ? "conversation" : source);

function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  let out = "";
  for (const ch of text) {
    if (out.length + ch.length > max) break;
    out += ch;
  }
  return out;
}

function tagsOf(json: string): string[] {
  try {
    const parsed = JSON.parse(json);
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((t): t is string => typeof t === "string").map((t) => clip(t.trim(), 64)).filter(Boolean))].slice(0, 32);
  } catch {
    return [];
  }
}

const parse = (json: string): unknown => {
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
};

export function createMemoryVault({ sqlite, owner, access, now = () => Date.now(), random }: {
  /// The server's database (a second one in tests: another computer).
  sqlite: Database.Database;
  /// The person the memories belong to (this server's owner).
  owner: () => string | null;
  /// The vault as this computer holds it now; null when it is no trusted member.
  access: () => MemoryVaultAccess | null;
  now?: () => number;
  random?: Random;
}) {
  const getState = (key: string) => (sqlite.prepare("SELECT value FROM memory_vault_state WHERE key = ?").get(key) as { value: string } | undefined)?.value ?? null;
  const setState = (key: string, value: string) =>
    sqlite.prepare("INSERT INTO memory_vault_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  const rowById = (id: string) => sqlite.prepare("SELECT * FROM memories WHERE id = ?").get(id) as Row | undefined;
  const logRow = (eventId: string) => sqlite.prepare("SELECT * FROM memory_vault_events WHERE event_id = ?").get(eventId) as LogRow | undefined;

  /// The vault now, with the memories stream's id; null when this computer
  /// is no member, or holds no epoch-1 key (the stream id comes from it).
  function context(): Context | null {
    const a = access();
    const epochOne = a?.deviceId ? a.epochKeys.get(1) : undefined;
    if (!a || !epochOne) return null;
    const streamId = memoriesStreamId(epochOne);
    const known = getState("stream");
    if (known !== streamId) {
      // Another vault (founded again): what went to the old one goes again.
      if (known) sqlite.prepare("UPDATE memories SET hlc = NULL, vault_event_id = NULL WHERE vault_event_id IS NOT NULL AND vault_event_id != ?").run(LOCAL_ONLY);
      setState("stream", streamId);
    }
    if (getState("device") !== a.deviceId) setState("device", a.deviceId);
    return { ...a, epochOne, streamId };
  }

  function nextHlc(): string {
    const next = hlcTick(getState("hlc"), now());
    setState("hlc", next);
    return next;
  }

  const forbidden = (): Set<string> => new Set((parse(getState("forbidden") ?? "[]") as string[] | null) ?? []);

  /// This computer's own event, kept until the account has it. An event_id
  /// the account already gave (a fact learned elsewhere first) stands.
  function putOwn(streamId: string, eventId: string, memoryId: string, payload: unknown) {
    const known = logRow(eventId);
    if (known) {
      if (!known.own || known.sent) return;
      const a = readMemoryEvent(payload);
      const b = readMemoryEvent(parse(known.payload));
      // Two copies of one event here: the lesser, as the contract keeps it.
      if (a && b && compareMemoryEvents({ event_id: eventId, event: a }, { event_id: eventId, event: b }) >= 0) return;
    }
    sqlite.prepare(
      "INSERT OR REPLACE INTO memory_vault_events (event_id, stream_id, memory_id, payload, own, sealed, sent, seq) VALUES (?, ?, ?, ?, 1, NULL, 0, NULL)",
    ).run(eventId, streamId, memoryId, JSON.stringify(payload));
  }

  /// Another row takes this id: the one there already stays (a duplicate
  /// of it goes), and whatever pointed to the old id points to the new.
  function rename(from: string, to: string): boolean {
    const taken = !!rowById(to);
    if (taken) sqlite.prepare("DELETE FROM memories WHERE id = ?").run(from);
    else sqlite.prepare("UPDATE memories SET id = ? WHERE id = ?").run(to, from);
    sqlite.prepare("UPDATE memories SET superseded_by_id = ? WHERE superseded_by_id = ?").run(to, from);
    return !taken;
  }

  function payloadOf(row: Row, id: string, source: MemorySource, hlc: string, device: string): MemoryEvent | null {
    if (!row.content || row.content.length > 8000) return null;
    return {
      type: "memory", id,
      kind: (MEMORY_KINDS as readonly string[]).includes(row.kind) ? (row.kind as MemoryEvent["kind"]) : "user",
      title: row.title == null ? null : clip(row.title, 200),
      content: row.content,
      tags: tagsOf(row.tags),
      source,
      superseded_by: row.superseded_by_id && UUID.test(row.superseded_by_id) ? row.superseded_by_id : null,
      hlc, device,
    };
  }

  /// A memory written here goes into the vault: `write` as it is (a new
  /// memory, a learned fact, an import), `edit` by the person (a manual
  /// event, even over a learned fact), `upload` a memory from before (the
  /// first upload: under the content-hash id). Returns the memory's id now
  /// (it may have changed), or null when it does not travel.
  function recordIn(ctx: Context, localId: string, how: "write" | "edit" | "upload"): string | null {
    const row = rowById(localId);
    if (!row || row.user_id !== owner()) return null;
    const hash = memoryContentHash(row.content);
    let source: MemorySource = how === "edit" ? "manual" : contractSource(row.source);
    if (source === "learned" && !hash) source = "manual";
    // Content the person deleted is never learned again, nor brought back
    // by the first upload of another computer.
    if (hash && forbidden().has(hash) && (source === "learned" || how === "upload")) {
      sqlite.prepare("DELETE FROM memories WHERE id = ?").run(row.id);
      return null;
    }
    let id = row.id;
    if (source === "learned") id = learnedMemoryId(ctx.epochOne, hash!);
    else if (how === "upload" && !UUID.test(row.id)) id = hash ? learnedMemoryId(ctx.epochOne, hash) : randomUUID();
    else if (!UUID.test(row.id)) id = randomUUID();
    if (id !== row.id && !rename(row.id, id)) return null;
    const payload = payloadOf(row, id, source, nextHlc(), ctx.deviceId);
    if (!payload) {
      sqlite.prepare("UPDATE memories SET vault_event_id = ? WHERE id = ?").run(LOCAL_ONLY, id);
      return id;
    }
    const eventId = memoryEventId(ctx.streamId, payload);
    putOwn(ctx.streamId, eventId, id, payload);
    sqlite.prepare("UPDATE memories SET hlc = ?, vault_event_id = ? WHERE id = ?").run(payload.hlc, eventId, id);
    return id;
  }

  function record(localId: string, how: "write" | "edit" = "write"): string | null {
    const ctx = context();
    if (ctx) return sqlite.transaction(() => recordIn(ctx, localId, how))();
    // Not a member now: an edit of a memory already in the vault still
    // waits here for the next time, the rest waits for the first upload.
    const stream = getState("stream");
    const device = getState("device");
    const row = rowById(localId);
    if (!stream || !device || !row || row.user_id !== owner() || !row.vault_event_id || row.vault_event_id === LOCAL_ONLY || !UUID.test(row.id)) return null;
    return sqlite.transaction(() => {
      // Only the person edits a memory already in the vault: a manual event.
      const payload = payloadOf(row, row.id, "manual", nextHlc(), device);
      if (!payload) return null;
      const eventId = memoryEventId(stream, payload);
      putOwn(stream, eventId, row.id, payload);
      sqlite.prepare("UPDATE memories SET hlc = ?, vault_event_id = ? WHERE id = ?").run(payload.hlc, eventId, row.id);
      return row.id;
    })();
  }

  /// A memory deleted here: a tombstone, when it had been in the vault.
  /// Kept here whatever the account does with it.
  function recordDelete(row: { id: string; content: string; vaultEventId: string | null }): boolean {
    if (!row.vaultEventId || row.vaultEventId === LOCAL_ONLY || !UUID.test(row.id)) return false;
    const stream = context()?.streamId ?? getState("stream");
    if (!stream) return false;
    return sqlite.transaction(() => {
      const tombstone: MemoryStreamEvent = { type: "tombstone", id: row.id, hlc: nextHlc() };
      putOwn(stream, memoryEventId(stream, tombstone), row.id, tombstone);
      const hash = memoryContentHash(row.content);
      if (hash) setState("forbidden", JSON.stringify([...new Set([...forbidden(), hash])]));
      return true;
    })();
  }

  /// An event as another client wrote it, sent from here (tests, and
  /// whatever brings events from elsewhere).
  function enqueueRaw(eventId: string, payload: unknown) {
    const ctx = context();
    if (!ctx) return false;
    const id = payload && typeof payload === "object" && typeof (payload as { id?: unknown }).id === "string" ? (payload as { id: string }).id : "";
    putOwn(ctx.streamId, eventId, id, payload);
    return true;
  }

  async function flush(ctx: Context) {
    let sent = 0;
    for (;;) {
      const rows = sqlite.prepare("SELECT * FROM memory_vault_events WHERE stream_id = ? AND own = 1 AND sent = 0 ORDER BY rowid LIMIT 50").all(ctx.streamId) as LogRow[];
      if (rows.length === 0) return sent;
      const epoch = Math.max(...ctx.epochKeys.keys());
      const batch = rows.map((row) => {
        if (row.sealed) return JSON.parse(row.sealed) as SealedEvent;
        const payload = parse(row.payload) as { type?: unknown } | null;
        // Sealed once: a retry resends the same bytes (a duplicate, never a conflict).
        const sealed = sealEvent({
          epochKey: ctx.epochKeys.get(epoch)!, epoch, userId: ctx.userId, conversationId: ctx.streamId, eventId: row.event_id,
          kind: payload?.type === "tombstone" ? "tombstone" : "memory", createdAt: new Date(now()).toISOString(), payload, random,
        });
        sqlite.prepare("UPDATE memory_vault_events SET sealed = ? WHERE event_id = ?").run(JSON.stringify(sealed), row.event_id);
        return sealed;
      });
      const result = await ctx.api.postEvents(batch.map((event) => ({ ...event, stream: MEMORIES_STREAM })));
      if (result?.error === "invalid_event") {
        // Refused: kept here (it still counts on this computer), not sent again.
        const refused = rows.find((r) => r.event_id === result.event_id) ?? rows[0]!;
        sqlite.prepare("UPDATE memory_vault_events SET sent = 2 WHERE event_id = ?").run(refused.event_id);
        continue;
      }
      // Stored, a duplicate, or a conflict (the account keeps another copy,
      // which the pull brings): none changes by sending again.
      const mark = sqlite.prepare("UPDATE memory_vault_events SET sent = 1 WHERE event_id = ?");
      sqlite.transaction(() => rows.forEach((r) => mark.run(r.event_id)))();
      sent += result?.stored ?? 0;
    }
  }

  async function pull(ctx: Context) {
    const cursorKey = `cursor:${ctx.streamId}`;
    let received = 0;
    let unreadable = 0;
    for (;;) {
      const after = Number(getState(cursorKey) ?? 0) || 0;
      const page = await ctx.api.events({ after, limit: 200, stream: MEMORIES_STREAM });
      const events = page?.events ?? [];
      sqlite.transaction(() => {
        let cursor = after;
        for (const event of events) {
          cursor = Math.max(cursor, Number(event.seq) || 0);
          // Only this vault's memories stream: anything else is not ours to read here.
          if ((event.stream && event.stream !== MEMORIES_STREAM) || event.conversation_id !== ctx.streamId) continue;
          if (event.kind !== "memory" && event.kind !== "tombstone") continue;
          let payload: unknown;
          try {
            payload = openEvent(event, ctx.epochKeys);
          } catch {
            unreadable += 1;
            continue;
          }
          const type = payload && typeof payload === "object" ? (payload as { type?: unknown }).type : null;
          if ((type === "tombstone") !== (event.kind === "tombstone")) continue;
          const read = readMemoryEvent(payload);
          const memoryId = typeof (payload as { id?: unknown } | null)?.id === "string" ? (payload as { id: string }).id : "";
          // The account's copy: the one every device reads, replacing ours,
          // with when the account stored it (its own clock, not the sender's).
          const stamp = (event as { stored_at?: unknown }).stored_at;
          const storedAt = typeof stamp === "string" ? Date.parse(stamp) : NaN;
          sqlite.prepare(
            "INSERT OR REPLACE INTO memory_vault_events (event_id, stream_id, memory_id, payload, own, sealed, sent, seq, stored_at) VALUES (?, ?, ?, ?, 0, NULL, 1, ?, ?)",
          ).run(event.event_id, ctx.streamId, memoryId, JSON.stringify(payload), Number(event.seq) || null, Number.isFinite(storedAt) ? storedAt : null);
          if (read) {
            try {
              setState("hlc", hlcReceive(getState("hlc"), read.hlc, now()));
            } catch {
              /* a clock we cannot read changes nothing */
            }
          }
          received += 1;
        }
        setState(cursorKey, String(cursor));
      })();
      if (!page?.next_after) return { received, unreadable };
    }
  }

  /// The memories table made what the events say.
  function apply(ctx: Context) {
    const me = owner();
    const log = sqlite.prepare("SELECT event_id, memory_id, payload, stored_at FROM memory_vault_events WHERE stream_id = ?").all(ctx.streamId) as Array<Pick<LogRow, "event_id" | "memory_id" | "payload" | "stored_at">>;
    const merged = mergeMemories(log.map((r) => ({ event_id: r.event_id, payload: parse(r.payload), stored_at_ms: r.stored_at })), { epochOne: ctx.epochOne, nowMs: now() });
    const tombstoned = new Set(merged.tombstoned);
    const hashes = new Set<string>();
    for (const r of log) {
      const e = readMemoryEvent(parse(r.payload));
      const hash = e?.type === "memory" && tombstoned.has(e.id) ? memoryContentHash(e.content) : null;
      if (hash) hashes.add(hash);
    }
    setState("forbidden", JSON.stringify([...hashes].sort()));
    if (!me) return { changed: 0, removed: 0 };
    let changed = 0;
    let removed = 0;
    sqlite.transaction(() => {
      const live = new Set<string>();
      for (const m of merged.memories) {
        live.add(m.id);
        const { content_hash: _hash, ...rest } = m;
        const eventId = memoryEventId(ctx.streamId, { type: "memory", ...rest });
        const here = rowById(m.id);
        const tags = JSON.stringify(m.tags);
        const source = localSource(m.source);
        if (here && here.hlc === m.hlc && here.vault_event_id === eventId && here.content === m.content && here.title === m.title && here.tags === tags && here.kind === m.kind && here.source === source && here.superseded_by_id === m.superseded_by) continue;
        const at = parseHlc(m.hlc).wall;
        if (here) {
          if (here.user_id !== me) continue;
          sqlite.prepare("UPDATE memories SET kind = ?, title = ?, content = ?, tags = ?, source = ?, superseded_by_id = ?, hlc = ?, vault_event_id = ?, updated_at = ? WHERE id = ?")
            .run(m.kind, m.title, m.content, tags, source, m.superseded_by, m.hlc, eventId, at, m.id);
        } else {
          sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags, source, superseded_by_id, hlc, vault_event_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
            .run(m.id, me, m.kind, m.title, m.content, tags, source, m.superseded_by, m.hlc, eventId, now(), at);
        }
        changed += 1;
      }
      // Deleted, hidden behind the same memory written by hand, or learned
      // again after the person deleted it: gone from here.
      const del = sqlite.prepare("DELETE FROM memories WHERE id = ? AND user_id = ?");
      for (const id of new Set(log.map((r) => r.memory_id))) {
        if (id && !live.has(id)) removed += del.run(id, me).changes;
      }
    })();
    return { changed, removed };
  }

  /// The first upload: every memory not yet through the vault.
  function upload(ctx: Context) {
    const me = owner();
    if (!me) return 0;
    const ids = (sqlite.prepare("SELECT id FROM memories WHERE user_id = ? AND vault_event_id IS NULL ORDER BY created_at, rowid").all(me) as Array<{ id: string }>).map((r) => r.id);
    let uploaded = 0;
    sqlite.transaction(() => {
      for (const id of ids) if (recordIn(ctx, id, "upload")) uploaded += 1;
    })();
    return uploaded;
  }

  async function run() {
    const ctx = context();
    if (!ctx) return { status: "off" as const };
    const sentBefore = await flush(ctx);
    const pulled = await pull(ctx);
    apply(ctx);
    const uploaded = upload(ctx);
    const applied = apply(ctx);
    const sent = sentBefore + (await flush(ctx));
    return { status: "synced" as const, sent, ...pulled, uploaded, ...applied, pending: pending() };
  }

  let chain: Promise<unknown> = Promise.resolve();
  /// Push, pull, merge, one at a time.
  function sync(): Promise<Awaited<ReturnType<typeof run>>> {
    const next = chain.then(run);
    chain = next.catch(() => undefined);
    return next;
  }

  function pending(): number {
    const stream = getState("stream");
    return stream ? (sqlite.prepare("SELECT COUNT(*) AS n FROM memory_vault_events WHERE stream_id = ? AND own = 1 AND sent = 0").get(stream) as { n: number }).n : 0;
  }

  /// The id a fact learned now takes (the same on every computer), when
  /// this computer is in the vault.
  function learnedIdFor(content: string): string | null {
    const ctx = context();
    const hash = memoryContentHash(content);
    return ctx && hash ? learnedMemoryId(ctx.epochOne, hash) : null;
  }

  /// Whether the person deleted this content: then it is not learned again.
  function isForgotten(content: string): boolean {
    const hash = memoryContentHash(content);
    return !!hash && forbidden().has(hash);
  }

  /// « Doublons possibles »: current memories sharing a title, whose
  /// contents differ. The person decides; nothing is merged for them.
  function possibleDuplicates(userId: string) {
    const rows = sqlite.prepare("SELECT * FROM memories WHERE user_id = ? AND superseded_by_id IS NULL ORDER BY created_at, rowid").all(userId) as Row[];
    const groups = new Map<string, Row[]>();
    for (const row of rows) {
      const key = normaliseMemoryContent(row.title ?? "");
      if (key) groups.set(key, [...(groups.get(key) ?? []), row]);
    }
    return [...groups.values()]
      .filter((group) => new Set(group.map((r) => memoryContentHash(r.content) ?? r.content)).size > 1)
      .map((group) => ({ title: group[0]!.title, memory_ids: group.map((r) => r.id) }))
      .sort((a, b) => String(a.title).localeCompare(String(b.title)));
  }

  return { record, recordDelete, enqueueRaw, sync, pending, learnedIdFor, isForgotten, possibleDuplicates };
}

export type MemoryVault = ReturnType<typeof createMemoryVault>;

// ── this server ──────────────────────────────────────────────────────────

function ownerId(): string | null {
  return (localSqlite.prepare("SELECT id FROM users ORDER BY rowid LIMIT 1").get() as { id: string } | undefined)?.id ?? null;
}

/// The vault S1 holds: a trusted member only, with its device id and keys.
function serverAccess(): MemoryVaultAccess | null {
  if (vaultIdentity()?.status !== "trusted") return null;
  const ctx = vaultContext();
  const epochKeys = vaultEpochKeys();
  if (!ctx?.deviceId || epochKeys.size === 0) return null;
  return { api: ctx.api, userId: ctx.userId, deviceId: ctx.deviceId, epochKeys };
}

let serverVault: MemoryVault | null = null;
const vault = () => (serverVault ??= createMemoryVault({ sqlite: localSqlite, owner: ownerId, access: serverAccess }));

/// One sync; what it changed here gets its links and vectors again
/// (src/memory/changes.ts).
async function syncHere() {
  const result = await vault().sync();
  if (result.status === "synced" && (result.changed || result.removed || result.uploaded)) memoriesChanged(ownerId());
  return result;
}

let soon: NodeJS.Timeout | null = null;
function syncSoon() {
  if (soon) return;
  soon = setTimeout(() => {
    soon = null;
    void syncHere().catch(() => null);
  }, SOON_MS);
  soon.unref?.();
}

function userOf(id: string): string | null {
  return (localSqlite.prepare("SELECT user_id FROM memories WHERE id = ?").get(id) as { user_id: string } | undefined)?.user_id ?? null;
}

/// A memory was written here (created, learned, imported: `write`; edited
/// by the person: `edit`). Returns its id, which the vault may have
/// changed; never throws — a memory is kept here whatever the vault says.
export function memoryWritten(id: string, how: "write" | "edit" = "write"): string {
  let current = id;
  try {
    current = vault().record(id, how) ?? id;
    syncSoon();
  } catch {
    /* kept here anyway */
  }
  memoriesChanged(userOf(current) ?? userOf(id));
  return current;
}

/// A memory was deleted here (the row as it was).
export function memoryDeleted(row: { id: string; content: string; vaultEventId: string | null; userId?: string | null }): void {
  try {
    if (vault().recordDelete(row)) syncSoon();
  } catch {
    /* deleted here anyway */
  }
  memoriesChanged(row.userId ?? ownerId());
}

/// The id of a new manual or imported memory: a random UUID v4, as the vault wants it.
export const newMemoryId = (): string => randomUUID();

/// The id a learned fact takes, the same on every computer of the vault (else a new one).
export function learnedFactId(content: string): string {
  try {
    return vault().learnedIdFor(content) ?? randomUUID();
  } catch {
    return randomUUID();
  }
}

/// Whether the person deleted this content (it is not learned again).
export function isForgottenFact(content: string): boolean {
  try {
    return vault().isForgotten(content);
  } catch {
    return false;
  }
}

export const possibleDuplicates = (userId: string) => vault().possibleDuplicates(userId);

/// One sync now (tests, and the timer).
export const syncMemories = () => syncHere();

/// This server's memory vault itself (tests).
export const serverMemoryVault = (): MemoryVault => vault();

/// Every minute while this computer is a trusted vault member (headless or
/// inside Twoody Desktop); nothing otherwise.
export function startMemorySync(options: { intervalMs?: number; firstTickMs?: number; log?: (message: string) => void } = {}) {
  let timer: NodeJS.Timeout | null = null;
  let stopped = false;
  const schedule = (ms: number) => {
    if (stopped) return;
    timer = setTimeout(() => {
      void syncHere()
        .catch((err) => options.log?.(`Vault memories: ${err instanceof Error ? err.message : String(err)}`))
        .finally(() => schedule(options.intervalMs ?? TICK_MS));
    }, ms);
    timer.unref?.();
  };
  schedule(options.firstTickMs ?? FIRST_TICK_MS);
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}
