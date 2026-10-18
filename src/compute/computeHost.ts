import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { ed25519, x25519 } from "@noble/curves/ed25519.js";
import {
  createComputeIdentity,
  createHostPrekey,
  forgetTurn,
  identityFingerprint,
  openComputeRequest,
  PREKEY_LIFETIME_MS,
  publicIdentity,
  REPLAY_MEMORY_MS,
  startComputeResponse,
  type ComputeIdentity,
  type PrekeyBundle,
  type PrekeySecret,
  type PublicIdentity,
  type SealedRequest,
} from "./computeSeal.js";
import { fromHex, toHex } from "./sealBase.js";
import { createDeltaRelay } from "../executors/completionStream.js";

// This computer's side of a sealed turn for someone it is shared with
// (cockpit checklists/shared-compute-e2ee.md): its keys, the guests' keys
// it has pinned, the requests it has already opened, and the turn itself —
// open the question, run the model without tools, seal each piece of the
// answer. The account relays blocks it cannot read.
//
// The keys live in one file, readable by this user only (like the
// tunnel's), or, in Twoody Desktop, sealed by its main process
// (ComputeKeyStore below): an identity (X25519 + Ed25519) kept for good, and a prekey
// (X25519 + ML-KEM-768) made every day and whose secrets are erased 48 h
// later. What this computer computes, its owner can see: nothing here
// changes that, and nothing of a turn is written anywhere.

const ROTATE_AFTER_MS = 24 * 60 * 60 * 1000;
const MAX_MESSAGES = 64;
const MAX_TOKENS_CAP = 4096;

interface StoredPrekey {
  bundle: PrekeyBundle;
  x25519_private: string;
  mlkem_secret: string;
}

interface PinnedGuestKey {
  fingerprint: string;
  enc_public: string;
  sign_public: string;
  pinned_at: number;
}

interface StoredKeys {
  v: 1;
  identity: { enc_private: string; sign_private: string };
  prekeys: StoredPrekey[];
  /// Per grant, the guest devices that have reached this computer.
  pins: Record<string, PinnedGuestKey[]>;
}

export interface ComputeHostKeys {
  identity: { enc_public: string; sign_public: string };
  fingerprint: string;
  prekeys: PrekeyBundle[];
}

export interface SealedTurnArgs {
  principal?: { kind?: string; grant_id?: unknown };
  sealed_request?: SealedRequest;
  guest_key?: { enc_public?: string; sign_public?: string };
}

export function isSealedTurn(args: unknown): args is SealedTurnArgs & { sealed_request: SealedRequest } {
  return !!args && typeof args === "object" && typeof (args as SealedTurnArgs).sealed_request === "object";
}

/// A grantee's request on a folder shared from this computer
/// (docs/sharing-contracts.md §1–§3): the account's principal beside the
/// sealed body, as for a compute turn.
export interface SealedShareArgs {
  principal?: { kind?: unknown; share_uuid?: unknown; revision?: unknown; grantee_id?: unknown };
  sealed_request?: SealedRequest;
  guest_key?: { enc_public?: unknown; sign_public?: unknown };
}

/// What the bridge worker hands the server for one share request
/// (POST /local_shares/serve, or in-process on a Pi): who asks, through
/// which device, on which share, and the opened body — `{op: "check"}` for
/// the check made before anything is opened (an object, as the Desktop's
/// main process passes on nothing else). Answers the JSON value of
/// docs/sharing-contracts.md §2.
export interface ShareServePayload {
  share_uuid: string;
  grantee_user_id: string;
  guest: { enc_public: string; sign_public: string };
  op: unknown;
}
export type ServeShare = (payload: ShareServePayload) => Promise<unknown>;

const SHARE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const GRANTEE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const KEY_HEX = /^[0-9a-f]{64}$/;
/// An answer goes back in pieces of at most this many characters of its
/// JSON: each one sealed and relayed as one line by the account.
export const SHARE_PIECE_CHARS = 16_000;
/// Sealed lines go to the account several at a time, up to this many
/// characters a delta (it splits them at their newlines): a chunk of a
/// file (lot L5, ~2.8 MB sealed) in a dozen requests, not two hundred.
export const SHARE_DELTA_CHARS = 256 * 1024;

