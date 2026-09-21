import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { isPrivateAddress, isPrivateUrl } from "../src/outbound.js";

test("loopback, RFC 1918, link-local and tailnet addresses are private", () => {
  for (const address of [
    "127.0.0.1", "127.8.9.10", "10.0.0.5", "172.16.0.1", "172.31.255.254",
    "192.168.1.142", "169.254.10.1", "100.64.0.1", "100.101.102.103",
    "::1", "fd7a:115c:a1e0::1", "fe80::1", "::ffff:192.168.1.10",
  ]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
});

test("public addresses and non-addresses are not private", () => {
  for (const address of [
    "8.8.8.8", "172.32.0.1", "172.15.255.255", "100.128.0.1", "192.169.0.1",
    "2606:4700:4700::1111", "::ffff:8.8.8.8", "api.openai.com", "",
  ]) {
    assert.equal(isPrivateAddress(address), false, address);
  }
});

test("URLs are judged by where their host points", async () => {
  assert.equal(await isPrivateUrl("http://localhost:11434/v1"), true);
  assert.equal(await isPrivateUrl("http://127.0.0.1:8080/v1/chat/completions"), true);
  assert.equal(await isPrivateUrl("http://[::1]:3000/health"), true);
  assert.equal(await isPrivateUrl("http://192.168.1.89:8123/api/states"), true);
  assert.equal(await isPrivateUrl("https://8.8.8.8/"), false);
  assert.equal(await isPrivateUrl("not a url"), false);
  // Unresolvable names must not be given the benefit of the doubt.
  assert.equal(await isPrivateUrl("http://does-not-exist.invalid/"), false);
});

test("every outbound call in src/ goes through outboundFetch", () => {
  const srcDir = fileURLToPath(new URL("../src", import.meta.url));
  const offenders: string[] = [];

  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
      } else if (name.endsWith(".ts") && path !== join(srcDir, "outbound.ts")) {
        readFileSync(path, "utf8").split("\n").forEach((line, index) => {
          if (/(?<![\w.])fetch\(/.test(line)) offenders.push(`${path}:${index + 1}`);
        });
      }
    }
  };
  walk(srcDir);

  assert.deepEqual(offenders, [], "bare fetch( bypasses the local-only gate");
});
