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
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
}

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

export function createRelayTransport(options: RelayTransportOptions): RelayTransport {
  const fetchImpl = options.fetchImpl ?? fetch;
  const waitSeconds = options.waitSeconds ?? 25;
  const base = options.backendUrl.replace(/\/+$/, "");
  let stopped = false;
  let peerListening = false;
  let pending: Buffer[] = [];
  let flushing: Promise<void> | null = null;
  let flushTimer: NodeJS.Timeout | null = null;
  const inFlight = new AbortController();

  function headers(): Record<string, string> {
    const out: Record<string, string> = {
      "content-type": "application/json",
      "x-user-token": options.userToken,
    };
    if (options.deviceToken) out["x-device-token"] = options.deviceToken;
    return out;
  }

  function notePeer(listening: unknown): void {
    const next = listening === true;
    if (next === peerListening) return;
    peerListening = next;
    options.onPeerChanged?.(next);
  }

  async function poll(): Promise<void> {
    let backoff = BACKOFF_MIN_MS;
    while (!stopped) {
      try {
        const url = new URL(`${base}/api/v1/tunnel/frames`);
        url.searchParams.set("rendezvous", options.rendezvous);
        url.searchParams.set("as", options.as);
        url.searchParams.set("wait", String(waitSeconds));
        const response = await fetchImpl(url, { headers: headers(), signal: inFlight.signal });
        if (!response.ok) throw new Error(`relay answered ${response.status}`);
        const body = (await response.json()) as { frames?: unknown; peer_listening?: unknown };
        notePeer(body.peer_listening);
        backoff = BACKOFF_MIN_MS;

        const frames = Array.isArray(body.frames) ? body.frames.filter((frame): frame is string => typeof frame === "string").map((frame) => Buffer.from(frame, "base64")) : [];
        if (frames.length > 0 && !stopped) await options.onFrames(frames);
      } catch (err) {
        if (stopped || (err instanceof Error && err.name === "AbortError")) return;
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

  void poll();

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
      inFlight.abort();
      pending = [];
    },
  };
}
