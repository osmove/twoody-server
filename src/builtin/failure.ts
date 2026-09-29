// Why the built-in runtime did not start, as a model screen tells it.
// Ported from twoody-desktop/src/main/runtimeFailure.ts; pure.

/// A missing library is told apart: on Windows it is most often
/// Microsoft's Visual C++ runtime, which not every Windows has.
export interface RuntimeFailure {
  reason: "missing-library" | "exited" | "no-answer";
  exitCode: number | null;
}

/// STATUS_DLL_NOT_FOUND on Windows (as Node reports it, unsigned or not);
/// elsewhere the dynamic loader exits with 127. Killed by a signal (the
/// Mac's loader aborts): it exited. Neither: it ran but never answered.
export function failureOf(exitCode: number | null, platform: NodeJS.Platform = process.platform, signal: string | null = null): RuntimeFailure {
  if (exitCode === null) return { reason: signal ? "exited" : "no-answer", exitCode };
  const missing = platform === "win32" ? exitCode === 0xc0000135 || exitCode === 0xc0000135 - 2 ** 32 : exitCode === 127;
  return { reason: missing ? "missing-library" : "exited", exitCode };
}
