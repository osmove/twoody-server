import { ed25519 } from "@noble/curves/ed25519.js";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalHeader, fromHex, toHex } from "../compute/sealBase.js";

// The shared contracts of the Twoody mesh (docs/mesh-design.md, lot P0),
// as a reference every other lot checks itself against: backend B1, the
// server's vault (S1–S5), Desktop (D1–D2) and the app (A1–A3). Pure
// functions, no storage, no network, no Electron. The vectors are in
// test/fixtures/{computer-binding-v1,device-access-v1,memory-lww-vectors}.json.
//
// Statements are signed exactly as the v1 vault approval
// (twoody-desktop src/shared/vault.ts signApproval, twoody-app
// utils/vault.js, twoody-backend VaultDevice#approval_message): Ed25519
// (RFC 8032, @noble/curves) by the signer's vault signing key (the
// device's `sign_public`), over the canonical header — the label's UTF-8
// bytes, then each field as UTF-8 of String(field) prefixed by its length
// on two bytes, big-endian. Signatures and keys travel as lowercase hex.

export const VAULT_VERSION = 1;
export const BINDING_LABEL = "twoody/vault/computer-binding/v1";
export const DEVICE_ACCESS_LABEL = "twoody/vault/device-access/v1";
export const MEMORIES_ID_LABEL = "twoody/vault/memories-id/v1";

export class ContractError extends Error {
  code: string;
  constructor(code: string) {
    super(code);
    this.code = code;
  }
}

const HEX_KEY = /^[0-9a-f]{64}$/;
const encoder = new TextEncoder();
const utf8 = (value: string): Uint8Array => encoder.encode(value);

function requireKey(value: unknown, code: string): string {
  if (typeof value !== "string" || !HEX_KEY.test(value)) throw new ContractError(code);
  return value;
}
function requireId(value: unknown, code: string): string {
  if (typeof value !== "string" || !value || value.length > 200) throw new ContractError(code);
  return value;
}

// ── computer-binding/v1 ─────────────────────────────────────────────────
// A person-device vouches that a vault device is this account computer,
// reached by these tunnel and pairing keys, and whether it may approve.

export interface ComputerBinding {
  vault_device_id: string;
  account_computer_id: string;
  /// X25519, the computer's tunnel identity (src/tunnel/identity.ts).
  tunnel_public_key: string;
  /// X25519, the computer's account pairing key (account_computers.public_key).
  pairing_public_key: string;
  /// false for a computer nobody sits at (a Pi, a NAS): it may never approve.
  can_approve: boolean;
}

export function bindingStatement(userId: string | number, binding: ComputerBinding): Uint8Array {
  if (typeof binding?.can_approve !== "boolean") throw new ContractError("bad_binding");
  return canonicalHeader(BINDING_LABEL, [
    VAULT_VERSION,
    requireId(String(userId), "bad_binding"),
    requireId(binding.vault_device_id, "bad_binding"),
    requireId(binding.account_computer_id, "bad_binding"),
    requireKey(binding.tunnel_public_key, "bad_binding"),
    requireKey(binding.pairing_public_key, "bad_binding"),
    binding.can_approve ? 1 : 0,
  ]);
}

export function signBinding(args: { userId: string | number; binding: ComputerBinding; signPrivate: Uint8Array }): string {
  return toHex(ed25519.sign(bindingStatement(args.userId, args.binding), args.signPrivate));
}

export function bindingValid(args: { userId: string | number; binding: ComputerBinding; signerSignPublic: Uint8Array; signature: string }): boolean {
  try {
    return ed25519.verify(fromHex(args.signature), bindingStatement(args.userId, args.binding), args.signerSignPublic);
  } catch {
    return false;
  }
}

// ── device-access/v1 ────────────────────────────────────────────────────
// A person-device (a phone) says, with its own vault key, that this tunnel
// key is its own: a trusted computer then links it without asking.

