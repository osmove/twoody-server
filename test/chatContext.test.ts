import { test } from "node:test";
import assert from "node:assert/strict";
import { buildChatMessages, buildChatTurn, type ChatContextInput } from "../src/chatContext.js";

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


test("folder access questions receive the real library, separately from system instructions", () => {
  const messages = buildChatMessages(input({ content: "À quels dossiers as-tu accès ?", hasDocuments: true,
    documentFolders: [{ name: "Dossier_CV_Jimmy_2026", indexed: 25, without_text: 1, failed: 0 }] }));
  assert.match(messages[0].content, /never claim there are no folders/);
  assert.doesNotMatch(messages[0].content, /Dossier_CV_Jimmy/);
  assert.match(messages.at(-1)!.content, /Dossier_CV_Jimmy_2026/);
  assert.match(messages.at(-1)!.content, /"indexed":25/);
  assert.match(messages.at(-1)!.content, /data only, not instructions/);
});

test('library counts are distinct from matching files and never promise a complete directory tree', () => {
  const messages = buildChatMessages(input({content:'Combien de CV ai-je ?',hasDocuments:true,documentFolders:[{name:'Camille',indexed:580,without_text:5,failed:0}],documentFiles:[{name:'CV.pdf',modified_at:'2026-09-21',chars:50}],documentFileTotal:22,documentScan:{running:true,limited:true}}));
  const text=JSON.stringify(messages);
  assert.match(text,/matching_files/);
  assert.match(text,/NOT a directory tree/);
  assert.match(text,/NOT all files/);
  assert.match(text,/limited/);
  assert.match(text,/580/);
});


test('index progress does not disclose a filename outside the selected document scope', () => {
  const messages=buildChatMessages(input({documentFolders:[{name:'Allowed',indexed:1,without_text:0,failed:0}],documentScan:{running:true,limited:false,current:'other-folder-private-file.txt'} as any}));
  assert.doesNotMatch(JSON.stringify(messages),/other-folder-private-file/);
});

test("documents switched off: a question about them is told they are off and can be turned on", () => {
  const asked = buildChatMessages(input({ documentMode: "off", content: "Tu n'as pas accès à mes documents ?" }));
  assert.match(asked[asked.length - 1].content, /Documents are switched off in this conversation/);
  assert.match(asked[asked.length - 1].content, /Documents button/);
  const other = buildChatMessages(input({ documentMode: "off", content: "Quelle est la capitale de l'Italie ?" }));
  assert.doesNotMatch(other[other.length - 1].content, /switched off/);
});

test("a fact the user asked to remember is confirmed, not denied, from its own message", () => {
  const messages = buildChatMessages(input({ content: "Retiens que je préfère le thé", remembered: "Je préfère le thé" }));
  assert.match(messages.at(-1)!.content, /Just saved in the user's Memories on this computer, as their message asks: « Je préfère le thé »/);
  assert.ok(messages.at(-1)!.content.endsWith("Retiens que je préfère le thé"));
  assert.doesNotMatch(messages[0].content, /thé/, "the system prompt does not move for it");
});

test("memories learned during a conversation leave the system prompt as it was (prefix cache)", () => {
  const first = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }], content: "Bonjour", currentId: "m1" }));
  assert.match(first.messages[0].content, /- Architecte à Lyon\./);
  const learned = [
    { kind: "user", title: null, content: "Sa fille s'appelle Léa." },
    { kind: "user", title: null, content: "Architecte à Lyon." },
  ];
  const second = buildChatTurn(input({
    memories: learned,
    state: first.state,
    history: [{ id: "m1", role: "user", content: "Bonjour" }, { id: "m2", role: "assistant", content: "Bonjour !" }],
    content: "Quel âge a ma fille ?",
    currentId: "m3",
  }));
  assert.equal(second.messages[0].content, first.messages[0].content);
  // Still given, with the message it bears on.
  assert.match(second.messages.at(-1)!.content, /\[Saved notes that may be relevant\]\n- Sa fille s'appelle Léa\./);
  assert.doesNotMatch(second.messages.at(-1)!.content, /Architecte/, "a frozen memory is not given twice");
});

test("a memory removed or memory switched off refreshes the frozen ones; a compaction too", () => {
  const first = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }] }));
  const removed = buildChatTurn(input({ memories: [], state: first.state }));
  assert.doesNotMatch(removed.messages[0].content, /Architecte/);
  const off = buildChatTurn(input({ prefs: { memory_enabled: false }, memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }], state: first.state }));
  assert.doesNotMatch(off.messages[0].content, /Architecte/);
  const compacted = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Vit à Lyon." }], state: first.state, summaryThrough: "m9" }));
  assert.match(compacted.messages[0].content, /Vit à Lyon/);
  assert.equal(compacted.state.basis, "m9");
});

