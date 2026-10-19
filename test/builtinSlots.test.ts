// How many slots Twoody's llama.cpp opens a model with (19/10/2026, Jimmy:
// two when the computer is shared, from 24 GB): the rule by memory, shared
// or not, the engine and the model (src/builtin/slots.ts); what the account
// says of the grants; and the switch, at a quiet moment only.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { CATALOG } from "../src/builtin/catalog.js";
import { catalogMemoryNeed, memoryNeed, slotMemory, twoodyContext } from "../src/builtin/memory.js";
import {
  GUEST_SLOT,
  MAX_SLOTS,
  MIN_SWITCH_INTERVAL_MS,
  OWNER_SLOT,
  createSlotSwitch,
  largeForMemory,
  routerLoadedModel,
  routerQuiet,
  routerReload,
  runtimeSlots,
  sharedFromGrants,
  sharedSlotsByMemory,
  slotArgs,
  slotCacheRam,
} from "../src/builtin/slots.js";

const GIB = 1024 ** 3;
const MIB = 1024 ** 2;
const byId = (id: string) => CATALOG.find((model) => model.id === id)!;
const nine = byId("Qwen3.5-9B-Q4_K_M");
const four = byId("Qwen3.5-4B-Q4_K_M");
const large = byId("Qwen3.6-35B-A3B-IQ3_XXS");
const of = (model: typeof nine) => ({ modelBytes: model.bytes, figures: model.memory!, visionBytes: model.vision?.bytes ?? null });

test("one slot for a computer used by its owner alone, whatever its memory", () => {
  for (const gb of [8, 16, 24, 32, 48, 64, 128, 192]) {
    assert.equal(runtimeSlots({ totalMemory: gb * GIB, shared: false, ...of(nine) }), 1, `${gb} GB`);
  }
});

test("shared: one slot below 24 GB, two from 24 GB — and no more than two for now", () => {
  assert.equal(runtimeSlots({ totalMemory: 8 * GIB, shared: true, ...of(four) }), 1);
  assert.equal(runtimeSlots({ totalMemory: 15.9 * GIB, shared: true, ...of(nine) }), 1, "a « 16 GB » Mac");
  assert.equal(runtimeSlots({ totalMemory: 18 * GIB, shared: true, ...of(nine) }), 1);
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, ...of(nine) }), 2);
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, ...of(four) }), 2);
  assert.equal(runtimeSlots({ totalMemory: 32 * GIB, shared: true, ...of(nine) }), 2);
  // The hook for a Mac Studio in a firm: four by its memory, two for now.
  assert.equal(sharedSlotsByMemory(64 * GIB), 4);
  assert.equal(MAX_SLOTS, 2);
  assert.equal(runtimeSlots({ totalMemory: 64 * GIB, shared: true, ...of(nine) }), 2);
  assert.equal(runtimeSlots({ totalMemory: 192 * GIB, shared: true, ...of(nine) }), 2);
  assert.equal(OWNER_SLOT, 0);
  assert.equal(GUEST_SLOT, 1);
});

test("one slot for MLX (mlx-lm batches on its own), a model large for the memory, or one without figures", () => {
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, engine: "mlx", ...of(nine) }), 1);
  // Qwen3.6 35B-A3B (14.7 GiB) on 24 and 32 GB: its cache was cut to fit.
  assert.ok(largeForMemory(large.bytes, 24 * GIB) && largeForMemory(large.bytes, 32 * GIB));
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, ...of(large) }), 1);
  assert.equal(runtimeSlots({ totalMemory: 32 * GIB, shared: true, ...of(large) }), 1);
  assert.equal(runtimeSlots({ totalMemory: 48 * GIB, shared: true, ...of(large) }), 2, "not large on 48 GB");
  // A GGUF put in the folder by hand: what a second slot costs is unknown.
  assert.equal(runtimeSlots({ totalMemory: 64 * GIB, shared: true, modelBytes: 5e9, figures: null }), 1);
  assert.equal(runtimeSlots({ totalMemory: 64 * GIB, shared: true, modelBytes: null, figures: nine.memory! }), 1);
});

