import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatMessages, type ChatContextInput } from "../src/chatContext.js";

// Local-time constructor so the expected weekday holds in any timezone.
const NOW = new Date(2026, 8, 21, 10, 0, 0);

function input(overrides: Partial<ChatContextInput> = {}): ChatContextInput {
  return {
    userName: "Camille",
    prefs: {},
    history: [],
    memories: [],
    content: "Bonjour",
    local: true,
    now: NOW,
    ...overrides,
  };
}

test("first turn: system prompt then the prompt", () => {
  const messages = buildChatMessages(input());
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, "system");
  assert.match(messages[0].content, /running entirely on the user's own computer/);
  assert.match(messages[0].content, /Today is Monday 21 September 2026\./);
  assert.match(messages[0].content, /The user's name is Camille\./);
  assert.deepEqual(messages[1], { role: "user", content: "Bonjour" });
});

test("a cloud turn does not claim the conversation stays on the machine", () => {
  const [system] = buildChatMessages(input({ local: false }));
  assert.doesNotMatch(system.content, /own computer|stays on that machine/);
});

test("history is replayed in order before the new prompt", () => {
  const messages = buildChatMessages(input({
    history: [
      { role: "user", content: "Mon client s'appelle Dupont." },
      { role: "assistant", content: "Noté." },
    ],
    content: "Comment s'appelle mon client ?",
  }));
  assert.deepEqual(messages.slice(1), [
    { role: "user", content: "Mon client s'appelle Dupont." },
    { role: "assistant", content: "Noté." },
    { role: "user", content: "Comment s'appelle mon client ?" },
  ]);
});

test("an unanswered prompt is folded into the new one so roles alternate", () => {
  const messages = buildChatMessages(input({
    history: [
      { role: "user", content: "Première question" },
      { role: "assistant", content: "Réponse" },
      { role: "user", content: "Question restée sans réponse" },
    ],
    content: "Nouvelle question",
  }));
  const roles = messages.map((message) => message.role);
  assert.deepEqual(roles, ["system", "user", "assistant", "user"]);
  assert.equal(messages[3].content, "Question restée sans réponse\n\nNouvelle question");
});

test("history never starts with an assistant turn and skips unknown roles", () => {
  const messages = buildChatMessages(input({
    history: [
      { role: "assistant", content: "Orphan reply" },
      { role: "tool", content: "ignored" },
      { role: "user", content: "Question" },
      { role: "assistant", content: "Answer" },
    ],
  }));
  assert.deepEqual(messages.map((message) => message.role), ["system", "user", "assistant", "user"]);
  assert.equal(messages[1].content, "Question");
});

test("history keeps the newest messages within the character budget", () => {
  const history = [];
  for (let i = 0; i < 40; i += 1) {
    history.push({ role: "user", content: `question ${i} ${"x".repeat(900)}` });
    history.push({ role: "assistant", content: `answer ${i} ${"y".repeat(900)}` });
  }
  const messages = buildChatMessages(input({ history }));
  const replayed = messages.slice(1, -1);
  const chars = replayed.reduce((sum, message) => sum + message.content.length, 0);
  assert.ok(chars <= 16_000, `history is ${chars} chars`);
  assert.ok(replayed.length <= 20);
  assert.match(replayed[replayed.length - 1].content, /^answer 39 /);
  assert.equal(replayed[0].role, "user");
});

test("an oversized message is truncated rather than dropped", () => {
  const messages = buildChatMessages(input({
    history: [
      { role: "user", content: "a".repeat(10_000) },
      { role: "assistant", content: "ok" },
    ],
  }));
  assert.equal(messages[1].content.length, 4_000);
  assert.ok(messages[1].content.endsWith("…"));
});

test("profile memories go in the system prompt, topic memories only when they match", () => {
  const memories = [
    { kind: "user", title: "Métier", content: "Avocate en propriété intellectuelle." },
    { kind: "project", title: "Dossier Dupont", content: "Litige de brevet, audience le 3 octobre." },
    { kind: "reference", title: "Recette", content: "Tarte aux pommes de mamie." },
  ];
  const messages = buildChatMessages(input({
    memories,
    content: "Où en est le dossier Dupont ?",
  }));

  assert.match(messages[0].content, /- Métier: Avocate en propriété intellectuelle\./);
  assert.doesNotMatch(messages[0].content, /Dupont|Tarte/);

  const prompt = messages[messages.length - 1].content;
  assert.match(prompt, /^\[Saved notes that may be relevant\]\n- Dossier Dupont: Litige de brevet/);
  assert.doesNotMatch(prompt, /Tarte/);
  assert.ok(prompt.endsWith("Où en est le dossier Dupont ?"));
});

test("memory matching ignores accents and case", () => {
  const messages = buildChatMessages(input({
    memories: [{ kind: "project", title: null, content: "Le DÉLAI de réponse est de deux mois." }],
    content: "quel delai pour repondre",
  }));
  assert.match(messages[messages.length - 1].content, /DÉLAI de réponse/);
});

test("memory_enabled=false injects no memory at all", () => {
  const messages = buildChatMessages(input({
    prefs: { memory_enabled: false },
    memories: [
      { kind: "user", title: null, content: "Secret profile fact" },
      { kind: "project", title: null, content: "Dossier Dupont" },
    ],
    content: "dossier Dupont",
  }));
  assert.doesNotMatch(messages[0].content, /Secret profile fact/);
  assert.equal(messages[1].content, "dossier Dupont");
});

test("a custom system prompt is appended, or replaces the base when asked", () => {
  const appended = buildChatMessages(input({ prefs: { system_prompt: "Tutoie-moi." } }))[0].content;
  assert.match(appended, /You are Twoody/);
  assert.match(appended, /Tutoie-moi\./);

  const replaced = buildChatMessages(input({
    prefs: { system_prompt: "Tu es un juriste.", system_prompt_replace_base: true },
  }))[0].content;
  assert.doesNotMatch(replaced, /You are Twoody/);
  assert.match(replaced, /^Tu es un juriste\./);
  assert.match(replaced, /Today is/);
});

test("the system prompt is identical across turns of the same day (prefix cache)", () => {
  const first = buildChatMessages(input({ content: "un" }))[0].content;
  const second = buildChatMessages(input({
    content: "deux",
    history: [{ role: "user", content: "un" }, { role: "assistant", content: "ok" }],
    now: new Date(2026, 8, 21, 20, 30, 0),
  }))[0].content;
  assert.equal(first, second);
});

test("a small window gets less history than the defaults, made for 32 000 tokens", () => {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", content: `${i} ${"mot ".repeat(400)}` }));
  const roomy = buildChatMessages(input({ history, content: "Et alors ?" }));
  const small = buildChatMessages(input({ history, content: "Et alors ?", contextWindow: 8_192 }));
  const size = (messages: Array<{ content: string }>) => messages.slice(1).reduce((total, message) => total + message.content.length, 0);
  assert.ok(size(roomy) > 12_000);
  assert.ok(size(small) <= 8_602 + "Et alors ?".length + 2, `${size(small)}`);
  assert.equal(small.at(-1)?.content.endsWith("Et alors ?"), true);
});
