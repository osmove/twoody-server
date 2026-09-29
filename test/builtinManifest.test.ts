import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  RUNTIME_TAG,
  RUNTIME_TARGETS,
  RUNTIME_VULKAN,
  isAllowedRuntimeUrl,
  keepRuntimeFile,
  runtimeAssetUrl,
  runtimeTarget,
} from "../src/builtin/runtimeManifest.js";

test("every target is pinned to the tag, with a SHA-256", () => {
  assert.equal(RUNTIME_TAG, "b11146");
  assert.deepEqual(Object.keys(RUNTIME_TARGETS).sort(), ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-arm64", "win32-x64"]);
  for (const [key, target] of [...Object.entries(RUNTIME_TARGETS), ["vulkan", RUNTIME_VULKAN] as const]) {
    assert.match(target.sha256, /^[0-9a-f]{64}$/, key);
    assert.ok(target.asset.startsWith(`llama-${RUNTIME_TAG}-bin-`), key);
  }
  assert.equal(runtimeTarget("linux", "arm64")?.asset, "llama-b11146-bin-ubuntu-arm64.tar.gz");
  // The digest the Pi speed gate checked on 29/09/2026.
  assert.equal(runtimeTarget("linux", "arm64")?.sha256, "4aeda6fe68831547e49b7fa87607383ca5352b3d72ca5f70d52ed265f58c131f");
  assert.equal(runtimeTarget("freebsd", "x64"), null);
  assert.equal(runtimeAssetUrl("a.tar.gz"), "https://github.com/ggml-org/llama.cpp/releases/download/b11146/a.tar.gz");
});

// Until the Desktop's script imports the manifest, the two copies must agree.
const desktopScript = fileURLToPath(new URL("../../twoody-desktop/scripts/fetch-runtime.mjs", import.meta.url));
test("same tag and digests as the Desktop's fetch-runtime.mjs", { skip: !existsSync(desktopScript) && "no twoody-desktop checkout beside this one" }, () => {
  const script = readFileSync(desktopScript, "utf8");
  if (!/const TAG = "/.test(script)) return; // the script imports the manifest: nothing to compare
  assert.equal(/const TAG = "([^"]+)"/.exec(script)?.[1], RUNTIME_TAG);
  for (const [key, target] of Object.entries(RUNTIME_TARGETS)) {
    const line = new RegExp(`"${key}": \\{ asset: \`llama-\\$\\{TAG\\}-([^\`]+)\`, sha256: "([0-9a-f]{64})"`).exec(script);
    assert.ok(line, `${key} missing from the Desktop's script`);
    assert.equal(`llama-${RUNTIME_TAG}-${line[1]}`, target.asset, key);
    assert.equal(line[2], target.sha256, key);
  }
  assert.ok(script.includes(RUNTIME_VULKAN.sha256));
});

test("only llama-server and what it opens are kept", () => {
  for (const name of ["llama-server", "llama-server.exe", "libggml-base.so.0.25.1", "libggml-cpu-armv8.2_2.so", "libllama.so.0", "libllama-server-impl.so", "libmtmd.so.0.5.0", "libllama.0.5.0.dylib", "ggml-cpu-haswell.dll", "libomp.dll"]) {
    assert.ok(keepRuntimeFile(name), name);
  }
  for (const name of ["llama-cli", "llama-bench", "libllama-cli-impl.so", "libllama-bench-impl.so", "libllama-quantize-impl.so", "ggml-rpc-server", "LICENSE", "README.md"]) {
    assert.ok(!keepRuntimeFile(name), name);
  }
});

test("the runtime only ever comes from GitHub's release hosts, over HTTPS", () => {
  assert.ok(isAllowedRuntimeUrl("https://github.com/ggml-org/llama.cpp/releases/download/b11146/x.tar.gz"));
  assert.ok(isAllowedRuntimeUrl("https://objects.githubusercontent.com/github-production-release-asset/x"));
  assert.ok(isAllowedRuntimeUrl("https://release-assets.githubusercontent.com/github-production-release-asset/x"));
  assert.ok(!isAllowedRuntimeUrl("http://github.com/x"));
  assert.ok(!isAllowedRuntimeUrl("https://github.com.evil.example/x"));
  assert.ok(!isAllowedRuntimeUrl("https://raw.githubusercontent.com/x"));
  assert.ok(!isAllowedRuntimeUrl("https://huggingface.co/x"));
  assert.ok(!isAllowedRuntimeUrl("not a url"));
  assert.ok(!isAllowedRuntimeUrl("http://127.0.0.1:9000/x.tar.gz"));
  assert.ok(isAllowedRuntimeUrl("http://127.0.0.1:9000/x.tar.gz", true));
  assert.ok(!isAllowedRuntimeUrl("http://192.168.1.10:9000/x.tar.gz", true));
});
