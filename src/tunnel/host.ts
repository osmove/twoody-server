import { outboundFetch } from "../outbound.js";
import { Channel, ChannelError } from "./channel.js";
import { decode, encode, MAX_BODY_BYTES, ProtocolError, type Message } from "./protocol.js";

// This computer's end of the tunnel: it opens what the phone sealed,
// runs the request against the Twoody server on this machine, and seals
// the answer back.
//
// It is written against two functions — one to send a frame, one to be
// called with each frame that arrives — and knows nothing about how they
// reach the other side. That is what lets the whole exchange be tested
// with the two ends in one process, and it is also true of the real
// thing: the relay is one implementation of those two functions and a
// direct socket would be another.
//
// What it will not do:
//
//   - reach anything but the local server. The phone sends a path, never
//     a URL, and the base is fixed here. A tunnel that forwarded
//     arbitrary URLs would be an open proxy sitting on someone's home
//     network;
//   - hold a request forever. Each one has a deadline, and a phone that
//     goes through a tunnel gets the same 30 s a phone on the LAN gets,
//     except for the streaming answers that are the point of this.

export interface TunnelHostOptions {
  channel: Channel;
  /// Where the local Twoody server answers, e.g. http://127.0.0.1:8910.
  localBaseUrl: string;
  /// Hands a sealed frame to whatever carries it. May be async; a
  /// rejection ends the exchange it belonged to, not the host.
  send(frame: Buffer): void | Promise<void>;
  /// How long a request may take before it is given up on. Streamed
  /// answers are not bound by it once they have started.
  timeoutMs?: number;
  /// What carries the frames: the account's relay, or a socket straight
  /// to this computer on the local network (routes/tunnelDirect.ts). Said
  /// in the marker below, for the routes whose limits depend on it (a raw
  /// file is capped lower through the relay). Relay when unsaid.
  transport?: "relay" | "direct";
  /// The other end's static X25519 key, which the channel was built with
  /// (the only proof of who sealed a frame): stamped on every request it
  /// serves (TUNNEL_PEER_HEADER), so that a route can hold a session to the
  /// key it was given for.
  peerPublicKey?: Buffer;
  /// Only for tests.
  fetchImpl?: typeof fetch;
  onError?(err: unknown): void;
}

/// Headers that describe the hop rather than the request. Forwarding
/// them would describe the wrong hop.
const HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

const CHUNK_BYTES = 64 * 1024;

/// Set on every request the tunnel serves, whatever the other end sent:
/// "relay", or "direct" for the local network's socket.
export const VIA_TUNNEL_HEADER = "x-twoody-via-tunnel";
/// Set on every request the tunnel serves to the hex of the key of the
/// device at the other end, replacing whatever that device sent; removed
/// when the host was not told it.
export const TUNNEL_PEER_HEADER = "x-twoody-tunnel-peer";

export interface TunnelHost {
  /// Feed it every frame that arrives. It never throws: a frame that
  /// cannot be opened is reported and dropped, because the other side of
  /// a tunnel is not trusted to be well-behaved.
  ///
  /// Answers whether the frame was this session's — which is also the
  /// only proof of who sealed it, and is what lets a caller holding two
  /// sessions know which one a frame belonged to.
  receive(frame: Buffer): Promise<boolean>;
  /// Stops everything in flight. Safe to call twice.
  close(): void;
  /// How many requests are being served right now.
  readonly inFlight: number;
}

