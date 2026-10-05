import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// « Se connecter avec Google » (Capacités → E-mails, 05/10/2026): a Gmail
// mailbox read through the Gmail API. Its doors (src/outbound.ts) open two
// addresses and nothing else — Google's token endpoint, and below
// /gmail/v1/users/me/ what reading the mailbox needs plus one write, a
// draft created — only while E-mails is on and the mailbox signs in with
// Google. Here, the proof that nothing can be sent, deleted, trashed or
// relabelled through them, whatever the address is made to look like.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-gmail-door-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { GMAIL_ME, gmailDoor, GmailDoorClosedError, gmailFetch, gmailRoute, GOOGLE_TOKEN_URL, googleTokenDoor, googleTokenFetch } = await import("../src/outbound.js");

const open = { gmailMailbox: true, emailOn: true };
const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    return err instanceof GmailDoorClosedError ? err.reason : `other: ${String(err)}`;
  }
  return null;
};
const door = (target: string, method = "GET", state = open) => refusal(() => gmailDoor(target, method, state));

test("Google's token endpoint: that address only, while E-mails is on and the mailbox signs in with Google", () => {
  assert.equal(GOOGLE_TOKEN_URL, "https://oauth2.googleapis.com/token");
  const token = (target: string, state = open) => refusal(() => googleTokenDoor(target, state));
  assert.equal(token(GOOGLE_TOKEN_URL), null);
  assert.equal(token("https://OAUTH2.googleapis.com:443/x/../token"), null, "the same address, however written");
  assert.equal(token(GOOGLE_TOKEN_URL, { gmailMailbox: true, emailOn: false }), "email_off");
  assert.equal(token(GOOGLE_TOKEN_URL, { gmailMailbox: false, emailOn: true }), "not_configured");
  for (const other of [
    "https://oauth2.googleapis.com/token?x=1",
    "https://oauth2.googleapis.com/revoke",
    "https://oauth2.googleapis.com:8443/token",
    "https://user@oauth2.googleapis.com/token",
    "http://oauth2.googleapis.com/token",
    "https://oauth2.googleapis.com.evil.example/token",
    "https://accounts.google.com/o/oauth2/token",
    "https://www.googleapis.com/oauth2/v4/token",
    "not a url",
  ]) assert.equal(token(other), "other_address", other);
});

test("the Gmail door: reading what the copy needs, and creating a draft — nothing else", () => {
  for (const [path, method] of [
    ["/profile", "GET"],
    ["/labels", "GET"],
    ["/labels/INBOX", "GET"],
    ["/messages?labelIds=INBOX&q=after%3A1790000000&maxResults=100", "GET"],
    ["/messages/18c0000000000a01?format=full", "GET"],
    ["/messages/18c0000000000a01/attachments/ANGjdJ_text", "GET"],
    ["/threads", "GET"],
    ["/threads/18c0000000000a01", "GET"],
    ["/history?startHistoryId=5000&historyTypes=messageAdded", "GET"],
    ["/drafts", "POST"],
  ] as const) assert.equal(door(`${GMAIL_ME}${path}`, method), null, `${method} ${path}`);
  assert.equal(door(`${GMAIL_ME}/labels`, "GET", { gmailMailbox: true, emailOn: false }), "email_off");
  assert.equal(door(`${GMAIL_ME}/labels`, "GET", { gmailMailbox: false, emailOn: true }), "not_configured");
});

