import { test } from "node:test";
import assert from "node:assert/strict";
import { isSharedTask, sharedInferenceArgs } from "../src/bridgeClient.js";

const body = { model: "local", messages: [{ role: "user", content: "Bonjour" }], tools: [{ type: "function" }], tool_choice: "auto" };
const shared = { kind: "llm_infer", args: { openai_body_json: JSON.stringify(body), principal: { kind: "shared", grant_id: 3 } } };

test("another person's turn is recognised by its principal", () => {
  assert.equal(isSharedTask(shared), true);
  assert.equal(isSharedTask({ args: { openai_body_json: "{}" } }), false);
  assert.equal(isSharedTask({ args: { principal: { kind: "owner" } } }), false);
});

test("it runs as a completion without tools or routing details", () => {
  const args = sharedInferenceArgs(shared);
  assert.deepEqual(Object.keys(args), ["openai_body_json"]);
  const sent = JSON.parse(String(args.openai_body_json));
  assert.equal(sent.tools, undefined);
  assert.equal(sent.tool_choice, undefined);
  assert.deepEqual(sent.messages, body.messages);
});

test("anything but a completion is refused", () => {
  for (const kind of ["search", "read", "list_dir", "open_document", "transcribe", "smart_home_proxy"]) {
    assert.throws(() => sharedInferenceArgs({ ...shared, kind }), /shared_task_refused/);
  }
  assert.throws(() => sharedInferenceArgs({ kind: "llm_infer", args: { openai_body_json: "not json" } }), /shared_task_refused/);
  assert.throws(() => sharedInferenceArgs({ kind: "llm_infer", args: { openai_body_json: "{}" } }), /shared_task_refused/);
});
