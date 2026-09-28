// The relay over a WebSocket (the backend's TunnelChannel): the same two
// queues as /api/v1/tunnel/frames, but the frames the phone leaves are
// pushed here the moment they arrive, and the answer's chunks leave on
// the open socket instead of one POST per batch (Jimmy, 28/09/2026: voice
// and streamed answers came in bursts). What travels is sealed between
// the two devices; this only moves base64 strings.
//
// Action Cable's protocol, on a socket opened with a single-use ticket
// (POST /api/v1/cable/tickets), so that no lasting token is ever in a
// URL. `ready` settles true once subscribed, false if the socket cannot
// be had — relayTransport.ts then polls over HTTP, as before. The twin of
// twoody-app utils/tunnel/cableLink.js.

import { relaySocketUrl } from "../outbound.js";

const SUBSCRIBE_TIMEOUT_MS = 6_000;

export interface CableLinkOptions {
  base: string;
  headers(): Record<string, string>;
  rendezvous: string;
  as: "host" | "phone";
  onFrames(frames: string[]): void | Promise<void>;
  onPeer?(listening: boolean): void;
  onClosed?(): void;
  fetchImpl: typeof fetch;
  WebSocketImpl?: typeof WebSocket;
}

export interface CableLink {
  readonly ready: Promise<boolean>;
  readonly open: boolean;
  /// Hands base64 frames to the other end; false when the socket is not
  /// there, and the caller posts them over HTTP instead.
  push(frames: string[]): boolean;
  close(): void;
}

export function createCableLink(options: CableLinkOptions): CableLink {
  const identifier = JSON.stringify({ channel: "TunnelChannel", rendezvous: options.rendezvous, as: options.as });
  const WebSocketImpl = options.WebSocketImpl ?? globalThis.WebSocket;
  let socket: WebSocket | null = null;
  let open = false;
  let closed = false;
  let settle: ((ok: boolean) => void) | null = null;
  const ready = new Promise<boolean>((resolve) => {
    settle = resolve;
  });
  const finish = (ok: boolean) => {
    settle?.(ok);
    settle = null;
  };

  const end = () => {
    if (closed) return;
    closed = true;
    const wasOpen = open;
    open = false;
    finish(false);
    try {
      socket?.close();
    } catch {
      // already closed
    }
    if (wasOpen) options.onClosed?.();
  };

  void (async () => {
    if (!WebSocketImpl) return end();
    const response = await options.fetchImpl(`${options.base}/api/v1/cable/tickets`, { method: "POST", headers: options.headers(), body: "{}" });
    if (!response.ok) return end();
    const { ticket } = (await response.json()) as { ticket?: string };
    if (!ticket || closed) return end();
    const url = await relaySocketUrl(options.base, ticket);
    if (!url || closed) return end();
    // The backend takes a socket only from its own origins (Action Cable's
    // request forgery check); a browser says its page's, Node says none,
    // so this end says the relay's own.
    const current = new (WebSocketImpl as unknown as new (url: URL, init: { headers: Record<string, string> }) => WebSocket)(url, { headers: { origin: new URL(options.base).origin } });
    socket = current;
    const timer = setTimeout(end, SUBSCRIBE_TIMEOUT_MS);
    timer.unref?.();
    current.onopen = () => current.send(JSON.stringify({ command: "subscribe", identifier }));
    current.onmessage = (event) => {
      let message: { type?: string; message?: { frames?: unknown; peer_listening?: unknown } };
      try {
        message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
      } catch {
        return;
      }
      if (message.type === "confirm_subscription") {
        clearTimeout(timer);
        open = true;
        finish(true);
        return;
      }
      if (message.type === "reject_subscription" || message.type === "disconnect") {
        clearTimeout(timer);
        end();
        return;
      }
      if (message.type) return; // welcome, ping
      const payload = message.message ?? {};
      if (typeof payload.peer_listening === "boolean") options.onPeer?.(payload.peer_listening);
      const frames = Array.isArray(payload.frames) ? payload.frames.filter((frame): frame is string => typeof frame === "string") : [];
      if (frames.length > 0) void options.onFrames(frames);
    };
    current.onerror = () => end();
    current.onclose = () => end();
  })().catch(() => end());

  return {
    ready,
    get open() {
      return open;
    },
    push(frames: string[]): boolean {
      if (!open || !socket) return false;
      try {
        socket.send(JSON.stringify({ command: "message", identifier, data: JSON.stringify({ action: "push", frames }) }));
        return true;
      } catch {
        end();
        return false;
      }
    },
    close: end,
  };
}
