import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The runtime's prompt cache, measured the way it sees it: a 30-turn
// conversation through /queries — memories learned on the way, a
// « retiens que… », notes matching later messages — against an
// OpenAI-compatible server that records every request. Each chat request
// must start with the exact messages of the one before (so the runtime
// reads only the new tokens), except at a cut of the history, which the
// discussion's context state declares (a new liveFrom).
// scripts/prefix-cache-replay.ts does the same against a real llama-server.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-prefix-cache-"));
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;

type Message = { role: string; content: string };
const chats: Message[][] = [];
let background = 0;

const server = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ data: [{ id: "qwen" }] }));
    return;
  }
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", () => {
    const { messages } = JSON.parse(raw) as { messages: Message[] };
    const extraction = messages[0].content.startsWith("You read a conversation between");
    let text: string;
    if (extraction) {
      background += 1;
      const said = messages[1].content.split("CONVERSATION:")[1]!;
      const learned = (text: string, evidence: string) => JSON.stringify({ facts: [{ text, evidence, kind: "user", category: "family", confidence: 0.9 }] });
      text = /Léa/.test(said) ? learned("Sa fille s'appelle Léa.", "Ma fille s'appelle Léa")
        : /Thomas/.test(said) ? learned("Son mari s'appelle Thomas.", "Mon mari s'appelle Thomas")
        : /architecte/.test(said) ? learned("Architecte à Lyon.", "je travaille comme architecte à Lyon")
        : '{"facts":[]}';
    } else {
      chats.push(messages);
      text = `Réponse ${chats.length}. ${"Une phrase de réponse assez longue pour remplir la fenêtre. ".repeat(6)}`;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { db, discussions, memories } = await import("../src/db.js");
const { eq } = await import("drizzle-orm");
const app = await buildApp();
test.after(async () => {
  await app.close();
  await new Promise((resolve) => server.close(resolve));
});

const QUESTIONS = [
  "Bonjour ! Je m'appelle Camille et je travaille comme architecte à Lyon.",
  "Explique-moi ce qu'est un permis de construire.",
  "Quels documents faut-il joindre ?",
  "Combien de temps dure l'instruction ?",
  "Ma fille s'appelle Léa, elle a sept ans.",
  "Propose une activité créative pour ma fille ce week-end.",
  "Quel matériel faut-il ?",
  "Retiens que je préfère les réponses courtes.",
  "Qu'est-ce qu'un plan de masse ?",
  "Et un plan de coupe ?",
  "Quelle échelle pour ces plans ?",
  "Mon mari s'appelle Thomas.",
  "Trois conseils pour présenter un projet à un client ?",
  "Comment gérer un client qui change d'avis ?",
  "Rédige un e-mail pour reporter une réunion.",
  "Plus formel.",
  "Les normes d'accessibilité d'un ERP ?",
  "Résume-les.",
  "Quels quartiers pour un bureau à Lyon ?",
  "Et les transports ?",
  "Quel logiciel de CAO pour une petite agence ?",
  "Compare Revit et ArchiCAD.",
  "Lequel est le moins cher ?",
  "Une sortie à Lyon pour ma fille et mon mari ?",
  "Et s'il pleut ?",
  "Que sais-tu de ma famille ?",
  "Et de mon travail d'architecte ?",
  "Un conseil pour finir la semaine ?",
  "Merci.",
  "À bientôt !",
];

test("30 turns with memories learned on the way: each request starts with the previous one, except at a declared cut", async () => {
  const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
  const headers = { authorization: `Bearer ${paired.json().token}` };
  assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers, payload: { url, model: "qwen", name: "llama.cpp" } })).statusCode, 201);

  let discussionId: string | undefined;
  let liveFrom: string | null = null;
  const declared: number[] = [];
  const broken: number[] = [];
  for (const [index, text] of QUESTIONS.entries()) {
    const response = await app.inject({
      method: "POST",
      url: "/queries",
      headers,
      // A small window, so that the history is cut on the way.
      payload: { text, channel: "desktop", context_window: 4_096, ...(discussionId ? { discussion_id: discussionId } : { force_new_discussion: true }) },
    });
    assert.equal(response.statusCode, 200, response.body);
    const final = response.body.split("\n\n").find((block) => block.startsWith("event: final"))!;
    discussionId ??= (JSON.parse(final.slice(final.indexOf("data: ") + 6)) as { discussion_id: string }).discussion_id;
    // What was said is learned between two turns, as after a pause
    // (src/memory/learner.ts).
    assert.equal((await app.inject({ method: "POST", url: "/memories/learn", headers, payload: { discussion_id: discussionId } })).statusCode, 200);

    const [row] = db.select({ contextJson: discussions.contextJson }).from(discussions).where(eq(discussions.id, discussionId)).all();
    const state = JSON.parse(row.contextJson!) as { liveFrom: string | null };
    if (index > 0) {
      if (state.liveFrom !== liveFrom) declared.push(index + 1);
      const [before, after] = [chats[index - 1], chats[index]];
      if (JSON.stringify(after.slice(0, before.length)) !== JSON.stringify(before)) broken.push(index + 1);
      else assert.equal(after[before.length].role, "assistant", `turn ${index + 1}: the answer, then the new message`);
    }
    liveFrom = state.liveFrom;
  }

  const learned = db.select({ content: memories.content }).from(memories).all().map((memory) => memory.content);
  assert.ok(learned.includes("Sa fille s'appelle Léa.") && learned.includes("Son mari s'appelle Thomas.") && learned.includes("Je préfère les réponses courtes"), learned.join(" | "));
  assert.ok(background >= 3, "memories were learned mid-conversation");
  assert.deepEqual(broken, declared, "the prefix breaks only where a cut is declared");
  assert.ok(declared.length >= 1 && declared.length <= 4, `cuts at turns ${declared.join(", ")}`);
  for (let i = 1; i < declared.length; i += 1) assert.ok(declared[i] - declared[i - 1] >= 4, `cuts at turns ${declared.join(", ")}`);
  // A memory learned on the way reaches the model with the message it bears
  // on, then in the system prompt from the next cut on.
  assert.doesNotMatch(chats[5][0].content, /Léa/);
  assert.match(chats[5].at(-1)!.content, /\[Saved notes that may be relevant\][\s\S]*Sa fille s'appelle Léa/);
  assert.match(chats.at(-1)![0].content, /What you know about the user, from their saved Memories[\s\S]*Sa fille s'appelle Léa/);
});
