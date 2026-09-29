// A local server plays the GitHub release: a runtime archive, a corrupted
// one, a redirect that stays and one that leaves the allowlist.
import { after, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { RUNTIME_STAMP, RuntimeFetchError, installRuntime, installedRuntime, runtimeDir } from "../src/builtin/fetchRuntime.js";
import { RUNTIME_TAG } from "../src/builtin/runtimeManifest.js";

const work = mkdtempSync(join(tmpdir(), "twoody-fetch-runtime-"));

function makeArchive(marker: string): Buffer {
  const root = join(work, `src-${marker}`);
  const dir = join(root, `llama-${RUNTIME_TAG}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server"), `#!/bin/sh\necho ${marker}\n`);
  writeFileSync(join(dir, "llama-cli"), "#!/bin/sh\n");
  writeFileSync(join(dir, "libggml-base.so.0.25.1"), "ggml");
  symlinkSync("libggml-base.so.0.25.1", join(dir, "libggml-base.so.0"));
  writeFileSync(join(dir, "libggml-cpu-armv8.2_2.so"), "cpu");
  writeFileSync(join(dir, "libllama-cli-impl.so"), "cli");
  writeFileSync(join(dir, "LICENSE"), "MIT");
  const archive = join(work, `${marker}.tar.gz`);
  execFileSync("tar", ["-czf", archive, "-C", root, `llama-${RUNTIME_TAG}`]);
  return readFileSync(archive);
}

const good = makeArchive("good");
const other = makeArchive("other");
const target = { asset: `llama-${RUNTIME_TAG}-bin-test.tar.gz`, sha256: createHash("sha256").update(good).digest("hex") };

async function mirror(): Promise<{ base: string; seen: string[]; server: Server }> {
  const seen: string[] = [];
  const server = createServer((req, res) => {
    seen.push(req.url ?? "");
    if (req.url === "/redirect-here") {
      res.writeHead(302, { location: "/good.tar.gz" });
      return res.end();
    }
    if (req.url === "/redirect-away") {
      res.writeHead(302, { location: "https://example.com/llama.tar.gz" });
      return res.end();
    }
    if (req.url === "/missing") {
      res.writeHead(404);
      return res.end();
    }
    const body = req.url === "/other.tar.gz" ? other : good;
    res.writeHead(200, { "content-length": body.length });
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, server };
}

const { base, seen, server } = await mirror();
after(() => {
  server.closeAllConnections();
  server.close();
  rmSync(work, { recursive: true, force: true });
});
const opts = (root: string, path: string, extra: Record<string, unknown> = {}) => ({
  runtimeRoot: root,
  platform: "linux",
  arch: "arm64",
  target,
  url: base + path,
  allowLoopback: true,
  ...extra,
});

test("the runtime is fetched, checked and installed whole, with only what llama-server needs", async () => {
  const root = mkdtempSync(join(work, "root-"));
  const installed = await installRuntime(opts(root, "/redirect-here"));
  assert.equal(installed.fetched, true);
  assert.equal(installed.dir, join(root, `${RUNTIME_TAG}-linux-arm64`));
  assert.deepEqual(readdirSync(installed.dir).sort(), ["LICENSE.llama.cpp", "VERSION", "libggml-base.so.0", "libggml-base.so.0.25.1", "libggml-cpu-armv8.2_2.so", "llama-server"]);
  assert.equal(readFileSync(join(installed.dir, "VERSION"), "utf8").trim(), RUNTIME_STAMP);
  assert.ok(lstatSync(join(installed.dir, "libggml-base.so.0")).isSymbolicLink());
  assert.equal(readlinkSync(join(installed.dir, "libggml-base.so.0")), "libggml-base.so.0.25.1");
  assert.equal(statSync(join(installed.dir, "llama-server")).mode & 0o777, 0o755);
  assert.equal(statSync(join(installed.dir, "libggml-cpu-armv8.2_2.so")).mode & 0o777, 0o644);
  // No staging folder left behind.
  assert.deepEqual(readdirSync(root), [`${RUNTIME_TAG}-linux-arm64`]);
  assert.equal((await installedRuntime(root, "linux", "arm64"))?.dir, installed.dir);

  // Asked again: nothing is fetched.
  const before = seen.length;
  const again = await installRuntime(opts(root, "/good.tar.gz"));
  assert.equal(again.fetched, false);
  assert.equal(seen.length, before);
});

test("an archive whose digest is not the pinned one is refused, and nothing is installed", async () => {
  const root = mkdtempSync(join(work, "root-"));
  await assert.rejects(installRuntime(opts(root, "/other.tar.gz")), (err) => err instanceof RuntimeFetchError && err.code === "checksum_mismatch");
  assert.ok(!existsSync(runtimeDir(root, "linux", "arm64")));
  assert.deepEqual(readdirSync(root), []);
  assert.equal(await installedRuntime(root, "linux", "arm64"), null);
});

test("a redirect off the allowlist is refused, and so is a mirror on this computer outside tests", async () => {
  const root = mkdtempSync(join(work, "root-"));
  await assert.rejects(installRuntime(opts(root, "/redirect-away")), (err) => err instanceof RuntimeFetchError && err.code === "forbidden_url" && /example\.com/.test(err.message));
  const before = seen.length;
  await assert.rejects(installRuntime(opts(root, "/good.tar.gz", { allowLoopback: false })), (err) => err instanceof RuntimeFetchError && err.code === "forbidden_url");
  assert.equal(seen.length, before, "nothing asked of a host that is not allowed");
  await assert.rejects(installRuntime(opts(root, "/missing")), (err) => err instanceof RuntimeFetchError && err.code === "http_error");
  assert.deepEqual(readdirSync(root), []);
});

test("a failed reinstall leaves the installed runtime as it was; a good one replaces it at once", async () => {
  const root = mkdtempSync(join(work, "root-"));
  const first = await installRuntime(opts(root, "/good.tar.gz"));
  const marker = join(first.dir, "llama-server");
  const original = readFileSync(marker, "utf8");
  await assert.rejects(installRuntime(opts(root, "/other.tar.gz", { force: true })));
  assert.equal(readFileSync(marker, "utf8"), original);
  assert.ok(await installedRuntime(root, "linux", "arm64"));

  writeFileSync(join(first.dir, "stale-file"), "x");
  const second = await installRuntime(opts(root, "/good.tar.gz", { force: true }));
  assert.equal(second.fetched, true);
  assert.ok(!existsSync(join(second.dir, "stale-file")), "the old folder is replaced, not merged");
  assert.deepEqual(readdirSync(root), [`${RUNTIME_TAG}-linux-arm64`]);
});

test("a folder with another stamp is not taken for an installed runtime; concurrent installs share one fetch", async () => {
  const root = mkdtempSync(join(work, "root-"));
  const dir = runtimeDir(root, "linux", "arm64");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "llama-server"), "");
  writeFileSync(join(dir, "VERSION"), "b1 layout 0\n");
  assert.equal(await installedRuntime(root, "linux", "arm64"), null);
  const before = seen.filter((url) => url === "/good.tar.gz").length;
  const [a, b] = await Promise.all([installRuntime(opts(root, "/good.tar.gz")), installRuntime(opts(root, "/good.tar.gz"))]);
  assert.equal(a, b);
  assert.equal(seen.filter((url) => url === "/good.tar.gz").length, before + 1);
});

test("a platform without a release is said so", async () => {
  await assert.rejects(
    installRuntime({ runtimeRoot: mkdtempSync(join(work, "root-")), platform: "freebsd", arch: "x64" }),
    (err) => err instanceof RuntimeFetchError && err.code === "unsupported_platform",
  );
});