test("a model whose need with two slots passes what may hold it keeps one", () => {
  // Not large (10 GiB of 24), but its 16-bit cache is big: 2.5 GiB a slot
  // fits the 16 GiB a 24 GB Mac's GPU may use, 3.1 GiB a slot does not.
  const dense = (kvBytesPerToken: number) => ({ modelBytes: 10 * GIB, figures: { kvBytesPerToken, stateBytes: 0, hybrid: false } });
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, ...dense(160 * 1024) }), 2);
  assert.equal(runtimeSlots({ totalMemory: 24 * GIB, shared: true, ...dense(200 * 1024) }), 1);
  // Every catalogue model offered on 24 or 32 GB that keeps one slot there
  // is a large one (Qwen3.6 35B-A3B, gpt-oss 20B on 24 GB; the 27B to 35B
  // ones on 32 GB).
  for (const gb of [24, 32]) {
    for (const model of CATALOG.filter((entry) => entry.minRamGb <= gb && entry.memory)) {
      const slots = runtimeSlots({ totalMemory: gb * GIB, shared: true, ...of(model) });
      assert.equal(slots, largeForMemory(model.bytes, gb * GIB) ? 1 : 2, `${model.id} on ${gb} GB`);
    }
  }
  // A PC's graphics card of its own: the 9B with two slots in a 16-bit cache
  // does not fit 8 GB (less llama.cpp's margin), fits 16.
  assert.equal(runtimeSlots({ totalMemory: 32 * GIB, shared: true, ...of(nine), deviceMemory: 8 * GIB, f16Cache: true }), 1);
  assert.equal(runtimeSlots({ totalMemory: 32 * GIB, shared: true, ...of(nine), deviceMemory: 16 * GIB, f16Cache: true }), 2);
});

test("llama.cpp's options: each slot its own whole window, an idle one left alone", () => {
  assert.deepEqual(slotArgs(1, 32_768), ["--parallel", "1", "--ctx-size", "32768"]);
  assert.deepEqual(slotArgs(2, 32_768), ["--parallel", "2", "--ctx-size", "65536", "--no-kv-unified", "--no-cache-idle-slots"]);
  assert.deepEqual(slotArgs(2, 65_536).slice(0, 4), ["--parallel", "2", "--ctx-size", "131072"]);
});

test("a second slot's memory: counted in the need, given back by the prompt cache", () => {
  const context = twoodyContext({ hybrid: true, totalMemory: 24 * GIB });
  const slot = slotMemory(nine.memory!, context, "llamacpp");
  // Measured with b11146: 544 MiB of q8_0 cache (and 50.25 MiB of state; the
  // catalogue's figure from config.json: 48).
  assert.equal(slot, 544 * MIB + nine.memory!.stateBytes);
  const one = catalogMemoryNeed(nine, 24 * GIB)!;
  const two = catalogMemoryNeed(nine, 24 * GIB, "llamacpp", 2)!;
  assert.equal(two - one, slot);
  // One slot: the same bytes as before (the site's calculator compares them).
  assert.equal(memoryNeed({ weightsBytes: nine.bytes, figures: nine.memory!, context, engine: "llamacpp", visionBytes: nine.vision!.bytes }), one);
  assert.equal(memoryNeed({ weightsBytes: nine.bytes, figures: nine.memory!, context, engine: "llamacpp", visionBytes: nine.vision!.bytes, slots: 1 }), one);
  // MLX reserves nothing per slot.
  assert.equal(catalogMemoryNeed(nine, 24 * GIB, "mlx", 2), catalogMemoryNeed(nine, 24 * GIB, "mlx"));
  // 4 096 MiB of prompt cache with one slot on 24 GB, 3 504 with two.
  assert.equal(slotCacheRam(4_096, 1, slot), 4_096);
  assert.equal(slotCacheRam(4_096, 2, slot), 3_504);
  assert.equal(slotCacheRam(8_192, 2, 2 * slot), 8_192 - Math.ceil((2 * slot) / MIB));
  assert.equal(slotCacheRam(2_048, 2, 10 * GIB), 1_024, "never below half");
});

