import type { FrameTransport } from "./client.js";

// The sealed frames over the other computer's own `/tunnel` WebSocket, on
// the local network (routes/tunnelDirect.ts is the other end): the same
// frames the relay carries, without the relay. Used by a computer that
// sends questions to another of the account's computers (peers/links.ts).
//
// The socket is opened on the first send and again after it closed; the
// frames sent while it opens wait for it.

export interface DirectTransportOptions {
  /// The other computer's address, e.g. http://192.168.1.42:3000.
  url: string;
  rendezvous: string;
  onFrames(frames: Buffer[]): void | Promise<void>;
  onError?(err: unknown): void;
  onReset?(): void;
  WebSocketImpl?: typeof WebSocket;
}

export function directTunnelUrl(url: string, rendezvous: string): string {
  const base = new URL(url);
  base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
  base.pathname = "/tunnel";
  base.search = `?rendezvous=${encodeURIComponent(rendezvous)}`;
  return base.toString();
}

export function createDirectTransport(options: DirectTransportOptions): FrameTransport {
  const Impl = options.WebSocketImpl ?? globalThis.WebSocket;
  let socket: WebSocket | null = null;
  let open = false;
  let stopped = false;
  let waiting: Buffer[] = [];
  let queue = Promise.resolve();

  function connect(): WebSocket {
    const ws = new Impl(directTunnelUrl(options.url, options.rendezvous));
    ws.binaryType = "arraybuffer";
    ws.addEventListener("open", () => {
      open = true;
      const frames = waiting;
      waiting = [];
      for (const frame of frames) ws.send(frame);
    });
    ws.addEventListener("message", (event: MessageEvent) => {
      const data = event.data;
      const frame = Buffer.isBuffer(data) ? data : Buffer.from(data as ArrayBuffer);
      queue = queue.then(() => options.onFrames([frame])).catch((err) => options.onError?.(err));
    });
    ws.addEventListener("close", () => {
      if (socket === ws) {
        socket = null;
        const wasOpen = open;
        open = false;
        waiting = [];
        if (wasOpen) options.onReset?.();
      }
    });
    ws.addEventListener("error", (event) => options.onError?.(event));
    return ws;
  }

  return {
    async send(frames: Buffer[]): Promise<void> {
      if (stopped) throw new Error("the tunnel is closed");
      if (!socket) socket = connect();
      if (!open) {
        waiting.push(...frames);
        return;
      }
      for (const frame of frames) socket.send(frame);
    },
    get peerListening() {
      return open;
    },
    stop(): void {
      stopped = true;
      waiting = [];
      try {
        socket?.close();
      } catch {
        // already closed
      }
      socket = null;
      open = false;
    },
  };
}
