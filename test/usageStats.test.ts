import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Usage and performance stats (29/09/2026): every call to a model is
// counted — chat answers here, Twoody Code and the Agent reported by the
// desktop app — by hour, day or month in the person's time zone, with its
// speed; the machine's load is sampled and thinned out with age.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-usage-stats-"));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { db, discussions, messages, tunnelPeers, usageEvents, usageSamples } = await import("../src/db.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");
const { backfillUsageEvents, compactUsageSamples, recordSamples, recordUsageEvent } = await import("../src/usageStore.js");
const { periodRange } = await import("../src/usagePeriods.js");
const { periodUsage } = await import("../src/routes/usage.js");

// A llama.cpp that says what it spent: usage with its cache, then timings.
const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3", object: "model" }] }));
    return;
  }
  req.resume();
  req.on("end", () => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const send = (event: object) => res.write(`data: ${JSON.stringify(event)}\n\n`);
    send({ choices: [{ delta: { content: "Trois mois." } }] });
    send({ choices: [{ delta: {}, finish_reason: "stop" }], timings: { cache_n: 300, prompt_n: 200, prompt_ms: 400, predicted_n: 50, predicted_ms: 1000 } });
    send({ choices: [], usage: { prompt_tokens: 500, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 300 } } });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phoneSession = createAuthSession(owner, "pair:iPhone");
const phone = { authorization: `Bearer ${phoneSession.token}` };
// A phone that named itself like the app is still a phone: it has a tunnel key.
const impostor = createAuthSession(owner, "pair:Twoody Desktop");
db.insert(tunnelPeers).values({ publicKey: "ab".repeat(32), userId: owner, name: "Twoody Desktop", pairedAt: new Date(), sessionId: impostor.sessionId }).run();

test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

const clearEvents = () => db.delete(usageEvents).run();

test("the answers kept before usage_events are copied once, as chat", () => {
  const now = new Date();
  db.insert(discussions).values({ id: "d-old", userId: owner, channel: "desktop", title: "t", createdAt: now, lastActivityAt: now }).run();
  db.insert(messages).values({ id: "m-old", discussionId: "d-old", userId: owner, role: "assistant", content: "…", model: "Qwen3.5-9B", client: "iPhone", promptTokens: 1200, completionTokens: 80, tokensEstimated: false, createdAt: new Date(now.getTime() - 3 * 86_400_000) }).run();
  db.insert(messages).values({ id: "m-question", discussionId: "d-old", userId: owner, role: "user", content: "?", createdAt: now }).run();
  db.insert(messages).values({ id: "m-stopped", discussionId: "d-old", userId: owner, role: "assistant", content: "…", createdAt: now }).run();

  assert.equal(backfillUsageEvents(), 1);
  assert.equal(backfillUsageEvents(), 0);
  const [copied] = db.select().from(usageEvents).all();
  assert.equal(copied.source, "chat");
  assert.equal(copied.messageId, "m-old");
  assert.equal(copied.promptTokens, 1200);
  assert.equal(copied.client, "iPhone");
  assert.equal(copied.at.getTime(), Math.floor((now.getTime() - 3 * 86_400_000) / 1000) * 1000);
  clearEvents();
});

test("a chat answer is counted with the runtime's cache and timings, and its time to first token", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: `${runtimeUrl}/v1`, model: "qwen3", name: "llama.cpp" } })).statusCode, 201);
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers: phone, payload: { text: "Quel préavis ?", channel: "desktop", force_new_discussion: true } });
  assert.equal(response.statusCode, 200, response.body);
  const final = JSON.parse(response.body.split("event: final\ndata: ")[1].split("\n")[0]);
  // The answer's own usage keeps its shape.
  assert.deepEqual(final.usage, { prompt_tokens: 500, completion_tokens: 50, estimated: false });

  const [event] = db.select().from(usageEvents).all();
  assert.equal(event.source, "chat");
  assert.equal(event.client, "iPhone");
  assert.equal(event.model, "qwen3");
  assert.equal(event.promptTokens, 500);
  assert.equal(event.completionTokens, 50);
  assert.equal(event.cachedTokens, 300);
  assert.equal(event.promptMs, 400);
  assert.equal(event.generationMs, 1000);
  assert.ok(event.ttftMs !== null && event.ttftMs >= 0);
  assert.ok(event.messageId);
  assert.equal(event.estimated, false);

  const usage = (await app.inject({ method: "GET", url: "/api/v1/usage?period=day&tz=UTC", headers: phone })).json();
  assert.equal(usage.totals.cached_tokens, 300);
  assert.equal(usage.speed.generation_tps_avg, 50);
  // 200 tokens read past the cache in 400 ms.
  assert.equal(usage.speed.prompt_tps_avg, 500);
  assert.deepEqual(usage.by_source.map((row: { source: string }) => row.source), ["chat"]);
  clearEvents();
});

