// Ported from twoody-desktop/test/modelDownloads.test.mjs.
// A local server plays Hugging Face: ranges, a dropped connection, a
// redirect to somewhere it should not go.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DownloadError, downloadModel, freeDiskBytes, isInstalled, removeModel, SPACE_MARGIN_BYTES, spaceToInstall } from "../src/builtin/downloads.js";

const content = randomBytes(3 * 1024 * 1024 + 123);
const sha256 = createHash("sha256").update(content).digest("hex");

async function mirror() {
  const seen = [];
  let dropAfter = null; // bytes after which the next response is cut
  const server = createServer((req, res) => {
    seen.push({ url: req.url, range: req.headers.range ?? null });
    if (req.url === "/redirect-away") {
      res.writeHead(302, { location: "http://192.168.77.77/elsewhere.gguf" });
      return res.end();
    }
    if (req.url === "/redirect-here") {
      res.writeHead(302, { location: "/model.gguf" });
      return res.end();
    }
    const body = req.url === "/corrupt.gguf" ? Buffer.concat([content.subarray(0, content.length - 1), Buffer.from([content.at(-1) ^ 0xff])]) : content;
    const match = /^bytes=(\d+)-$/.exec(req.headers.range ?? "");
    const from = match ? Number(match[1]) : 0;
    // /close.gguf: an HTTP/1.0-style server, which closes the connection after the file.
    res.writeHead(match ? 206 : 200, { "content-length": body.length - from, "accept-ranges": "bytes", ...(req.url === "/close.gguf" ? { connection: "close" } : {}) });
    if (dropAfter !== null) {
      const cut = dropAfter;
      dropAfter = null;
      res.write(body.subarray(from, from + cut));
      return setTimeout(() => res.destroy(), 50);
    }
    if (req.url === "/slow.gguf") {
      // A connection slow enough for someone to change their mind.
      let sent = from;
      const timer = setInterval(() => {
        if (res.destroyed || sent >= body.length) {
          clearInterval(timer);
          return res.end();
        }
        res.write(body.subarray(sent, sent + 65_536));
        sent += 65_536;
      }, 10);
      return;
    }
    res.end(body.subarray(from));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return { base, seen, dropNextAfter: (bytes) => (dropAfter = bytes), close: () => new Promise((resolve) => server.close(resolve)) };
}

const entry = (base, path = "/model.gguf") => ({ id: "Tiny-Q8_0", name: "Tiny", file: "Tiny-Q8_0.gguf", url: base + path, bytes: content.length, sha256, minRamGb: 4, publisher: "", license: "" });

async function withMirror(run) {
  const server = await mirror();
  const dir = mkdtempSync(join(tmpdir(), "twoody-models-"));
  try {
    await run(server, dir);
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a model is downloaded, checked, and only then given its name", () =>
  withMirror(async (server, dir) => {
    const states = [];
    const model = entry(server.base, "/redirect-here");
    const path = await downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true, onProgress: (p) => states.push(p.state) });
    assert.equal(path, join(dir, "Tiny-Q8_0.gguf"));
    assert.ok(readFileSync(path).equals(content));
    // Windows has no POSIX modes: there the profile folder's ACL keeps it private.
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.ok(!existsSync(`${path}.part`));
    assert.equal(states.at(-1), "done");
    assert.ok(states.includes("verifying"));
    assert.ok(await isInstalled(dir, model));
    // Asked again: nothing is fetched.
    const before = server.seen.length;
    await downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true });
    assert.equal(server.seen.length, before);
    await removeModel(dir, model);
    assert.ok(!(await isInstalled(dir, model)));
  }));

// fetch (undici, in Electron 44) threw an uncaught AssertionError here when
// the reading was paused as the server closed: the app is now downloaded
// with Node's own client, which a closing server does not trouble.
test("a server that closes the connection after the file still gives a whole, checked model", () =>
  withMirror(async (server, dir) => {
    const model = entry(server.base, "/close.gguf");
    const path = await downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true });
    assert.ok(readFileSync(path).equals(content));
  }));

test("an interrupted download resumes where it stopped, and the digest still covers every byte", () =>
  withMirror(async (server, dir) => {
    const model = entry(server.base);
    server.dropNextAfter(1_000_000);
    await assert.rejects(downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true }));
    const partial = statSync(join(dir, "Tiny-Q8_0.gguf.part")).size;
    assert.ok(partial > 0 && partial < content.length, `partial file of ${partial} bytes`);
    assert.ok(!(await isInstalled(dir, model)));

    const path = await downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true });
    assert.equal(server.seen.at(-1).range, `bytes=${partial}-`);
    assert.ok(readFileSync(path).equals(content));
  }));

