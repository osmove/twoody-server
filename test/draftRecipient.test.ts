import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Dis à maman que je serai en retard », « oui »: whom the e-mail goes to,
// found by the server in the person's Memories, entity graph, Contacts and
// e-mails — in the ten languages of the app (10/10/2026: Qwen3.5 9B asked
// for Mum's address in ja, it, pt, ko and en although the Memories held
// it) — and, the draft refused at the approval step, an answer that cannot
// say it was saved (3 of 14 refused drafts did, in de and fr).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-draft-recipient-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { relinkMemories } = await import("../src/memory/entities.js");
const { relativeIn, resolveRecipient, recipientFor, recipientBlock, addressesIn } = await import("../src/email/recipient.js");
const { emailsAgreedTo, runEmailTool, refusedDraft, claimsDraftSaved, answerAfterRefusal, NOT_SAVED, subjectFromBody } = await import("../src/email/chat.js");
const { passOnWithoutHow, agreedToDraft } = await import("../src/email/intent.js");
const { saveEmail, saveSource, upsertFolder, correspondentsNamed, addressInMailbox } = await import("../src/email/store.js");

const app = await buildApp();
test.after(() => app.close());
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;

/// « Tell Mum I'll be late » in each language, as the bench says it.
const TELL_MUM: Record<string, string> = {
  de: "Sag Mama, dass ich später komme", es: "Dile a mamá que llegaré tarde", ja: "ママに遅れるって伝えて", zh: "告诉妈妈我会晚点到",
  nl: "Zeg tegen mama dat ik later ben", it: "Di' alla mamma che farò tardi", pt: "Diga à mamãe que vou me atrasar", ko: "엄마한테 늦는다고 전해줘",
  fr: "Dis à maman que je serai en retard", en: "Tell Mom I'll be late",
};

const contact = (name: string, emails: string[], firstName: string | null = null, lastName: string | null = null) => ({ name, firstName, lastName, organization: null, phones: [], emails, birthday: null });
const none = () => [];

test("Mum, as each language calls her — and not a grandmother, a mother-in-law, a name, a daughter said without « my »", () => {
  for (const [lang, message] of Object.entries(TELL_MUM)) {
    const said = passOnWithoutHow(message)!.recipient;
    assert.equal(relativeIn(said)?.key, "mother", `${lang}: ${said}`);
  }
  for (const said of ["ma mère", "my mother", "meiner Mutter", "mi madre", "mia madre", "minha mãe", "mijn moeder", "母", "お母さん", "我妈", "母亲", "어머니", "maman", "Mutti", "mum"]) {
    assert.equal(relativeIn(said)?.key, "mother", said);
  }
  for (const [said, key] of [["papa", "father"], ["mon père", "father"], ["パパ", "father"], ["爸爸", "father"], ["아빠", "father"], ["ma sœur", "sister"], ["언니", "sister"], ["mon frère", "brother"],
    ["ma femme", "wife"], ["mein Mann", "husband"], ["老公", "husband"], ["ma fille", "daughter"], ["딸", "daughter"], ["mamie", "grandmother"], ["Oma", "grandmother"], ["おばあちゃん", "grandmother"],
    ["mon chef", "boss"], ["patron", "boss"], ["上司", "boss"]] as const) {
    assert.equal(relativeIn(said)?.key, key, said);
  }
  for (const said of ["Paul", "Paul Martin", "Maître Dupont", "fille", "Frau Müller", "René", "ポール", "保罗"]) assert.equal(relativeIn(said), null, said);
});

test("Mum's address from a memory written in French, asked for in each language: the memory's address, and her name's from Contacts and e-mails", () => {
  const sources = {
    memories: [{ content: "Ma mère s'appelle Nadine Douieb ; son e-mail : mama@example.com" }, { content: "Ma grand-mère vit à Nice, grandma@example.com" }, { content: "La mère de Paul s'appelle Anne, anne@example.com" }],
    contacts: [contact("Nadine Douieb", ["mama@example.com"], "Nadine", "Douieb"), contact("Paul Martin", ["paul.martin@example.com"], "Paul", "Martin")],
    entities: [],
    correspondents: (names: string[]) => names.some((name) => /Nadine Douieb/.test(name)) ? [{ name: "Nadine Douieb", address: "mama@example.com" }] : [],
  };
  for (const [lang, message] of Object.entries(TELL_MUM)) {
    const resolved = resolveRecipient(passOnWithoutHow(message)!.recipient, sources);
    assert.deepEqual(resolved.candidates.map((one) => one.address), ["mama@example.com"], lang);
    assert.deepEqual(resolved.candidates[0]!.from, ["Memories", "Contacts", "e-mails"], lang);
    assert.ok(resolved.names.includes("Nadine Douieb"), lang);
  }
});

