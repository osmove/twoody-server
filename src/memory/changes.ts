import { sqlite } from "../db.js";
import { inflight } from "../account/inflight.js";
import { dropVectorsIfSwitchedOff, embedPendingMemories, invalidateMemoryVectors, memoryEmbeddingsEnabled } from "./embeddings.js";
import { ensureLinked, markLinksStale } from "./entities.js";

// What follows a change of the memories (docs/memory-v2-design.md §3):
// the vectors' cache is dropped at once; the links to the entities and the
// vectors themselves are worked out a moment later, together for a burst
// of writes (an import writes one memory at a time), and the vectors only
// while the computer generates nothing — a chat turn goes first.

const SOON_MS = 1_500;
const BUSY_RETRY_MS = 5_000;
const pending = new Set<string>();
let timer: NodeJS.Timeout | null = null;
let running = false;

function schedule(ms: number) {
  if (timer || running) return;
  timer = setTimeout(() => {
    timer = null;
    void run();
  }, ms);
  timer.unref?.();
}

async function run() {
  running = true;
  let busy = false;
  try {
    for (const userId of [...pending]) {
      pending.delete(userId);
      try {
        ensureLinked(userId);
      } catch {
        /* the links are worked out again at the next change */
      }
      if (!memoryEmbeddingsEnabled(userId)) {
        dropVectorsIfSwitchedOff(userId);
        continue;
      }
      if (inflight() > 0) {
        pending.add(userId);
        busy = true;
        continue;
      }
      const result = await embedPendingMemories(userId).catch(() => null);
      if (result?.yielded) {
        pending.add(userId);
        busy = true;
      }
    }
  } finally {
    running = false;
  }
  if (pending.size) schedule(busy ? BUSY_RETRY_MS : SOON_MS);
}

const listeners = new Set<(userId: string) => void>();

/// Told when a person's memories change (the chat reads ahead the next new
/// conversation's start, routes/queries.ts).
export function onMemoriesChanged(listener: (userId: string) => void) {
  listeners.add(listener);
}

/// This person's memories changed here: written, deleted, or brought by a
/// vault sync. Never throws.
export function memoriesChanged(userId: string | null | undefined) {
  if (!userId) return;
  for (const listener of listeners) {
    try {
      listener(userId);
    } catch {
      /* a listener never stops a memory */
    }
  }
  try {
    invalidateMemoryVectors(userId);
    markLinksStale(userId);
    pending.add(userId);
    schedule(SOON_MS);
  } catch {
    /* a memory is kept whatever its vectors */
  }
}

/// At start: every person's memories looked at once, a while after boot
/// (what was written before the vectors existed gets them).
export function startMemoryWork(options: { delayMs?: number } = {}) {
  const boot = setTimeout(() => {
    for (const { id } of sqlite.prepare("SELECT id FROM users").all() as Array<{ id: string }>) memoriesChanged(id);
  }, options.delayMs ?? 20_000);
  boot.unref?.();
  return {
    stop() {
      clearTimeout(boot);
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}

/// Runs what is pending now (tests).
export async function flushMemoryWork() {
  if (timer) clearTimeout(timer);
  timer = null;
  while (running) await new Promise((resolve) => setTimeout(resolve, 10));
  await run();
}
