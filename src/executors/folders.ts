// Grant model for the in-process bridge executor.
//
// On macOS the Mac Bridge picked folders via NSOpenPanel and stored
// security-scoped bookmarks. A headless Linux deployment can't open a
// dialog, so the operator declares granted folders via
// `TWOODY_BRIDGE_FOLDERS`.
//
// Accepted forms:
//   /home/pi/Documents:/srv/share              (colon-separated)
//   /home/pi/Documents,/srv/share              (comma-separated)
//   ["/home/pi/Documents","/srv/share"]        (JSON array)
//
// Optional `name=` prefix gives the folder a friendly label:
//   TWOODY_BRIDGE_FOLDERS="Documents=/home/pi/Documents:Media=/srv/share"

import { createHash } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";

export interface GrantedFolder {
  id: string;
  name: string;
  path: string;
}

const SYSTEM_SENSITIVE = [
  "/etc",
  "/root",
  "/boot",
  "/proc",
  "/sys",
  "/dev",
  "/.ssh",
  "/.aws",
  "/.gnupg",
];

function looksSensitive(absolute: string): boolean {
  return SYSTEM_SENSITIVE.some(
    (prefix) => absolute === prefix || absolute.startsWith(prefix + "/"),
  );
}

function parseSpec(raw: string): Array<{ label?: string; path: string }> {
  const trimmed = raw.trim();
  if (!trimmed) return [];
  if (trimmed.startsWith("[")) {
    try {
      const arr = JSON.parse(trimmed) as unknown;
      if (Array.isArray(arr)) {
        return arr
          .map((value) => {
            if (typeof value === "string") return { path: value };
            if (value && typeof value === "object" && "path" in value) {
              const v = value as { name?: unknown; path: unknown };
              return {
                label: typeof v.name === "string" ? v.name : undefined,
                path: String(v.path),
              };
            }
            return null;
          })
          .filter((v): v is { label?: string; path: string } => v !== null);
      }
    } catch {
      // fall through to delimiter parsing
    }
  }
  const delimiter = trimmed.includes(":") ? ":" : ",";
  return trimmed
    .split(delimiter)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((entry) => {
      const eq = entry.indexOf("=");
      if (eq > 0) {
        return { label: entry.slice(0, eq).trim(), path: entry.slice(eq + 1).trim() };
      }
      return { path: entry };
    });
}

function folderId(absolutePath: string): string {
  return "fld_" + createHash("sha1").update(absolutePath).digest("hex").slice(0, 16);
}

let cache: GrantedFolder[] | null = null;
let cacheKey: string | null = null;

export function grantedFolders(): GrantedFolder[] {
  const raw = process.env.TWOODY_BRIDGE_FOLDERS ?? "";
  if (raw === cacheKey && cache) return cache;

  const parsed = parseSpec(raw);
  const folders: GrantedFolder[] = [];
  for (const entry of parsed) {
    const absolute = resolve(entry.path);
    if (looksSensitive(absolute)) continue;
    if (!existsSync(absolute)) continue;
    const stat = statSync(absolute);
    if (!stat.isDirectory()) continue;
    folders.push({
      id: folderId(absolute),
      name: entry.label && entry.label.length > 0 ? entry.label : basename(absolute) || absolute,
      path: absolute,
    });
  }

  cache = folders;
  cacheKey = raw;
  return folders;
}

export function resolveFolder(id: string): GrantedFolder | null {
  return grantedFolders().find((f) => f.id === id) ?? null;
}

/** True if the absolute path lives under any granted folder. */
export function isUnderGrant(absolute: string): boolean {
  const folders = grantedFolders();
  return folders.some(
    (f) => absolute === f.path || absolute.startsWith(f.path + "/"),
  );
}

/** Pick the granted folder that contains the absolute path, or null. */
export function findOwningGrant(absolute: string): GrantedFolder | null {
  for (const f of grantedFolders()) {
    if (absolute === f.path || absolute.startsWith(f.path + "/")) return f;
  }
  return null;
}