test("a file that is not the catalogue's is discarded, never installed", () =>
  withMirror(async (server, dir) => {
    const model = entry(server.base, "/corrupt.gguf");
    await assert.rejects(
      downloadModel(model, dir, { signal: new AbortController().signal, allowLoopback: true }),
      (err) => err instanceof DownloadError && err.code === "checksum_mismatch",
    );
    assert.ok(!existsSync(join(dir, "Tiny-Q8_0.gguf")));
    assert.ok(!existsSync(join(dir, "Tiny-Q8_0.gguf.part")));
  }));

// The small text files of an MLX folder are named by git's object id
// (catalogTypes.ts MlxFile): checked so, resumed too.
test("a file named by its git object id is checked by it, resumed or not, and refused when it differs", () =>
  withMirror(async (server, dir) => {
    const gitSha1 = createHash("sha1").update(`blob ${content.length}\0`).update(content).digest("hex");
    const file = { id: "config", file: "config.json", url: `${server.base}/config.json`, bytes: content.length, sha256: "", gitSha1 };
    server.dropNextAfter(500_000);
    await assert.rejects(downloadModel(file, dir, { signal: new AbortController().signal, allowLoopback: true }));
    const path = await downloadModel(file, dir, { signal: new AbortController().signal, allowLoopback: true });
    assert.ok(readFileSync(path).equals(content));
    const wrong = { ...file, file: "other.json", gitSha1: "0".repeat(40) };
    await assert.rejects(
      downloadModel(wrong, dir, { signal: new AbortController().signal, allowLoopback: true }),
      (err) => err instanceof DownloadError && err.code === "checksum_mismatch" && /git object id/.test(err.message),
    );
    assert.ok(!existsSync(join(dir, "other.json")));
  }));

test("a redirect to anywhere else is refused before a byte is asked for there", () =>
  withMirror(async (server, dir) => {
    await assert.rejects(
      downloadModel(entry(server.base, "/redirect-away"), dir, { signal: new AbortController().signal, allowLoopback: true }),
      (err) => err instanceof DownloadError && err.code === "forbidden_url",
    );
    // And a loopback mirror is itself refused outside a test catalogue.
    await assert.rejects(
      downloadModel(entry(server.base), dir, { signal: new AbortController().signal }),
      (err) => err instanceof DownloadError && err.code === "forbidden_url",
    );
    assert.equal(server.seen.filter((request) => request.url === "/model.gguf").length, 0);
  }));

test("cancelling keeps what was received, for the next attempt", () =>
  withMirror(async (server, dir) => {
    const abort = new AbortController();
    const model = entry(server.base, "/slow.gguf");
    await assert.rejects(
      downloadModel(model, dir, { signal: abort.signal, allowLoopback: true, onProgress: (p) => p.received > 200_000 && abort.abort() }),
      (err) => err instanceof DownloadError && err.code === "cancelled",
    );
    assert.ok(!existsSync(join(dir, "Tiny-Q8_0.gguf")));
    const kept = statSync(join(dir, "Tiny-Q8_0.gguf.part")).size;
    assert.ok(kept > 0 && kept < content.length, `kept ${kept} bytes`);
  }));

// Checked before the first byte, for the model and its vision file at once:
// running out of room between the two would leave gigabytes for nothing.
test("the room an install needs counts what is already there, and the margin once", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-models-"));
  try {
    const model = entry("http://127.0.0.1:9/");
    const vision = { ...model, id: "Tiny-Q8_0.mmproj", file: "Tiny-Q8_0.mmproj.gguf", bytes: 1_000 };
    const both = [{ dir, model }, { dir, model: vision }];
    assert.equal(await spaceToInstall(both), content.length + 1_000 + SPACE_MARGIN_BYTES);
    writeFileSync(join(dir, "Tiny-Q8_0.gguf.part"), content.subarray(0, 1_000_000));
    assert.equal(await spaceToInstall(both), content.length - 1_000_000 + 1_000 + SPACE_MARGIN_BYTES);
    writeFileSync(join(dir, "Tiny-Q8_0.gguf"), content);
    writeFileSync(join(dir, "Tiny-Q8_0.mmproj.gguf"), Buffer.alloc(1_000));
    assert.equal(await spaceToInstall(both), 0);
    // A folder not made yet: its disk's room.
    assert.ok(((await freeDiskBytes(join(dir, "not", "yet"))) ?? 0) > 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
