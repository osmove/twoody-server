import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeMailServer, rfc822 } from "./helpers/fakeMailServer.js";

// Several mailboxes (Jimmy, 05/10/2026: « si je veux mettre aussi mon email
// perso, je peux avoir plusieurs boîtes mail ? »): each added, changed,
// read and removed on its own; the chat searches them all, each e-mail with
// its mailbox, and writes a draft in the mailbox of the e-mail it answers.
// The mailbox set up before, alone, carries on as it was — its password
// kept, nothing to give again. Two IMAP servers in memory (no network), a
// fictional person: Claire Martin, at work (Tessane) and at home.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-mailboxes-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const DAY = 86_400_000;
const now = Date.now();
const WORK = "claire.martin@tessane.example";
const HOME = "claire.martin@maison.example";

// ── Work, set up before (one mailbox, as Twoody 0.13.81 kept it) ────────
const work = new FakeMailServer();
work.password = "work-password-1";
work.folder("INBOX", "\\Inbox", null);
work.folder("Sent", "\\Sent");
work.folder("Drafts", "\\Drafts");
work.deliver("INBOX", rfc822({ from: "Marc Dubois <marc.dubois@tessane.example>", to: `Claire Martin <${WORK}>`, subject: "Contrat de maintenance", messageId: "<contrat@tessane.example>", date: new Date(now - 4 * DAY), text: "Claire, la date de fin du contrat de maintenance est le 31 décembre." }), { at: now - 4 * DAY });
work.deliver("Sent", rfc822({ from: `Claire Martin <${WORK}>`, to: "Marc Dubois <marc.dubois@tessane.example>", subject: "Re: Contrat de maintenance", messageId: "<re-contrat@tessane.example>", inReplyTo: "<contrat@tessane.example>", date: new Date(now - 3 * DAY), text: "Merci Marc." }), { at: now - 3 * DAY, flags: ["\\Seen"] });

// ── Home, added now ─────────────────────────────────────────────────────
const home = new FakeMailServer();
home.password = "home-password-2";
home.folder("INBOX", "\\Inbox", null);
home.folder("Envoyés", "\\Sent");
home.folder("Brouillons", "\\Drafts");
home.deliver("INBOX", rfc822({ from: "Léa Fontaine <lea.fontaine@example.net>", to: `Claire <${HOME}>`, subject: "Dîner du 10 octobre", messageId: "<diner@example.net>", date: new Date(now - 2 * DAY), text: "Tu viens dîner samedi 10 octobre ? Le contrat de location est signé !" }), { at: now - 2 * DAY });

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { useMailConnectorForTests } = await import("../src/email/imap.js");
const { syncMailbox } = await import("../src/email/sync.js");
const { activeSources, gmailSyncState, MAX_MAILBOXES } = await import("../src/email/store.js");
const { draftMailbox, runEmailTool } = await import("../src/email/chat.js");
const servers: Record<string, FakeMailServer> = { "imap.tessane.example": work, "imap.maison.example": home };
useMailConnectorForTests((settings) => {
  const server = servers[settings.host];
  if (!server) throw Object.assign(new Error("getaddrinfo ENOTFOUND"), { code: "ENOTFOUND" });
  return server.connector(settings);
});

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const phone = { authorization: `Bearer ${createAuthSession(userId, "pair:iPhone").token}` };
test.after(async () => {
  useMailConnectorForTests(null);
  await app.close();
});

const credentialsFile = join(process.env.TWOODY_DATA_DIR!, "email-credentials.json");
const credentials = () => (existsSync(credentialsFile) ? (JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, Record<string, unknown>>) : {});
const status = async () => (await app.inject({ url: "/email/status", headers })).json();
const addressOf = (id: string) => (sqlite.prepare("SELECT email_address FROM email_sources WHERE id = ?").get(id) as { email_address: string }).email_address;
const allowAll = { userId, timeZone: "Europe/Paris", budgetChars: 20_000, approve: async () => true };
await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers, payload: { enabled: true } });

const WORK_ID = "0c8f1d5e-7a52-4b4e-9d0b-3f1e2a6c9b10";

