import { randomUUID } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// The server's own crash reports (04/10/2026): an exception nothing caught
// — the process is about to end — is written down, synchronously, as one
// file in TWOODY_CRASH_DIR, where Twoody Desktop gathers its own
// (twoody-desktop src/main/crashReports.ts) and, with the diagnostics on,
// sends them after taking paths and quoted text out. Run headless (a
// Raspberry Pi), the file stays in the data folder's crash-reports/pending.
// Imported first by index.ts, so it watches from the start.

const MAX_PENDING = 50;
const MAX_PER_RUN = 5;
let written = 0;

export function crashDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.TWOODY_CRASH_DIR?.trim() || join(env.TWOODY_DATA_DIR?.trim() || join(homedir(), ".twoody", "data"), "crash-reports", "pending");
}

export function recordServerCrash(error: unknown, origin: string, dir = crashDir()): string | null {
  try {
    if (written >= MAX_PER_RUN) return null;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (readdirSync(dir).length >= MAX_PENDING) return null;
    written += 1;
    const id = randomUUID();
    const parts = error instanceof Error
      ? { name: error.name, message: error.message, stack: error.stack }
      : { name: "NonError", message: typeof error === "string" ? error : typeof error };
    const report = { id, kind: "server_exception", occurred_at: new Date().toISOString(), process: "server", error: parts, details: { origin } };
    const path = join(dir, `${Date.now()}-${id}.json`);
    writeFileSync(path, JSON.stringify(report), { mode: 0o600 });
    return path;
  } catch {
    // Failing to write it down must not hide the failure itself.
    return null;
  }
}

process.on("uncaughtExceptionMonitor", (error, origin) => {
  recordServerCrash(error, origin);
});
