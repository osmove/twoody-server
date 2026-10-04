import assert from "node:assert/strict";
import test from "node:test";
import {
  attachmentsOf, bodyOf, capText, cleanAddress, flagState, htmlToPlain, normalizeSubject, parseEmail, parseRecipients, pickFolders, replySubject,
  textMayBeCut, threadIdOf, tidyText, type ListedFolder,
} from "../src/email/parse.js";

// « E-mails » (Capacités): what an e-mail is made of, as Twoody keeps it —
// pure helpers, no mail server, no database.

test("a conversation's subject: replies and forwards, in the languages mail clients write them, left out", () => {
  assert.equal(normalizeSubject("RE: TR: Réunion de lundi"), "réunion de lundi");
  assert.equal(normalizeSubject("Fwd: Re[2]: AW: Angebot"), "angebot");
  assert.equal(normalizeSubject("Rép. : Votre devis"), "votre devis");
  assert.equal(normalizeSubject("Retour de congés"), "retour de congés", "a word starting like a prefix is no prefix");
  assert.equal(normalizeSubject(null), "");
  assert.equal(replySubject("Réunion de lundi"), "Re: Réunion de lundi");
  assert.equal(replySubject("RE: Réunion de lundi"), "RE: Réunion de lundi", "an answer to an answer keeps its « RE: »");
  assert.equal(replySubject(""), "Re:");
});

test("a conversation: the server's thread first, else the first message its References name", () => {
  assert.equal(threadIdOf({ serverThreadId: "1789", references: ["<a@x>"], messageId: "<c@x>" }), "server:1789");
  assert.equal(threadIdOf({ references: ["<Root@X>", "<b@x>"], inReplyTo: "<b@x>", messageId: "<c@x>" }), "message:<root@x>");
  assert.equal(threadIdOf({ references: [], inReplyTo: "<b@x>", messageId: "<c@x>" }), "message:<b@x>");
  assert.equal(threadIdOf({ messageId: "<c@x>" }), "message:<c@x>");
  assert.equal(threadIdOf({}), null);
});

test("addresses: as people and models write them; what is not one is said", () => {
  assert.equal(cleanAddress(" Rene@Example.COM "), "Rene@example.com");
  assert.equal(cleanAddress("mailto:paul@example.net"), "paul@example.net");
  assert.equal(cleanAddress("paul at example.net"), null);
  assert.equal(cleanAddress("<script>@x.y"), null);
  const { addresses, invalid } = parseRecipients(["paul@example.net, \"Dupont, René\" <rene@example.com>; lea@example.fr", "Paul@example.net"]);
  assert.deepEqual(addresses, [
    { name: null, address: "paul@example.net" },
    { name: "Dupont, René", address: "rene@example.com" },
    { name: null, address: "lea@example.fr" },
  ], "a comma within quotes separates nothing; the same address twice is one");
  assert.deepEqual(invalid, []);
  assert.deepEqual(parseRecipients("René, paul@example.net").invalid, ["René"]);
});

test("HTML as text: words, paragraphs and lists; no links, images, styles or invisible padding", () => {
  const text = htmlToPlain(`<html><head><style>p{color:red}</style></head><body>
    <p>Bonjour&nbsp;Jimmy,</p><p>Votre <b>facture</b> est prête : <a href="https://track.example.com/?u=1">la voir</a></p>
    <img src="https://pix.example.com/p.gif"><table><tr><td>Total</td><td>42,00 €</td></tr></table>
    <ul><li>un</li><li>deux</li></ul><span>&#847;&zwnj;&#847;</span></body></html>`);
  assert.match(text, /Bonjour Jimmy,/);
  assert.match(text, /Votre facture est prête : la voir/);
  assert.match(text, /Total\n42,00 €/);
  assert.match(text, /\* un\n \* deux/);
  assert.doesNotMatch(text, /https?:|color:red|͏|‌/);
});

test("the body kept: the plain part when there is a real one, else the HTML part's text; capped at a word", () => {
  assert.deepEqual(bodyOf({ text: "Bonjour,\r\n\r\n\r\n\r\nÀ lundi.  ", html: "<p>Bonjour</p>" }), { text: "Bonjour,\n\nÀ lundi.", format: "text" });
  assert.deepEqual(bodyOf({ text: "Voir en ligne", html: "<p>La vraie lettre, avec tout son contenu.</p>" }), { text: "La vraie lettre, avec tout son contenu.", format: "html" });
  assert.deepEqual(bodyOf({ html: false }), { text: "", format: "text" });
  assert.deepEqual(capText("un deux trois quatre", 12), { text: "un deux", truncated: true });
  assert.equal(tidyText("a b​ c \n\n\n\nd"), "a b c\n\nd");
});