test("what the model is asked to learn from a conversation is counted as memory, on this computer", async () => {
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "J'habite à Lyon, quel temps ?", channel: "desktop", force_new_discussion: true } });
  assert.equal(response.statusCode, 200, response.body);
  const discussionId = /"discussion_id":"([^"]+)"/.exec(response.body)![1];
  assert.equal((await app.inject({ method: "POST", url: "/memories/learn", headers: desktop, payload: { discussion_id: discussionId } })).statusCode, 200);
  const sources = db.select().from(usageEvents).all().map((event) => event.source);
  assert.deepEqual(sources.sort(), ["chat", "memory"]);
  const memory = db.select().from(usageEvents).all().find((event) => event.source === "memory")!;
  assert.equal(memory.client, "this-computer");
  assert.equal(memory.cachedTokens, 300);
  clearEvents();
});

test("the desktop app alone reports its calls; phones are refused", async () => {
  const at = new Date().toISOString();
  const event = { at, source: "code", model: "Qwen3-14B", prompt_tokens: 4000, completion_tokens: 200, cached_tokens: 3500, prompt_ms: 900, generation_ms: 10_000, ttft_ms: 950 };
  const ok = await app.inject({ method: "POST", url: "/api/v1/usage/events", headers: desktop, payload: { events: [event, { ...event, source: "agent", estimated: true }] } });
  assert.equal(ok.statusCode, 201, ok.body);
  assert.deepEqual(ok.json(), { accepted: 2 });

  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/events", headers: phone, payload: { events: [event] } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/events", headers: { authorization: `Bearer ${impostor.token}` }, payload: { events: [event] } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/events", payload: { events: [event] } })).statusCode, 401);
  const tooMany = Array.from({ length: 501 }, () => event);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/events", headers: desktop, payload: { events: tooMany } })).statusCode, 422);
  for (const bad of [{ ...event, source: "chat" }, { ...event, prompt_tokens: -1 }, { ...event, at: "2001-01-01T00:00:00Z" }, { ...event, model: undefined }, { ...event, estimated: "yes" }]) {
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/events", headers: desktop, payload: { events: [bad] } })).statusCode, 422, JSON.stringify(bad));
  }

  // Readable from the phone.
  const usage = (await app.inject({ method: "GET", url: "/api/v1/usage?period=day&tz=UTC", headers: phone })).json();
  assert.equal(usage.totals.requests, 2);
  assert.equal(usage.totals.estimated_requests, 1);
  assert.deepEqual(usage.by_source.map((row: { source: string }) => row.source).sort(), ["agent", "code"]);
  assert.equal(usage.by_device[0].device, "this-computer");
  // The estimated call has no speed: 200 tokens in 10 s is the timed one's.
  assert.equal(usage.speed.generation_tps_avg, 20);
  assert.equal(usage.speed.ttft_ms_p50, 950);
  clearEvents();
});

