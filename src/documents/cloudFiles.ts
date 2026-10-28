import { spawn, execFile } from "node:child_process";
import { access, constants } from "node:fs/promises";

// Files only online (Jimmy, 28/10/2026, for Namestorm: project folders in
// OneDrive under Windows). OneDrive's « Fichiers à la demande », iCloud
// Drive's « Optimiser le stockage » and the other cloud syncs keep on the
// computer, for some files, only their name, size and date: reading one makes
// the system fetch it from the cloud. Indexing a folder of them would download
// it whole, gigabytes perhaps, without a word. The index pass asks here first
// which of the files it is about to read are only online, and leaves them
// unread (`documents.status` « online_only ») unless the person chose, for the
// folder, to have them downloaded and read (`document_folders.cloud_files`).
//
// Nothing is read to tell: on Windows, the files' attributes, from the
// Desktop's helper (TWOODY_FILES_BIN, twoody-desktop native/twoody-files-win:
// GetFileAttributesW, a line per path); on a Mac, the files' flags from
// /usr/bin/stat (SF_DATALESS). Elsewhere, or without the helper: none.

/// FILE_ATTRIBUTE_RECALL_ON_DATA_ACCESS, FILE_ATTRIBUTE_RECALL_ON_OPEN and
/// FILE_ATTRIBUTE_OFFLINE: the content is not (all) on this PC.
export const WINDOWS_ONLINE_ONLY = 0x400000 | 0x40000 | 0x1000;
/// SF_DATALESS (sys/stat.h): a file whose content the File Provider fetches.
export const MAC_DATALESS = 0x40000000;
const CHUNK = 400;
const TIMEOUT_MS = 60_000;

type Finder = (paths: string[]) => Promise<Set<string>>;
let finder: Finder | null = null;

/// Tests stand in for the system (null: the system's again).
export function setOnlineOnlyForTests(fake: Finder | null): void {
  finder = fake;
}

export async function onlineOnly(paths: string[], platform: NodeJS.Platform = process.platform): Promise<Set<string>> {
  if (paths.length === 0) return new Set();
  if (finder) return finder(paths);
  try {
    if (platform === "win32") return await windowsOnlineOnly(paths);
    if (platform === "darwin") return await macOnlineOnly(paths);
  } catch (err) {
    console.warn(`[cloud files] ${(err as Error).message}`);
  }
  return new Set();
}

async function windowsOnlineOnly(paths: string[]): Promise<Set<string>> {
  const bin = process.env.TWOODY_FILES_BIN;
  if (!bin) return new Set();
  await access(bin, constants.F_OK);
  const out = await new Promise<string>((resolve, reject) => {
    const child = spawn(bin, [], { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] });
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => child.kill(), TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(Buffer.concat(chunks).toString("utf8"));
      else reject(new Error(`twoody-files exited with ${code}`));
    });
    child.stdin.end(paths.map((path) => path.replace(/[\r\n]/g, "")).join("\n") + "\n");
  });
  return windowsFromLines(paths, out);
}

/// The helper's lines, one per path in the same order.
export function windowsFromLines(paths: string[], out: string): Set<string> {
  const lines = out.split(/\r?\n/);
  const found = new Set<string>();
  paths.forEach((path, index) => {
    const attributes = Number(lines[index]);
    if (Number.isFinite(attributes) && attributes >= 0 && (attributes & WINDOWS_ONLINE_ONLY) !== 0) found.add(path);
  });
  return found;
}

async function macOnlineOnly(paths: string[]): Promise<Set<string>> {
  const found = new Set<string>();
  for (let start = 0; start < paths.length; start += CHUNK) {
    const chunk = paths.slice(start, start + CHUNK);
    // « flags<TAB>path »: a file gone meanwhile is left out by stat, so the
    // lines are matched by their path, never by their order.
    const out = await new Promise<string>((resolve) => {
      execFile("/usr/bin/stat", ["-f", "%f\t%N", "--", ...chunk], { timeout: TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024 }, (_error, stdout) => resolve(String(stdout ?? "")));
    });
    for (const path of macFromLines(chunk, out)) found.add(path);
  }
  return found;
}

export function macFromLines(paths: string[], out: string): Set<string> {
  const wanted = new Set(paths);
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab < 0) continue;
    const flags = Number(line.slice(0, tab));
    const path = line.slice(tab + 1);
    if (wanted.has(path) && Number.isFinite(flags) && (flags & MAC_DATALESS) !== 0) found.add(path);
  }
  return found;
}