test("flags as the account's columns say them; Twoody never needs more", () => {
  assert.deepEqual(flagState(["\\Seen", "\\Answered"]), { is_read: true, is_replied: true, important: false, deleted: false });
  assert.deepEqual(flagState(["\\Flagged", "\\Deleted"]), { is_read: false, is_replied: false, important: true, deleted: true });
});

test("INBOX, Sent and Drafts: what the server says of a folder (SPECIAL-USE) before a name guessed", () => {
  const folder = (path: string, specialUse: string | null, source: string | null, flags: string[] = []): ListedFolder => ({ path, name: path.split("/").pop()!, specialUse, specialUseSource: source, flags });
  const picked = pickFolders([
    folder("INBOX", "\\Inbox", null),
    folder("Sent", "\\Sent", "name"),
    folder("[Gmail]/Messages envoyés", "\\Sent", "extension"),
    folder("[Gmail]/Brouillons", "\\Drafts", "extension"),
    folder("[Gmail]", null, null, ["\\Noselect"]),
  ]);
  assert.equal(picked.inbox?.path, "INBOX");
  assert.equal(picked.sent?.path, "[Gmail]/Messages envoyés");
  assert.equal(picked.drafts?.path, "[Gmail]/Brouillons");
  assert.equal(pickFolders([folder("Archive", null, null)]).inbox, undefined);
});

test("attachments: names, types and sizes from the structure; a text that fits was not cut with them", () => {
  const structure = {
    type: "multipart/mixed",
    childNodes: [
      { type: "multipart/alternative", childNodes: [{ type: "text/plain", size: 1_200 }, { type: "text/html", size: 4_800 }] },
      { type: "application/pdf", disposition: "attachment", dispositionParameters: { filename: "facture-septembre.pdf" }, size: 812_000 },
      { type: "image/png", parameters: { name: "logo.png" }, size: 2_000 },
      { type: "message/rfc822", size: 9_000, childNodes: [{ type: "application/zip", disposition: "attachment", size: 1 }] },
    ],
  };
  assert.deepEqual(attachmentsOf(structure), [
    { filename: "facture-septembre.pdf", mime_type: "application/pdf", size: 812_000 },
    { filename: "logo.png", mime_type: "image/png", size: 2_000 },
    { filename: "message.eml", mime_type: "message/rfc822", size: 9_000 },
  ]);
  assert.equal(textMayBeCut(826_000, 262_144, structure), false, "6 KB of text, then the PDF: the text was read whole");
  assert.equal(textMayBeCut(900_000, 262_144, { type: "text/html", size: 900_000 }), true);
  assert.equal(textMayBeCut(900_000, 262_144, null), true, "without a structure, assumed cut");
  assert.equal(textMayBeCut(2_000, 2_000, null), false);
});

test("a whole message: encoded headers, people, ids, dates, the HTML part's text", async () => {
  const source = Buffer.from([
    "From: =?UTF-8?Q?Ren=C3=A9_Dupont?= <rene@example.com>",
    "To: Jimmy <jimmy@example.org>, paul@example.net",
    "Cc: \"Léa M.\" <lea@example.fr>",
    "Reply-To: secretariat@example.com",
    "Subject: =?UTF-8?Q?R=C3=A9union_de_lundi?=",
    "Date: Sat, 03 Oct 2026 09:12:00 +0200",
    "Message-ID: <abc123@example.com>",
    "In-Reply-To: <root@example.com>",
    "References: <root@example.com> <mid@example.com>",
    "MIME-Version: 1.0",
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "<p>On se voit lundi =C3=A0 10h ?</p>",
    "",
  ].join("\r\n"));
  const parsed = await parseEmail(source);
  assert.equal(parsed.subject, "Réunion de lundi");
  assert.deepEqual(parsed.from, { name: "René Dupont", address: "rene@example.com" });
  assert.deepEqual(parsed.to.map((one) => one.address), ["jimmy@example.org", "paul@example.net"]);
  assert.deepEqual(parsed.cc, [{ name: "Léa M.", address: "lea@example.fr" }]);
  assert.deepEqual(parsed.replyTo, [{ name: null, address: "secretariat@example.com" }]);
  assert.equal(parsed.messageId, "<abc123@example.com>");
  assert.equal(parsed.inReplyTo, "<root@example.com>");
  assert.deepEqual(parsed.references, ["<root@example.com>", "<mid@example.com>"]);
  assert.equal(parsed.sentAt, Date.parse("2026-10-03T07:12:00Z"));
  assert.equal(parsed.text, "On se voit lundi à 10h ?");
  assert.equal(parsed.format, "html");
  assert.equal(parsed.truncated, false);
  assert.equal((await parseEmail(source, { cut: true })).truncated, true);
});
