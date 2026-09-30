// `twoody-server config set` (src/cli/runtime.ts): what it accepts.
import assert from "node:assert/strict";
import test from "node:test";

import { parseAssignments } from "../src/cli/runtime.js";

test("config set: an engine, an address, the built-in runtime's settings", () => {
  assert.deepEqual(parseAssignments(["runtime=builtin"]), { engine: "builtin" });
  assert.deepEqual(parseAssignments(["runtime=http://192.168.1.5:8080/v1"]), { engine: "custom", custom_url: "http://192.168.1.5:8080/v1" });
  assert.deepEqual(parseAssignments(["default_model=Qwen3.5-4B-Q4_K_M", "builtin.ctx=4096", "threads=default"]), {
    builtin: { default_model: "Qwen3.5-4B-Q4_K_M", ctx: 4096, threads: null },
  });
  for (const bad of [[], ["runtime=vllm"], ["runtime"], ["ctx=big"], ["idle_minutes="], ["colour=blue"], ["default_model=../x"], ["custom_url=ftp://x"]]) {
    assert.throws(() => parseAssignments(bad), undefined, bad.join(" "));
  }
});
