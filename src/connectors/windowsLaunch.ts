import { existsSync } from "node:fs";
import { win32 } from "node:path";

// How a connector's command starts on Windows, without a shell
// (docs/connectors-security-review.md, residual 1).
//
// `npx`, `npm` and most programs installed with npm are `.cmd` files there:
// Node refuses to start one without a shell (EINVAL), and starting it
// through cmd.exe would hand every argument to cmd's quoting rules, which
// cannot be made safe (« BatBadBut »: `&`, `|`, `%VAR%`, `"` in an argument
// run other commands). So:
//   - the command is looked up on PATH ourselves, never in the current
//     folder (Windows searches it first), with PATHEXT's extensions;
//   - an `.exe` (or `.com`) found is started as it is;
//   - `npx` and `npm` become `node.exe <npm>\bin\npx-cli.js …` — the very
//     script their `.cmd` runs, from the same Node installation (the
//     `node.exe` next to it, else the one on PATH);
//   - any other `.cmd` or `.bat` is refused, with a code the app shows in
//     the person's language;
//   - a command found nowhere on PATH is not started (Windows would look
//     for it in the current folder).
// Twoody ships no Node of its own that could run npm (the Desktop's
// Electron has no npm). Arguments always stay an array. Twoody Code's MCP
// servers start the same way (twoody-desktop src/main/code/windowsLaunch.ts).

export const WINDOWS_SCRIPT_REFUSED = "windows_script_refused";
export const WINDOWS_NODE_NOT_FOUND = "windows_node_not_found";

export type WindowsLaunch =
  | { command: string; args: string[] }
  | { refused: typeof WINDOWS_SCRIPT_REFUSED | typeof WINDOWS_NODE_NOT_FOUND; file: string }
  /// Nowhere on PATH: not looked for in the current folder either.
  | { missing: string };

const NPM_CLIS: Record<string, string> = { npx: "npx-cli.js", npm: "npm-cli.js" };

function envValue(env: Record<string, string | undefined>, name: string): string | undefined {
  const key = Object.keys(env).find((one) => one.toUpperCase() === name);
  return key ? env[key] : undefined;
}

/// Where Windows would find `name`, on PATH only (absolute folders), or
/// at the path given — null when nowhere.
export function findOnWindowsPath(name: string, env: Record<string, string | undefined>, home: string, exists: (path: string) => boolean = existsSync): string | null {
  const extensions = (envValue(env, "PATHEXT") || ".COM;.EXE;.BAT;.CMD").split(";").map((ext) => ext.trim().toLowerCase()).filter((ext) => ext.startsWith("."));
  const hasExtension = win32.extname(name) !== "";
  const candidates = (base: string) => (hasExtension ? [base] : extensions.map((ext) => base + ext));
  if (/[\\/]/.test(name) || win32.isAbsolute(name)) {
    for (const candidate of candidates(win32.resolve(home, name))) if (exists(candidate)) return candidate;
    return null;
  }
  const folders = (envValue(env, "PATH") ?? "").split(";").map((dir) => dir.trim().replace(/^"(.*)"$/, "$1")).filter((dir) => dir && win32.isAbsolute(dir));
  for (const dir of folders) {
    for (const candidate of candidates(win32.join(dir, name))) if (exists(candidate)) return candidate;
  }
  return null;
}

/// What to start for `command args` on Windows (see above).
export function windowsLaunch(command: string, args: string[], env: Record<string, string | undefined>, home: string, exists: (path: string) => boolean = existsSync): WindowsLaunch {
  const found = findOnWindowsPath(command, env, home, exists);
  const extension = found ? win32.extname(found).toLowerCase() : "";
  if (found && (extension === ".exe" || extension === ".com")) return { command: found, args };
  const base = win32.basename(found ?? command, found ? win32.extname(found) : win32.extname(command)).toLowerCase();
  const cli = NPM_CLIS[base];
  if (cli) {
    // The script their .cmd runs, from the installation it belongs to:
    // next to the .cmd (Node's installer, nvm-windows, scoop), else next
    // to the node.exe on PATH (npm updated into %APPDATA%\npm keeps its
    // own node_modules, node stays where Node is).
    const node = (found && [win32.join(win32.dirname(found), "node.exe")].find(exists)) || findOnWindowsPath("node.exe", env, home, exists);
    const scripts = [found, node].filter((one): one is string => !!one).map((file) => win32.join(win32.dirname(file), "node_modules", "npm", "bin", cli));
    const script = scripts.find(exists);
    if (!node || !script) return { refused: WINDOWS_NODE_NOT_FOUND, file: found ?? command };
    return { command: node, args: [script, ...args] };
  }
  if (!found) return { missing: command };
  if (extension === ".cmd" || extension === ".bat") return { refused: WINDOWS_SCRIPT_REFUSED, file: found };
  return { command: found, args };
}