export interface DeviceAccess {
  vault_device_id: string;
  tunnel_public_key: string;
}

export function deviceAccessStatement(userId: string | number, access: DeviceAccess): Uint8Array {
  return canonicalHeader(DEVICE_ACCESS_LABEL, [
    VAULT_VERSION,
    requireId(String(userId), "bad_device_access"),
    requireId(access?.vault_device_id, "bad_device_access"),
    requireKey(access?.tunnel_public_key, "bad_device_access"),
  ]);
}

export function signDeviceAccess(args: { userId: string | number; access: DeviceAccess; signPrivate: Uint8Array }): string {
  return toHex(ed25519.sign(deviceAccessStatement(args.userId, args.access), args.signPrivate));
}

export function deviceAccessValid(args: { userId: string | number; access: DeviceAccess; signerSignPublic: Uint8Array; signature: string }): boolean {
  try {
    return ed25519.verify(fromHex(args.signature), deviceAccessStatement(args.userId, args.access), args.signerSignPublic);
  } catch {
    return false;
  }
}

// ── peer documents ──────────────────────────────────────────────────────
// A document as the mesh names it (peer-documents-search.schema.json):
// "<account computer id>:<local document id>", never a path.

const SOURCE_ID = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):([A-Za-z0-9_-]{1,64})$/;

export function sourceId(computerId: string, documentId: string): string {
  const id = `${computerId}:${documentId}`;
  if (!SOURCE_ID.test(id)) throw new ContractError("bad_source_id");
  return id;
}

export function parseSourceId(value: string): { computerId: string; documentId: string } | null {
  const match = typeof value === "string" ? SOURCE_ID.exec(value) : null;
  return match ? { computerId: match[1]!, documentId: match[2]! } : null;
}

/// The link a citation opens: streamed from the computer that holds it.
export const citationUrl = (computerId: string, documentId: string): string => {
  sourceId(computerId, documentId);
  return `twoody://doc/${computerId}/${documentId}`;
};

// ── ids ─────────────────────────────────────────────────────────────────
// The same as twoody-desktop src/shared/vaultSync.ts: the first 16 bytes
// of a hash as a UUID, version nibble 5, variant 10.

