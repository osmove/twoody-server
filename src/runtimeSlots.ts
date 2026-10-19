import { GUEST_SLOT, OWNER_SLOT, type SlotsMode } from "./builtin/slots.js";
import { outboundFetch } from "./outbound.js";
import { runtimeAuthHeaders } from "./runtimeAuth.js";

// Which of llama.cpp's slots a call goes to, when the runtime has two: a
// computer shared with someone, from 24 GB (builtin/slots.ts, 19/10/2026).
//   - slot 0, the owner's: their chat and its warms, their other devices
//     (routes/peer.ts), and the work done in the background (memory
//     extraction, titles);
//   - slot 1, the guests': the questions of the people the computer is
//     shared with, and their warms (bridgeClient.ts, executors/llmInfer.ts).
//
// The background on the owner's slot, not the guests': measured on the
// bench's Qwen3.5 9B (twoody-bench scripts/two-slots-router-bench.mjs,
// AGENTS.md §5), a guest who asks while the learner reads a conversation on
// slot 1 waits for it to end — 13.9 s to the first word —, against 2.5 s
// when it runs on slot 0; and the owner's conversation, set aside in the
// prompt cache while it ran there, came back whole after it (4 685 tokens
// found, 0.36 s to the first word). With one slot (a computer not shared),
// nothing is named, as before: llama.cpp keeps the chat's prompt in its RAM
// cache while a background call uses the slot, and restores it.
//
// Only for the runtime Twoody ships (started with a key, runtimeAuth.ts)
// when llama.cpp says it has two slots or more (`GET /props?model=`,
// `total_slots`, kept a minute, forgotten when the Desktop switches it:
// forgetRuntimeSlots). Never sent to Ollama, LM Studio, mlx-lm or a runtime
// the person started: they ignore it at best. A guest's body never names a
// slot itself (compute/computeHost.ts bareCompletion keeps only its
// messages and bounds).

export type SlotPurpose = "chat" | "background" | "guest";

const KEEP_MS = 60_000;
const TIMEOUT_MS = 1_500;
const known = new Map<string, { at: number; slots: number | null }>();

/// The slot to name for this call, or null to name none. `autoload: false`:
/// the runtime is not to load the model to answer (a guest's warm reads only
/// for the model it holds, compute/guestWarm.ts).
export async function runtimeSlot(baseUrl: string, model: string, purpose: SlotPurpose, options: { autoload?: boolean } = {}): Promise<number | null> {
  const slots = await slotCount(baseUrl, model, options.autoload !== false);
  if (slots === null || slots < 2) return null;
  return purpose === "guest" ? GUEST_SLOT : OWNER_SLOT;
}

async function slotCount(baseUrl: string, model: string, autoload: boolean): Promise<number | null> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  const auth = runtimeAuthHeaders(base);
  if (!auth.Authorization) return null;
  const key = `${base} ${model}`;
  const kept = known.get(key);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.slots;
  let slots: number | null = null;
  let answered = false;
  try {
    const root = base.replace(/\/v1$/, "");
    const response = await outboundFetch(`${root}/props?model=${encodeURIComponent(model)}${autoload ? "" : "&autoload=false"}`, { headers: auth, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (response.ok) {
      answered = true;
      const body = (await response.json().catch(() => null)) as { total_slots?: unknown; build_info?: unknown } | null;
      if (body && typeof body.build_info === "string" && typeof body.total_slots === "number" && Number.isInteger(body.total_slots)) slots = body.total_slots;
    } else {
      await response.body?.cancel().catch(() => undefined);
    }
  } catch {
    // not llama.cpp, or not there: no slot named
  }
  // A model not loaded, asked without loading it, says nothing of its
  // slots: not kept, the next call asks again.
  if (answered || autoload) known.set(key, { at: Date.now(), slots });
  return slots;
}

/// Forgets what the runtimes said: the Desktop switched its slots (the
/// message « runtime-slots », index.ts), the server's own runtime started
/// again with others (builtin/manager.ts), tests.
export function forgetRuntimeSlots(): void {
  known.clear();
}

// Whether this computer is shared with someone now, as the Desktop or the
// bridge client last heard it from the account (builtin/slots.ts
// sharedFromGrants), and the Desktop's « Réponses en même temps »: the
// memory a model needs here counts its slots (GET /runtime/catalog, the
// iPhone's screen of this computer).
let sharedHere = false;
let modeHere: SlotsMode = "auto";

export function noteComputeShared(shared: boolean, mode?: SlotsMode): void {
  sharedHere = shared;
  if (mode) modeHere = mode;
}

export function computeSharedHere(): boolean {
  return sharedHere;
}

export function slotsModeHere(): SlotsMode {
  return modeHere;
}
