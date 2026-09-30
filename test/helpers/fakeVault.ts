import { ed25519 } from "@noble/curves/ed25519.js";
import { randomUUID } from "node:crypto";
import { approvalValid, canonicalHeader, fromHex } from "../../src/vault/crypto.js";
import { approvalV2Valid } from "../../src/vault/contracts.js";

// A stand-in for twoody-backend's /api/v1/vault as lot B1 (693ac548) left
// it, as a fetch function (setBackendFetch): person and computer devices, a
// computer bound to an account computer that never founds, approves, gives
// keys or revokes; a headless computer's session (kind "server") that may
// read the vault, enrol only itself, read its own envelopes and read or
// write events once its computer device is trusted; events in streams.

type Device = {
  id: string; label: string; enc_public: string; sign_public: string; status: "pending" | "trusted" | "revoked";
  approved_at: string | null; approved_by_id: string | null; approval: { approver_id: string; signature: string } | null;
  kind: "person" | "computer"; account_computer_id: string | null; binding: string | null; invite_proof: null;
};
type Envelope = { v: number; user_id: string; epoch: number; to_device: string; from_device: string; epk: string; nonce: string; ciphertext: string; signature: string };
/// `stored_at`: when the account stored it, by its own clock (the
/// backend's created_at of the row), unlike `created_at`, the sender's.
type StoredEvent = { seq: number; v: 1; user_id: string; conversation_id: string; event_id: string; epoch: number; kind: string; stream: string; created_at: string; stored_at: string; nonce: string; ciphertext: string };
type Session = { kind: "person" } | { kind: "server"; accountComputerId: string };

const STREAM_KINDS: Record<string, string[]> = { conversations: ["turn", "title", "tombstone"], memories: ["memory", "tombstone"] };

