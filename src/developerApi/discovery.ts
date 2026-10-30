import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

// Where a program of this machine finds this server (docs/developer-api-design.md
// §2): ~/.twoody/local-server.json, written once the server listens, removed
// when it stops. The `twoody` command reads it before trying the usual
// ports (47821 for Twoody Desktop, 3000 for `twoody serve`).
//
//   { "url": "http://127.0.0.1:47821", "api": "http://127.0.0.1:47821/v1",
//     "kind": "desktop" | "server", "pid": 123, "version": "0.2.0", "started_at": "…" }
//
// Twoody Desktop's server wins: a `twoody serve` started while the Desktop's
// is alive leaves the file to it. TWOODY_DISCOVERY_FILE moves it (the bench's
// fake home), « off » writes none.

export type ServerKind = "desktop" | "server";

export interface Discovery {
  url: string;
  api: string;
  kind: ServerKind;
  pid: number;
  version: string;
  started_at: string;
}

export function discoveryPath(): string | null {
  const configured = process.env.TWOODY_DISCOVERY_FILE?.trim();
  if (configured === "off") return null;
  return configured || join(homedir(), ".twoody", "local-server.json");
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readDiscovery(path = discoveryPath()): Discovery | null {
  if (!path || !existsSync(path)) return null;
  try {
    const value = JSON.parse(readFileSync(path, "utf8")) as Discovery;
    return typeof value.url === "string" && typeof value.pid === "number" ? value : null;
  } catch {
    return null;
  }
}

/// Says where this server is. False when the file was left to a live Desktop.
export function writeDiscovery(port: number, kind: ServerKind, version: string, path = discoveryPath()): boolean {
  if (!path) return false;
  const current = readDiscovery(path);
  if (current && current.pid !== process.pid && current.kind === "desktop" && kind !== "desktop" && alive(current.pid)) return false;
  const url = `http://127.0.0.1:${port}`;
  const value: Discovery = { url, api: `${url}/v1`, kind, pid: process.pid, version, started_at: new Date().toISOString() };
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temp, path);
    return true;
  } catch {
    return false;
  }
}

/// Removes the file when it is still this process's.
export function clearDiscovery(path = discoveryPath()): void {
  if (!path) return;
  if (readDiscovery(path)?.pid !== process.pid) return;
  try {
    rmSync(path, { force: true });
  } catch {
    // Best-effort: the `twoody` command checks /health anyway.
  }
}