test("shared or not, from the account's grants: active, not expired, for this computer", () => {
  const now = Date.parse("2026-10-19T12:00:00Z");
  const host = "4f7e2c1a-0b9d-4e55-8a6f-2d3c4b5a6e7f";
  const grant = (hostId: string, expires: string | null) => ({ id: 1, expires_at: expires, computer: { id: 3, host_id: hostId, name: "MacBook" }, grantee: { id: 9, first_name: "Claire" } });
  assert.deepEqual(sharedFromGrants({ given: [grant(host, null)], received: [] }, host, now), { shared: true, until: null });
  assert.deepEqual(sharedFromGrants({ given: [grant(host.toUpperCase(), null)] }, ` ${host} `, now), { shared: true, until: null });
  assert.deepEqual(sharedFromGrants({ given: [grant(host, "2026-10-20T12:00:00Z")] }, host, now), { shared: true, until: Date.parse("2026-10-20T12:00:00Z") });
  assert.deepEqual(sharedFromGrants({ given: [grant(host, "2026-10-19T11:59:59Z")] }, host, now), { shared: false, until: null }, "expired");
  assert.deepEqual(sharedFromGrants({ given: [grant("another-computer", null)] }, host, now), { shared: false, until: null });
  assert.deepEqual(sharedFromGrants({ given: [] }, host, now), { shared: false, until: null });
  assert.deepEqual(sharedFromGrants({ given: [grant(host, null)] }, null, now), { shared: false, until: null }, "no bridge device id: never bridged");
  assert.deepEqual(sharedFromGrants({ given: [grant(host, "not a date"), null, { computer: null }] }, host, now), { shared: false, until: null });
  // Nothing usable: what was known stands.
  for (const body of [null, "<html>", { error: "unauthorized" }, { given: "all" }]) assert.equal(sharedFromGrants(body, host, now), null);
});

// ── The switch ─────────────────────────────────────────────────────────

function clock() {
  let at = 0;
  const timers: Array<{ at: number; fn: () => void; live: boolean }> = [];
  return {
    now: () => at,
    setTimer: (fn: () => void, ms: number) => {
      const timer = { at: at + ms, fn, live: true };
      timers.push(timer);
      return { cancel: () => void (timer.live = false) };
    },
    async advance(ms: number) {
      const end = at + ms;
      for (;;) {
        const next = timers.filter((timer) => timer.live && timer.at <= end).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.live = false;
        at = next.at;
        next.fn();
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
      }
      at = end;
    },
  };
}

test("a switch waits for a quiet moment, never during an answer", async () => {
  const time = clock();
  let busy = true;
  let wanted = 2;
  let running = 1;
  const applied: number[] = [];
  const toggle = createSlotSwitch({
    needed: async () => wanted !== running,
    quiet: async () => !busy,
    apply: async () => { running = wanted; applied.push(time.now()); },
    now: time.now,
    setTimer: time.setTimer,
    pollMs: 2_000,
  });
  toggle.request();
  await time.advance(10_000);
  assert.deepEqual(applied, [], "an answer being written: nothing");
  assert.equal(toggle.pending(), true);
  busy = false;
  await time.advance(2_000);
  assert.deepEqual(applied, [12_000], "at the first quiet look");
  assert.equal(toggle.pending(), false);
  // Asked again with nothing to change: nothing.
  toggle.request();
  await time.advance(60_000);
  assert.equal(applied.length, 1);
});

