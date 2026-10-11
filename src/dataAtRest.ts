import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// Whether this server's data folder (DATA_DIR: its database, its keys, the
// vault's copies) is on an encrypted volume.
//
// Twoody Server on its own — a Raspberry Pi, a NAS — keeps its keys in
// 0600 files: there is no one at boot to unlock a keyring, and a key kept
// next to what it protects protects nothing. What does protect them, if
// the disk or the SD card is taken, is the volume being encrypted
// (docs/encrypted-storage.md). This says whether it is, so that the
// person is told when it is not: in the log at start, in /health, and in
// the status the person's other computers read (« Appareils » in Twoody
// Desktop). It never says more than it knows: "unknown" when it cannot tell.
//
// Linux: the mount holding the folder (/proc/self/mountinfo), then its
// block device in /sys: dm-crypt (LUKS) anywhere below it, every branch of
// it, counts; so do ecryptfs, gocryptfs and the like, and fscrypt on the
// folder itself (lsattr's "E"). macOS: FileVault on the volume (diskutil).
// Elsewhere: unknown.

export type DataAtRest = "encrypted" | "not_encrypted" | "unknown";

export interface AtRestDeps {
  platform: NodeJS.Platform;
  readFile(path: string): string;
  readdir(path: string): string[];
  realpath(path: string): string;
  exists(path: string): boolean;
  /// Runs a program, returns its output (throws when it fails).
  run(file: string, args: string[]): string;
}

const realDeps: AtRestDeps = {
  platform: process.platform,
  readFile: (path) => readFileSync(path, "utf8"),
  readdir: (path) => readdirSync(path),
  realpath: (path) => realpathSync(path),
  exists: (path) => existsSync(path),
  run: (file, args) => execFileSync(file, args, { encoding: "utf8", timeout: 5_000, stdio: ["ignore", "pipe", "ignore"] }),
};

const ENCRYPTED_FILESYSTEMS = new Set(["ecryptfs", "fuse.gocryptfs", "fuse.encfs", "fuse.cryfs", "fuse.securefs"]);

/// The folder itself, or its nearest parent that exists (a volume not
/// mounted yet: the folder is then on whatever holds the mount point).
function existingPath(path: string, deps: AtRestDeps): string {
  let current = path;
  while (!deps.exists(current) && dirname(current) !== current) current = dirname(current);
  try {
    return deps.realpath(current);
  } catch {
    return current;
  }
}

/// "\040" and the like, as mountinfo writes spaces, tabs and backslashes.
function unescapeMount(field: string): string {
  return field.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8)));
}

interface Mount {
  point: string;
  device: string;
  fstype: string;
  source: string;
}

/// The mount that holds `path`: the longest mount point it is under.
export function mountOf(path: string, mountinfo: string): Mount | null {
  let best: Mount | null = null;
  for (const line of mountinfo.split("\n")) {
    const [left, right] = line.split(" - ");
    if (!left || !right) continue;
    const fields = left.split(" ");
    const [fstype, source] = right.split(" ");
    const point = unescapeMount(fields[4] ?? "");
    if (!point || !fstype) continue;
    const under = point === "/" || path === point || path.startsWith(`${point}/`);
    // A later line for the same point is a mount on top of the earlier one.
    if (under && (!best || point.length >= best.point.length)) best = { point, device: fields[2] ?? "", fstype, source: unescapeMount(source ?? "") };
  }
  return best;
}

/// Whether the block device at /sys/class/block/<name> is dm-crypt, or
/// built only on dm-crypt devices (LVM on LUKS, RAID of LUKS members).
function blockEncrypted(dir: string, deps: AtRestDeps, depth = 0): boolean {
  if (depth > 8) return false;
  try {
    if (deps.readFile(join(dir, "dm", "uuid")).trim().startsWith("CRYPT-")) return true;
  } catch {
    // Not a device-mapper device.
  }
  let slaves: string[] = [];
  try {
    slaves = deps.readdir(join(dir, "slaves"));
  } catch {
    slaves = [];
  }
  return slaves.length > 0 && slaves.every((name) => blockEncrypted(join("/sys/class/block", name), deps, depth + 1));
}