test("the mailbox set up before, alone, as Twoody 0.13.81 kept it: still read, its password kept — nothing to give again", async () => {
  // Its row and its password, as the version before wrote them.
  sqlite.prepare(`INSERT INTO email_sources (id, user_id, provider, email_address, display_name, imap_host, imap_port, imap_security, username, status, import_after, metadata, created_at, updated_at)
    VALUES (?, ?, 'imap', ?, NULL, 'imap.tessane.example', 993, 'tls', ?, 'active', ?, ?, ?, ?)`)
    .run(WORK_ID, userId, WORK, WORK, now - 90 * DAY, JSON.stringify({ preset: "other", window_days: 90, auth: "password" }), now - 10 * DAY, now - 10 * DAY);
  writeFileSync(credentialsFile, JSON.stringify({ [WORK_ID]: { password: work.password, saved_at: now - 10 * DAY } }, null, 2), { mode: 0o600 });
  chmodSync(credentialsFile, 0o600);
  const before = await status();
  assert.equal(before.configured, true);
  assert.deepEqual(before.mailboxes.map((one: { id: string }) => one.id), [WORK_ID]);
  assert.equal(before.mailboxes[0].account.password_kept, true);
  // The fields of a page that knows of one mailbox: the first.
  assert.equal(before.account.address, WORK);
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 2 });
  assert.equal(work.connections, 1);
  // A Gmail mailbox's state as 0.13.81 kept it: its history followed, no first reading to carry on.
  sqlite.prepare("UPDATE email_sources SET metadata = json_set(metadata, '$.gmail_sync', json(?)) WHERE id = ?").run(JSON.stringify({ since: now - 90 * DAY, history_id: "5012" }), WORK_ID);
  assert.deepEqual(gmailSyncState(WORK_ID), { since: now - 90 * DAY, history_id: "5012", backfill: null });
  sqlite.prepare("UPDATE email_sources SET metadata = json_remove(metadata, '$.gmail_sync') WHERE id = ?").run(WORK_ID);
});

test("« Ajouter une boîte mail »: another address is added next to the first — each its own password (0600), its own copy, read on its own", async () => {
  const added = await app.inject({ method: "POST", url: "/email/account", headers, payload: { address: HOME, host: "imap.maison.example", port: 993, password: home.password, window_days: 30 } });
  assert.equal(added.statusCode, 200, added.body);
  await settled();
  const shown = await status();
  assert.deepEqual(shown.mailboxes.map((one: { account: { address: string } }) => one.account.address), [WORK, HOME], "the first set up first");
  assert.equal(shown.kept.length, 0, "the first one is not replaced");
  const homeId = shown.mailboxes[1].id as string;
  assert.deepEqual(shown.mailboxes.map((one: { counts: { inbox: number } }) => one.counts.inbox), [1, 1]);
  assert.deepEqual(Object.keys(credentials()).sort(), [WORK_ID, homeId].sort());
  assert.equal(credentials()[WORK_ID]!.password, work.password);
  assert.equal(credentials()[homeId]!.password, home.password);
  if (process.platform !== "win32") assert.equal(statSync(credentialsFile).mode & 0o777, 0o600);
  assert.doesNotMatch(JSON.stringify(shown), /work-password|home-password/);
  // One mailbox read when it alone is asked for.
  const connections = { work: work.connections, home: home.connections };
  const one = await app.inject({ method: "POST", url: `/email/sync?id=${homeId}`, headers });
  assert.equal(one.statusCode, 202);
  await settled();
  assert.equal(work.connections, connections.work, "the other mailbox left alone");
  assert.equal(home.connections, connections.home + 1);
  assert.equal((await app.inject({ method: "POST", url: "/email/sync?id=not-one-of-hers", headers })).statusCode, 404);
});

test("« Modifier » a mailbox: its window changed without its password typed again; the other untouched", async () => {
  const homeId = (await status()).mailboxes[1].id as string;
  const changed = await app.inject({ method: "POST", url: "/email/account", headers, payload: { id: homeId, address: HOME, host: "imap.maison.example", port: 993, window_days: 90 } });
  assert.equal(changed.statusCode, 200, changed.body);
  const shown = await status();
  assert.equal(shown.mailboxes.length, 2);
  assert.equal(shown.mailboxes[1].account.window_days, 90);
  assert.equal(shown.mailboxes[0].account.window_days, 90);
  // Another mailbox's password is never taken for this one.
  const borrowed = await app.inject({ method: "POST", url: "/email/test", headers, payload: { id: homeId, address: WORK, host: "imap.tessane.example", port: 993 } });
  assert.equal(borrowed.json().error, "password_required");
  const unknown = await app.inject({ method: "POST", url: "/email/account", headers, payload: { id: "0c8f1d5e-0000-4000-8000-000000000000", address: HOME, host: "imap.maison.example", port: 993 } });
  assert.equal(unknown.statusCode, 404);
  assert.equal(unknown.json().error, "mailbox_not_found");
});