test("periods follow the time zone: Paris's day starts at 22:00 UTC in summer, weeks on Monday, 25 hours when clocks go back", () => {
  const now = Date.parse("2026-09-29T10:00:00Z"); // a Tuesday, noon in Paris
  const day = periodRange("day", "Europe/Paris", 0, now);
  assert.equal(new Date(day.from).toISOString(), "2026-09-28T22:00:00.000Z");
  assert.equal(day.buckets.length, 24);
  assert.equal(new Date(periodRange("week", "Europe/Paris", 0, now).from).toISOString(), "2026-09-27T22:00:00.000Z");
  assert.equal(new Date(periodRange("week", "Europe/Paris", 1, now).from).toISOString(), "2026-09-20T22:00:00.000Z");
  assert.equal(periodRange("month", "Europe/Paris", 0, now).buckets.length, 30);
  const year = periodRange("year", "Europe/Paris", 0, now);
  assert.equal(year.buckets.length, 12);
  assert.equal(new Date(year.from).toISOString(), "2025-12-31T23:00:00.000Z");
  assert.equal(periodRange("day", "Europe/Paris", 0, Date.parse("2026-10-25T12:00:00Z")).buckets.length, 25);
  assert.equal(periodRange("day", "Europe/Paris", 0, Date.parse("2026-03-29T12:00:00Z")).buckets.length, 23);
  const january = periodRange("month", "Europe/Paris", 8, now);
  assert.equal(new Date(january.from).toISOString(), "2025-12-31T23:00:00.000Z");

  const base = { userId: owner, source: "chat" as const, model: "Qwen3.5-9B", client: "iPhone" };
  // 00:30 in Paris on the 29th, but still the 28th in UTC.
  recordUsageEvent({ ...base, at: new Date("2026-09-28T22:30:00Z"), promptTokens: 100, completionTokens: 10, generationMs: 1000 });
  // 23:30 in Paris on the 28th.
  recordUsageEvent({ ...base, at: new Date("2026-09-28T21:30:00Z"), promptTokens: 7, completionTokens: 7 });

  const paris = periodUsage(owner, "day", "Europe/Paris", 0, now);
  assert.equal(paris.bucket, "hour");
  assert.equal(paris.series.length, 24);
  assert.equal(paris.totals.requests, 1);
  assert.equal(paris.series[0].prompt_tokens, 100);
  assert.equal(paris.series[0].generation_tps, 10);
  assert.ok(paris.series.slice(1).every((point) => point.requests === 0));
  assert.equal(paris.previous.totals.requests, 1);
  assert.equal(paris.previous.totals.prompt_tokens, 7);

  const utc = periodUsage(owner, "day", "UTC", 0, now);
  assert.equal(utc.totals.requests, 0);
  assert.equal(utc.previous.totals.requests, 2);

  const week = periodUsage(owner, "week", "Europe/Paris", 0, now);
  assert.equal(week.bucket, "day");
  assert.equal(week.series.length, 7);
  assert.deepEqual(week.series.map((point) => point.requests), [1, 1, 0, 0, 0, 0, 0]);
  assert.equal(week.by_model[0].model, "Qwen3.5-9B");
  clearEvents();
});

test("GET /usage?period= validates what it is asked, and ?days= keeps its shape", async () => {
  for (const url of ["/api/v1/usage?period=decade", "/api/v1/usage?period=day&tz=Mars/Olympus", "/api/v1/usage?period=day&offset=-1"]) {
    assert.equal((await app.inject({ method: "GET", url, headers: phone })).statusCode, 422, url);
  }
  const current = (await app.inject({ method: "GET", url: "/api/v1/usage?period=year&tz=Europe/Paris&offset=1", headers: phone })).json();
  assert.equal(current.bucket, "month");
  assert.equal(current.series.length, 12);
  assert.ok(current.previous.totals);
  const old = (await app.inject({ method: "GET", url: "/api/v1/usage?days=7", headers: phone })).json();
  assert.deepEqual(Object.keys(old).sort(), ["by_day", "by_device", "by_model", "days", "totals"]);
});

test("the export is one CSV line per call, formulas defused", async () => {
  recordUsageEvent({ userId: owner, source: "code", model: "=cmd|' /C calc'!A0", client: "this-computer", promptTokens: 10, completionTokens: 20, generationMs: 2000, at: new Date("2026-09-10T08:00:00Z") });
  recordUsageEvent({ userId: owner, source: "memory", model: "qwen, 3", client: null, promptTokens: 5, completionTokens: 1, estimated: true, at: new Date("2026-09-11T08:00:00Z") });
  const response = await app.inject({ method: "GET", url: "/api/v1/usage/export.csv?from=2026-09-01T00:00:00Z&to=2026-10-01T00:00:00Z", headers: phone });
  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers["content-type"]), /^text\/csv/);
  assert.match(String(response.headers["content-disposition"]), /attachment; filename="twoody-usage-2026-09-01-2026-09-30.csv"/);
  const lines = response.body.trimEnd().split("\r\n");
  assert.equal(lines[0], "id,at,source,model,client,prompt_tokens,completion_tokens,cached_tokens,prompt_ms,generation_ms,ttft_ms,generation_tps,estimated");
  assert.equal(lines.length, 3);
  assert.match(lines[1], /,2026-09-10T08:00:00.000Z,code,'=cmd\|' \/C calc'!A0,this-computer,10,20,,,2000,,10,false$/);
  assert.match(lines[2], /,memory,"qwen, 3",,5,1,,,,,,true$/);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/usage/export.csv?from=nope", headers: phone })).statusCode, 422);
  const byPeriod = await app.inject({ method: "GET", url: "/api/v1/usage/export.csv?period=month&tz=UTC", headers: phone });
  assert.equal(byPeriod.statusCode, 200);
  clearEvents();
});

