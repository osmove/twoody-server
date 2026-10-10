import assert from "node:assert/strict";
import test from "node:test";
import { launchFor } from "../src/connectors/mcpClient.js";
import { windowsLaunch } from "../src/connectors/windowsLaunch.js";

// How a connector's command starts on Windows without a shell
// (src/connectors/windowsLaunch.ts): on simulated Windows folders, since
// these tests run on macOS too. What was not run on a real Windows machine
// is said in docs/connectors-security-review.md.

const HOME = "C:\\Users\\jimmy";
const NODEJS = "C:\\Program Files\\nodejs";
const APPDATA_NPM = "C:\\Users\\jimmy\\AppData\\Roaming\\npm";

/// A Windows disk: these files, names compared as Windows does (any case).
const disk = (...files: string[]) => {
  const set = new Set(files.map((file) => file.toLowerCase()));
  return (path: string) => set.has(path.toLowerCase());
};
const nodeInstall = [`${NODEJS}\\node.exe`, `${NODEJS}\\npx.cmd`, `${NODEJS}\\npm.cmd`, `${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, `${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js`];
// Windows writes it « Path »; PATHEXT as it comes.
const env = (path: string) => ({ Path: path, PATHEXT: ".COM;.EXE;.BAT;.CMD;.VBS;.JS;.WSF;.MSC" });

test("npx from Node's installer: node.exe runs npm's npx script, every argument as it is", () => {
  const args = ["-y", "@modelcontextprotocol/server-filesystem", "C:\\Users\\jimmy\\Documents"];
  assert.deepEqual(windowsLaunch("npx", args, env(`${NODEJS};C:\\Windows\\system32`), HOME, disk(...nodeInstall)), {
    command: `${NODEJS}\\node.exe`,
    args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, ...args],
  });
  assert.deepEqual(windowsLaunch("npm", ["exec", "pkg"], env(NODEJS), HOME, disk(...nodeInstall)), {
    command: `${NODEJS}\\node.exe`,
    args: [`${NODEJS}\\node_modules\\npm\\bin\\npm-cli.js`, "exec", "pkg"],
  });
  // Written with its extension, or its whole path: the same.
  assert.deepEqual(windowsLaunch("npx.cmd", ["pkg"], env(NODEJS), HOME, disk(...nodeInstall)), { command: `${NODEJS}\\node.exe`, args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, "pkg"] });
  assert.deepEqual(windowsLaunch(`${NODEJS}\\npx.cmd`, ["pkg"], env(""), HOME, disk(...nodeInstall)), { command: `${NODEJS}\\node.exe`, args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, "pkg"] });
});

test("npm updated into AppData: its own npx script, the node.exe on PATH", () => {
  const files = [...nodeInstall, `${APPDATA_NPM}\\npx.cmd`, `${APPDATA_NPM}\\node_modules\\npm\\bin\\npx-cli.js`];
  assert.deepEqual(windowsLaunch("npx", ["pkg"], env(`${APPDATA_NPM};${NODEJS}`), HOME, disk(...files)), {
    command: `${NODEJS}\\node.exe`,
    args: [`${APPDATA_NPM}\\node_modules\\npm\\bin\\npx-cli.js`, "pkg"],
  });
});

test("node, uvx, docker or a Volta npx.exe: the .exe found on PATH, by its full path", () => {
  const files = [...nodeInstall, `${HOME}\\.local\\bin\\uvx.exe`, "C:\\Program Files\\Volta\\npx.exe"];
  assert.deepEqual(windowsLaunch("node", ["server.js"], env(NODEJS), HOME, disk(...files)), { command: `${NODEJS}\\node.exe`, args: ["server.js"] });
  assert.deepEqual(windowsLaunch("uvx", ["mcp-server-git"], env(`${NODEJS};${HOME}\\.local\\bin`), HOME, disk(...files)), { command: `${HOME}\\.local\\bin\\uvx.exe`, args: ["mcp-server-git"] });
  assert.deepEqual(windowsLaunch("npx", ["pkg"], env(`C:\\Program Files\\Volta;${NODEJS}`), HOME, disk(...files)), { command: "C:\\Program Files\\Volta\\npx.exe", args: ["pkg"] });
});

test("attack: any other .cmd or .bat is refused, never handed to cmd.exe", () => {
  const files = [...nodeInstall, `${APPDATA_NPM}\\pnpm.cmd`, "C:\\tools\\run.bat", "C:\\tools\\Start.CMD"];
  for (const [command, file] of [["pnpm", `${APPDATA_NPM}\\pnpm.cmd`], ["C:\\tools\\run.bat", "C:\\tools\\run.bat"], ["C:\\tools\\start", "C:\\tools\\Start.CMD"]] as const) {
    const launch = windowsLaunch(command, ["&", "calc"], env(`${APPDATA_NPM};${NODEJS}`), HOME, disk(...files));
    assert.equal("refused" in launch && launch.refused, "windows_script_refused", command);
    assert.equal("refused" in launch && launch.file.toLowerCase(), file.toLowerCase());
  }
  assert.throws(() => launchFor("pnpm", ["dlx", "pkg"], env(APPDATA_NPM), "win32", disk(...files)), /^Error: windows_script_refused: /);
});

test("attack: cmd.exe's syntax in an argument stays an argument of node, cmd.exe is never what starts", () => {
  const hostile = ["-y", "pkg", "&", "calc.exe", "a\" & del /q C:\\*", "%COMSPEC%", "^&", "|whoami", "$(id)"];
  const launch = windowsLaunch("npx", hostile, env(NODEJS), HOME, disk(...nodeInstall));
  assert.ok("command" in launch);
  assert.equal(launch.command, `${NODEJS}\\node.exe`);
  assert.deepEqual(launch.args.slice(1), hostile);
  assert.doesNotMatch(launch.command, /cmd(\.exe)?$/i);
});

test("attack: the current folder and relative PATH entries are not searched — a planted node.exe or npx.exe does not run", () => {
  const files = [...nodeInstall, `${HOME}\\npx.exe`, `${HOME}\\node.exe`, `${HOME}\\evil.exe`, `${HOME}\\bin\\node.exe`];
  assert.deepEqual(windowsLaunch("evil", [], env(NODEJS), HOME, disk(...files)), { missing: "evil" });
  assert.deepEqual(windowsLaunch("node", [], env(`.;bin;${NODEJS}`), HOME, disk(...files)), { command: `${NODEJS}\\node.exe`, args: [] });
  assert.deepEqual(windowsLaunch("npx", ["pkg"], env(`.;${NODEJS}`), HOME, disk(...files)), { command: `${NODEJS}\\node.exe`, args: [`${NODEJS}\\node_modules\\npm\\bin\\npx-cli.js`, "pkg"] });
  assert.throws(() => launchFor("evil", [], env(NODEJS), "win32", disk(...files)), /not found: evil/);
});

test("npx without Node: said as such", () => {
  assert.deepEqual(windowsLaunch("npx", ["pkg"], env("C:\\Windows\\system32"), HOME, disk()), { refused: "windows_node_not_found", file: "npx" });
  // A .cmd with no npm script beside it nor beside a node.exe.
  assert.deepEqual(windowsLaunch("npx", ["pkg"], env("C:\\odd"), HOME, disk("C:\\odd\\npx.cmd")), { refused: "windows_node_not_found", file: "C:\\odd\\npx.cmd" });
});

test("on macOS and Linux the command is started as written (no shell either)", () => {
  assert.deepEqual(launchFor("npx", ["-y", "pkg"], { PATH: "/usr/bin" }, "darwin"), { command: "npx", args: ["-y", "pkg"] });
  assert.deepEqual(launchFor("npx", ["-y", "pkg"], { PATH: "/usr/bin" }, "linux"), { command: "npx", args: ["-y", "pkg"] });
});
