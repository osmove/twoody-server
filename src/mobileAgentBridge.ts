import { randomUUID } from "node:crypto";
import type { TunnelParentPort } from "./tunnel/index.js";
let listening = false;
const pending = new Map<string, { resolve: (value: unknown) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
export function askDesktopAgent(owner: string, command: string, input: Record<string, unknown>): Promise<unknown> {
  const port = (process as unknown as { parentPort?: TunnelParentPort }).parentPort;
  if (!port) return Promise.reject(new Error("desktop_required"));
  if (!listening) {
    listening = true;
    port.on("message", ({ data }) => {
      const message = data as { type?: unknown; id?: unknown; result?: unknown; error?: unknown };
      if (message?.type !== "mobile-agent-result" || typeof message.id !== "string") return;
      const request = pending.get(message.id); if (!request) return;
      pending.delete(message.id); clearTimeout(request.timer);
      if (typeof message.error === "string") request.reject(new Error(message.error)); else request.resolve(message.result);
    });
  }
  if (pending.size >= 32) return Promise.reject(new Error("agent_busy"));
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const timer = setTimeout(() => { pending.delete(id); reject(new Error("agent_timeout")); }, 30_000);
    pending.set(id, { resolve, reject, timer });
    port.postMessage({ type: "mobile-agent", id, owner, command, input });
  });
}