export function uuidFrom(bytes: Uint8Array): string {
  if (bytes.length < 16) throw new ContractError("bad_uuid_bytes");
  const b = Uint8Array.from(bytes.slice(0, 16));
  b[6] = (b[6]! & 0x0f) | 0x50;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const hex = toHex(b);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/// twoody-desktop's eventIdFor, unchanged.
export function eventIdFor(conversationId: string, kind: string, ref: string): string {
  return uuidFrom(sha256(utf8(`twoody/vault/event-id/v1\n${conversationId}\n${kind}\n${ref}`)));
}

function epochOneKey(key: Uint8Array): Uint8Array {
  if (!(key instanceof Uint8Array) || key.length !== 32) throw new ContractError("bad_epoch_key");
  return key;
}

/// The conversation_id of the memories stream: the same on every device of
/// the vault, unknown to the account.
export function memoriesStreamId(epochOne: Uint8Array): string {
  return uuidFrom(hkdf(sha256, epochOneKey(epochOne), utf8(MEMORIES_ID_LABEL), utf8(""), 16));
}

/// The key that turns a learned fact's content hash into its memory id. A
/// bare hash of the content would let the account confirm a guess (« lives
/// in Paris »): the id is keyed by the vault.
export function learnedIdKey(epochOne: Uint8Array): Uint8Array {
  return hkdf(sha256, epochOneKey(epochOne), utf8(MEMORIES_ID_LABEL), utf8("learned"), 32);
}

export function learnedMemoryId(epochOne: Uint8Array, contentHash: string): string {
  if (!/^[0-9a-f]{64}$/.test(contentHash)) throw new ContractError("bad_content_hash");
  return uuidFrom(hmac(sha256, learnedIdKey(epochOne), utf8(contentHash)));
}

// ── content hash ────────────────────────────────────────────────────────
// Lower-cased (String.prototype.toLowerCase, no locale), NFKD, marks
// (\p{M}) removed, every run of characters that are neither letters (\p{L})
// nor numbers (\p{N}) made one space, trimmed. Unicode-aware on purpose:
// the server's older normalize() (memoryLearning.ts) keeps only a-z0-9 and
// makes every Hebrew or Cyrillic fact the same empty string.

export function normaliseMemoryContent(text: string): string {
  return String(text)
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/// Hex SHA-256 of the UTF-8 of the normalised content; null when nothing
/// is left (such a fact is never learned).
export function memoryContentHash(text: string): string | null {
  const normalised = normaliseMemoryContent(text);
  return normalised ? toHex(sha256(utf8(normalised))) : null;
}

// ── HLC ─────────────────────────────────────────────────────────────────
// "<wall>-<counter>": wall = Unix time in ms, 13 digits zero-padded;
// counter 4 digits. Fixed width, so comparing the strings compares the
// clocks.

export const HLC_PATTERN = /^[0-9]{13}-[0-9]{4}$/;
export const HLC_MAX_COUNTER = 9999;
/// A remote clock further ahead than this is merged but not adopted.
export const HLC_MAX_DRIFT_MS = 60 * 60 * 1000;

export interface Hlc { wall: number; counter: number }

export function parseHlc(value: string): Hlc {
  if (typeof value !== "string" || !HLC_PATTERN.test(value)) throw new ContractError("bad_hlc");
  return { wall: Number(value.slice(0, 13)), counter: Number(value.slice(14)) };
}

export function formatHlc({ wall, counter }: Hlc): string {
  if (!Number.isInteger(wall) || wall < 0 || wall > 9_999_999_999_999 || !Number.isInteger(counter) || counter < 0 || counter > HLC_MAX_COUNTER) {
    throw new ContractError("bad_hlc");
  }
  return `${String(wall).padStart(13, "0")}-${String(counter).padStart(4, "0")}`;
}

function carry(wall: number, counter: number): string {
  return counter > HLC_MAX_COUNTER ? formatHlc({ wall: wall + 1, counter: 0 }) : formatHlc({ wall, counter });
}

/// The clock for an event this device writes now.
export function hlcTick(last: string | null, nowMs: number): string {
  if (!last) return formatHlc({ wall: nowMs, counter: 0 });
  const l = parseHlc(last);
  const wall = Math.max(l.wall, nowMs);
  return carry(wall, wall === l.wall ? l.counter + 1 : 0);
}

/// The clock after reading an event written elsewhere.
export function hlcReceive(last: string | null, remote: string, nowMs: number): string {
  const r = parseHlc(remote);
  if (r.wall > nowMs + HLC_MAX_DRIFT_MS) return hlcTick(last, nowMs);
  const l = last ? parseHlc(last) : { wall: -1, counter: -1 };
  const wall = Math.max(l.wall, r.wall, nowMs);
  let counter = 0;
  if (wall === l.wall && wall === r.wall) counter = Math.max(l.counter, r.counter) + 1;
  else if (wall === l.wall) counter = l.counter + 1;
  else if (wall === r.wall) counter = r.counter + 1;
  return carry(wall, counter);
}

// ── memory events ───────────────────────────────────────────────────────

export const MEMORY_KINDS = ["user", "feedback", "project", "reference"] as const;
export const MEMORY_SOURCES = ["manual", "learned", "import"] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export interface MemoryEvent {
  type: "memory";
  id: string;
  kind: (typeof MEMORY_KINDS)[number];
  title: string | null;
  content: string;
  tags: string[];
  source: MemorySource;
  superseded_by: string | null;
  hlc: string;
  /// The vault device id of the writer.
  device: string;
}
export interface TombstoneEvent { type: "tombstone"; id: string; hlc: string }
export type MemoryStreamEvent = MemoryEvent | TombstoneEvent;

/// The payload if it is one (memory-event.schema.json), else null.
export function readMemoryEvent(raw: unknown): MemoryStreamEvent | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const e = raw as Record<string, unknown>;
  const keys = Object.keys(e).sort().join(",");
  if (typeof e.id !== "string" || !UUID.test(e.id) || typeof e.hlc !== "string" || !HLC_PATTERN.test(e.hlc)) return null;
  if (e.type === "tombstone") return keys === "hlc,id,type" ? { type: "tombstone", id: e.id, hlc: e.hlc } : null;
  if (e.type !== "memory" || keys !== "content,device,hlc,id,kind,source,superseded_by,tags,title,type") return null;
  if (!(MEMORY_KINDS as readonly unknown[]).includes(e.kind) || !(MEMORY_SOURCES as readonly unknown[]).includes(e.source)) return null;
  if (!(e.title === null || (typeof e.title === "string" && e.title.length <= 200))) return null;
  if (typeof e.content !== "string" || e.content.length < 1 || e.content.length > 8000) return null;
  if (!Array.isArray(e.tags) || e.tags.length > 32 || e.tags.some((t) => typeof t !== "string" || t.length < 1 || t.length > 64)) return null;
  if (!(e.superseded_by === null || (typeof e.superseded_by === "string" && UUID.test(e.superseded_by)))) return null;
  if (typeof e.device !== "string" || !UUID.test(e.device)) return null;
  return {
    type: "memory", id: e.id, kind: e.kind as MemoryEvent["kind"], title: e.title as string | null, content: e.content,
    tags: [...(e.tags as string[])], source: e.source as MemorySource, superseded_by: e.superseded_by as string | null, hlc: e.hlc, device: e.device,
  };
}

/// The event_id an event travels under (the header's event_id; the
/// account keeps one event per id). A learned fact's first event has the
/// same id wherever it is learned, so the account keeps it once.
export function memoryEventId(streamId: string, event: MemoryStreamEvent): string {
  if (event.type === "tombstone") return eventIdFor(streamId, "tombstone", `${event.id}\n${event.hlc}`);
  if (event.source === "learned") return eventIdFor(streamId, "memory", `learned\n${event.id}`);
  return eventIdFor(streamId, "memory", `${event.id}\n${event.hlc}\n${event.device}`);
}

const SOURCE_RANK: Record<MemorySource, number> = { learned: 0, import: 1, manual: 2 };

interface Held { event_id: string; event: MemoryStreamEvent; hash: string | null }

/// Which of two events of one memory wins: the later HLC; on the same HLC
/// a tombstone, then manual > import > learned, then the greater device id,
/// then the greater event_id. Positive when `a` wins.
export function compareMemoryEvents(a: { event_id: string; event: MemoryStreamEvent }, b: { event_id: string; event: MemoryStreamEvent }): number {
  const cmp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byHlc = cmp(a.event.hlc, b.event.hlc);
  if (byHlc) return byHlc;
  const tomb = Number(a.event.type === "tombstone") - Number(b.event.type === "tombstone");
  if (tomb) return tomb;
  if (a.event.type === "memory" && b.event.type === "memory") {
    const source = SOURCE_RANK[a.event.source] - SOURCE_RANK[b.event.source];
    if (source) return source;
    const device = cmp(a.event.device, b.event.device);
    if (device) return device;
  }
  return cmp(a.event_id, b.event_id);
}

export interface MergedMemory extends Omit<MemoryEvent, "type"> { content_hash: string | null }
export interface MergeResult {
  /// The memories as they are, by id.
  memories: MergedMemory[];
  /// Ids whose last word is a tombstone.
  tombstoned: string[];
  /// Learned memories left out because a manual or imported memory says the same.
  hidden_duplicates: string[];
  /// Events that take no part, by event_id: invalid, or a learned fact
  /// whose content was deleted.
  ignored: Array<{ event_id: string; reason: "invalid" | "learned_id_mismatch" | "forbidden_hash" }>;
}

/// The memories stream folded into the set of memories. Commutative and
/// idempotent: the same events in any order give the same set.
export function mergeMemories(input: Array<{ event_id: string; payload: unknown }>, { epochOne }: { epochOne: Uint8Array }): MergeResult {
  const ignored: MergeResult["ignored"] = [];
  const held = new Map<string, Held>();
  for (const item of input) {
    const event = readMemoryEvent(item?.payload);
    if (!event || typeof item.event_id !== "string" || !UUID.test(item.event_id)) {
      if (typeof item?.event_id === "string") ignored.push({ event_id: item.event_id, reason: "invalid" });
      continue;
    }
    const hash = event.type === "memory" ? memoryContentHash(event.content) : null;
    if (event.type === "memory" && event.source === "learned" && (!hash || learnedMemoryId(epochOne, hash) !== event.id)) {
      ignored.push({ event_id: item.event_id, reason: "learned_id_mismatch" });
      continue;
    }
    // One event per event_id, as the account keeps it; two different
    // copies (a device's own, not yet replaced by the account's): the
    // lesser, the same everywhere.
    const candidate: Held = { event_id: item.event_id, event, hash };
    const known = held.get(item.event_id);
    if (!known || compareMemoryEvents(candidate, known) < 0) held.set(item.event_id, candidate);
  }

  const byId = new Map<string, Held[]>();
  for (const h of held.values()) byId.set(h.event.id, [...(byId.get(h.event.id) ?? []), h]);

  // Content that was deleted is never learned again: the hashes of every
  // memory event of an id whose winner is a tombstone, until nothing more.
  let forbidden = new Set<string>();
  let winners = new Map<string, Held>();
  for (;;) {
    winners = new Map();
    for (const [id, events] of byId) {
      let best: Held | null = null;
      for (const h of events) {
        if (h.event.type === "memory" && h.event.source === "learned" && h.hash && forbidden.has(h.hash)) continue;
        if (!best || compareMemoryEvents(h, best) > 0) best = h;
      }
      if (best) winners.set(id, best);
    }
    const next = new Set(forbidden);
    for (const [id, winner] of winners) {
      if (winner.event.type !== "tombstone") continue;
      for (const h of byId.get(id)!) if (h.hash) next.add(h.hash);
    }
    if (next.size === forbidden.size) break;
    forbidden = next;
  }
  for (const h of held.values()) {
    if (h.event.type === "memory" && h.event.source === "learned" && h.hash && forbidden.has(h.hash)) ignored.push({ event_id: h.event_id, reason: "forbidden_hash" });
  }

  const live = [...winners.values()].filter((w): w is Held & { event: MemoryEvent } => w.event.type === "memory");
  const saidByHand = new Set(live.filter((w) => w.event.source !== "learned" && w.hash).map((w) => w.hash as string));
  const hidden = live.filter((w) => w.event.source === "learned" && w.hash && saidByHand.has(w.hash)).map((w) => w.event.id);
  const hiddenSet = new Set(hidden);
  const byKey = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

  return {
    memories: live
      .filter((w) => !hiddenSet.has(w.event.id))
      .map(({ event, hash }) => {
        const { type: _type, ...rest } = event;
        return { ...rest, content_hash: hash };
      })
      .sort((a, b) => byKey(a.id, b.id)),
    tombstoned: [...winners.values()].filter((w) => w.event.type === "tombstone").map((w) => w.event.id).sort(byKey),
    hidden_duplicates: hidden.sort(byKey),
    ignored: [...new Map(ignored.map((i) => [`${i.event_id}\n${i.reason}`, i])).values()].sort((a, b) => byKey(a.event_id, b.event_id) || byKey(a.reason, b.reason)),
  };
}
