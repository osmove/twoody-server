import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The effort the person chooses — Rapide, Réfléchi, Approfondi — as the
// server turns it into the model's reasoning: on or off, shown as it
// comes, cut past its budget, kept with the answer.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-reasoning-"));

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");

type Chat = {
  messages: Array<{ role: string; content: string }>;
  chat_template_kwargs?: { enable_thinking?: boolean };
  thinking_budget_tokens?: number;
  max_tokens?: number;
};
const asked: Chat[] = [];
/// How the fake runtime reasons: in mlx-lm's field, between <think> tags,
/// or on and on until it is cut.
let style: "field" | "tags" | "endless" = "field";

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3", object: "model" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    const body = JSON.parse(raw) as Chat;
    asked.push(body);
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.on("error", () => undefined);
    const send = (delta: object) => res.write(`data: ${JSON.stringify({ choices: [{ delta }] })}\n\n`);
    const thinking = body.chat_template_kwargs?.enable_thinking === true;
    if (thinking && style === "field") {
      for (const part of ["Le préavis ", "est de trois mois ", "selon l'article 7."]) send({ reasoning: part });
    }
    if (thinking && style === "tags") send({ content: "<think>Je relis l'article 7.</think>\n\n" });
    if (thinking && style === "endless") {
      for (let i = 0; i < 200 && !res.destroyed; i += 1) {
        send({ reasoning: "Je réfléchis encore à la question posée, sous tous ses angles. " });
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
      res.end();
      return;
    }
    send({ content: thinking ? "Trois mois." : "Trois mois, sans détour." });
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: `${url}/v1`, model: "qwen3", name: "mlx-lm" } })).statusCode, 201);

test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

async function ask(effort?: string) {
  forgetRuntimeProbes();
  const response = await app.inject({ method: "POST", url: "/queries", headers, payload: { text: "Quel préavis ?", channel: "desktop", force_new_discussion: true, effort } });
  assert.equal(response.statusCode, 200, response.body);
  const events = response.body.split("\n\n").filter((block) => block.startsWith("event: "));
  const data = (name: string) => events.filter((block) => block.startsWith(`event: ${name}`)).map((block) => block.slice(block.indexOf("data: ") + 6));
  const final = JSON.parse(data("final")[0]) as { discussion_id: string; message: string; reasoning_ms: number | null };
  return { final, reasoning: data("reasoning").join(""), answer: data("message").join("") };
}

test("Rapide: no reasoning asked for, none shown", async () => {
  const { final, reasoning } = await ask();
  assert.equal(asked.at(-1)!.chat_template_kwargs?.enable_thinking, false);
  assert.equal(asked.at(-1)!.thinking_budget_tokens, undefined);
  assert.equal(reasoning, "");
  assert.equal(final.message, "Trois mois, sans détour.");
  assert.equal(final.reasoning_ms, null);
});

test("Réfléchi: the reasoning is sent as it comes and kept with the answer", async () => {
  style = "field";
  const { final, reasoning } = await ask("think");
  assert.equal(asked.at(-1)!.chat_template_kwargs?.enable_thinking, true);
  assert.equal(asked.at(-1)!.thinking_budget_tokens, 1_000, "llama.cpp ends it there itself");
  assert.equal(reasoning, "Le préavis est de trois mois selon l'article 7.");
  assert.equal(final.message, "Trois mois.");
  assert.equal(typeof final.reasoning_ms, "number");
  const opened = (await app.inject({ method: "GET", url: `/discussions/${final.discussion_id}`, headers })).json();
  assert.equal(opened.messages[1].reasoning, "Le préavis est de trois mois selon l'article 7.");

  style = "tags";
  const tagged = await ask("deep");
  assert.equal(asked.at(-1)!.thinking_budget_tokens, 4_000);
  assert.equal(tagged.reasoning, "Je relis l'article 7.");
  assert.equal(tagged.final.message, "Trois mois.");
});

test("past its budget, the reasoning is cut and the model answers from it", async () => {
  style = "endless";
  const before = asked.length;
  const { final, reasoning } = await ask("think");
  const [first, second] = asked.slice(before);
  assert.equal(first.chat_template_kwargs?.enable_thinking, true);
  assert.equal(second.chat_template_kwargs?.enable_thinking, false, "asked again, to answer");
  assert.match(second.messages.at(-1)!.content, /^Quel préavis \?\n\n\[Your reasoning so far, cut to answer in time:\]\nJe réfléchis encore/);
  assert.ok(reasoning.length > 3_500 && reasoning.length < 5_000, `${reasoning.length}`);
  assert.equal(final.message, "Trois mois, sans détour.");
});