test("at most one switch every ten minutes, and a change taken back before its moment does nothing", async () => {
  const time = clock();
  let wanted = 2;
  let running = 1;
  const applied: number[] = [];
  const toggle = createSlotSwitch({
    needed: async () => wanted !== running,
    quiet: async () => true,
    apply: async () => { running = wanted; applied.push(time.now()); },
    now: time.now,
    setTimer: time.setTimer,
  });
  toggle.request();
  await time.advance(0);
  assert.deepEqual(applied, [0], "the first one at once");
  // The account says no longer shared, a minute later: not before ten minutes.
  await time.advance(60_000);
  wanted = 1;
  toggle.request();
  await time.advance(MIN_SWITCH_INTERVAL_MS - 60_000 - 1);
  assert.deepEqual(applied, [0]);
  await time.advance(1);
  assert.deepEqual(applied, [0, MIN_SWITCH_INTERVAL_MS]);
  // Shared again, then not, before the moment comes: nothing switched.
  wanted = 2;
  toggle.request();
  await time.advance(1_000);
  wanted = 1;
  await time.advance(MIN_SWITCH_INTERVAL_MS);
  assert.deepEqual(applied, [0, MIN_SWITCH_INTERVAL_MS]);
  toggle.stop();
});

test("a switch that fails is tried again at the next quiet look", async () => {
  const time = clock();
  let fails = 1;
  let applied = 0;
  const toggle = createSlotSwitch({
    needed: async () => applied === 0,
    quiet: async () => true,
    apply: async () => {
      if (fails-- > 0) throw new Error("the router did not answer");
      applied += 1;
    },
    now: time.now,
    setTimer: time.setTimer,
    pollMs: 2_000,
    minIntervalMs: 0,
  });
  toggle.request();
  await time.advance(0);
  assert.equal(applied, 0);
  await time.advance(2_000);
  assert.equal(applied, 1);
});

// ── llama.cpp's router, as far as the switch goes ──────────────────────

test("the router is quiet when no model loads and no slot of the one it holds is busy; asleep is quiet, and never woken", async () => {
  const KEY = "router-key";
  let models: Array<{ id: string; status: unknown }> = [];
  let slots: Array<{ id: number; is_processing: boolean }> = [];
  const asked: string[] = [];
  const server = createServer((req, res) => {
    asked.push(req.url ?? "");
    if (req.headers.authorization !== `Bearer ${KEY}`) return void res.writeHead(401).end();
    const url = new URL(req.url ?? "/", "http://x");
    if (url.pathname === "/v1/models") {
      if (url.searchParams.get("reload") === "1") models = models.map((model) => ({ ...model, status: { value: "unloaded" } }));
      return void res.end(JSON.stringify({ data: models }));
    }
    if (url.pathname === "/slots") {
      assert.equal(url.searchParams.get("autoload"), "false", "never loads a model to be asked");
      return void res.end(JSON.stringify(slots));
    }
    res.writeHead(404).end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  try {
    models = [{ id: "qwen", status: { value: "unloaded" } }];
    assert.equal(await routerQuiet(base, KEY, fetch), true, "nothing loaded");
    models = [{ id: "qwen", status: { value: "loading" } }];
    assert.equal(await routerQuiet(base, KEY, fetch), false, "a model loading");
    models = [{ id: "qwen", status: "sleeping" }];
    asked.length = 0;
    assert.equal(await routerQuiet(base, KEY, fetch), true, "asleep");
    assert.ok(!asked.some((url) => url.startsWith("/slots")), "a model asleep is not asked, so not woken");
    models = [{ id: "qwen", status: { value: "loaded" } }];
    slots = [{ id: 0, is_processing: false }, { id: 1, is_processing: true }];
    assert.equal(await routerQuiet(base, KEY, fetch), false, "the guest's answer being written");
    slots = [{ id: 0, is_processing: false }, { id: 1, is_processing: false }];
    assert.equal(await routerQuiet(base, KEY, fetch), true);
    assert.equal(await routerQuiet(base, "wrong key", fetch), false, "cannot tell: not quiet");
    assert.equal(await routerLoadedModel(base, KEY, fetch), "qwen");
    assert.equal(await routerReload(base, KEY, fetch), true);
    assert.ok(asked.includes("/v1/models?reload=1"));
    assert.equal(await routerLoadedModel(base, KEY, fetch), null, "let go by the reload");
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
