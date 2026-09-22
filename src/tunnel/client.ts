import { Channel, rendezvousId, startHandshake, type StaticIdentity } from "./channel.js";
import { helloFrame, readHello } from "./link.js";
import { decode, encode, type Message } from "./protocol.js";
import { createRelayTransport, type RelayTransport } from "./relayTransport.js";

// The other end: a phone, or anything else, reaching the Twoody on its
// own computer through the relay.
//
// What it offers is `fetch`. Every screen of the app is written against
// the HTTP the local server speaks, and the point of carrying that same
// HTTP through the tunnel is that those screens do not have to know
// where they are talking to. Swapping this in for `fetch` is the whole
// change.
//
// The answer comes back as a real Response with a streaming body, so a
// reply being written token by token reaches the screen the same way it
// does on the same Wi-Fi.

export interface TunnelClientOptions {
  backendUrl: string;
  userToken: string;
  deviceToken?: string;
  /// This device's long-lived key pair.
  identity: StaticIdentity;
  /// The computer's public key, learnt when the two were paired.
  peerStaticKey: Buffer;
  onError?(err: unknown): void;
  fetchImpl?: typeof fetch;
  waitSeconds?: number;
  /// How long to wait for the computer to answer a hello.
  handshakeTimeoutMs?: number;
}

export interface TunnelClient {
  readonly rendezvous: string;
  /// Whether a session is open.
  readonly connected: boolean;
  /// Whether the relay has seen the computer recently. False means it
  /// is asleep or offline — worth saying, rather than waiting.
  readonly peerListening: boolean;
  /// A path on the computer's Twoody server, never a whole URL.
  fetch(path: string, init?: { method?: string; headers?: Record<string, string>; body?: Buffer | string; signal?: AbortSignal }): Promise<Response>;
  stop(): void;
}

const HELLO_RETRY_MS = 3_000;

export function startTunnelClient(options: TunnelClientOptions): TunnelClient {
  const rendezvous = rendezvousId(options.identity.publicKey, options.peerStaticKey);
  const handshakeTimeoutMs = options.handshakeTimeoutMs ?? 15_000;
  let transport: RelayTransport;
  let channel: Channel | null = null;
  let handshake = startHandshake();
  let waitingForHello: Array<(channel: Channel) => void> = [];
  let nextId = 1;
  let stopped = false;

  interface Exchange {
    head(status: number, headers: Record<string, string>): void;
    chunk(bytes: Buffer): void;
    end(): void;
    fail(message: string): void;
  }
  const exchanges = new Map<number, Exchange>();

  function onHello(peerEphemeral: Buffer): void {
    channel = new Channel({
      role: "initiator",
      handshake,
      identity: options.identity,
      peerEphemeral,
      peerStatic: options.peerStaticKey,
    });
    // Anything that was in flight belonged to the session that just
    // ended; it will not be answered.
    for (const exchange of exchanges.values()) exchange.fail("the connection to your computer started again");
    exchanges.clear();
    const waiting = waitingForHello;
    waitingForHello = [];
    for (const resolve of waiting) resolve(channel);
  }

  async function ready(): Promise<Channel> {
    if (channel) return channel;
    if (stopped) throw new Error("the tunnel is closed");

    const settled = new Promise<Channel>((resolve) => waitingForHello.push(resolve));
    // A hello every few seconds until one comes back: the computer may
    // be waking up, or may have missed the first while reconnecting.
    handshake = startHandshake();
    const hello = helloFrame(handshake.ephemeralPublicKey);
    const retry = setInterval(() => void transport.send([hello]).catch(() => {}), HELLO_RETRY_MS);
    retry.unref?.();
    void transport.send([hello]).catch((err) => options.onError?.(err));

    try {
      return await Promise.race([
        settled,
        new Promise<Channel>((_, reject) =>
          setTimeout(
            () => reject(new Error(transport.peerListening ? "your computer did not answer" : "your computer is not connected to Twoody")),
            handshakeTimeoutMs,
          ).unref?.(),
        ),
      ]);
    } finally {
      clearInterval(retry);
    }
  }

  transport = createRelayTransport({
    backendUrl: options.backendUrl,
    userToken: options.userToken,
    deviceToken: options.deviceToken,
    rendezvous,
    as: "phone",
    onError: options.onError,
    fetchImpl: options.fetchImpl,
    waitSeconds: options.waitSeconds,
    onFrames: (frames) => {
      for (const frame of frames) {
        const hello = readHello(frame);
        if (hello) {
          onHello(hello);
          continue;
        }
        if (!channel) continue;

        let message: Message;
        let body: Buffer;
        try {
          ({ message, body } = decode(channel.open(frame)));
        } catch (err) {
          options.onError?.(err);
          continue;
        }

        if (message.t === "ping") continue;
        if (!("id" in message)) continue;
        const exchange = exchanges.get(message.id);
        if (!exchange) continue;
        switch (message.t) {
          case "res":
            exchange.head(message.status, message.headers);
            break;
          case "chunk":
            exchange.chunk(body);
            break;
          case "end":
            exchange.end();
            exchanges.delete(message.id);
            break;
          case "err":
            exchange.fail(message.message);
            exchanges.delete(message.id);
            break;
          default:
            break;
        }
      }
    },
  });

  return {
    rendezvous,
    get connected() {
      return channel !== null;
    },
    get peerListening() {
      return transport.peerListening;
    },

    async fetch(path, init = {}): Promise<Response> {
      const open = await ready();
      const id = nextId++;
      const body = init.body === undefined ? Buffer.alloc(0) : Buffer.isBuffer(init.body) ? init.body : Buffer.from(init.body, "utf8");

      let head: ((value: { status: number; headers: Record<string, string> }) => void) | null = null;
      let headFailed: ((err: Error) => void) | null = null;
      const headed = new Promise<{ status: number; headers: Record<string, string> }>((resolve, reject) => {
        head = resolve;
        headFailed = reject;
      });

      let push: ((bytes: Buffer) => void) | null = null;
      let finish: (() => void) | null = null;
      let broke: ((err: Error) => void) | null = null;
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          push = (bytes) => controller.enqueue(new Uint8Array(bytes));
          finish = () => {
            try {
              controller.close();
            } catch {
              // Already closed by an abort.
            }
          };
          broke = (err) => controller.error(err);
        },
      });

      let answered = false;
      exchanges.set(id, {
        head: (status, headers) => {
          answered = true;
          head?.({ status, headers });
        },
        chunk: (bytes) => push?.(bytes),
        end: () => finish?.(),
        fail: (message) => {
          const err = new Error(message);
          if (answered) broke?.(err);
          else headFailed?.(err);
        },
      });

      const stop = () => {
        exchanges.delete(id);
        void transport.send([open.seal(encode({ t: "abort", id }))]).catch(() => {});
        const err = new Error("the request was stopped");
        if (answered) broke?.(err);
        else headFailed?.(err);
      };
      init.signal?.addEventListener("abort", stop, { once: true });

      await transport.send([open.seal(encode({ t: "req", id, method: (init.method ?? "GET").toUpperCase(), path, headers: init.headers ?? {} }, body))]);

      const { status, headers } = await headed;
      return new Response(status === 204 || status === 304 ? null : stream, { status, headers });
    },

    stop(): void {
      stopped = true;
      transport.stop();
      for (const exchange of exchanges.values()) exchange.fail("the tunnel is closed");
      exchanges.clear();
      channel = null;
    },
  };
}