/// The grant id a share's requests are sealed for. Compute grants are the
/// account's integers: a request sealed for one can never be opened as the
/// other (computeSeal binds the grant id into its keys).
export const shareGrantId = (uuid: string) => `share:${uuid}`;

/// The operation of the check made before a request is opened. The guest
/// never sends it: a sealed body that says it is refused (shares/serve.ts).
export const SHARE_CHECK = Object.freeze({ op: "check" });

/// Where the keys go instead of `path`, when the process that runs the host
/// can keep them better than a file: Twoody Desktop seals them with
/// safeStorage (the Keychain on macOS, DPAPI on Windows) in its main process,
/// which hands them to its bridge worker at start and is handed them back
/// whenever they change (bridgeWorker.ts; cryptography audit of 11/10/2026).
/// `path` then holds the public identity only, for the safety numbers the
/// Desktop's embedded server shows (shares/hostIdentity.ts). A headless
/// server (a Pi) has no store: its keys stay in `path`, readable by its user
/// only.
export interface ComputeKeyStore {
  /// The keys' JSON as last saved, or null when there are none yet.
  initial: string | null;
  /// Called with the keys' JSON each time they change.
  save(json: string): void;
}

function writePrivately(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, path);
}

export function createComputeHost({ path, now = Date.now, store }: { path: string; now?: () => number; store?: ComputeKeyStore }) {
  let made = false;
  let stored = load();
  const seen = new Map<string, number>();
  // With a store, the public file is written at once (new keys are saved
  // first): the embedded server reads it before the first prekey is made.
  if (store) {
    if (made) save();
    else writePublic();
  }

  function parse(raw: string): StoredKeys | null {
    const parsed = JSON.parse(raw) as StoredKeys;
    if (parsed?.v === 1 && parsed.identity?.enc_private && parsed.identity?.sign_private) {
      return { ...parsed, pins: parsed.pins ?? {}, prekeys: Array.isArray(parsed.prekeys) ? parsed.prekeys : [] };
    }
    return null;
  }

  function load(): StoredKeys {
    const source = store ? "the sealed store" : path;
    const raw = store ? store.initial : existsSync(path) ? readFileSync(path, "utf8") : null;
    if (raw !== null) {
      try {
        const parsed = parse(raw);
        if (parsed) return parsed;
      } catch {
        // Unreadable keys are replaced: the guests will see a new key,
        // which their devices refuse until it is verified again.
      }
      console.warn(`[compute] ${source} unreadable; making new keys. Guests must verify this computer again.`);
    }
    made = true;
    const identity = createComputeIdentity();
    return {
      v: 1,
      identity: { enc_private: toHex(identity.encPrivate), sign_private: toHex(identity.signPrivate) },
      prekeys: [],
      pins: {},
    };
  }

  /// The public half of the identity, all `path` holds when there is a store.
  function writePublic() {
    const own = publicIdentity(identity());
    writePrivately(path, JSON.stringify({ v: 1, identity: { enc_public: own.encPublic, sign_public: own.signPublic } }));
  }

  function save() {
    if (store) {
      store.save(JSON.stringify(stored));
      writePublic();
      return;
    }
    writePrivately(path, JSON.stringify(stored));
  }

  function identity(): ComputeIdentity {
    const encPrivate = fromHex(stored.identity.enc_private);
    const signPrivate = fromHex(stored.identity.sign_private);
    return { encPrivate, encPublic: x25519.getPublicKey(encPrivate), signPrivate, signPublic: ed25519.getPublicKey(signPrivate) };
  }

  /// A new prekey when the newest is a day old; the secrets of expired ones
  /// erased. Answers whether the public keys changed (to publish them).
  function rotate(): boolean {
    const at = now();
    const before = stored.prekeys.length;
    stored.prekeys = stored.prekeys.filter((prekey) => prekey.bundle.expires_at > at);
    const newest = stored.prekeys.reduce((latest, prekey) => Math.max(latest, prekey.bundle.created_at), 0);
    let changed = stored.prekeys.length !== before;
    if (at - newest >= ROTATE_AFTER_MS) {
      const { bundle, secret } = createHostPrekey({ host: identity(), id: randomUUID(), now: at });
      stored.prekeys.push({ bundle, x25519_private: toHex(secret.x25519Private), mlkem_secret: toHex(secret.mlkemSecret) });
      changed = true;
    }
    if (changed || !existsSync(path)) save();
    return changed;
  }

  function prekeySecrets(): PrekeySecret[] {
    return stored.prekeys.map((prekey) => ({
      id: prekey.bundle.id,
      x25519Private: fromHex(prekey.x25519_private),
      mlkemSecret: fromHex(prekey.mlkem_secret),
      expiresAt: prekey.bundle.expires_at,
    }));
  }

  function publicKeys(): ComputeHostKeys {
    const own = publicIdentity(identity());
    return {
      identity: { enc_public: own.encPublic, sign_public: own.signPublic },
      fingerprint: identityFingerprint(own),
      prekeys: stored.prekeys.map((prekey) => prekey.bundle),
    };
  }

  /// Pins a guest device's key for a grant the first time it reaches this
  /// computer (shown as unverified until compared in person).
  function pin(grantId: string, guest: PublicIdentity): PinnedGuestKey {
    const fingerprint = identityFingerprint(guest);
    const pinned = (stored.pins[grantId] ??= []);
    let entry = pinned.find((candidate) => candidate.fingerprint === fingerprint);
    if (!entry) {
      entry = { fingerprint, enc_public: guest.encPublic, sign_public: guest.signPublic, pinned_at: now() };
      pinned.push(entry);
      save();
    }
    return entry;
  }

  function markSeen(requestId: string): boolean {
    const at = now();
    for (const [id, until] of seen) if (until <= at) seen.delete(id);
    if (seen.has(requestId)) return false;
    seen.set(requestId, at + REPLAY_MEMORY_MS);
    return true;
  }

  /// One sealed turn: opens the question, runs the model through `runModel`
  /// (each piece of text to `onPiece`), and hands `send` the answer's
  /// lines — `{"h": header}`, then `{"c": piece}`…, the last one final. Text
  /// is gathered as the relay paces it and sealed when it leaves, so the
  /// pieces are numbered in the order they go.
  ///
  /// A guest's warm (`{warm: true}` in the sealed body, isWarmRequest) is
  /// answered at once, empty, and the same way whatever follows; what it
  /// asks is then handed to `warm` (compute/guestWarm.ts decides whether it
  /// runs), never to `runModel`. Without `warm`, nothing runs.
  async function runSealedTurn({
    args,
    runModel,
    send,
    minIntervalMs,
    warm,
  }: {
    args: SealedTurnArgs;
    runModel: (openaiBody: Record<string, unknown>, onPiece: (text: string) => void) => Promise<{ model?: string }>;
    send: (line: string) => Promise<void>;
    minIntervalMs?: number;
    warm?: (openaiBody: Record<string, unknown>, grantId: string) => void;
  }): Promise<{ sealed: true }> {
    const grantId = String(args.principal?.grant_id ?? "");
    const guestKey = args.guest_key;
    if (!grantId || !guestKey?.enc_public || !guestKey?.sign_public || !isSealedTurn(args)) throw new Error("sealed_turn_malformed");
    // A compute grant is a bare id; a share's (« share:<uuid> ») or any
    // other namespaced one is never a model turn, whatever the task says.
    if (grantId.includes(":")) throw new Error("shared_task_refused");
    rotate();
    const guest: PublicIdentity = { encPublic: guestKey.enc_public, signPublic: guestKey.sign_public };
    pin(grantId, guest);
    const { body, turn } = openComputeRequest({
      host: identity(),
      prekeys: prekeySecrets(),
      guest,
      request: args.sealed_request,
      grantId,
      now: now(),
      markSeen,
    });
    const answer = startComputeResponse(turn);
    const line = (value: unknown) => `${JSON.stringify(value)}\n`;
    if (isWarmRequest(body)) {
      // Checked before anything is answered, as a question is.
      let asked: Record<string, unknown>;
      try {
        asked = warmCompletion(body);
        // Two lines, no text, nothing of the outcome: the guest (and the
        // account in between) learns neither whether this computer slept,
        // was busy or holds that model, nor whether the read ran.
        await send(line({ h: answer.header }));
        await send(line({ c: answer.finish("") }));
      } finally {
        forgetTurn(turn);
      }
      try {
        warm?.(asked, grantId);
      } catch {
        // A read ahead that cannot start changes nothing for the guest.
      }
      return { sealed: true };
    }
    const relay = createDeltaRelay((text) => send(line({ c: answer.piece(text) })), { minIntervalMs });
    try {
      await send(line({ h: answer.header }));
      const served = await runModel(bareCompletion(body), (text) => relay.push(text));
      await relay.drain();
      await send(line({ c: answer.finish("", served.model ? { model: served.model } : {}) }));
      return { sealed: true };
    } finally {
      await relay.drain();
      forgetTurn(turn);
    }
  }

  /// One request on a folder shared from this computer: checked by the
  /// server before anything is opened (the share, its folder, the grantee,
  /// the device — `serve` with `{op: "check"}`), opened for grant id
  /// « share:<uuid> » from the device the task names, served, and answered
  /// sealed — `{"h": header}`, then `{"c": piece}`… whose texts joined are
  /// the answer's JSON; `send` gets one or more whole lines at a time (at
  /// most SHARE_DELTA_CHARS, or one line). A refusal before opening fails the task with
  /// « share_refused:<reason> »: nothing can be sealed to a request that was
  /// not opened, and the account learns no more than the reason.
  ///
  /// Request ids seen are kept in memory only: after a restart, a request
  /// relayed again within its five minutes would be served again. Accepted:
  /// every operation only reads, and its answer is sealed to keys the
  /// guest's device made for that one request, which the account cannot
  /// read.
  async function runSealedShare({
    args,
    serve,
    send,
  }: {
    args: SealedShareArgs;
    serve: ServeShare;
    send: (line: string) => Promise<void>;
  }): Promise<{ sealed: true }> {
    const principal = args.principal ?? {};
    const uuid = typeof principal.share_uuid === "string" && SHARE_UUID.test(principal.share_uuid) ? principal.share_uuid : null;
    const grantee = typeof principal.grantee_id === "number" && Number.isSafeInteger(principal.grantee_id) && principal.grantee_id > 0
      ? String(principal.grantee_id)
      : typeof principal.grantee_id === "string" && GRANTEE_ID.test(principal.grantee_id) ? principal.grantee_id : null;
    const enc = args.guest_key?.enc_public;
    const sign = args.guest_key?.sign_public;
    if (principal.kind !== "folder_share" || !uuid || !grantee || typeof enc !== "string" || typeof sign !== "string" || !KEY_HEX.test(enc) || !KEY_HEX.test(sign) || !isSealedTurn(args)) {
      throw new Error("sealed_share_malformed");
    }
    const base = { share_uuid: uuid, grantee_user_id: grantee, guest: { enc_public: enc, sign_public: sign } };
    const check = (await serve({ ...base, op: SHARE_CHECK })) as { ok?: unknown; error?: unknown } | null;
    if (check?.ok !== true) throw new Error(`share_refused:${typeof check?.error === "string" && /^[a-z_]{1,40}$/.test(check.error) ? check.error : "unknown"}`);
    rotate();
    const { body, turn } = openComputeRequest({
      host: identity(),
      prekeys: prekeySecrets(),
      guest: { encPublic: enc, signPublic: sign },
      request: args.sealed_request,
      grantId: shareGrantId(uuid),
      now: now(),
      markSeen,
    });
    try {
      const result = await serve({ ...base, op: body ?? {} });
      const json = JSON.stringify(result && typeof result === "object" ? result : { ok: false, error: "bad_request" });
      const answer = startComputeResponse(turn);
      const line = (value: unknown) => `${JSON.stringify(value)}\n`;
      let delta = "";
      const push = async (next: string) => {
        if (delta && delta.length + next.length > SHARE_DELTA_CHARS) {
          await send(delta);
          delta = "";
        }
        delta += next;
      };
      await push(line({ h: answer.header }));
      for (let at = 0; at < json.length; at += SHARE_PIECE_CHARS) await push(line({ c: answer.piece(json.slice(at, at + SHARE_PIECE_CHARS)) }));
      await push(line({ c: answer.finish("") }));
      await send(delta);
      return { sealed: true };
    } finally {
      forgetTurn(turn);
    }
  }

  return {
    rotate,
    publicKeys,
    pins: () => structuredClone(stored.pins),
    runSealedTurn,
    runSealedShare,
    /// For tests.
    markSeen,
  };
}