test("memories in the other languages say Mum too; two addresses are both given; none is none", () => {
  const lone = (content: string, said: string) => resolveRecipient(said, { memories: [{ content }], contacts: [], entities: [], correspondents: none }).candidates.map((one) => one.address);
  assert.deepEqual(lone("Meine Mutter heißt Nadine, ihre E-Mail: nadine@example.de", "Mama"), ["nadine@example.de"]);
  assert.deepEqual(lone("Mi madre se llama Nadine (nadine@example.es)", "mamá"), ["nadine@example.es"]);
  assert.deepEqual(lone("Sua mãe: nadine@example.pt", "mamãe"), ["nadine@example.pt"]);
  assert.deepEqual(lone("Mijn moeder heet Nadine, nadine@example.nl", "mama"), ["nadine@example.nl"]);
  assert.deepEqual(lone("La mia mamma: nadine@example.it", "mamma"), ["nadine@example.it"]);
  assert.deepEqual(lone("母のメールアドレスは nadine@example.jp", "ママ"), ["nadine@example.jp"]);
  assert.deepEqual(lone("母親のメールアドレスは nadine@example.jp", "お母さん"), ["nadine@example.jp"]);
  assert.deepEqual(lone("母校の事務局: office@example.jp", "ママ"), [], "« 母校 » is a school");
  assert.deepEqual(lone("我妈妈的邮箱是 nadine@example.cn", "妈妈"), ["nadine@example.cn"]);
  assert.deepEqual(lone("엄마 이메일은 nadine@example.kr", "어머니"), ["nadine@example.kr"]);
  assert.deepEqual(lone("Mom's email is nadine@example.com", "my mother"), ["nadine@example.com"]);
  // Someone else's mother, a grandmother, a mother-in-law: not Mum.
  for (const content of ["La mère de Paul : anne@example.com", "Ma grand-mère : mamie@example.com", "Ma belle-mère : bm@example.com", "My mother-in-law: mil@example.com", "祖母のメール: sobo@example.jp", "시어머니 이메일: mil@example.kr"]) {
    assert.deepEqual(lone(content, "maman"), [], content);
  }
  // Two memories, two addresses: both, for the model to ask which.
  const two = resolveRecipient("maman", { memories: [{ content: "Ma mère : mama@example.com" }, { content: "Maman a une adresse pro : nadine@work.example" }], contacts: [], entities: [], correspondents: none });
  assert.deepEqual(two.candidates.map((one) => one.address).sort(), ["mama@example.com", "nadine@work.example"]);
  // One memory naming Mum and Dad: each their own address.
  const both = { memories: [{ content: "Ma mère : mama@example.com. Mon père : papa@example.com." }], contacts: [], entities: [], correspondents: none };
  assert.deepEqual(resolveRecipient("maman", both).candidates.map((one) => one.address), ["mama@example.com"]);
  assert.deepEqual(resolveRecipient("papa", both).candidates.map((one) => one.address), ["papa@example.com"]);
  // An archived memory (an import's whole answer) is not used.
  assert.deepEqual(resolveRecipient("maman", { memories: [{ content: "Ma mère : mama@example.com", archived: true }], contacts: [], entities: [], correspondents: none }).candidates, []);
  // A contact card called « Maman », « Mom », « お母さん ».
  assert.deepEqual(resolveRecipient("ママ", { memories: [], contacts: [contact("Maman", ["maman@example.fr"])], entities: [], correspondents: none }).candidates.map((one) => one.address), ["maman@example.fr"]);
  assert.deepEqual(resolveRecipient("Mom", { memories: [], contacts: [contact("お母さん", ["okaasan@example.jp"])], entities: [], correspondents: none }).candidates.map((one) => one.address), ["okaasan@example.jp"]);
});

