// A guest's warm (18/10/2026): someone this computer is shared with opens
// their conversation with it, or starts typing, and their phone sends a
// sealed « warm » (twoody-app utils/sharedTurn.js) — the conversation so far
// and an empty last message. Opened like a question and answered at once,
// empty (computeHost.ts); what it asks is read here, if allowed, so that
// the question finds the model awake and the conversation already read: the
// runtime keeps a checkpoint at the start of that last message and goes
// back to it (llama.cpp's hybrid models, Qwen3.5), reading only the
// question then.
//
// Measured on the bench's real model (twoody-bench
// scripts/shared-compute-bench.mts, see AGENTS.md §5): the runtime asleep,
// the model loads again in 1 to 2.3 s and reads everything from nothing;
// the conversation going on, the next question reads only itself instead of
// the whole last answer. On a computer with two slots (shared, 24 GB or
// more: builtin/slots.ts) the warm is read on the guests' slot, where the
// question will come — never on the owner's (bridgeClient.ts, `guest`).
//
// What a guest may make this computer do with it (AGENTS.md rule 12, the
// account taken as possibly malicious; test/guestWarm.test.ts):
//   - never load a model: only the one the runtime holds now, awake or
//     asleep, is read for (`held`); another one, or none, is skipped;
//   - never more than a question could: the same bounded messages
//     (computeHost.ts bareCompletion), one token written, no tools, no
//     reasoning;
//   - never often: one warm per grant every WARM_EVERY_MS at most, none
//     while a turn of that grant runs, one at a time on this computer — the
//     rest skipped, never queued;
//   - nothing learned: the guest's answer is the same whatever happens here
//     (computeHost.ts), and nothing of it is kept or logged but the outcome.

/// The shortest time between two warms of one grant read here.
export const WARM_EVERY_MS = 15_000;

export type WarmOutcome = "warmed" | "busy" | "turn" | "rate" | "not_held" | "failed";

export interface GuestWarmer {
  /// A warm opened for this grant (warmCompletion's body): read now if
  /// allowed. Never throws; resolves with what was done (for tests and the
  /// log), and is never awaited by the guest's answer.
  request(grantId: string, body: Record<string, unknown>): Promise<WarmOutcome>;
  /// A question of this grant starts; call the function returned when it
  /// ends. A warm is skipped meanwhile: the question reads what it needs.
  turnStarted(grantId: string): () => void;
}

export function createGuestWarmer({
  run,
  held,
  now = Date.now,
  log,
}: {
  /// Runs the completion (llm_infer), its answer discarded.
  run: (body: Record<string, unknown>) => Promise<unknown>;
  /// Whether the runtime holds this model now, loaded or asleep: never
  /// true for a model it would have to load.
  held: (model: unknown) => Promise<boolean>;
  now?: () => number;
  log?: (grantId: string, outcome: WarmOutcome) => void;
}): GuestWarmer {
  const lastAt = new Map<string, number>();
  const turns = new Map<string, number>();
  let running = false;

  async function request(grantId: string, body: Record<string, unknown>): Promise<WarmOutcome> {
    const outcome = await decide(grantId, body);
    log?.(grantId, outcome);
    return outcome;
  }

  async function decide(grantId: string, body: Record<string, unknown>): Promise<WarmOutcome> {
    if (running) return "busy";
    if ((turns.get(grantId) ?? 0) > 0) return "turn";
    const at = now();
    const last = lastAt.get(grantId);
    if (last !== undefined && at - last < WARM_EVERY_MS) return "rate";
    // Counted before anything is asked of the runtime: a warm that is then
    // skipped still waits its turn, so the runtime's state cannot be
    // probed faster than a warm may run.
    lastAt.set(grantId, at);
    running = true;
    try {
      if (!(await held(body.model).catch(() => false))) return "not_held";
      await run(body);
      return "warmed";
    } catch {
      return "failed";
    } finally {
      running = false;
    }
  }

  function turnStarted(grantId: string): () => void {
    turns.set(grantId, (turns.get(grantId) ?? 0) + 1);
    let ended = false;
    return () => {
      if (ended) return;
      ended = true;
      const left = (turns.get(grantId) ?? 1) - 1;
      if (left > 0) turns.set(grantId, left);
      else turns.delete(grantId);
    };
  }

  return { request, turnStarted };
}
