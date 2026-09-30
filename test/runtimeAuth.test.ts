import { test } from "node:test";
import assert from "node:assert/strict";
import { configureRuntimeKeys, runtimeAuthHeaders } from "../src/runtimeAuth.js";

test("a key is attached to its runtime, whatever the trailing slash, and to nothing else", () => {
  configureRuntimeKeys({ "http://127.0.0.1:47831/v1": "s3cret" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47831/v1"), { Authorization: "Bearer s3cret" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47831/v1/"), { Authorization: "Bearer s3cret" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:8080/v1"), {});
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47831"), {});
});

test("a key is never accepted for an address that is not this computer", () => {
  configureRuntimeKeys({
    "https://api.example.com/v1": "leak",
    "http://192.168.1.20:1234/v1": "leak",
    "http://localhost:1234/v1": "fine",
    "not a url": "leak",
  });
  assert.deepEqual(runtimeAuthHeaders("https://api.example.com/v1"), {});
  assert.deepEqual(runtimeAuthHeaders("http://192.168.1.20:1234/v1"), {});
  assert.deepEqual(runtimeAuthHeaders("http://localhost:1234/v1"), { Authorization: "Bearer fine" });
});

test("configuring again replaces what was known; junk means no key", () => {
  configureRuntimeKeys({ "http://127.0.0.1:1/v1": "a" });
  configureRuntimeKeys({ "http://127.0.0.1:2/v1": "b", "http://127.0.0.1:3/v1": 42 });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:1/v1"), {});
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:2/v1"), { Authorization: "Bearer b" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:3/v1"), {});
  configureRuntimeKeys(null);
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:2/v1"), {});
});

test("a key added by this process survives the Desktop's keys being replaced, and is loopback only", async () => {
  const { addRuntimeKey } = await import("../src/runtimeAuth.js");
  assert.equal(addRuntimeKey("http://127.0.0.1:47900/v1/", "mine"), true);
  assert.equal(addRuntimeKey("http://192.168.1.20:47900/v1", "leak"), false);
  configureRuntimeKeys({ "http://127.0.0.1:47831/v1": "desktop" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47900/v1"), { Authorization: "Bearer mine" });
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47831/v1"), { Authorization: "Bearer desktop" });
  configureRuntimeKeys(null);
  assert.deepEqual(runtimeAuthHeaders("http://127.0.0.1:47900/v1"), { Authorization: "Bearer mine" });
  assert.deepEqual(runtimeAuthHeaders("http://192.168.1.20:47900/v1"), {});
});
