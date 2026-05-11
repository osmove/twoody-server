// `list_dir` task — list one level of a granted folder.
//
// `sub_path` is appended to the granted root and the resolved absolute
// path is validated against the root to block `..` traversal.

import { readdir, stat as fsStat } from "node:fs/promises";
import { extname, join, normalize, relative } from "node:path";
import { resolveFolder } from "./folders.js";
import { rememberPath } from "./idCache.js";

const MIME_BY_EXT: Record<string, string> = {
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".pdf": "application/pdf",
  ".html": "text/html",
  ".json": "application/json",
  ".csv": "text/csv",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".heic": "image/heic",
};

export async function runListDir(args: Record<string, unknown>) {
  const folderId = String(args.folder_id ?? "");
  const subPath = String(args.sub_path ?? "");
  const folder = resolveFolder(folderId);
  if (!folder) throw new Error("folder_not_granted");

  const targetAbs = normalize(join(folder.path, subPath));
  const relativeToRoot = relative(folder.path, targetAbs);
  if (relativeToRoot.startsWith("..") || relativeToRoot === "..") {
    throw new Error("sub_path_escapes_grant");
  }

  let entries: Array<{ name: string; isFile: boolean; isDir: boolean }> = [];
  try {
    const dirents = await readdir(targetAbs, { withFileTypes: true });
    entries = dirents
      .filter((d) => !d.name.startsWith("."))
      .map((d) => ({ name: d.name, isFile: d.isFile(), isDir: d.isDirectory() }));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`list_failed:${message}`);
  }

  const items = await Promise.all(
    entries.map(async (entry) => {
      const abs = join(targetAbs, entry.name);
      const childSubPath = subPath ? join(subPath, entry.name) : entry.name;
      let size: number | null = null;
      let modifiedAt: string | null = null;
      try {
        const stat = await fsStat(abs);
        size = stat.size;
        modifiedAt = stat.mtime.toISOString();
      } catch {
        // best-effort
      }
      const ext = extname(entry.name).toLowerCase();
      return {
        id: entry.isFile ? rememberPath(abs) : `${folder.id}:${childSubPath}`,
        name: entry.name,
        type: entry.isDir ? "folder" : "file",
        mime: entry.isFile ? MIME_BY_EXT[ext] ?? null : null,
        size: entry.isFile ? size : null,
        modified_at: modifiedAt,
        sub_path: childSubPath,
      };
    }),
  );

  items.sort((a, b) => {
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  return { items, sub_path: subPath, folder_id: folderId };
}