test("a name: the contact, or every Paul when there are several", () => {
  const contacts = [contact("Paul Martin", ["paul.martin@example.com"], "Paul", "Martin"), contact("Paul Durand", ["pdurand@example.com"], "Paul", "Durand"), contact("René Dupont", ["rene@example.com"], "René", "Dupont")];
  const at = (said: string) => resolveRecipient(said, { memories: [], contacts, entities: [], correspondents: none }).candidates.map((one) => one.address).sort();
  assert.deepEqual(at("Paul"), ["paul.martin@example.com", "pdurand@example.com"]);
  assert.deepEqual(at("Paul Martin"), ["paul.martin@example.com"]);
  assert.deepEqual(at("René"), ["rene@example.com"]);
  assert.deepEqual(at("Maître Dupont"), ["rene@example.com"]);
  assert.deepEqual(at("Léa"), []);
});

test("the entity graph: « mère » from the person to Rachel, her linked memory's address; her alias « Mamounette »", async () => {
  const post = (entity: unknown) => app.inject({ method: "POST", url: "/api/v1/entities", headers, payload: { entity } });
  assert.equal((await post({ kind: "self", name: "Jimmy", relations: [{ to: "Rachel Cohen", label: "mère" }] })).statusCode, 201);
  assert.equal((await post({ kind: "person", name: "Rachel Cohen", aliases: ["Mamounette"] })).statusCode, 200, "the stub, filled in");
  const memory = await app.inject({ method: "POST", url: "/api/v1/memories", headers, payload: { memory: { content: "Rachel Cohen écrit depuis rachel.cohen@example.org" } } });
  assert.ok(memory.statusCode < 300, memory.body);
  relinkMemories(userId);
  for (const said of Object.values(TELL_MUM).map((message) => passOnWithoutHow(message)!.recipient)) {
    const resolved = recipientFor(userId, said, { memories: [], contacts: [] });
    assert.deepEqual(resolved.candidates.map((one) => one.address), ["rachel.cohen@example.org"], said);
  }
  assert.deepEqual(recipientFor(userId, "Mamounette", { memories: [], contacts: [] }).candidates.map((one) => one.address), ["rachel.cohen@example.org"]);
  // Her name on a contact card: its address too.
  assert.deepEqual(recipientFor(userId, "ママ", { memories: [], contacts: [contact("Rachel Cohen", ["rachel@home.example"], "Rachel", "Cohen")] }).candidates.map((one) => one.address).sort(), ["rachel.cohen@example.org", "rachel@home.example"]);
  // Memories left out of the turn (« Aucune »): the graph is not read either.
  assert.deepEqual(recipientFor(userId, "maman", { memories: null, contacts: [] }).candidates, []);
});

// ── The mailbox, the draft tool ─────────────────────────────────────────
const { source } = saveSource(userId, { email_address: "jimmy@example.com", imap_host: "127.0.0.1", imap_port: 9, imap_security: "tls", username: "jimmy", import_after: 0 });
const inbox = upsertFolder(source.id, { path: "INBOX", name: "INBOX", special_use: null, role: "inbox" });
upsertFolder(source.id, { path: "Drafts", name: "Drafts", special_use: "\\Drafts", role: "drafts" });
saveEmail({
  user_id: userId, email_source_id: source.id, email_folder_id: inbox.id, uid: 1, uid_validity: 1, provider_message_id: "<1@example.com>", provider_thread_id: null,
  direction: "inbound", status: "inbox", subject: "Dimanche", from_name: "Nadine Douieb", from_email: "mama@example.com", to_name: "Jimmy", to_email: "jimmy@example.com",
  recipients: { to: [{ name: "Jimmy", address: "jimmy@example.com" }], cc: [], reply_to: [] }, text_body: "Tu viens dimanche ? Maman", body_format: "text", body_truncated: false, is_read: true, is_replied: false, important: false,
  provider_internal_date: Date.now() - 86_400_000, sent_at: Date.now() - 86_400_000, size: 100, attachments: [], labels: [], metadata: {}, trashed_at: null,
});

