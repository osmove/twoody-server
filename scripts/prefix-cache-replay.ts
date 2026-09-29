// Replays a 30-turn conversation through /queries against a real
// OpenAI-compatible runtime (llama-server) and says, for each turn, how
// many prompt tokens the runtime read (prompt_n) and how many it found in
// its cache (cache_n): whether a turn reads only its new tokens.
//
//   npx tsx scripts/prefix-cache-replay.ts http://127.0.0.1:18110/v1 Qwen3.5-9B-Q4_K_M [context_window]
//
// Personal messages on the way (« je m'appelle… », « ma fille… ») make
// the server learn memories mid-conversation, as it does after an answer.
// A recording proxy sits between the server and the runtime; nothing of
// the person's own data is used (a fresh data folder).

import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const target = (process.argv[2] ?? "http://127.0.0.1:18110/v1").replace(/\/$/, "");
const model = process.argv[3] ?? "Qwen3.5-9B-Q4_K_M";
const contextWindow = Number(process.argv[4] ?? 16_384);

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-cache-replay-"));
process.env.TWOODY_LOCAL_MAX_TOKENS ??= "160";

type Call = { purpose: "chat" | "background"; body: { messages: Array<{ role: string; content: string }> }; prompt_n?: number; cache_n?: number; prompt_ms?: number };
const calls: Call[] = [];
let inflight = 0;

