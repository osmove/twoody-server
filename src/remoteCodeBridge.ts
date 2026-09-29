import { randomUUID } from "node:crypto";
import type { TunnelParentPort } from "./tunnel/index.js";

// Twoody Code lives in the Desktop app's main process, not here: this
// asks it over the child-process channel the Desktop started this server
// with (`remote-code` → `remote-code-result`), and hears Code's events
// while at least one phone follows a session (`remote-code-subscribe`).
// Run without the Desktop, there is no channel and no Code.

export interface RemoteCodeEvent {
  sessionId: string;
  type: string;
  [field: string]: unknown;
}

export type RemoteCodeSignal = { type: "event"; seq: number; event: RemoteCodeEvent } | { type: "off" };

export interface RemoteCodeBridge {
  /// Answers with the Desktop's result; rejects with an Error whose
  /// message is its error code.
  ask(command: string, input: Record<string, unknown>): Promise<unknown>;
  /// Code's events from now on; returns how to stop hearing them.
  follow(listener: (signal: RemoteCodeSignal) => void): () => void;
}

const TIMEOUT_MS = 60_000;
const MAX_PENDING = 32;

export function remoteCodeBridgeOver(port: TunnelParentPort, timeoutMs = TIMEOUT_MS): RemoteCodeBridge {
  const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  const listeners = new Set<(signal: RemoteCodeSignal) => void>();
  port.on("message", ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; result?: unknown; error?: unknown; seq?: unknown; event?: unknown } | null;
    if (message?.type === "remote-code-result" && typeof message.id === "string") {
      const request = pending.get(message.id);
      if (!request) return;
      pending.delete(message.id);
      clearTimeout(request.timer);
      if (typeof message.error === "string") request.reject(new Error(message.error));
      else request.resolve(message.result);
    } else if (message?.type === "remote-code-event" && typeof message.seq === "number" && message.event && typeof message.event === "object") {
      const event = message.event as RemoteCodeEvent;
      if (typeof event.sessionId !== "string" || typeof event.type !== "string") return;
      for (const listener of [...listeners]) listener({ type: "event", seq: message.seq, event });
    } else if (message?.type === "remote-code-off") {
      for (const listener of [...listeners]) listener({ type: "off" });
    }
  });
  return {
    ask(command, input) {
      if (pending.size >= MAX_PENDING) return Promise.reject(new Error("desktop_busy"));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error("desktop_timeout"));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        port.postMessage({ type: "remote-code", id, command, input });
      });
    },
    follow(listener) {
      listeners.add(listener);
      if (listeners.size === 1) port.postMessage({ type: "remote-code-subscribe", on: true });
      return () => {
        if (!listeners.delete(listener)) return;
        if (listeners.size === 0) port.postMessage({ type: "remote-code-subscribe", on: false });
      };
    },
  };
}

let desktop: RemoteCodeBridge | null = null;

/// The Desktop's Code, or null when this server runs on its own.
export function desktopRemoteCode(): RemoteCodeBridge | null {
  if (desktop) return desktop;
  const port = (process as unknown as { parentPort?: TunnelParentPort }).parentPort;
  if (!port) return null;
  desktop = remoteCodeBridgeOver(port);
  return desktop;
}
