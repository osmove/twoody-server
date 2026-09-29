import { outboundFetch } from "./outbound.js";
import { runtimeAuthHeaders } from "./runtimeAuth.js";

// Which of llama.cpp's slots a call goes to: the chat to slot 0, the work
// done in the background (memory extraction) to slot 1, so that the one
// does not push the other's prompt out of the runtime's cache.
//
// Only for the runtime Twoody ships (started with a key, runtimeAuth.ts)
// when llama.cpp says it has two slots or more (`GET /props?model=`,
// `total_slots`). The Desktop and the server start it with `--parallel 1`
// today (twoody-desktop/src/main/runtimeArgs.ts, src/builtin/manager.ts):
// nothing is sent then — llama.cpp keeps the chat's prompt in its RAM
// cache while a background call uses the slot, and restores it (measured
// on Qwen3.5 9B, 29/09/2026). Never sent to Ollama, LM Studio, mlx-lm or a
// runtime the person started: they ignore it at best.

export type SlotPurpose = "chat" | "background";

const KEEP_MS = 60_000;
const TIMEOUT_MS = 1_500;
const known = new Map<string, { at: number; slots: number | null }>();

/// The slot to name for this call, or null to name none.
export async function runtimeSlot(baseUrl: string, model: string, purpose: SlotPurpose): Promise<number | null> {
  const slots = await slotCount(baseUrl, model);
  if (slots === null || slots < 2) return null;
  return purpose === "background" ? 1 : 0;
}

async function slotCount(baseUrl: string, model: string): Promise<number | null> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const auth = runtimeAuthHeaders(base);
  if (!auth.Authorization) return null;
  const key = `${base} ${model}`;
  const kept = known.get(key);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.slots;
  let slots: number | null = null;
  try {
    const root = base.replace(/\/v1$/, "");
    const response = await outboundFetch(`${root}/props?model=${encodeURIComponent(model)}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) {
      const body = (await response.json().catch(() => null)) as { total_slots?: unknown; build_info?: unknown } | null;
      if (body && typeof body.build_info === "string" && typeof body.total_slots === "number" && Number.isInteger(body.total_slots)) slots = body.total_slots;
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // not llama.cpp, or not there: no slot named
  }
  known.set(key, { at: Date.now(), slots });
  return slots;
}

/// Forgets what the runtimes said: for tests.
export function forgetRuntimeSlots(): void {
  known.clear();
}
