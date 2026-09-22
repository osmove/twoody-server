import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// This server is run two ways: started by Twoody Desktop, which passes
// everything it needs, and on its own on a Linux box — a Raspberry Pi,
// a small server — where a person has to be told what to put in a file.
// The second is the one that rots, because nothing fails when a new
// setting is added and nobody writes it down; it is simply missing the
// day someone needs it. That is what these check.

const root = fileURLToPath(new URL("..", import.meta.url));
const example = readFileSync(join(root, "scripts", "twoody-server.env.example"), "utf8");

/// Read by the code but not a person's to set: handed over by the
/// desktop, provided by the system, or belonging to a test.
const NOT_FOR_A_HUMAN = new Set([
  "TWOODY_RUNTIME_KEYS", // the desktop mints one per launch and sends it by message
  "TWOODY_DEVICE_TOKEN", // the app that owns the session supplies it
  "TWOODY_DEVICE_MIN_SHA",
  "TWOODY_DEVICE_UPDATES_BLOCKED",
  "TWOODY_MCP_URL",
  "TWOODY_BRIDGE_CAPABILITIES",
  "TWOODY_CLOUD_FALLBACK_ENABLED",
  "TWOODY_LOCAL_MAX_TOKENS",
  "TWOODY_WHISPER_BINARY",
  "TWOODY_WHISPER_MODEL",
  "TWOODY_WHISPER_MODEL_DIR",
]);

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) found.push(...sourceFiles(path));
    else if (name.endsWith(".ts")) found.push(path);
  }
  return found;
}

test("every setting a person is meant to set is written down", () => {
  const read = new Set<string>();
  for (const path of sourceFiles(join(root, "src"))) {
    for (const match of readFileSync(path, "utf8").matchAll(/process\.env\.(TWOODY_[A-Z0-9_]+)/g)) {
      read.add(match[1]);
    }
  }

  const undocumented = [...read].filter((name) => !NOT_FOR_A_HUMAN.has(name) && !example.includes(name)).sort();
  assert.deepEqual(
    undocumented,
    [],
    `read by the code, absent from scripts/twoody-server.env.example — add them there, or to NOT_FOR_A_HUMAN with a reason`,
  );
});

test("the example does not describe settings the code stopped reading", () => {
  const read = new Set<string>();
  for (const path of sourceFiles(join(root, "src"))) {
    for (const match of readFileSync(path, "utf8").matchAll(/process\.env\.([A-Z0-9_]+)/g)) {
      read.add(match[1]);
    }
  }

  const mentioned = new Set((example.match(/^#?\s*([A-Z][A-Z0-9_]{3,})=/gm) ?? []).map((line) => line.replace(/^#?\s*/, "").replace(/=$/, "")));
  const stale = [...mentioned].filter((name) => !read.has(name)).sort();
  assert.deepEqual(stale, [], "described in the example, read nowhere — a setting that does nothing is worse than none");
});

// The unit runs with ProtectHome=read-only, which makes the whole of
// /home unwritable. The two directories this server writes to have to
// be named, or it starts and cannot open its own database.
test("the systemd unit can write where the database goes", () => {
  const unit = readFileSync(join(root, "scripts", "twoody-server.service"), "utf8");
  const user = unit.match(/^User=(\S+)$/m)?.[1];
  assert.ok(user, "the unit names no user");

  if (/^ProtectHome=read-only$/m.test(unit)) {
    const writable = unit.match(/^ReadWritePaths=(.+)$/m)?.[1] ?? "";
    assert.match(writable, new RegExp(`/home/${user}/\\.twoody(\\s|$)`), "the data directory is not writable by the unit");
  }
});

// Compiling it needs a toolchain and minutes on a Pi, and produces a
// file the module never opens: it loads the prebuilt binary that ships
// with the package. npm builds anything with a binding.gyp unless told
// not to, so every place that installs has to say so.
test("nothing installs the native module by compiling it", () => {
  for (const [path, pattern] of [
    ["Dockerfile", /npm ci(?![^\n]*--ignore-scripts)/],
    [join("scripts", "install-linux.sh"), /npm ci(?![^\n]*--ignore-scripts)/],
    [join("scripts", "upgrade-linux.sh"), /npm ci(?![^\n]*--ignore-scripts)/],
  ] as const) {
    // Comments and log lines are prose about the command, not the
    // command: one of them says "skipping npm ci", which is true and
    // installs nothing.
    const text = readFileSync(join(root, path), "utf8")
      .split("\n")
      .filter((line) => !/^\s*(#|log\s|echo\s)/.test(line))
      .join("\n");
    assert.doesNotMatch(text, pattern, `${path} runs npm ci without --ignore-scripts`);
  }
});