/// What the model is given of the question: text messages and a bound on
/// the answer, nothing else — no tools, whatever the sealed body says.
///
/// And no reasoning before the answer, as the owner's own chat by default
/// (« Rapide », routes/queries.ts streamLocal): Qwen3.5's chat template
/// reasons unless told not to, and a guest's phone has no effort to choose.
/// On Jimmy's M5 (18/10/2026), the first word of his daughter's question
/// came 35.7 s after it, 33 s of them reasoning nobody saw (751 tokens
/// written, the answer the last 10 or so); the next one, 8.3 s, 7.5 of them
/// reasoning (the runtime's own log). The bench's model on that Mac, the
/// phone's body asked directly: first word 15 to 64 s with reasoning, 0.5 to
/// 0.7 s without; the whole way, AGENTS.md §5 (twoody-bench
/// scripts/shared-compute-bench.mts). llama.cpp, mlx-lm and vLLM read
/// `chat_template_kwargs`, Ollama `reasoning_effort`; a runtime that refuses
/// either is asked again without (executors/llmInfer.ts).
export function bareCompletion(body: unknown): Record<string, unknown> {
  const value = (body ?? {}) as { model?: unknown; messages?: unknown; max_tokens?: unknown; temperature?: unknown };
  if (!Array.isArray(value.messages)) throw new Error("sealed_turn_malformed");
  const messages = value.messages
    .filter((message): message is { role: string; content: string } =>
      !!message && typeof message === "object" && ["system", "user", "assistant"].includes((message as { role?: string }).role ?? "")
      && typeof (message as { content?: unknown }).content === "string")
    .slice(-MAX_MESSAGES)
    .map(({ role, content }) => ({ role, content }));
  if (messages.length === 0) throw new Error("sealed_turn_malformed");
  const maxTokens = typeof value.max_tokens === "number" && value.max_tokens > 0 ? Math.min(Math.floor(value.max_tokens), MAX_TOKENS_CAP) : 2048;
  return {
    model: typeof value.model === "string" && value.model ? value.model : "local",
    messages,
    max_tokens: maxTokens,
    temperature: typeof value.temperature === "number" ? Math.min(Math.max(value.temperature, 0), 2) : 0.2,
    chat_template_kwargs: { enable_thinking: false },
    reasoning_effort: "none",
  };
}

/// A guest's warm (twoody-app utils/sharedTurn.js warmBody): sent when the
/// conversation with this computer is opened or the first letter typed, so
/// that the model wakes if it slept and the conversation so far is read
/// before the question comes (compute/guestWarm.ts).
export function isWarmRequest(body: unknown): boolean {
  return !!body && typeof body === "object" && (body as { warm?: unknown }).warm === true;
}

/// What a warm may ask of the model: the same messages as a question (the
/// conversation so far, its last message empty, so that what is read is
/// the very start of the next question), one token written, no tools and
/// no reasoning — whatever the sealed body says.
export function warmCompletion(body: unknown): Record<string, unknown> {
  return { ...bareCompletion(body), max_tokens: 1, temperature: 0 };
}
