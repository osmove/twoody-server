import { posix, win32 } from "node:path";

// Which folders are never indexed wholesale. Pure, so the tests can hand
// it Windows paths on any system: `real` and `home` are canonical
// (realpath'd) paths of the machine the server runs on.
//
// Everywhere: the root of a disk, the home directory and any folder that
// holds it (it holds everything in it), and anything hidden. On the Mac
// and Linux, the system directories and ~/Library — keychains, mail
// stores, application data. On Windows, its system folders and AppData,
// which is what ~/Library is there; Windows compares paths without case.

export type FolderRisk = "too_broad" | "sensitive";

const POSIX_SYSTEM_ROOTS = ["/System", "/Library", "/private", "/etc", "/usr", "/bin", "/sbin", "/var", "/dev", "/proc", "/sys", "/boot", "/root", "/opt", "/Applications"];
const WINDOWS_SYSTEM_FOLDERS = new Set(["windows", "program files", "program files (x86)", "programdata", "$recycle.bin", "system volume information", "recovery"]);

export function folderRisk(real: string, home: string, platform: NodeJS.Platform = process.platform): FolderRisk | null {
  const windows = platform === "win32";
  const path = windows ? win32 : posix;
  const canonical = (value: string) => (windows ? path.resolve(value).toLowerCase() : path.resolve(value));
  const target = canonical(real);
  const house = canonical(home);
  const root = path.parse(target).root;
  const inside = (parent: string, child: string) => child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

  if (target === root || target === house || inside(target, house)) return "too_broad";
  const segments = target.slice(root.length).split(path.sep).filter(Boolean);
  if (windows ? WINDOWS_SYSTEM_FOLDERS.has(segments[0] ?? "") : POSIX_SYSTEM_ROOTS.some((system) => target === system || inside(system, target))) {
    return "sensitive";
  }
  const underHome = inside(house, target) ? target.slice(house.length).split(path.sep).filter(Boolean) : null;
  if (underHome?.[0] === (windows ? "appdata" : "Library")) return "sensitive";
  if (segments.some((segment) => segment.startsWith("."))) return "sensitive";
  return null;
}