export function fakeVaultBackend({ userId, computers }: { userId: number; computers: string[] }) {
  const devices: Device[] = [];
  const envelopes: Envelope[] = [];
  const events: StoredEvent[] = [];
  const sessions = new Map<string, Session>();
  const calls: string[] = [];
  let seq = 0;
  let needsRotation = false;

  const epoch = () => Math.max(0, ...envelopes.map((e) => e.epoch));
  const pub = (d: Device) => ({ ...d });
  const envelopeBytes = (e: Envelope) => {
    const header = canonicalHeader("twoody/vault/envelope/v1", [e.v, e.user_id, e.epoch, e.to_device, e.from_device, e.epk]);
    const nonce = fromHex(e.nonce);
    const ciphertext = fromHex(e.ciphertext);
    const out = new Uint8Array(header.length + nonce.length + ciphertext.length);
    out.set(header, 0);
    out.set(nonce, header.length);
    out.set(ciphertext, header.length + nonce.length);
    return out;
  };

  function handle(session: Session, method: string, url: URL, body: Record<string, unknown>): [number, unknown] {
    const path = url.pathname.replace(/^\/api\/v1\//, "");
    const server = session.kind === "server";
    const live = devices.filter((d) => d.status !== "revoked");
    if (method === "GET" && path === "vault") return [200, { devices: devices.map(pub), epoch: epoch(), needs_rotation: needsRotation }];

    if (method === "POST" && path === "vault/devices") {
      const kind = (body.kind as string) || (server ? "computer" : "person");
      if (server && kind !== "computer") return [403, { error: "server_session_scope" }];
      let computer: string | null = null;
      if (kind === "computer") {
        computer = String(body.account_computer_id || "");
        if (!computers.includes(computer)) return [422, { error: "invalid_account_computer" }];
        if (server && session.accountComputerId !== computer) return [403, { error: "server_session_scope" }];
      }
      const existing = devices.find((d) => d.sign_public === body.sign_public && d.enc_public === body.enc_public && d.kind === kind && d.account_computer_id === computer);
      if (existing) return [200, { device: pub(existing) }];
      if (computer && live.some((d) => d.account_computer_id === computer)) return [409, { error: "computer_already_enrolled" }];
      const founding = kind === "person" && !devices.some((d) => d.status === "trusted") && envelopes.length === 0;
      const device: Device = {
        id: randomUUID(), label: String(body.label || "Device"), enc_public: String(body.enc_public), sign_public: String(body.sign_public),
        status: founding ? "trusted" : "pending", approved_at: founding ? new Date().toISOString() : null, approved_by_id: null, approval: null,
        kind: kind as Device["kind"], account_computer_id: computer, binding: typeof body.binding === "string" ? body.binding : null, invite_proof: null,
      };
      devices.push(device);
      return [201, { device: pub(device), founding }];
    }

    const approval = /^vault\/devices\/([^/]+)\/approval$/.exec(path);
    if (method === "POST" && approval) {
      if (server) return [403, { error: "server_session_scope" }];
      const device = live.find((d) => d.id === approval[1]);
      if (!device) return [404, {}];
      const approver = devices.find((d) => d.id === body.approver_id && d.status === "trusted");
      if (!approver) return [422, { error: "untrusted_giver" }];
      if (approver.kind === "computer") return [422, { error: "computer_cannot_approve" }];
      // v1, or approval/v2 for what the device is (twoody-backend
      // VaultDevice#approval_valid?).
      const signed = { userId, device, approverId: approver.id, approverSignPublic: fromHex(approver.sign_public), signature: String(body.signature) };
      const v2 = approvalV2Valid({ ...signed, kind: device.kind === "computer" ? "computer" : "person", accountComputerId: device.kind === "computer" ? device.account_computer_id : null });
      if (!v2 && !approvalValid(signed)) return [422, { error: "bad_signature" }];
      device.approval = { approver_id: approver.id, signature: String(body.signature) };
      if (typeof body.binding === "string") {
        if (device.kind !== "computer") return [422, { error: "invalid_binding" }];
        device.binding = body.binding;
      }
      return [200, { device: pub(device) }];
    }

    if (method === "POST" && path === "vault/envelopes") {
      if (server) return [403, { error: "server_session_scope" }];
      let latest = epoch();
      let rotated = false;
      for (const e of body.envelopes as Envelope[]) {
        if (e.user_id !== String(userId)) return [422, { error: "wrong_account" }];
        if (e.epoch > latest + 1) return [422, { error: "bad_epoch" }];
        const giver = devices.find((d) => d.id === e.from_device && d.status === "trusted");
        if (!giver) return [422, { error: "untrusted_giver" }];
        if (giver.kind === "computer") return [422, { error: "computer_cannot_approve" }];
        if (!ed25519.verify(fromHex(e.signature), envelopeBytes(e), fromHex(giver.sign_public))) return [422, { error: "bad_signature" }];
        const to = live.find((d) => d.id === e.to_device);
        if (!to) return [422, { error: "unknown_recipient" }];
        envelopes.push(e);
        rotated ||= e.epoch > latest;
        latest = Math.max(latest, e.epoch);
        if (to.status === "pending") Object.assign(to, { status: "trusted", approved_at: new Date().toISOString(), approved_by_id: e.from_device });
      }
      if (rotated) needsRotation = false;
      return [200, { stored: (body.envelopes as Envelope[]).length, epoch: epoch() }];
    }

    if (method === "GET" && path === "vault/envelopes") {
      const target = url.searchParams.get("device_id") || "";
      if (!live.some((d) => d.id === target)) return [404, {}];
      if (server && !live.some((d) => d.id === target && d.account_computer_id === session.accountComputerId)) return [403, { error: "server_session_scope" }];
      return [200, { envelopes: envelopes.filter((e) => e.to_device === target) }];
    }

    if (path === "vault/events") {
      if (server && !devices.some((d) => d.status === "trusted" && d.kind === "computer" && d.account_computer_id === session.accountComputerId)) return [403, { error: "server_session_scope" }];
      if (method === "POST") {
        let stored = 0;
        let duplicates = 0;
        const conflicts: string[] = [];
        for (const e of body.events as Array<Omit<StoredEvent, "seq" | "stream"> & { stream?: string }>) {
          const stream = e.stream || "conversations";
          if (!STREAM_KINDS[stream]?.includes(e.kind)) return [422, { error: "invalid_event", event_id: e.event_id }];
          const known = events.find((x) => x.event_id === e.event_id);
          if (known) {
            if (known.nonce === e.nonce && known.ciphertext === e.ciphertext) duplicates += 1;
            else conflicts.push(e.event_id);
            continue;
          }
          events.push({ seq: ++seq, v: 1, user_id: String(userId), conversation_id: e.conversation_id, event_id: e.event_id, epoch: e.epoch, kind: e.kind, stream, created_at: e.created_at, stored_at: new Date().toISOString(), nonce: e.nonce, ciphertext: e.ciphertext });
          stored += 1;
        }
        return [conflicts.length ? 409 : 200, { stored, duplicates, conflicts }];
      }
      const stream = url.searchParams.get("stream") || "conversations";
      if (!STREAM_KINDS[stream]) return [422, { error: "invalid_stream" }];
      const after = Number(url.searchParams.get("after") || 0);
      const limit = Math.min(500, Math.max(1, Number(url.searchParams.get("limit") || 200)));
      const conversation = url.searchParams.get("conversation_id");
      const rows = events.filter((e) => e.stream === stream && e.seq > after && (!conversation || e.conversation_id === conversation));
      return [200, { events: rows.slice(0, limit), next_after: rows.length > limit ? rows[limit - 1]!.seq : null }];
    }

    const revoke = /^vault\/devices\/([^/]+)\/revoke$/.exec(path);
    if (method === "POST" && revoke) {
      if (server) return [403, { error: "server_session_scope" }];
      const device = devices.find((d) => d.id === revoke[1]);
      if (!device) return [404, {}];
      device.status = "revoked";
      if (device.kind === "computer" && envelopes.some((e) => e.to_device === device.id)) needsRotation = true;
      return [200, {}];
    }
    return [404, { error: "not_found" }];
  }

  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const headers = new Headers(init?.headers);
    const session = sessions.get(headers.get("X-User-Token") || "");
    const method = (init?.method || "GET").toUpperCase();
    calls.push(`${method} ${url.pathname}${url.search}`);
    if (!session) return new Response(JSON.stringify({ error: "session_expired" }), { status: 401 });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const [status, json] = handle(session, method, url, body);
    return new Response(JSON.stringify(json), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  return {
    devices, envelopes, events, calls, fetch: fetchImpl,
    /// A person's session (the iPhone, a Desktop).
    personSession(token = `person-${randomUUID()}`) {
      sessions.set(token, { kind: "person" });
      return token;
    },
    /// A headless computer's own session (AuthSession::SERVER_SCOPE).
    serverSession(accountComputerId: string, token = `server-${randomUUID()}`) {
      sessions.set(token, { kind: "server", accountComputerId });
      return token;
    },
    get needsRotation() {
      return needsRotation;
    },
  };
}
