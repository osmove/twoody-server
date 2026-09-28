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
// tunnel's): an identity (X25519 + Ed25519) kept for good, and a prekey
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

export function createComputeHost({ path, now = Date.now }: { path: string; now?: () => number }) {
  let stored = load();
  const seen = new Map<string, number>();

  function load(): StoredKeys {
    if (existsSync(path)) {
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as StoredKeys;
        if (parsed?.v === 1 && parsed.identity?.enc_private && parsed.identity?.sign_private) {
          return { ...parsed, pins: parsed.pins ?? {}, prekeys: Array.isArray(parsed.prekeys) ? parsed.prekeys : [] };
        }
      } catch {
        // An unreadable file is replaced: the guests will see a new key,
        // which their devices refuse until it is verified again.
      }
      console.warn(`[compute] ${path} unreadable; making new keys. Guests must verify this computer again.`);
    }
    const identity = createComputeIdentity();
    return {
      v: 1,
      identity: { enc_private: toHex(identity.encPrivate), sign_private: toHex(identity.signPrivate) },
      prekeys: [],
      pins: {},
    };
  }

  function save() {
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    writeFileSync(temporary, JSON.stringify(stored), { mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
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
  async function runSealedTurn({
    args,
    runModel,
    send,
    minIntervalMs,
  }: {
    args: SealedTurnArgs;
    runModel: (openaiBody: Record<string, unknown>, onPiece: (text: string) => void) => Promise<{ model?: string }>;
    send: (line: string) => Promise<void>;
    minIntervalMs?: number;
  }): Promise<{ sealed: true }> {
    const grantId = String(args.principal?.grant_id ?? "");
    const guestKey = args.guest_key;
    if (!grantId || !guestKey?.enc_public || !guestKey?.sign_public || !isSealedTurn(args)) throw new Error("sealed_turn_malformed");
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

  return {
    rotate,
    publicKeys,
    pins: () => structuredClone(stored.pins),
    runSealedTurn,
    /// For tests.
    markSeen,
  };
}

/// What the model is given of the question: text messages and a bound on
/// the answer, nothing else — no tools, whatever the sealed body says.
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
  };
}
