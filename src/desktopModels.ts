import { randomUUID } from "node:crypto";

import type { TunnelParentPort } from "./tunnel/index.js";

// The models of a computer whose engine Twoody Desktop runs (01/11/2026):
// `twoody pull` and `twoody rm` in a terminal, and the person's other
// devices, install and remove them through the /runtime routes as on a
// server alone, and the Desktop does it — the same download as « Modèles »
// › « Installer », its progress shown in the app too. Before, those routes
// answered 409 managed_by_desktop (docs/builtin-runtime-design.md §4).
//
// Over the Desktop's port (index.ts), as share-call does:
//   {type: "model-call", id, op: "install" | "remove" | "cancel", model}
//   → {type: "model-call-result", id, ok, code?, message?}
// and, while the Desktop downloads any model:
//   {type: "model-progress", id: <model>, state, received, total, bytesPerSecond}
// Only a catalogue id goes out; the Desktop checks it against its own copy
// of the catalogue and its disk space, as for its own screen.

export const MODEL_CALL = "model-call";
export const MODEL_CALL_RESULT = "model-call-result";
export const MODEL_PROGRESS = "model-progress";
const MAX_PENDING = 8;

export type ModelOp = "install" | "remove" | "cancel";

export interface ModelCallAnswer {
  ok: boolean;
  code?: string;
  message?: string;
}

export interface DesktopProgress {
  model: string;
  state: string;
  received: number;
  total: number;
  bytesPerSecond: number;
}

export interface DesktopModelHost {
  call(op: ModelOp, model: string, timeoutMs: number): Promise<ModelCallAnswer>;
  onProgress(listener: ((progress: DesktopProgress) => void) | null): void;
}

let host: DesktopModelHost | null = null;

/// The Desktop that keeps this computer's models, when this server is its child.
export function desktopModelHost(): DesktopModelHost | null {
  return host;
}

/// For the tests: a Desktop of their own.
export function setDesktopModelHostForTests(next: DesktopModelHost | null): void {
  host = next;
}

const number = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0);

/// Installs the model calls on the Desktop's port (index.ts). Returns what undoes it.
export function relayModelsThroughDesktop(port: TunnelParentPort): () => void {
  const pending = new Map<string, { resolve: (value: ModelCallAnswer) => void; timer: ReturnType<typeof setTimeout> }>();
  let listener: ((progress: DesktopProgress) => void) | null = null;
  port.on("message", ({ data }) => {
    const message = data as { type?: unknown; id?: unknown; ok?: unknown; code?: unknown; message?: unknown; state?: unknown } & Record<string, unknown> | null;
    if (message?.type === MODEL_PROGRESS && typeof message.id === "string" && typeof message.state === "string") {
      listener?.({ model: message.id, state: message.state, received: number(message.received), total: number(message.total), bytesPerSecond: number(message.bytesPerSecond) });
      return;
    }
    if (message?.type !== MODEL_CALL_RESULT || typeof message.id !== "string") return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
    const code = typeof message.code === "string" && /^[a-z_]{1,64}$/.test(message.code) ? message.code : undefined;
    const text = typeof message.message === "string" ? message.message.slice(0, 500) : undefined;
    request.resolve({ ok: message.ok === true, ...(code ? { code } : {}), ...(text ? { message: text } : {}) });
  });
  host = {
    call(op, model, timeoutMs) {
      if (pending.size >= MAX_PENDING) return Promise.resolve({ ok: false, code: "desktop_busy" });
      return new Promise((resolve) => {
        const id = randomUUID();
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve({ ok: false, code: "timeout" });
        }, timeoutMs);
        timer.unref?.();
        pending.set(id, { resolve, timer });
        try {
          port.postMessage({ type: MODEL_CALL, id, op, model });
        } catch {
          pending.delete(id);
          clearTimeout(timer);
          resolve({ ok: false, code: "desktop_unreachable" });
        }
      });
    },
    onProgress(next) {
      listener = next;
    },
  };
  return () => {
    host = null;
    listener = null;
    for (const [id, request] of pending) {
      clearTimeout(request.timer);
      request.resolve({ ok: false, code: "desktop_unreachable" });
      pending.delete(id);
    }
  };
}