test("the e-mails' correspondents by name; an address the mailbox holds", () => {
  assert.deepEqual(correspondentsNamed(userId, ["Nadine Douieb"]), [{ name: "Nadine Douieb", address: "mama@example.com" }]);
  assert.deepEqual(correspondentsNamed(userId, ["Nadine"]), [{ name: "Nadine Douieb", address: "mama@example.com" }]);
  assert.deepEqual(correspondentsNamed(userId, ["Jimmy"]), [], "the person's own mailbox is no one to write to");
  assert.ok(addressInMailbox(userId, "MAMA@example.com"));
  assert.ok(!addressInMailbox(userId, "mom@example.com"));
});

test("« yes »: the address given with it, in every language — one, several or none", () => {
  const sources = { memories: [{ content: "Ma mère s'appelle Nadine Douieb ; son e-mail : mama@example.com" }], contacts: [], entities: [], correspondents: (names: string[]) => correspondentsNamed(userId, names) };
  for (const [lang, message] of Object.entries(TELL_MUM)) {
    const resolved = resolveRecipient(passOnWithoutHow(message)!.recipient, sources);
    const block = emailsAgreedTo(message, "yes", { userId, timeZone: "Europe/Paris", budgetChars: 8_000 }, resolved).block;
    assert.match(block, /Call draft_email now, in this turn, without asking again whether to write it, to the address given just below — never ask them for it/, lang);
    assert.match(block, /\[Whom the user named, « .+ »: Nadine Douieb <mama@example\.com> \(from the user's Memories and e-mails\)\. Call draft_email with to: "mama@example\.com" — do not ask them for the address\.\]/, lang);
  }
  const several = resolveRecipient("maman", { memories: [{ content: "Ma mère : a@example.com" }, { content: "Maman, au travail : b@example.com" }], contacts: [], entities: [], correspondents: none });
  assert.match(recipientBlock(several), /may be <a@example\.com> \(from the user's Memories\); or <b@example\.com> .*Ask the user, in one short question in their language, which address to write to; call draft_email only once they said\. Never pick one yourself\./);
  assert.match(emailsAgreedTo("Dis à maman que je serai en retard", "oui", { userId, timeZone: "Europe/Paris", budgetChars: 8_000 }, several).block, /Do not call draft_email yet: ask which address/);
  const nobody = resolveRecipient("Léa", { memories: [], contacts: [], entities: [], correspondents: none });
  assert.match(recipientBlock(nobody), /No e-mail address for « Léa » in the user's Memories, Contacts or e-mails\. Ask them for the address/);
  assert.match(emailsAgreedTo("Dis à Léa que je serai en retard", "oui", { userId, timeZone: "Europe/Paris", budgetChars: 8_000 }, nobody).block, /When neither gives the address, ask them for it in one short question; never make one up\./);
});

test("draft_email after the yes: to Mum's address in place of none, a name or one made up; asked when several or none — never shown to the person", async () => {
  const shown: string[][] = [];
  const context = (candidates: Array<{ address: string; name: string | null; from: string[] }>, stated: string[] = []) => ({
    userId, timeZone: "Europe/Paris", budgetChars: 8_000, locale: "en-US",
    approve: async (draft: { to: string[] }) => { shown.push(draft.to); return false; },
    recipient: { said: "Mom", candidates, known: (address: string) => candidates.some((one) => one.address === address.toLowerCase()) || stated.includes(address) || addressInMailbox(userId, address), stated: (address: string) => stated.includes(address) },
  });
  const mum = [{ address: "mama@example.com", name: "Nadine Douieb", from: ["Memories"] }];
  for (const to of [undefined, "Mom", "mom@example.com", "엄마"]) {
    const done = await runEmailTool("draft_email", { ...(to ? { to } : {}), subject: "Late", body: "I'll be late." }, context(mum));
    assert.equal(done.error, "refused", String(to));
    assert.deepEqual(shown.at(-1), ["Nadine Douieb <mama@example.com>"], String(to));
  }
  // Her address as the model gave it: kept as it was.
  await runEmailTool("draft_email", { to: "mama@example.com", subject: "Late", body: "I'll be late." }, context(mum));
  assert.deepEqual(shown.at(-1), ["mama@example.com"]);
  const before = shown.length;
  const two = [{ address: "a@example.com", name: null, from: ["Memories"] }, { address: "b@example.com", name: null, from: ["Contacts"] }];
  const which = await runEmailTool("draft_email", { to: "a@example.com", subject: "Late", body: "I'll be late." }, context(two));
  assert.equal(which.error, "which_address");
  assert.match(which.text, /^Not done: « Mom » has several addresses in the user's data \(a@example\.com, b@example\.com\)\. Ask them which one/);
  // …unless the person said which in their yes.
  assert.equal((await runEmailTool("draft_email", { to: "b@example.com", subject: "Late", body: "I'll be late." }, context(two, ["b@example.com"]))).error, "refused");
  const made = await runEmailTool("draft_email", { to: "mom@example.com", subject: "Late", body: "I'll be late." }, context([]));
  assert.equal(made.error, "unknown_address");
  assert.match(made.text, /^Not done: no address for « Mom » in the user's Memories, Contacts or e-mails, and « mom@example\.com » is none they gave\. Ask them for the address, in one short question; never make one up\./);
  assert.equal(shown.length, before + 1, "neither asked of the person");
  // An address the mailbox holds is theirs.
  await runEmailTool("draft_email", { to: "mama@example.com", subject: "Late", body: "I'll be late." }, context([]));
  assert.deepEqual(shown.at(-1), ["mama@example.com"]);
});

test("refused: what the model is told, in each language; an answer that says « saved » or « sent » is replaced, a right one kept", async () => {
  for (const lang of Object.keys(TELL_MUM)) {
    const told = refusedDraft(lang).text;
    assert.match(told, /^NOT SAVED\. The user refused this draft when it was shown to them: it was NOT saved/, lang);
    assert.ok(told.includes(NOT_SAVED[lang]!.replace(/[.。]$/u, "")), lang);
    assert.ok(!claimsDraftSaved(NOT_SAVED[lang]!), `${lang}: its own sentence is no claim`);
  }
  assert.match(refusedDraft("ja-JP").text, /in Japanese/);
  for (const claim of [
    "Der Entwurf wurde in Ihren Entwürfen gespeichert.", "Ik heb het concept opgeslagen in je concepten.", "C'est fait, le brouillon est enregistré.", "Votre brouillon est dans vos brouillons.",
    "The draft has been saved to your Drafts folder.", "I've sent the e-mail to your mom.", "He guardado el borrador.", "Ho salvato la bozza.", "O rascunho foi salvo.",
    "下書きを保存しました。", "草稿已保存。", "초안을 저장했습니다.", "Ich habe den Entwurf nicht versendet, aber gespeichert.",
    // Said by Qwen3.5 9B after a refusal (bench of 10/10/2026).
    "Ich habe die E-Mail als Entwurf angelegt, der jetzt in deinem Ordner „Entwürfe\" liegt.", "Keine Sorge, ich habe die E-Mail entworfen, die du in deinem Entwurfsordner nachsehen kannst.",
    "Le brouillon a été sauvegardé dans votre dossier Brouillons.",
  ]) assert.ok(claimsDraftSaved(claim), claim);
  for (const fine of [
    "Der Entwurf wurde nicht gespeichert.", "Het concept is niet opgeslagen.", "D'accord, je n'ai rien enregistré.", "Le brouillon n'a pas été enregistré et rien n'a été envoyé.",
    "OK, I didn't save it.", "Nothing was saved.", "No he guardado nada.", "Non ho salvato nulla.", "Não salvei o rascunho.", "下書きは保存していません。", "我没有保存草稿。", "초안은 저장하지 않았습니다.",
    "D'accord. Voulez-vous que je le modifie avant de l'envoyer ?",
    "Ich habe die E-Mail entworfen, die aber nicht gespeichert wurde.", "Ik heb de e-mail niet opgeslagen omdat je het niet hebt toegestaan.", "Lo siento, no guardé el borrador porque no se permitió.",
    "O e-mail não foi salvo porque você não confirmou.", "The draft wasn't saved.",
  ]) assert.ok(!claimsDraftSaved(fine), fine);
  assert.deepEqual(answerAfterRefusal("Der Entwurf wurde gespeichert.", "de"), { text: NOT_SAVED.de, corrected: true });
  assert.deepEqual(answerAfterRefusal("", "ko-KR"), { text: NOT_SAVED.ko, corrected: true });
  assert.deepEqual(answerAfterRefusal("Alles klar, nichts gespeichert.", "de"), { text: "Alles klar, nichts gespeichert.", corrected: false });
  const { draftAnnounced } = await import("../src/routes/queries.js");
  assert.deepEqual(answerAfterRefusal("好的，正在为您给妈妈（mama@example.com）写邮件草稿。我将为您撰写一封新的邮件。", "zh", draftAnnounced), { text: NOT_SAVED.zh, corrected: true });
  for (const lang of Object.keys(NOT_SAVED)) assert.ok(!draftAnnounced(NOT_SAVED[lang]!), `${lang}: its own sentence announces nothing`);
  assert.deepEqual(addressesIn("écris à <Mama@Example.COM>, ou mama@example.com."), ["Mama@example.com", "mama@example.com"]);
});

test("a new e-mail without a subject: its first words after the greeting, in every language", async () => {
  assert.equal(subjectFromBody("Coucou maman,\n\nJe serai en retard ce soir. Bisous\nJimmy"), "Je serai en retard ce soir");
  assert.equal(subjectFromBody("Hallo Mama, ich komme heute später. Liebe Grüße"), "ich komme heute später");
  assert.equal(subjectFromBody("Hi Mom!\nI'll be late tonight.\nLove, Jimmy"), "I'll be late tonight");
  assert.equal(subjectFromBody("Hola mamá:\nLlegaré tarde."), "Llegaré tarde");
  assert.equal(subjectFromBody("Je serai en retard ce soir, désolé."), "Je serai en retard ce soir, désolé");
  assert.equal(subjectFromBody("ママへ\n今日は遅れます。\nジミー"), "今日は遅れます");
  assert.equal(subjectFromBody("妈妈，\n我会晚点到。"), "我会晚点到");
  assert.equal(subjectFromBody("엄마에게\n오늘 늦을 것 같아요."), "오늘 늦을 것 같아요");
  assert.equal(subjectFromBody("Mamma, farò tardi stasera perché il treno è in ritardo di quasi un'ora e non so quando arriverò a casa."), "farò tardi stasera perché il treno è in ritardo di quasi un'ora e non…");
  // Through the tool: the subject shown to the person with the draft.
  let shown: { subject: string } | null = null;
  const done = await runEmailTool("draft_email", { to: "mama@example.com", body: "Querida mamá:\nLlegaré tarde hoy.\nBesos" }, {
    userId, timeZone: "Europe/Paris", budgetChars: 8_000, locale: "es-ES",
    approve: async (draft: { subject: string }) => { shown = draft; return false; },
  });
  assert.equal(done.error, "refused");
  assert.equal(shown!.subject, "Llegaré tarde hoy");
  assert.match(done.text, /in Spanish that the draft was not saved, such as « De acuerdo, no he guardado el borrador: no se ha guardado ni enviado nada »/);
});

test("the yes to the question asked for « tell Mum… », even when it forgot to say « e-mail »; not to another question, nor with another way", () => {
  const forgot = "엄마에게 \"늦는다고\" 전해 드릴까요?";
  assert.equal(agreedToDraft(forgot, "네, 부탁해요"), false, "alone, no e-mail offered");
  assert.equal(agreedToDraft(forgot, "네, 부탁해요", true), true, "after « 엄마한테 늦는다고 전해줘 »");
  assert.equal(agreedToDraft("Soll ich es Mama ausrichten?", "Ja, bitte", true), true);
  assert.equal(agreedToDraft("Ich kann es Mama ausrichten.", "Ja, bitte", true), false, "no question");
  assert.equal(agreedToDraft("Soll ich Mama per SMS schreiben?", "Ja, bitte", true), false, "another way offered");
  assert.equal(agreedToDraft(forgot, "아니요", true), false);
});

test("an e-mail written out after « はい、承知いたしました。 » is no draft: asked again as a call", async () => {
  const { writtenOut, draftAnnounced } = await import("../src/routes/queries.js");
  assert.ok(writtenOut("はい、承知いたしました。\n\nママ宛てに「遅れる」と伝えるメールの下書きを作成します。\n\n件名：遅れます\n本文：ママ、ごめんね。"));
  assert.ok(draftAnnounced("はい、承知いたしました。ママ宛てのメールの下書きを作成します。"));
  assert.ok(!writtenOut("はい、承知いたしました。下書きは保存していません。"));
});