test("nothing is sent, deleted, trashed, moved or relabelled: every such address and method is refused", () => {
  const id = "18c0000000000a01";
  const refused: Array<[string, string, string]> = [
    // Sending, in every form Gmail takes it.
    ["/messages/send", "POST", "other_address"],
    ["/drafts/send", "POST", "other_address"],
    ["/drafts/r-draft-1/send", "POST", "other_address"],
    ["/messages/send", "GET", "other_address"],
    // Deleting, trashing, relabelling, importing, inserting.
    [`/messages/${id}`, "DELETE", "method_not_allowed"],
    [`/messages/${id}/trash`, "POST", "other_address"],
    [`/messages/${id}/untrash`, "POST", "other_address"],
    [`/messages/${id}/modify`, "POST", "other_address"],
    ["/messages/batchModify", "POST", "other_address"],
    ["/messages/batchDelete", "POST", "other_address"],
    ["/messages/import", "POST", "other_address"],
    ["/messages", "POST", "method_not_allowed"],
    [`/threads/${id}`, "DELETE", "method_not_allowed"],
    [`/threads/${id}/trash`, "POST", "other_address"],
    [`/threads/${id}/modify`, "POST", "other_address"],
    ["/drafts", "GET", "method_not_allowed"],
    ["/drafts/r-draft-1", "PUT", "other_address"],
    ["/drafts/r-draft-1", "DELETE", "other_address"],
    ["/labels", "POST", "method_not_allowed"],
    ["/labels/INBOX", "PATCH", "method_not_allowed"],
    ["/labels/INBOX", "DELETE", "method_not_allowed"],
    // The account's settings: forwarding, filters, delegates, sending addresses.
    ["/settings/forwardingAddresses", "POST", "other_address"],
    ["/settings/filters", "POST", "other_address"],
    ["/settings/sendAs", "GET", "other_address"],
    ["/watch", "POST", "other_address"],
    ["/stop", "POST", "other_address"],
    // An id made to read as a path, the same request spelled otherwise.
    [`/messages/${id}%2Ftrash`, "GET", "other_address"],
    [`/messages/${id}/../send`, "POST", "other_address"],
    [`/messages/x:send`, "GET", "other_address"],
    ["/messages/SEND", "GET", "other_address"],
  ];
  for (const [path, method, reason] of refused) assert.equal(door(`${GMAIL_ME}${path}`, method), reason, `${method} ${path}`);
  // Other people's mailboxes, other versions, uploads, batches, other hosts.
  for (const other of [
    "https://gmail.googleapis.com/gmail/v1/users/claire.martin@gmail.com/messages",
    "https://gmail.googleapis.com/gmail/v1/users/me",
    "https://gmail.googleapis.com/upload/gmail/v1/users/me/messages/send",
    "https://gmail.googleapis.com/upload/gmail/v1/users/me/drafts",
    "https://gmail.googleapis.com/batch/gmail/v1",
    "https://www.googleapis.com/gmail/v1/users/me/messages",
    "http://gmail.googleapis.com/gmail/v1/users/me/messages",
    "https://gmail.googleapis.com:8443/gmail/v1/users/me/messages",
    "https://user@gmail.googleapis.com/gmail/v1/users/me/messages",
    "https://gmail.googleapis.com.evil.example/gmail/v1/users/me/messages",
    "https://smtp.gmail.com/",
    "not a url",
  ]) assert.equal(gmailRoute(other), null, other);
});

test("a request refused at either door never leaves this machine", async () => {
  let reached = 0;
  const local = createServer((_req, res) => {
    reached += 1;
    res.end("{}");
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const elsewhere = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const refused = (reason: string) => (err: unknown) => err instanceof GmailDoorClosedError && err.reason === reason;
  await assert.rejects(gmailFetch(`${elsewhere}/gmail/v1/users/me/messages`, { method: "GET" }, open), refused("other_address"));
  await assert.rejects(gmailFetch(`${GMAIL_ME}/messages/send`, { method: "POST" }, open), refused("other_address"));
  await assert.rejects(gmailFetch(`${GMAIL_ME}/messages/18c0000000000a01`, { method: "DELETE" }, open), refused("method_not_allowed"));
  await assert.rejects(gmailFetch(`${GMAIL_ME}/labels`, {}, { gmailMailbox: true, emailOn: false }), refused("email_off"));
  await assert.rejects(googleTokenFetch(`${elsewhere}/token`, { method: "POST" }, open), refused("other_address"));
  await assert.rejects(googleTokenFetch(GOOGLE_TOKEN_URL, { method: "POST" }, { gmailMailbox: false, emailOn: true }), refused("not_configured"));
  assert.equal(reached, 0);
  await new Promise((resolve) => local.close(resolve));
});

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir = srcDir): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

test("Google's addresses are written in the doors' file alone; the token is renewed after its door, Gmail asked after its own", () => {
  assert.deepEqual(sources().filter(({ text }) => /gmail\.googleapis\.com|oauth2\.googleapis\.com|accounts\.google\.com/i.test(text)).map(({ path }) => path), [join(srcDir, "outbound.ts")]);
  const token = readFileSync(join(srcDir, "google", "token.ts"), "utf8");
  assert.ok(token.indexOf("googleTokenDoor(GOOGLE_TOKEN_URL, door)") > 0 && token.indexOf("googleTokenDoor(GOOGLE_TOKEN_URL, door);\n    response = await transport(") > 0);
  const mailbox = readFileSync(join(srcDir, "email", "gmailMailbox.ts"), "utf8");
  assert.ok(mailbox.indexOf("gmailDoor(url, method, this.door())") > 0 && mailbox.indexOf("gmailDoor(url, method, this.door())") < mailbox.indexOf("response = await transport(url"));
  // The one write Twoody asks of Gmail: a draft; no path that sends is ever written.
  const writes = [...mailbox.matchAll(/session\.post\(`([^`]+)`/g)].map((match) => match[1]);
  assert.deepEqual(writes, ["${GMAIL_ME}/drafts"]);
  for (const { path, text } of sources().filter(({ path: one }) => one !== join(srcDir, "outbound.ts"))) {
    assert.doesNotMatch(text, /\/(?:messages|drafts)\/send\b|gmail\.send|gmail\.modify|mail\.google\.com\//, path);
  }
});
