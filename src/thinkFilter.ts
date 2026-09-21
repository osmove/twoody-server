// Reasoning models (Qwen3, DeepSeek-R1 distills, …) open their reply
// with a `<think>…</think>` block when the runtime doesn't separate
// reasoning from content. The chat UI should only show the answer, so
// this filter drops that leading block from a stream of deltas.
//
// Only a block at the very start of the reply is treated as reasoning:
// once real text has been emitted, a literal `<think>` (say, in an
// answer about HTML) passes through untouched.

const OPEN = "<think>";
const CLOSE = "</think>";

export function createThinkFilter(emit: (text: string) => void): {
  push(delta: string): void;
  flush(): void;
} {
  let state: "start" | "thinking" | "answer" = "start";
  let pending = "";
  // The blank lines models put after `</think>` may arrive in a later
  // delta than the tag itself.
  let skipLeadingSpace = false;

  const emitAnswer = (text: string) => {
    const out = skipLeadingSpace ? text.replace(/^\s+/, "") : text;
    if (!out) return;
    skipLeadingSpace = false;
    emit(out);
  };

  const push = (delta: string) => {
    if (state === "answer") {
      emitAnswer(delta);
      return;
    }
    pending += delta;

    if (state === "start") {
      const trimmed = pending.trimStart();
      if (trimmed.startsWith(OPEN)) {
        state = "thinking";
        pending = trimmed.slice(OPEN.length);
      } else if (OPEN.startsWith(trimmed)) {
        // Could still turn into `<think>` — wait for the next delta.
        return;
      } else {
        state = "answer";
        // Runtimes that strip the reasoning themselves (mlx-lm streams
        // it in a separate field) still leave the blank lines that
        // followed it. Indentation on the first real line is kept.
        emitAnswer(pending.replace(/^(?:[^\S\n]*\n)+/, ""));
        pending = "";
        return;
      }
    }

    const end = pending.indexOf(CLOSE);
    if (end === -1) {
      // Keep only what could be the start of a split closing tag.
      pending = pending.slice(-(CLOSE.length - 1));
      return;
    }
    const rest = pending.slice(end + CLOSE.length);
    pending = "";
    state = "answer";
    skipLeadingSpace = true;
    emitAnswer(rest);
  };

  const flush = () => {
    // An unterminated block is all reasoning; a pending prefix that
    // never became a tag (e.g. a reply that is just "<") is real text.
    if (state === "start" && pending) emit(pending);
    pending = "";
  };

  return { push, flush };
}