const proxy = createServer((req: IncomingMessage, res: ServerResponse) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    inflight += 1;
    try {
      const upstream = await fetch(target + req.url!.replace(/^\/v1/, ""), {
        method: req.method,
        headers: { "content-type": "application/json" },
        body: req.method === "POST" ? raw : undefined,
      });
      const text = await upstream.text();
      if (req.method === "POST" && req.url!.endsWith("/chat/completions")) {
        const body = JSON.parse(raw) as Call["body"];
        const system = body.messages[0]?.content ?? "";
        const call: Call = { purpose: system.startsWith("You extract lasting facts") ? "background" : "chat", body };
        for (const line of text.split("\n")) {
          if (!line.startsWith("data: ") || line.includes("[DONE]")) continue;
          try {
            const event = JSON.parse(line.slice(6)) as { timings?: { prompt_n?: number; cache_n?: number; prompt_ms?: number } };
            if (event.timings) Object.assign(call, { prompt_n: event.timings.prompt_n, cache_n: event.timings.cache_n, prompt_ms: event.timings.prompt_ms });
          } catch {
            // not an event
          }
        }
        calls.push(call);
      }
      res.writeHead(upstream.status, { "content-type": upstream.headers.get("content-type") ?? "application/json" });
      res.end(text);
    } catch (err) {
      res.writeHead(502);
      res.end(String(err));
    } finally {
      inflight -= 1;
    }
  });
});
await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
const proxyUrl = `http://127.0.0.1:${(proxy.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, discussions } = await import("../src/db.js");
const { eq } = await import("drizzle-orm");
const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url: proxyUrl, model, name: "llama.cpp" } });

const QUESTIONS = [
  "Bonjour ! Je m'appelle Camille et je travaille comme architecte à Lyon.",
  "Peux-tu m'expliquer en trois phrases ce qu'est un permis de construire ?",
  "Quels documents faut-il joindre à une demande de permis ? Liste courte.",
  "Combien de temps dure l'instruction, en général ?",
  "Et pour une déclaration préalable de travaux ?",
  "Ma fille s'appelle Léa, elle a sept ans et adore le dessin.",
  "Propose-moi une activité créative à faire avec elle ce week-end.",
  "Il faudrait quel matériel pour cette activité ?",
  "Revenons au travail : qu'est-ce qu'un plan de masse ?",
  "Et un plan de coupe, à quoi sert-il ?",
  "Quelle échelle utilise-t-on d'habitude pour ces plans ?",
  "Je préfère les réponses courtes avec des listes à puces.",
  "Donne-moi trois conseils pour présenter un projet à un client.",
  "Comment gérer un client qui change souvent d'avis ?",
  "Rédige un court e-mail pour reporter une réunion à jeudi.",
  "Rends-le un peu plus formel.",
  "Quelles sont les normes d'accessibilité principales pour un ERP ?",
  "Résume-les en une phrase.",
  "J'habite à Villeurbanne depuis cinq ans.",
  "Quels sont les bons quartiers pour un bureau d'architecte à Lyon ?",
  "Et côté transports en commun ?",
  "Quel logiciel de CAO conseilles-tu pour une petite agence ?",
  "Compare rapidement Revit et ArchiCAD.",
  "Lequel est le moins cher ?",
  "Mon mari s'appelle Thomas et il est ingénieur.",
  "Suggère une idée de sortie à Lyon pour nous trois.",
  "Et s'il pleut ?",
  "Rappelle-moi ce que tu sais de ma famille.",
  "Et de mon travail ?",
  "Merci ! Un dernier conseil pour bien finir la semaine ?",
];

async function settle() {
  // The memory extraction runs after the answer: waited for, so that each
  // turn starts from the same state.
  for (let i = 0; i < 600 && inflight > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
  await new Promise((resolve) => setTimeout(resolve, 200));
  for (let i = 0; i < 600 && inflight > 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 100));
}

let discussionId: string | undefined;
const rows: Array<{ turn: number; prompt_n?: number; cache_n?: number; prompt_ms?: number; background: number; prefix: boolean }> = [];
let previous: Call | null = null;
let liveFrom: string | null | undefined;
for (const [index, text] of QUESTIONS.entries()) {
  const before = calls.length;
  const response = await app.inject({
    method: "POST",
    url: "/queries",
    headers,
    payload: { text, channel: "desktop", context_window: contextWindow, ...(discussionId ? { discussion_id: discussionId } : { force_new_discussion: true }) },
  });
  const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"));
  if (!final) throw new Error(`turn ${index + 1}: ${response.body.slice(-400)}`);
  discussionId ??= (JSON.parse(final.slice(final.indexOf("data: ") + 6)) as { discussion_id: string }).discussion_id;
  await settle();
  const made = calls.slice(before);
  const chat = made.find((call) => call.purpose === "chat")!;
  // A cut of the history, as the discussion's context state declares it
  // (absent before these states existed).
  const [row] = db.select().from(discussions).where(eq(discussions.id, discussionId)).all() as Array<{ contextJson?: string | null }>;
  const state = row?.contextJson ? (JSON.parse(row.contextJson) as { liveFrom?: string | null }) : null;
  const cut = index > 0 && state !== null && state.liveFrom !== liveFrom;
  liveFrom = state?.liveFrom;
  const prefix = previous !== null && JSON.stringify(chat.body.messages.slice(0, previous.body.messages.length)) === JSON.stringify(previous.body.messages);
  rows.push({ turn: index + 1, prompt_n: chat.prompt_n, cache_n: chat.cache_n, prompt_ms: chat.prompt_ms, background: made.length - 1, prefix });
  previous = chat;
  console.log(`turn ${String(index + 1).padStart(2)}  prompt_n ${String(chat.prompt_n).padStart(5)}  cache_n ${String(chat.cache_n).padStart(5)}  prompt_ms ${String(Math.round(chat.prompt_ms ?? 0)).padStart(6)}  background ${made.length - 1}  prefix ${prefix ? "kept" : "BROKEN"}${cut ? " (declared cut)" : ""}`);
}

const sum = (key: "prompt_n" | "cache_n" | "prompt_ms") => rows.reduce((total, row) => total + (row[key] ?? 0), 0);
console.log(`total  prompt_n ${sum("prompt_n")}  cache_n ${sum("cache_n")}  prompt_ms ${Math.round(sum("prompt_ms"))}  turns with prefix broken: ${rows.filter((row) => row.turn > 1 && !row.prefix).map((row) => row.turn).join(", ") || "none"}`);
await app.close();
proxy.close();