test("« Derniers messages »: from every mailbox, each with its own, or from the one chosen; this computer's app only", async () => {
  const [first, second] = (await status()).mailboxes as Array<{ id: string }>;
  const all = (await app.inject({ url: "/email/recent?folder=inbox", headers })).json().messages as Array<{ subject: string; mailbox: { id: string; address: string } }>;
  assert.deepEqual(all.map((one) => [one.subject, one.mailbox.address]), [["Dîner du 10 octobre", HOME], ["Contrat de maintenance", WORK]]);
  const homeOnly = (await app.inject({ url: `/email/recent?folder=inbox&mailbox=${second!.id}`, headers })).json().messages as Array<{ subject: string }>;
  assert.deepEqual(homeOnly.map((one) => one.subject), ["Dîner du 10 octobre"]);
  const sent = (await app.inject({ url: `/email/recent?folder=sent&mailbox=${first!.id}`, headers })).json().messages as Array<{ subject: string }>;
  assert.deepEqual(sent.map((one) => one.subject), ["Re: Contrat de maintenance"]);
  assert.equal((await app.inject({ url: "/email/recent", headers: phone })).statusCode, 403);
});

test("the chat searches every mailbox, each e-mail with its own; an answer is drafted in the mailbox the e-mail came to", async () => {
  const found = await runEmailTool("search_emails", { query: "contrat" }, allowAll);
  assert.match(found.text, /the copies of the user's 2 mailboxes kept on this computer: claire\.martin@tessane\.example \(inbox and sent since [\d-]+, last brought up to date [\d-]+ [\d:]+\); claire\.martin@maison\.example/);
  assert.match(found.text, /Mailbox: claire\.martin@tessane\.example\nFrom: Marc Dubois/);
  assert.match(found.text, /Mailbox: claire\.martin@maison\.example\nFrom: Léa Fontaine/);
  const lea = /id: ([0-9a-f-]{36}) [^\n]*\nMailbox: claire\.martin@maison\.example/.exec(found.text)![1]!;
  const read = await runEmailTool("read_email", { id: lea }, allowAll);
  assert.match(read.text, /Mailbox: claire\.martin@maison\.example/);
  const previews: Array<{ account: string }> = [];
  const drafted = await runEmailTool("draft_email", { in_reply_to: lea, body: "Avec plaisir !" }, { ...allowAll, approve: async (preview) => { previews.push(preview); return true; } });
  assert.equal(drafted.error, undefined, drafted.text);
  assert.equal(previews[0]!.account, HOME, "the person sees which mailbox before it is saved");
  assert.deepEqual(home.log.filter((line) => line.startsWith("APPEND")), ["APPEND Brouillons"]);
  assert.deepEqual(work.log.filter((line) => line.startsWith("APPEND")), []);
});

test("a new e-mail with several mailboxes: written from the one named, else asked — never guessed", async () => {
  const asked = await runEmailTool("draft_email", { to: "marc.dubois@tessane.example", subject: "Point", body: "Bonjour Marc." }, allowAll);
  assert.equal(asked.error, "which_mailbox");
  assert.match(asked.text, /several mailboxes \(claire\.martin@tessane\.example, claire\.martin@maison\.example\)/);
  const wrong = await runEmailTool("draft_email", { to: "marc.dubois@tessane.example", subject: "Point", body: "Bonjour Marc.", from_mailbox: "someone@else.example" }, allowAll);
  assert.equal(wrong.error, "unknown_mailbox");
  const named = await runEmailTool("draft_email", { to: "marc.dubois@tessane.example", subject: "Point", body: "Bonjour Marc.", from_mailbox: "Claire.Martin@Tessane.example" }, allowAll);
  assert.equal(named.error, undefined, named.text);
  assert.deepEqual(work.log.filter((line) => line.startsWith("APPEND")), ["APPEND Drafts"]);
  // An answer to an e-mail whose mailbox was removed: the one it was sent to.
  const sources = activeSources(userId);
  const orphan = { email_source_id: "gone", recipients: { to: [{ name: null, address: HOME }], cc: [], reply_to: [] }, from_email: "lea.fontaine@example.net" } as unknown as Parameters<typeof draftMailbox>[2];
  assert.equal((draftMailbox(sources, null, orphan) as { email_address: string }).email_address, HOME);
  assert.equal(draftMailbox(sources, null, null), null);
  assert.equal((draftMailbox(sources.slice(0, 1), null, null) as { email_address: string }).email_address, WORK, "one mailbox: that one");
});

test("as many mailboxes as Twoody keeps, no more; a second Microsoft account through Graph refused before anything is asked", async () => {
  // Fill up to the limit with addresses of the same home server.
  for (let i = (await status()).mailboxes.length; i < MAX_MAILBOXES; i += 1) {
    const done = await app.inject({ method: "POST", url: "/email/account", headers, payload: { address: `claire${i}@maison.example`, host: "imap.maison.example", port: 993, username: HOME, password: home.password, window_days: 30 } });
    assert.equal(done.statusCode, 200, done.body);
  }
  const over = await app.inject({ method: "POST", url: "/email/account", headers, payload: { address: "claire.extra@maison.example", host: "imap.maison.example", port: 993, username: HOME, password: home.password } });
  assert.equal(over.statusCode, 422);
  assert.equal(over.json().error, "too_many_mailboxes");
  // Changing one is still possible at the limit.
  const last = (await status()).mailboxes.at(-1).id as string;
  assert.equal((await app.inject({ method: "POST", url: "/email/account", headers, payload: { id: last, address: "claire.extra@maison.example", host: "imap.maison.example", port: 993, username: HOME, password: home.password } })).statusCode, 200);
  // Back under the limit: the extra ones removed, their copies deleted.
  for (const one of (await status()).mailboxes.slice(2) as Array<{ id: string }>) {
    assert.equal((await app.inject({ method: "DELETE", url: `/email/account?id=${one.id}&keep_messages=false`, headers })).statusCode, 200);
  }
  for (const copy of (await status()).kept as Array<{ id: string }>) await app.inject({ method: "DELETE", url: `/email/kept/${copy.id}`, headers });
  assert.equal((await status()).mailboxes.length, 2);
  // A mailbox read through Graph, of one Microsoft account; another account's is refused (409) with no sign-in asked.
  sqlite.prepare(`INSERT INTO email_sources (id, user_id, provider, email_address, imap_host, imap_port, imap_security, username, status, import_after, metadata, created_at, updated_at)
    VALUES ('graph-one', ?, 'imap', 'claire.martin@outlook.example', 'outlook.office365.com', 993, 'tls', 'claire.martin@outlook.example', 'active', ?, ?, ?, ?)`)
    .run(userId, now - 30 * DAY, JSON.stringify({ auth: "graph", preset: "outlook" }), now, now);
  const second = await app.inject({ method: "POST", url: "/email/account", headers, payload: { auth: "graph", address: "claire.autre@outlook.example", refresh_token: "m-refresh-made-up", scopes: "Mail.ReadWrite offline_access" } });
  assert.equal(second.statusCode, 409);
  assert.equal(second.json().error, "microsoft_one_account");
  sqlite.prepare("DELETE FROM email_sources WHERE id = 'graph-one'").run();
});

test("« Retirer » one mailbox: its password forgotten, its copy kept as asked — the other goes on; without saying which, nothing is removed", async () => {
  const [first, second] = (await status()).mailboxes as Array<{ id: string }>;
  const which = await app.inject({ method: "DELETE", url: "/email/account?keep_messages=true", headers });
  assert.equal(which.statusCode, 422);
  assert.equal(which.json().error, "mailbox_required");
  const removed = await app.inject({ method: "DELETE", url: `/email/account?id=${second!.id}&keep_messages=true`, headers });
  assert.equal(removed.statusCode, 200);
  const shown = removed.json();
  assert.deepEqual(shown.mailboxes.map((one: { id: string }) => one.id), [first!.id]);
  assert.ok(shown.kept.some((copy: { email_address: string }) => copy.email_address === HOME), "its copy kept, searchable");
  assert.deepEqual(Object.keys(credentials()), [first!.id]);
  assert.equal(addressOf(first!.id), WORK);
  const connections = home.connections;
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.equal(home.connections, connections, "the removed one is not read");
  // Its e-mails still found, said as from the copy kept.
  assert.match((await runEmailTool("search_emails", { query: "dîner" }, allowAll)).text, /Mailbox: claire\.martin@maison\.example/);
  // The only one left: removed without saying which, as before.
  assert.equal((await app.inject({ method: "DELETE", url: "/email/account?keep_messages=true", headers })).statusCode, 200);
  assert.equal((await status()).configured, false);
  assert.deepEqual(credentials(), {});
});

async function settled() {
  for (let i = 0; i < 300; i += 1) {
    const shown = await status();
    if (!shown.mailboxes.some((one: { sync: { running: boolean } }) => one.sync.running)) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
