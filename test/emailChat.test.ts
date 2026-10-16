import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « E-mails » in the chat, as measured with Qwen3.5 9B (bench of
// 04/10/2026): periods worked out by the server, the words of a question in
// the e-mails' words, which messages plainly ask about e-mails, and what
// asks the person something.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-chat-"));
// E-mails and Google Analytics / Search Console are offered to this
// account (src/reservedFeatures.ts: kept for the accounts Osmove chooses).
process.env.TWOODY_RESERVED_FEATURES = "all";
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { expandQuery, messageWords, periodBounds, periodIn } = await import("../src/email/chat.js");
const mail = await import("../src/email/intent.js");
const { aboutEmails } = mail;
const { asksSomething, automatedHeaders, automatedSender } = await import("../src/email/parse.js");

const paris = "Europe/Paris";
const at = (text: string) => Date.parse(text);

test("periods on the person's calendar: weeks from Monday, months from the 1st, summer and winter time", () => {
  const sunday = at("2026-10-04T10:00:00+02:00");
  assert.deepEqual(periodBounds("this_week", sunday, paris), { after: at("2026-09-28T00:00:00+02:00"), before: null });
  assert.deepEqual(periodBounds("last_week", sunday, paris), { after: at("2026-09-21T00:00:00+02:00"), before: at("2026-09-28T00:00:00+02:00") });
  assert.deepEqual(periodBounds("today", sunday, paris), { after: at("2026-10-04T00:00:00+02:00"), before: null });
  assert.deepEqual(periodBounds("yesterday", sunday, paris), { after: at("2026-10-03T00:00:00+02:00"), before: at("2026-10-04T00:00:00+02:00") });
  assert.deepEqual(periodBounds("this_month", sunday, paris), { after: at("2026-10-01T00:00:00+02:00"), before: null });
  assert.deepEqual(periodBounds("last_month", sunday, paris), { after: at("2026-09-01T00:00:00+02:00"), before: at("2026-10-01T00:00:00+02:00") });
  assert.deepEqual(periodBounds("last_7_days", sunday, paris), { after: at("2026-09-28T00:00:00+02:00"), before: null });
  // A Monday is the first day of its own week.
  assert.equal(periodBounds("this_week", at("2026-09-28T09:00:00+02:00"), paris)!.after, at("2026-09-28T00:00:00+02:00"));
  // January: last month is December of the year before.
  assert.deepEqual(periodBounds("last_month", at("2026-01-15T12:00:00+01:00"), paris), { after: at("2025-12-01T00:00:00+01:00"), before: at("2026-01-01T00:00:00+01:00") });
  // Across the change to winter time (25 October 2026).
  assert.deepEqual(periodBounds("last_week", at("2026-10-28T12:00:00+01:00"), paris), { after: at("2026-10-19T00:00:00+02:00"), before: at("2026-10-26T00:00:00+01:00") });
  assert.equal(periodBounds("next_year", sunday, paris), null);
});

test("the period a question names, in French or English", () => {
  assert.equal(periodIn("Qu'est-ce que René m'a écrit cette semaine ?"), "this_week");
  assert.equal(periodIn("What did Claire ask me last month?"), "last_month");
  assert.equal(periodIn("Did my bank send me anything this week?"), "this_week");
  assert.equal(periodIn("Et la semaine dernière ?"), "last_week");
  assert.equal(periodIn("Qui m'a écrit hier ?"), "yesterday");
  assert.equal(periodIn("Et avant-hier ?"), null);
  assert.equal(periodIn("Le mois dernier, Tessane a-t-elle facturé ?"), "last_month");
  assert.equal(periodIn("Résume le dernier échange avec Claire Martin"), null);
});

test("a question in the e-mails' words: « my bank » is « Banque », the words that only say « e-mail » left out", () => {
  assert.equal(expandQuery("my bank"), "my bank banque");
  assert.equal(expandQuery("invoice from Tessane"), "invoice from Tessane facture");
  assert.equal(expandQuery("réunion"), "réunion meeting");
  assert.equal(expandQuery("véranda"), "véranda");
  const words = messageWords("Réponds à René que c'est d'accord pour jeudi").split(" ");
  assert.ok(words.includes("rene") && words.includes("jeudi") && !words.includes("reponds"));
  assert.match(messageWords("Did my bank send me anything this week?"), /^bank banque$/);
});

test("which messages plainly ask about e-mails — and which do not", () => {
  for (const message of [
    "Qu'est-ce que René m'a écrit cette semaine ?", "Résume le dernier échange avec Claire Martin", "Est-ce que j'ai reçu une facture de Tessane ? De combien ?",
    "Quels e-mails attendent une réponse de ma part ?", "Réponds à René que c'est d'accord pour jeudi", "What did Claire ask me last month?",
    "Did my bank send me anything this week?", "Has René replied?", "Écris à Léa que je viens samedi", "Reply to Marc about the contract",
    "Ai-je reçu la confirmation de l'hôtel ?", "Fais un brouillon pour Claire", "Did I get an invoice from EDF?", "Réponds à Maître Dupont que je confirme le rendez-vous de jeudi",
  ]) assert.equal(aboutEmails(message), true, message);
  for (const message of [
    "Écris-moi un haïku sur l'automne", "Combien font 17 × 23 ?", "Réponds à cette question : 2+2 ?", "Comment écrire un e-mail de motivation ?",
    "How to write an email to my landlord?", "Did Einstein write about relativity?", "Qu'est-ce que tu m'as dit hier ?", "Envoie-moi une recette de crêpes",
    "Rappelle-moi d'appeler Marc demain", "Peux-tu répondre à ma question ?", "Bonjour",
  ]) assert.equal(aboutEmails(message), false, message);
});

test("what asks the person something, and what a machine sent", () => {
  assert.equal(asksSomething("Tu viens dîner samedi ? Dis-moi avant mercredi."), true);
  assert.equal(asksSomething("Pense aussi à me dire si vous avez besoin d'une prise électrique."), true);
  assert.equal(asksSomething("Could you send me the report?"), true);
  assert.equal(asksSomething("Merci pour ton aide hier, c'était parfait !"), false);
  assert.equal(asksSomething("Votre relevé est disponible.\n> Pouvez-vous confirmer ?"), false, "a question quoted from before is not new");
  assert.equal(automatedSender("noreply@example.com"), true);
  assert.equal(automatedSender("notifications@banque-orsay.example"), true);
  assert.equal(automatedSender("newsletter+fr@lalettreduvelo.example"), true);
  assert.equal(automatedSender("rene.garnier@example.fr"), false);
  assert.equal(automatedHeaders(new Map([["list-unsubscribe", "<https://x.example/u>"]])), true);
  assert.equal(automatedHeaders(new Map([["precedence", "bulk"]])), true);
  assert.equal(automatedHeaders(new Map([["auto-submitted", "auto-replied"]])), true);
  assert.equal(automatedHeaders(new Map([["auto-submitted", "no"]])), false);
  assert.equal(automatedHeaders(new Map()), false);
});

test("« Dis à maman que… »: something to pass on, how not said — never a question about Twoody itself, advice, or a way named", () => {
  const { passOnWithoutHow } = mail;
  for (const [message, recipient] of [
    ["Dis à maman que je viens dimanche", "maman"], ["Préviens Paul que je serai en retard", "Paul"], ["Tu peux dire à ma sœur Julie que j'arrive ?", "ma sœur Julie"],
    ["Préviens Maître Dupont de mon retard", "Maître Dupont"], ["Demande au plombier s'il passe demain", "plombier"], ["Dis-lui que je viens", "lui"],
    ["Tell my mom that I'm coming on Sunday", "my mom"], ["Let Paul know I will be late", "Paul"], ["Préviens Paul", "Paul"],
  ]) assert.equal(passOnWithoutHow(message!)?.recipient, recipient, message);
  for (const message of [
    "Dis-moi la capitale de l'Italie", "Dis à Siri que tu es bien plus malin qu'elle", "Explique-moi ce mail de Tessane", "Comment dire à mon patron que je démissionne ?",
    "Dis à quel point c'est important", "Tell me a joke", "Let me know", "Dis à maman par SMS que je viens", "Appelle maman pour lui dire que je viens",
    "Écris un mail à Paul pour le remercier", "Réponds à Maître Dupont que je confirme jeudi", "Je vais dire à maman que je viens", "Rappelle-moi de dire à Paul que je viens",
  ]) assert.equal(passOnWithoutHow(message), null, message);
});

test("« oui » to « Voulez-vous que je rédige un e-mail… ? »: the e-mail asked for; not another yes, nor another way", () => {
  const { agreedToDraft } = mail;
  const offer = "Voulez-vous que je rédige un e-mail à maman pour lui dire que vous venez dimanche ?";
  for (const reply of ["oui", "Oui, depuis ma boîte perso", "vas-y", "OK", "d'accord", "yes please"]) assert.equal(agreedToDraft(offer, reply), true, reply);
  for (const reply of ["non", "oui mais plutôt par SMS", "Et papa ?", ""]) assert.equal(agreedToDraft(offer, reply), false, reply);
  assert.equal(agreedToDraft("Souhaitez-vous que je lui envoie un e-mail pour le prévenir ?", "oui"), true);
  assert.equal(agreedToDraft("La capitale de l'Italie est Rome. Autre chose ?", "oui"), false);
  assert.equal(agreedToDraft(null, "oui"), false);
});

test("which e-mail messages ask for a draft — announced and not made, it is asked again", async () => {
  const { asksForADraft } = mail;
  for (const message of ["Réponds à Maître Dupont que je confirme jeudi", "Écris un mail à Paul pour le remercier", "Fais un brouillon pour Claire", "Reply to Marc about the contract"]) assert.equal(asksForADraft(message), true, message);
  for (const message of ["Explique-moi ce mail de Tessane", "Qu'est-ce que René m'a écrit ?", "Dis à maman que je viens dimanche", "Écris-moi un haïku"]) assert.equal(asksForADraft(message), false, message);
  const { draftAnnounced, onlyNarration, writtenOut } = await import("../src/routes/queries.js");
  assert.equal(draftAnnounced("Je rédige un brouillon de réponse à Maître Anne Dupont pour confirmer jeudi, en reprenant son email (id: 251d0be8-83e2-44bd-b9ae-4fc17d3e97f9)."), true, "cut at « id: »");
  assert.equal(draftAnnounced("Je rédige un brouillon : depuis quelle boîte, tessane ou maison ?"), false, "a question");
  for (const said of [
    "Je rédige un brouillon de réponse à Maître Dupont pour confirmer le rendez-vous du jeudi 8 octobre à 14 h.", "Je confirme le rendez-vous de jeudi.",
    "J'écris le brouillon de réponse à Maître Dupont.", "D'accord, je rédige l'e-mail.", "Je confirme le rendez-vous du jeudi 8 octobre à 14 h. Je vais maintenant rédiger le brouillon de réponse à Maître Dupont.",
    "I'll draft a reply now.",
  ]) {
    assert.equal(onlyNarration(said, true), true, said);
    assert.equal(onlyNarration(said), false, `not asked for a draft: ${said}`);
  }
  for (const said of ["Voulez-vous que je rédige un e-mail ?", "Je ne sais pas à quelle adresse répondre : tessane ou maison ?", "Paul vous a écrit deux fois."]) assert.equal(onlyNarration(said, true), false, said);
  assert.equal(writtenOut("Voici votre brouillon de réponse à Maître Dupont :\n\n**Objet :** Re : Rendez-vous\n\nMadame,\n\nJe confirme."), true);
  assert.equal(writtenOut("**Objet :** Merci\n\nBonjour Paul,"), true);
  assert.equal(writtenOut("Voici ce que dit le mail : une facture."), false);
  assert.equal(writtenOut("Paul vous a écrit deux fois. Voici un e-mail :"), false, "an answer first");
});
