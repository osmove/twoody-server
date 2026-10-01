import { execFile } from "node:child_process";

// Spotlight, the Mac's own index of the person's files, as one more source
// for the chat (fileListing.ts for names, kinds and dates; retrieval.ts for
// content). Only ever asked about granted folders (`-onlyin`, one per
// folder), and whatever it answers is filtered again by the caller with the
// grant's own rules (walk.ts, folderRisk.ts): Spotlight knows ~/Library,
// hidden folders and every disk, Twoody does not read them.
//
// No shell: mdfind and mdls are run with their arguments as an array, the
// query built from letters and digits only. Each call is given 1.5 s at
// most; one that fails, times out or is not there (Linux, Windows, a Mac
// with Spotlight off or without access to the folder) answers null and the
// caller falls back on the file system.

export const SPOTLIGHT_TIMEOUT_MS = 1_500;
const MAX_OUTPUT = 16 * 1024 * 1024;

/// Runs a command, answers its standard output, or null.
export type SpotlightRunner = (command: "mdfind" | "mdls", args: string[], timeoutMs: number) => Promise<string | null>;

const systemRunner: SpotlightRunner = (command, args, timeoutMs) =>
  new Promise((resolve) => {
    execFile(`/usr/bin/${command}`, args, { timeout: timeoutMs, maxBuffer: MAX_OUTPUT, encoding: "utf8", windowsHide: true }, (error, stdout) => {
      resolve(error ? null : stdout);
    });
  });

let runner: SpotlightRunner | null = null;
let forced: boolean | null = null;

/// Tests: a stand-in for mdfind and mdls, on any system; null puts the real ones back.
export function setSpotlightRunner(next: SpotlightRunner | null): void {
  runner = next;
  forced = next ? true : null;
}

/// Tests: Spotlight on or off whatever the system; null: by the system.
export function setSpotlightEnabled(enabled: boolean | null): void {
  forced = enabled;
}

export function spotlightEnabled(): boolean {
  if (forced !== null) return forced;
  return process.platform === "darwin" && process.env.TWOODY_SPOTLIGHT !== "0";
}

function run(command: "mdfind" | "mdls", args: string[], timeoutMs: number): Promise<string | null> {
  return (runner ?? systemRunner)(command, args, Math.min(timeoutMs, SPOTLIGHT_TIMEOUT_MS)).catch(() => null);
}

/// Paths in mdfind's -0 output.
function paths(stdout: string): string[] {
  return stdout.split("\0").map((p) => p.trim()).filter((p) => p.startsWith("/"));
}

/// Every item Spotlight knows inside `folders`, or null when it cannot say.
export async function spotlightItems(folders: string[], timeoutMs = SPOTLIGHT_TIMEOUT_MS): Promise<string[] | null> {
  if (!spotlightEnabled() || !folders.length) return null;
  const out = await run("mdfind", ["-0", ...folders.flatMap((f) => ["-onlyin", f]), 'kMDItemFSName == "*"'], timeoutMs);
  return out === null ? null : paths(out);
}

/// A term as Spotlight's query language may hold it: letters and digits only.
function safeTerm(term: string): string | null {
  const clean = term.replace(/[^\p{L}\p{N}]/gu, "");
  return clean.length >= 2 ? clean.slice(0, 40) : null;
}

/// The query for one term: a word of the text or of the name starting with
/// it, without case or accents (a word match: a substring one is slow).
function termQuery(term: string): string {
  return `(kMDItemTextContent == "${term}*"cdw || kMDItemDisplayName == "${term}*"cdw)`;
}

/**
 * Files whose content or name Spotlight matches with the terms, inside
 * `folders`: all the terms first, any of them when none has them all.
 * Null when Spotlight cannot say.
 */
export async function spotlightSearch(folders: string[], terms: string[], timeoutMs = SPOTLIGHT_TIMEOUT_MS): Promise<string[] | null> {
  if (!spotlightEnabled() || !folders.length) return null;
  const safe = [...new Set(terms.map(safeTerm).filter((t): t is string => !!t))].slice(0, 4);
  if (!safe.length) return null;
  const where = folders.flatMap((f) => ["-onlyin", f]);
  // Both at once: the time of one.
  const [all, any] = await Promise.all([
    run("mdfind", ["-0", ...where, safe.map(termQuery).join(" && ")], timeoutMs),
    safe.length > 1 ? run("mdfind", ["-0", ...where, safe.map(termQuery).join(" || ")], timeoutMs) : Promise.resolve(null),
  ]);
  if (all === null && any === null) return null;
  const found = paths(all ?? "");
  return found.length ? found : paths(any ?? "");
}

/// When each file arrived where it is (kMDItemDateAdded: the day a download
/// landed in Downloads, whatever date the file itself carries), by path.
export async function spotlightDatesAdded(files: string[], timeoutMs = SPOTLIGHT_TIMEOUT_MS): Promise<Map<string, number>> {
  const dates = new Map<string, number>();
  if (!spotlightEnabled() || !files.length) return dates;
  const out = await run("mdls", ["-raw", "-nullMarker", "", "-name", "kMDItemDateAdded", ...files], timeoutMs);
  if (out === null) return dates;
  const values = out.split("\0");
  files.forEach((file, index) => {
    const value = values[index]?.trim();
    if (!value) return;
    const at = Date.parse(value.replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) ([+-]\d{2})(\d{2})$/, "$1T$2$3:$4"));
    if (!Number.isNaN(at)) dates.set(file, at);
  });
  return dates;
}
