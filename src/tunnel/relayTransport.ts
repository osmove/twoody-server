// Carrying frames to the other device through the relay.
//
// The relay is two queues and a name (see the backend's TunnelRelay): a
// long poll takes what is waiting, a POST leaves something for the
// other end. Neither side ever accepts a connection, which is the whole
// point — a computer at home has no open port, and a phone on mobile
// data could not be reached at one anyway.
//
// This module knows nothing about what the frames hold. It is the
// `send` and the `onFrames` that channel.ts and host.ts are written
// against, with the network in between.

import { outboundFetch } from "../outbound.js";
import { createCableLink, type CableLink } from "./cableLink.js";

export interface RelayTransportOptions {
  /// Where the relay answers, e.g. https://api.twoody.com.
  backendUrl: string;
  /// The account both devices are signed into. A session the backend
  /// bound to a device needs that device's token alongside it.
  userToken: string;
  deviceToken?: string;
  /// The 32 hex characters both sides derived from their public keys.
  rendezvous: string;
  /// Which end this is: "host" is the computer, "phone" the other.
  as: "host" | "phone";
  onFrames(frames: Buffer[]): void | Promise<void>;
  onError?(err: unknown): void;
  /// Called when the relay says nobody is listening on the other side.
  onPeerChanged?(listening: boolean): void;
  /// Called when what the relay says changes: it answers the waits, it
  /// cannot be reached, or it refuses the account's session. What the
  /// person is shown depends on it — "waiting at the relay" is only true
  /// while it answers, and a refused session wants signing in again, not
  /// patience.
  onRelayState?(state: RelayState): void;
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
  /// The relay over a WebSocket first (cableLink.ts), the HTTP poll when
  /// the socket cannot be had. Off in tests that drive the poll.
  cable?: boolean;
  WebSocketImpl?: typeof WebSocket;
}

export type RelayState = "answering" | "unreachable" | "refused";

/// The relay answered, and said no to the account's session: not a relay
/// that cannot be reached.
class SessionRefused extends Error {}

export interface RelayTransport {
  /// Leaves frames for the other device. Several calls close together
  /// travel as one POST.
  send(frames: Buffer[]): Promise<void>;
  /// Whether the relay saw the other end recently.
  readonly peerListening: boolean;
  stop(): void;
}

const BACKOFF_MIN_MS = 500;
const BACKOFF_MAX_MS = 15_000;
/// Long enough to gather a burst of chunks into one POST, short enough
/// not to be felt in a conversation.
const SEND_BATCH_MS = 20;
/// How long before trying the socket again once it closed; the poll
/// carries the frames meanwhile.
const CABLE_RETRY_MS = 5_000;