test("the machine's load: reported by the desktop app, read by the phone", async () => {
  const now = Date.now();
  const samples = [0, 1, 2, 3].map((i) => ({ at: new Date(now - (4 - i) * 15_000).toISOString(), cpu_pct: 10 + i, ram_used_bytes: 8e9, ram_total_bytes: 16e9, gpu_pct: i === 0 ? null : 50, runtime_rss_bytes: 6e9, app_rss_bytes: 5e8 }));
  const machine = { cpu_model: "Apple M4 Pro", cores: 14, ram_total_bytes: 16e9, gpu_name: "Apple M4 Pro", os: "macOS 27.0" };
  const posted = await app.inject({ method: "POST", url: "/api/v1/usage/samples", headers: desktop, payload: { machine, samples } });
  assert.equal(posted.statusCode, 201, posted.body);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/samples", headers: desktop, payload: { machine } })).statusCode, 201);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/samples", headers: phone, payload: { samples } })).statusCode, 403);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/usage/samples", headers: desktop, payload: { samples: [{ ...samples[0], cpu_pct: 140 }] } })).statusCode, 422);
  recordUsageEvent({ userId: owner, source: "code", model: "Qwen3-14B", client: "this-computer", promptTokens: 100, completionTokens: 300, generationMs: 10_000, ttftMs: 400 });

  const perf = (await app.inject({ method: "GET", url: "/api/v1/usage/performance?range=1h", headers: phone })).json();
  assert.deepEqual(perf.machine, machine);
  assert.equal(perf.step_seconds, 15);
  assert.equal(perf.samples.length, 4);
  assert.deepEqual(Object.keys(perf.samples[0]).sort(), ["app_rss_bytes", "cpu_pct", "gpu_pct", "ram_used_bytes", "runtime_rss_bytes", "t"]);
  assert.equal(perf.samples[0].gpu_pct, null);
  assert.equal(perf.samples[3].cpu_pct, 13);
  assert.equal(perf.generation.length, 1);
  assert.equal(perf.generation[0].tps, 30);
  assert.equal(perf.generation[0].model, "Qwen3-14B");
  const day = (await app.inject({ method: "GET", url: "/api/v1/usage/performance?range=24h", headers: phone })).json();
  assert.ok(day.samples.length >= 1 && day.samples.length <= 2);
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/usage/performance?range=2y", headers: phone })).statusCode, 422);
  clearEvents();
});

test("retention: 15-s samples past 48 h become 5-min averages, averages past 30 days go", () => {
  db.delete(usageSamples).run();
  const now = new Date("2026-09-29T12:00:00Z");
  const old = Date.parse("2026-09-27T10:00:00Z"); // 50 h before, a 5-min boundary
  const sample = (at: number, cpu: number) => ({ at: new Date(at), cpuPct: cpu, ramUsedBytes: 1000, ramTotalBytes: 4000, gpuPct: null, runtimeRssBytes: null, appRssBytes: 300 });
  recordSamples(owner, [sample(old, 10), sample(old + 15_000, 20), sample(old + 60_000, 30), sample(old + 300_000, 90), sample(now.getTime() - 3600_000, 50)]);
  db.insert(usageSamples).values({ userId: owner, at: new Date(now.getTime() - 31 * 86_400_000), spanS: 300, cpuPct: 1 }).run();

  assert.deepEqual(compactUsageSamples(now), { averaged: 2, dropped: 1 });
  const rows = db.select().from(usageSamples).all().sort((a, b) => a.at.getTime() - b.at.getTime());
  assert.deepEqual(rows.map((row) => [row.at.toISOString(), row.spanS, row.cpuPct]), [
    ["2026-09-27T10:00:00.000Z", 300, 20],
    ["2026-09-27T10:05:00.000Z", 300, 90],
    ["2026-09-29T11:00:00.000Z", 15, 50],
  ]);
  assert.equal(rows[0].gpuPct, null);
  assert.equal(rows[0].appRssBytes, 300);
  // Run again: nothing more to do.
  assert.deepEqual(compactUsageSamples(now), { averaged: 0, dropped: 0 });
});