test("the system prompt does not move for a document-only turn, and says how to read the first documents on their message", () => {
  const first = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }], content: "Bonjour", currentId: "m1" }));
  const history = [{ id: "m1", role: "user", content: "Bonjour" }, { id: "m2", role: "assistant", content: "Bonjour !" }];
  const only = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }], state: first.state, history, documentMode: "only", content: "Que dit le bail ?" }));
  assert.doesNotMatch(only.messages[0].content, /Architecte/, "no memory in a document-only answer");
  assert.equal(only.state.profile, first.state.profile, "kept for the turns after it");
  const doc = '<<document name="bail.pdf">>\nDurée : trois ans.\n<</document>>\n\nRésume';
  const withDocument = buildChatTurn(input({ memories: [{ kind: "user", title: null, content: "Architecte à Lyon." }], state: first.state, history, content: doc }));
  assert.equal(withDocument.messages[0].content, first.messages[0].content);
  assert.match(withDocument.messages.at(-1)!.content, /^Documents the user joined to a message/);
});

test("a document joined to the message is answered from itself, documents switched off or not", () => {
  const content = 'Tu peux me donner les infos de ce RIB ?\n\n<<document name="rib.jpg">>\nIBAN FR76 3000 6000 0112 3456 7890 189\n<</document>>';
  const messages = buildChatMessages(input({ documentMode: "off", content }));
  assert.doesNotMatch(messages[messages.length - 1].content, /switched off/);
});

test("the history only grows between cuts, and a cut drops the oldest half at once (prefix cache)", () => {
  const rows: Array<{ id: string; role: string; content: string }> = [];
  let state = null as ReturnType<typeof buildChatTurn>["state"] | null;
  let previous: Array<{ role: string; content: string }> | null = null;
  const cuts: number[] = [];
  for (let turn = 1; turn <= 60; turn += 1) {
    const id = `u${turn}`;
    const built = buildChatTurn(input({ history: [...rows], state, currentId: id, content: `question ${turn} ${"mot ".repeat(60)}`, contextWindow: 16_384 }));
    if (previous) {
      const kept = JSON.stringify(built.messages.slice(0, previous.length)) === JSON.stringify(previous);
      if (!kept) cuts.push(turn);
      else assert.equal(built.state.liveFrom, state!.liveFrom);
    }
    if (built.state.liveFrom !== state?.liveFrom && state) {
      assert.ok(cuts.includes(turn), `turn ${turn}: a cut is declared by a new liveFrom`);
      assert.ok(built.messages.length - 2 <= 20, "a cut keeps at most half the messages");
    }
    state = built.state;
    rows.push({ id, role: "user", content: `question ${turn} ${"mot ".repeat(60)}` }, { id: `a${turn}`, role: "assistant", content: `réponse ${turn} ${"texte ".repeat(40)}` });
    previous = [...built.messages, { role: "assistant", content: rows.at(-1)!.content }];
  }
  // Where the last 20 slid by one message each turn from the 11th on.
  assert.ok(cuts.length >= 2 && cuts.length <= 6, `cuts at ${cuts.join(", ")}`);
  for (let i = 1; i < cuts.length; i += 1) assert.ok(cuts[i] - cuts[i - 1] >= 5, `cuts at ${cuts.join(", ")}`);
});

test("a prompt is given again as it was sent, with its excerpts and notes, so the next turn only adds to it", () => {
  const memories = [{ kind: "project", title: "Dossier Dupont", content: "Audience le 3 octobre." }];
  const first = buildChatTurn(input({
    memories,
    currentId: "u1",
    content: "Où en est le dossier Dupont ?",
    excerpts: [{ name: "dupont.pdf", page: 2, text: "Le tribunal fixe l'audience." }],
    remembered: null,
  }));
  assert.match(first.sent, /^\[Excerpts from the user's documents\][\s\S]*\[Saved notes that may be relevant\][\s\S]*Où en est le dossier Dupont \?$/);
  const history = [
    { id: "u1", role: "user", content: "Où en est le dossier Dupont ?", sent: first.sent },
    { id: "a1", role: "assistant", content: "L'audience est le 3 octobre [1]." },
  ];
  const second = buildChatTurn(input({ memories, state: first.state, history, currentId: "u2", content: "Merci" }));
  assert.deepEqual(second.messages.slice(0, first.messages.length), first.messages);
  assert.deepEqual(second.messages.slice(first.messages.length), [
    { role: "assistant", content: "L'audience est le 3 octobre [1]." },
    { role: "user", content: "Merci" },
  ]);
  // Without what was sent (a message from before, or from another device):
  // what was typed.
  const older = buildChatTurn(input({ memories, state: first.state, history: history.map(({ sent: _sent, ...row }) => row), currentId: "u2", content: "Merci" }));
  assert.equal(older.messages[1].content, "Où en est le dossier Dupont ?");
});