export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  // Through the gate, so a server started in local-only mode refuses
  // to reach a relay on the internet rather than quietly using one.
  const fetchImpl = options.fetchImpl ?? outboundFetch;
  const waitSeconds = options.waitSeconds ?? 25;
  const base = options.backendUrl.replace(/\/+$/, "");
  let stopped = false;
  let peerListening = false;
  let relayState: RelayState | null = null;
  let pending: Buffer[] = [];
  let flushing: Promise<void> | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  const inFlight = new AbortController();

  function headers(): Record<string, string> {
    const out: Record<string, string> = {
      // Asked for, so a refused session comes back as a 401 to read rather
      // than as a redirect to a sign-in page.
      accept: "application/json",
      "content-type": "application/json",
      "x-user-token": options.userToken,
    };
    if (options.deviceToken) out["x-device-token"] = options.deviceToken;
    return out;
  }

  function noteRelay(next: RelayState): void {
    if (next === relayState) return;
    relayState = next;
    options.onRelayState?.(next);
  }

  function notePeer(listening: unknown): void {
    const next = listening === true;
    if (next === peerListening) return;
    peerListening = next;
    options.onPeerChanged?.(next);
  }

  // The socket when it is open, the poll otherwise — never both reading,
  // or each would take the other's frames (the backend hands an end's
  // frames to its newest reader).
  let cable: CableLink | null = null;
  let polling = false;

  function openCable(): void {
    if (stopped || options.cable === false) return;
    const link = createCableLink({
      base,
      headers,
      rendezvous: options.rendezvous,
      as: options.as,
      fetchImpl,
      WebSocketImpl: options.WebSocketImpl,
      onFrames: async (frames) => {
        noteRelay("answering");
        if (!stopped) await options.onFrames(frames.map((frame) => Buffer.from(frame, "base64")));
      },
      onPeer: notePeer,
      onClosed: () => {
        if (cable === link) cable = null;
        if (stopped) return;
        if (!polling) void poll();
        setTimeout(openCable, CABLE_RETRY_MS).unref?.();
      },
    });
    cable = link;
    void link.ready.then((ok) => {
      if (stopped) return;
      if (ok) {
        noteRelay("answering");
        return;
      }
      if (cable === link) cable = null;
      if (!polling) void poll();
    });
  }

  async function poll(): Promise<void> {
    polling = true;
    try {
      await pollLoop();
    } finally {
      polling = false;
    }
  }

  async function pollLoop(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    // The first wait is short: whether the relay answers at all should be
    // known in a second, not after a whole long poll with nothing in it.
    let wait = Math.min(1, waitSeconds);
    while (!stopped && !cable?.open) {
      try {
        const url = new URL(`${base}/api/v1/tunnel/frames`);
        url.searchParams.set("rendezvous", options.rendezvous);
        url.searchParams.set("as", options.as);
        url.searchParams.set("wait", String(wait));
        wait = waitSeconds;
        const response = await fetchImpl(url, { headers: headers(), signal: inFlight.signal });
        if (response.status === 401 || response.status === 403) {
          noteRelay("refused");
          throw new SessionRefused(`relay refused the session (${response.status})`);
        }
        if (!response.ok) throw new Error(`relay answered ${response.status}`);
        const body = (await response.json()) as { frames?: unknown; peer_listening?: unknown };
        noteRelay("answering");
        notePeer(body.peer_listening);
        backoff = BACKOFF_MIN_MS;

        const frames = Array.isArray(body.frames) ? body.frames.filter((frame): frame is string => typeof frame === "string").map((frame) => Buffer.from(frame, "base64")) : [];
        if (frames.length > 0 && !stopped) await options.onFrames(frames);
      } catch (err) {
        if (stopped || (err instanceof Error && err.name === "AbortError")) return;
        if (!(err instanceof SessionRefused)) noteRelay("unreachable");
        options.onError?.(err);
        // A relay that is down, a network that is gone, a token that was
        // refused: all of them want the same thing, which is to stop
        // asking so often.
        await new Promise((resolve) => setTimeout(resolve, backoff));
        backoff = Math.min(backoff * 2, BACKOFF_MAX_MS);
      }
    }
  }

  async function flush(): Promise<void> {
    while (pending.length > 0 && !stopped) {
      const batch = pending.splice(0, 64);
      if (cable?.open && cable.push(batch.map((frame) => frame.toString("base64")))) continue;
      const response = await fetchImpl(`${base}/api/v1/tunnel/frames`, {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({
          rendezvous: options.rendezvous,
          to: options.as === "host" ? "phone" : "host",
          frames: batch.map((frame) => frame.toString("base64")),
        }),
        signal: inFlight.signal,
      });
      if (!response.ok) {
        // 409 is the other device having stopped reading; there is
        // nothing to retry, and holding the rest would only delay the
        // moment this session is given up on.
        pending = [];
        throw new Error(`relay refused the frames (${response.status})`);
      }
      const body = (await response.json().catch(() => ({}))) as { peer_listening?: unknown };
      notePeer(body.peer_listening);
    }
  }

  if (options.cable === false || !(options.WebSocketImpl ?? globalThis.WebSocket)) void poll();
  else openCable();

  return {
    get peerListening() {
      return peerListening;
    },

    async send(frames: Buffer[]): Promise<void> {
      if (stopped || frames.length === 0) return;
      pending.push(...frames);
      // Frames written in the same turn of the loop — the chunks of one
      // answer, most often — leave together.
      if (!flushTimer) {
        flushTimer = setTimeout(() => {
          flushTimer = null;
          flushing = flush().catch((err) => {
            options.onError?.(err);
          });
        }, SEND_BATCH_MS);
        flushTimer.unref?.();
      }
      await flushing;
    },

    stop(): void {
      if (stopped) return;
      stopped = true;
      if (flushTimer) clearTimeout(flushTimer);
      cable?.close();
      inFlight.abort();
      pending = [];
    },
  };
}
