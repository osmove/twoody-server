import { test } from "node:test";
import assert from "node:assert/strict";
import { assertSealedSharedTask, isSharedTask } from "../src/bridgeClient.js";

const body = { model: "local", messages: [{ role: "user", content: "Bonjour" }], tools: [{ type: "function" }], tool_choice: "auto" };
const sealed = { kind: "llm_infer", args: { sealed_request: { v: 1, ciphertext: "00" }, principal: { kind: "shared", grant_id: 3 } } };
const clear = { kind: "llm_infer", args: { openai_body_json: JSON.stringify(body), principal: { kind: "shared", grant_id: 3 } } };

test("another person's turn is recognised by its principal", () => {
  assert.equal(isSharedTask(clear), true);
  assert.equal(isSharedTask({ args: { openai_body_json: "{}" } }), false);
  assert.equal(isSharedTask({ args: { principal: { kind: "owner" } } }), false);
});

test("a sealed completion is the only shared turn this computer runs", () => {
  assert.doesNotThrow(() => assertSealedSharedTask(sealed));
});

test("a question in clear is refused, even a completion", () => {
  assert.throws(() => assertSealedSharedTask(clear), /shared_task_refused/);
  assert.throws(() => assertSealedSharedTask({ kind: "llm_infer", args: { openai_body_json: "{}" } }), /shared_task_refused/);
});

test("anything but a completion is refused", () => {
  for (const kind of ["search", "read", "list_dir", "open_document", "transcribe", "smart_home_proxy"]) {
    assert.throws(() => assertSealedSharedTask({ ...sealed, kind }), /shared_task_refused/);
  }
});