function linux(path: string, deps: AtRestDeps): DataAtRest {
  let mountinfo: string;
  try {
    mountinfo = deps.readFile("/proc/self/mountinfo");
  } catch {
    return "unknown";
  }
  const mount = mountOf(path, mountinfo);
  if (!mount) return "unknown";
  if (ENCRYPTED_FILESYSTEMS.has(mount.fstype)) return "encrypted";
  // fscrypt: the folder (or a parent) is encrypted on an ordinary disk.
  if (mount.fstype === "ext4" || mount.fstype === "f2fs") {
    try {
      const flags = deps.run("lsattr", ["-d", path]).trim().split(/\s+/)[0] ?? "";
      if (flags.includes("E")) return "encrypted";
    } catch {
      // No lsattr: the block device below decides.
    }
  }
  // The block device: by its numbers, or (btrfs, which shows anonymous
  // ones) by the device named as the source.
  const candidates: string[] = [];
  const [major] = mount.device.split(":");
  if (major && major !== "0") candidates.push(join("/sys/dev/block", mount.device));
  if (mount.source.startsWith("/dev/")) {
    try {
      candidates.push(join("/sys/class/block", basename(deps.realpath(mount.source))));
    } catch {
      // Gone, or not readable.
    }
  }
  const found = candidates.find((candidate) => deps.exists(candidate));
  if (!found) return "unknown";
  let dir = found;
  try {
    dir = deps.realpath(found);
  } catch {
    // The link itself will do.
  }
  return blockEncrypted(dir, deps) ? "encrypted" : "not_encrypted";
}

function mac(path: string, deps: AtRestDeps): DataAtRest {
  try {
    const df = deps.run("/bin/df", ["-P", path]).trim().split("\n").pop() ?? "";
    const point = df.split(/\s+/).slice(5).join(" ");
    if (!point.startsWith("/")) return "unknown";
    const info = deps.run("/usr/sbin/diskutil", ["info", "-plist", point]);
    const vault = /<key>FileVault<\/key>\s*<(true|false)\/>/.exec(info);
    if (!vault) return "unknown";
    return vault[1] === "true" ? "encrypted" : "not_encrypted";
  } catch {
    return "unknown";
  }
}

export function checkDataAtRest(dataDir: string, deps: AtRestDeps = realDeps): DataAtRest {
  const path = existingPath(dataDir, deps);
  if (deps.platform === "linux") return linux(path, deps);
  if (deps.platform === "darwin") return mac(path, deps);
  return "unknown";
}

let cached: DataAtRest | null = null;

/// This server's DATA_DIR, looked at once per run.
export function dataAtRest(dataDir: string): DataAtRest {
  cached ??= checkDataAtRest(dataDir);
  return cached;
}

/// TWOODY_DATA_ENCRYPTION=require: a server that must not write its keys
/// anywhere but on an encrypted volume refuses to start otherwise — for
/// instance when that volume is not mounted yet and the folder would be
/// made on the card underneath. Null when it may start.
export function refusalToStart(env: NodeJS.ProcessEnv, dataDir: string, deps: AtRestDeps = realDeps): string | null {
  if (env.TWOODY_DATA_ENCRYPTION !== "require") return null;
  const state = checkDataAtRest(dataDir, deps);
  if (state === "encrypted") return null;
  return state === "not_encrypted"
    ? `TWOODY_DATA_ENCRYPTION=require, and ${dataDir} is not on an encrypted volume (is it mounted?). See docs/encrypted-storage.md.`
    : `TWOODY_DATA_ENCRYPTION=require, and whether ${dataDir} is on an encrypted volume cannot be told on this system. See docs/encrypted-storage.md.`;
}