export function createTunnelHost(options: TunnelHostOptions): TunnelHost {
  const fetchImpl = options.fetchImpl ?? outboundFetch;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const base = new URL(options.localBaseUrl);
  const running = new Map<number, AbortController>();
  /// Requests whose body is arriving in pieces (`streamed`), until their
  /// `end`: then they are served like any other.
  const assembling = new Map<number, { request: Extract<Message, { t: "req" }>; pieces: Buffer[]; size: number; timer: NodeJS.Timeout }>();
  let closed = false;

  async function seal(message: Message, body?: Buffer): Promise<void> {
    if (closed) return;
    await options.send(options.channel.seal(encode(message, body)));
  }

  async function serve(request: Extract<Message, { t: "req" }>, body: Buffer): Promise<void> {
    // A second request with a live id would leave the first unanswered
    // and its abort ambiguous. The phone controls the ids, so this is a
    // bug on its side, and it is told rather than silently served.
    if (running.has(request.id)) {
      await seal({ t: "err", id: request.id, message: "a request with this id is already running" });
      return;
    }

    const url = new URL(request.path, base);
    // `new URL("//evil.example/x", base)` keeps the scheme and changes
    // the host, and a path is allowed to start with two slashes. The
    // base is the only server this tunnel serves, so anything that
    // moved off it is refused.
    if (url.origin !== base.origin) {
      await seal({ t: "err", id: request.id, message: "the tunnel only reaches the Twoody server on this computer" });
      return;
    }

    const controller = new AbortController();
    running.set(request.id, controller);
    const deadline = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers();
      for (const [name, value] of Object.entries(request.headers)) {
        if (!HOP_HEADERS.has(name)) headers.set(name, value);
      }
      // Every request from the tunnel arrives from 127.0.0.1: said so, for
      // the routes that trust this machine's own requests (localAccess.ts).
      headers.set(VIA_TUNNEL_HEADER, options.transport ?? "relay");
      if (options.peerPublicKey) headers.set(TUNNEL_PEER_HEADER, options.peerPublicKey.toString("hex"));
      else headers.delete(TUNNEL_PEER_HEADER);
      const response = await fetchImpl(url, {
        method: request.method,
        headers,
        // A view, not a copy: the body is already a slice of the frame
        // this process decrypted. The cast is about the type of the
        // backing store, which for a Buffer Node produced is always an
        // ArrayBuffer and never a shared one.
        body: body.length > 0 ? new Uint8Array(body.buffer as ArrayBuffer, body.byteOffset, body.byteLength) : undefined,
        signal: controller.signal,
        redirect: "manual",
      });

      const outHeaders: Record<string, string> = {};
      response.headers.forEach((value, name) => {
        if (!HOP_HEADERS.has(name.toLowerCase())) outHeaders[name.toLowerCase()] = value;
      });
      await seal({ t: "res", id: request.id, status: response.status, headers: outHeaders });

      // Past the headers the answer may run for as long as the model
      // takes: clearing the deadline here is what makes a streamed reply
      // possible. An abort from the phone, or a closed host, still stops
      // it.
      clearTimeout(deadline);

      if (response.body) {
        const reader = response.body.getReader();
        let sent = 0;
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (closed || controller.signal.aborted) {
            await reader.cancel().catch(() => {});
            break;
          }
          sent += value.byteLength;
          if (sent > MAX_BODY_BYTES) {
            await reader.cancel().catch(() => {});
            await seal({ t: "err", id: request.id, message: "the answer is larger than the tunnel carries" });
            return;
          }
          // One frame per chunk, split when a chunk is big: each frame
          // is sealed on its own, and a huge one would sit in memory
          // twice on both machines.
          for (let offset = 0; offset < value.byteLength; offset += CHUNK_BYTES) {
            await seal({ t: "chunk", id: request.id }, Buffer.from(value.buffer, value.byteOffset + offset, Math.min(CHUNK_BYTES, value.byteLength - offset)));
          }
        }
      }
      await seal({ t: "end", id: request.id });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      // What went wrong reaching a server on this machine is not
      // something to describe to the other end in detail.
      await seal({ t: "err", id: request.id, message: aborted ? "the request was stopped" : "the Twoody server on this computer did not answer" }).catch(() => {});
      if (!aborted) options.onError?.(err);
    } finally {
      clearTimeout(deadline);
      running.delete(request.id);
    }
  }

  return {
    get inFlight() {
      return running.size;
    },

    async receive(frame: Buffer): Promise<boolean> {
      if (closed) return false;
      let opened: Buffer;
      try {
        opened = options.channel.open(frame);
      } catch (err) {
        // A frame that does not open is a frame the other device did not
        // seal — a relay playing games, or bytes that got damaged. It is
        // dropped, and nothing is sent back: answering would tell
        // whoever sent it which of its guesses was closer.
        options.onError?.(err instanceof ChannelError ? err : new ChannelError("not_authentic", "frame refused"));
        return false;
      }

      let message: Message;
      let body: Buffer;
      try {
        ({ message, body } = decode(opened));
      } catch (err) {
        // It opened, so it came from the other device; it just made no
        // sense. The session is still theirs.
        options.onError?.(err instanceof ProtocolError ? err : new ProtocolError("message refused"));
        return true;
      }

      switch (message.t) {
        case "req":
          if (message.streamed) {
            if (running.has(message.id) || assembling.has(message.id)) {
              await seal({ t: "err", id: message.id, message: "a request with this id is already running" });
              return true;
            }
            // A body that stops arriving is given up on, like a request
            // that takes too long.
            const timer = setTimeout(() => {
              assembling.delete(message.id);
              void seal({ t: "err", id: message.id, message: "the rest of the request never came" }).catch(() => {});
            }, timeoutMs);
            timer.unref?.();
            assembling.set(message.id, { request: message, pieces: [], size: 0, timer });
            return true;
          }
          await serve(message, body);
          return true;
        case "chunk": {
          const pending = assembling.get(message.id);
          if (!pending) {
            options.onError?.(new ProtocolError("the phone sent a chunk of no request in progress"));
            return true;
          }
          pending.size += body.length;
          if (pending.size > MAX_BODY_BYTES) {
            clearTimeout(pending.timer);
            assembling.delete(message.id);
            await seal({ t: "err", id: message.id, message: "the request is too large" });
            return true;
          }
          pending.pieces.push(Buffer.from(body));
          return true;
        }
        case "end": {
          const pending = assembling.get(message.id);
          if (!pending) {
            options.onError?.(new ProtocolError("the phone ended no request in progress"));
            return true;
          }
          clearTimeout(pending.timer);
          assembling.delete(message.id);
          await serve(pending.request, Buffer.concat(pending.pieces));
          return true;
        }
        case "abort":
          running.get(message.id)?.abort();
          return true;
        case "ping":
          return true;
        default:
          // `res`, `chunk`, `end`, `err` are this side's to send. Getting
          // one back means the other end is confused, not hostile.
          options.onError?.(new ProtocolError(`the phone sent a ${message.t}, which is this side's to send`));
          return true;
      }
    },

    close(): void {
      closed = true;
      for (const controller of running.values()) controller.abort();
      running.clear();
      for (const pending of assembling.values()) clearTimeout(pending.timer);
      assembling.clear();
    },
  };
}
