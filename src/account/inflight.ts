import type { Purpose } from "./status.js";

// Generations running on this computer now, by purpose: what the status
// says (`inflight`) and what the peer endpoint checks before taking one
// more (1 chat + 1 background at a time, docs/multi-computer-design.md §3).

const running: Record<Purpose, number> = { chat: 0, background: 0 };

export const MAX_CONCURRENT: Record<Purpose, number> = { chat: 1, background: 1 };

export function inflight(purpose?: Purpose): number {
  return purpose ? running[purpose] : running.chat + running.background;
}

/// Counts one generation until the returned function is called (once).
export function beginGeneration(purpose: Purpose): () => void {
  running[purpose] += 1;
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    running[purpose] = Math.max(0, running[purpose] - 1);
  };
}

/// Whether one more of this purpose would go past the limit.
export function atCapacity(purpose: Purpose): boolean {
  return running[purpose] >= MAX_CONCURRENT[purpose];
}
