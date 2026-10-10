import { randomUUID } from "node:crypto";

// The bridge worker's side of serving a share (bridgeWorker.ts): it holds
// this computer's keys and opens the request, but has no database — the
// Desktop's embedded server holds the documents. So it asks its parent, the
// Desktop's main process: {type: "share-serve", id, payload} out,
// {type: "share-serve-result", id, result} back; main calls POST
// /local_shares/serve with this computer's app session (docs/sharing-
// contracts.md §4). No database import here: the worker must stay without
// one.

export const SHARE_SERVE_REQUEST = "share-serve";
export const SHARE_SERVE_RESULT = "share-serve-result";

/// Share requests waiting for the server's answer, at most.
const MAX_PENDING = 32;
/// The server answers a search in well under a second; the grantee gives up
/// after 4 s anyway.
const TIMEOUT_MS = 10_000;

export interface ShareServePort {
  postMessage(message: unknown): void;
}

export function createShareServeChannel(port: ShareServePort, options: { timeoutMs?: number } = {}) {
  const waiting = new Map<string, { resolve: (result: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  return {
    /// The bridge client's `serveShare`: the payload to the parent, its answer back.
    serve(payload: unknown): Promise<unknown> {
      if (waiting.size >= MAX_PENDING) return Promise.reject(new Error("share_serve_busy"));
      return new Promise((resolve, reject) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          waiting.delete(id);
          reject(new Error("share_serve_timeout"));
        }, options.timeoutMs ?? TIMEOUT_MS);
        timer.unref?.();
        waiting.set(id, { resolve, reject, timer });
        try {
          port.postMessage({ type: SHARE_SERVE_REQUEST, id, payload });
        } catch {
          clearTimeout(timer);
          waiting.delete(id);
          reject(new Error("share_serve_unreachable"));
        }
      });
    },
    /// A message from the parent: the answer to one of ours, or nothing to do.
    /// Answers whether it was one.
    received(message: unknown): boolean {
      const data = message as { type?: unknown; id?: unknown; result?: unknown } | null;
      if (data?.type !== SHARE_SERVE_RESULT || typeof data.id !== "string") return false;
      const request = waiting.get(data.id);
      if (!request) return true;
      waiting.delete(data.id);
      clearTimeout(request.timer);
      request.resolve(data.result ?? null);
      return true;
    },
    pending: () => waiting.size,
  };
}
