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
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { expandQuery, messageWords, periodBounds, periodIn } = await import("../src/email/chat.js");
const { aboutEmails } = await import("../src/email/intent.js");
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
