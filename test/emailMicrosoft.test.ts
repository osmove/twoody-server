import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeMailServer, rfc822 } from "./helpers/fakeMailServer.js";

// « Se connecter avec Microsoft » (Capacités → E-mails, 04/10/2026): an
// Outlook.com or Microsoft 365 mailbox, linked with the refresh token the
// Desktop's main process got from Microsoft's sign-in, read over IMAP with
// XOAUTH2. Microsoft's token endpoint is played by a fake one on this
// machine, the mailbox by a fake server in memory: no Microsoft account, no
// network beyond this machine.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-microsoft-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const CLIENT_ID = "804f73f0-5611-4e2e-a8da-fd5efb0293ea";
const ADDRESS = "claire.martin@outlook.fr";

// ── The mailbox ──────────────────────────────────────────────────────────
const DAY = 86_400_000;
const now = Date.now();
const mail = new FakeMailServer();
mail.folder("INBOX", "\\Inbox", null);
mail.folder("Sent Items", "\\Sent");
mail.folder("Drafts", "\\Drafts");
mail.deliver("INBOX", rfc822({ from: "Tessane - Service facturation <facturation@tessane.fr>", to: `Claire Martin <${ADDRESS}>`, subject: "Votre facture d'octobre", messageId: "<facture-10@tessane.fr>", date: new Date(now - 2 * DAY), text: "Bonjour Claire,\n\nVotre facture d'octobre : 42,00 €.\n\nTessane" }), { at: now - 2 * DAY });
mail.deliver("Sent Items", rfc822({ from: `Claire Martin <${ADDRESS}>`, to: "Tessane <facturation@tessane.fr>", subject: "Re: Votre facture d'octobre", messageId: "<reponse@outlook.fr>", inReplyTo: "<facture-10@tessane.fr>", date: new Date(now - DAY), text: "Merci, c'est réglé." }), { at: now - DAY, flags: ["\\Seen"] });

// ── Microsoft's token endpoint, on this machine ─────────────────────────
type Answer = { status: number; body: Record<string, unknown>; delayMs?: number };
const tokenRequests: Array<Record<string, string>> = [];
let issued = 0;
/// The access tokens given are taken by the mailbox (false: IMAP turned off there).
let imapOn = true;
let lifetime = 3_599;
/// An access token, and a new refresh token in place of the one used, as Microsoft does.
const grant = (): Answer => {
  issued += 1;
  const accessToken = `ms-access-${issued}`;
  if (imapOn) mail.accessTokens.add(accessToken);
  return { status: 200, body: { token_type: "Bearer", scope: "https://outlook.office.com/IMAP.AccessAsUser.All", expires_in: lifetime, access_token: accessToken, refresh_token: `ms-refresh-${issued + 1}` } };
};
let answer: () => Answer = grant;
const endpoint = createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => (raw += chunk));
  req.on("end", async () => {
    tokenRequests.push(Object.fromEntries(new URLSearchParams(raw)));
    const { status, body, delayMs } = answer();
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
});
await new Promise<void>((resolve) => endpoint.listen(0, "127.0.0.1", resolve));
const endpointUrl = `http://127.0.0.1:${(endpoint.address() as AddressInfo).port}/common/oauth2/v2.0/token`;
const fakeEndpoint = (init: RequestInit) => fetch(endpointUrl, init);

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, createAuthSession } = await import("../src/auth.js");
const { MailError, useMailConnectorForTests } = await import("../src/email/imap.js");
const { microsoftAccess, microsoftErrorCode, useMicrosoftTokenEndpointForTests } = await import("../src/email/microsoft.js");
const { syncDue, syncMailbox } = await import("../src/email/sync.js");
const { activeSource } = await import("../src/email/store.js");
const { saveDraft } = await import("../src/email/chat.js");
useMailConnectorForTests(mail.connector);
useMicrosoftTokenEndpointForTests(fakeEndpoint);

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const phone = { authorization: `Bearer ${createAuthSession(userId, "iphone").token}` };
test.after(async () => {
  useMailConnectorForTests(null);
  useMicrosoftTokenEndpointForTests(null);
  await app.close();
  await new Promise((resolve) => endpoint.close(resolve));
});

const credentialsFile = join(process.env.TWOODY_DATA_DIR!, "email-credentials.json");
const kept = () => (existsSync(credentialsFile) ? Object.values(JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, { refresh_token?: string; password?: string }>) : []);
const status = async () => (await app.inject({ url: "/email/status", headers })).json();
/// What the Desktop's main process sends once Microsoft's sign-in is done.
const signedIn = (refreshToken: string, extra: Record<string, unknown> = {}) => ({ auth: "microsoft", address: ADDRESS, refresh_token: refreshToken, window_days: 30, preset: "outlook", ...extra });
/// The server restarted: what memory held is gone, the file stays.
const restart = () => useMicrosoftTokenEndpointForTests(fakeEndpoint);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("off until Capacités → E-mails is on: no token asked of Microsoft, no connection", async () => {
  const refused = await app.inject({ method: "POST", url: "/email/account", headers, payload: signedIn("ms-refresh-1") });
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, "email_off");
  assert.equal(tokenRequests.length, 0);
  assert.equal(mail.connections + mail.logins.length, 0);
});

test("linked only from this computer's app; without a sign-in, nothing is tried", async () => {
  await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers, payload: { enabled: true } });
  assert.equal((await app.inject({ method: "POST", url: "/email/account", headers: phone, payload: signedIn("ms-refresh-1") })).statusCode, 403);
  const none = await app.inject({ method: "POST", url: "/email/test", headers, payload: { auth: "microsoft", address: ADDRESS } });
  assert.equal(none.statusCode, 409);
  assert.equal(none.json().error, "signin_required");
  assert.equal(tokenRequests.length, 0);
  assert.equal(mail.logins.length, 0);
});

test("linked: the refresh token traded at Microsoft's token endpoint (no secret), the mailbox opened with XOAUTH2 at outlook.office365.com; the newest refresh token kept apart (0600), never shown", async () => {
  const saved = await app.inject({ method: "POST", url: "/email/account", headers, payload: signedIn("ms-refresh-1", { host: "imap.evil.example", port: 143, password: "not-used" }) });
  assert.equal(saved.statusCode, 200, saved.body);
  await syncMailbox(userId);
  assert.equal(tokenRequests.length, 1, "the access token got for the test serves the first sync too");
  assert.deepEqual(tokenRequests[0], { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "ms-refresh-1", scope: "https://outlook.office.com/IMAP.AccessAsUser.All offline_access" });
  // Microsoft's server, whatever the body said; the address as username.
  assert.deepEqual(new Set(mail.logins.map((login) => JSON.stringify(login))), new Set([JSON.stringify({ host: "outlook.office365.com", port: 993, security: "tls", username: ADDRESS })]));
  assert.ok(mail.log.includes(`AUTHENTICATE XOAUTH2 ${ADDRESS}`));
  assert.ok(!mail.log.some((line) => line.startsWith("LOGIN")), "never a password");
  // The refresh token Microsoft gave back, kept alone in its file.
  assert.equal(statSync(credentialsFile).mode & 0o777, 0o600);
  assert.deepEqual(kept().map((one) => Object.keys(one).sort()), [["refresh_token", "saved_at"]]);
  assert.equal(kept()[0]!.refresh_token, "ms-refresh-2");
  const body = await status();
  assert.equal(body.account.address, ADDRESS);
  assert.equal(body.account.auth, "microsoft");
  assert.equal(body.account.signin_kept, true);
  assert.equal(body.account.password_kept, false);
  assert.equal(body.account.host, "outlook.office365.com");
  assert.equal(body.account.preset, "outlook");
  assert.equal(body.account.window_days, 30);
  assert.deepEqual(body.counts, { inbox: 1, sent: 1, unread: 1 });
  assert.deepEqual(body.folders, { inbox: "INBOX", sent: "Sent Items", drafts: "Drafts" });
  assert.doesNotMatch(saved.body + JSON.stringify(body), /ms-refresh|ms-access/, "never shown");
  for (const file of ["local.db", "local.db-wal"]) {
    const path = join(process.env.TWOODY_DATA_DIR!, file);
    if (existsSync(path)) assert.ok(!readFileSync(path).includes("ms-refresh") && !readFileSync(path).includes("ms-access"), `not in ${file}`);
  }
});

test("an access token serves until shortly before it expires; then a new one is got with the newest refresh token, and the one given back is kept", async () => {
  // Less than the margin: never served from memory.
  lifetime = 60;
  restart();
  const before = tokenRequests.length;
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.deepEqual(tokenRequests.slice(before).map((form) => form.refresh_token), ["ms-refresh-2", "ms-refresh-3"]);
  assert.equal(kept()[0]!.refresh_token, "ms-refresh-4");
  // None given back: the one used stays.
  lifetime = 3_599;
  answer = () => {
    const given = grant();
    delete given.body.refresh_token;
    return given;
  };
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.equal(tokenRequests.at(-1)!.refresh_token, "ms-refresh-4");
  assert.equal(kept()[0]!.refresh_token, "ms-refresh-4");
  answer = grant;
});

test("a token the server refuses before its time (a new password): a new one is got, once; refused again, IMAP is what is refused, and the sync waits for the person", async () => {
  mail.accessTokens.clear();
  const before = tokenRequests.length;
  const tries = () => mail.log.filter((line) => line.startsWith("AUTHENTICATE")).length;
  const triedBefore = tries();
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.equal(tokenRequests.length - before, 1, "one new token");
  assert.equal(tries() - triedBefore, 2, "refused, then let in");
  // IMAP turned off for the mailbox: no token is taken.
  imapOn = false;
  mail.accessTokens.clear();
  assert.deepEqual(await syncMailbox(userId), { ok: false, error: "imap_refused" });
  const body = await status();
  assert.equal(body.sync.last_error, "imap_refused");
  assert.equal(body.sync.next_at, null);
  assert.equal(syncDue(activeSource(userId)!, Date.now() + 3_600_000), false, "not asked again and again");
  imapOn = true;
});

test("a sign-in Microsoft no longer honours (expired, withdrawn, a new password): « Reconnectez-vous à Microsoft », and nothing of Microsoft's own words kept", async () => {
  answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: `AADSTS70008: The provided authorization code or refresh token has expired due to inactivity. ${ADDRESS}\r\nTrace ID: 0000`, error_codes: [70008] } });
  restart();
  assert.deepEqual(await syncMailbox(userId), { ok: false, error: "signin_required" });
  const body = await status();
  assert.equal(body.sync.last_error, "signin_required");
  assert.equal(body.sync.next_at, null);
  assert.equal(syncDue(activeSource(userId)!, Date.now() + 3_600_000), false);
  assert.doesNotMatch(JSON.stringify(body), /AADSTS|inactivity|Trace/);
  const tested = await app.inject({ method: "POST", url: "/email/test", headers, payload: { auth: "microsoft", address: ADDRESS } });
  assert.equal(tested.statusCode, 409);
  assert.equal(tested.json().error, "signin_required");
});

test("an approval the sign-in waits for — an organisation's (AADSTS90094, Conditional Access) or a consent (AADSTS65001) — is said apart from the rest", async () => {
  assert.equal(microsoftErrorCode({ error: "invalid_grant", error_codes: [65001] }), "admin_consent_required");
  assert.equal(microsoftErrorCode({ error: "invalid_request", error_description: "AADSTS90094: The grant requires admin permission." }), "admin_consent_required");
  assert.equal(microsoftErrorCode({ error: "invalid_grant", error_codes: [53003] }), "admin_consent_required");
  assert.equal(microsoftErrorCode({ error: "invalid_grant", error_codes: [50173] }), "signin_required");
  assert.equal(microsoftErrorCode({ error: "interaction_required", error_codes: [50076] }), "signin_required");
  assert.equal(microsoftErrorCode({ error: "invalid_client", error_codes: [7000218] }), "signin_failed");
  assert.equal(microsoftErrorCode({ error: "temporarily_unavailable" }), "signin_failed");
  assert.equal(microsoftErrorCode(null), "signin_failed");
  answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented to use the application.", error_codes: [65001] } });
  const tested = await app.inject({ method: "POST", url: "/email/test", headers, payload: { auth: "microsoft", address: ADDRESS } });
  assert.equal(tested.statusCode, 502);
  assert.equal(tested.json().error, "admin_consent_required");
  assert.equal(syncDue({ ...activeSource(userId)!, last_error: "admin_consent_required" }, Date.now() + 3_600_000), false);
});

test("Microsoft out of reach: said as such, and tried again at the next round", async () => {
  useMicrosoftTokenEndpointForTests(async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await syncMailbox(userId), { ok: false, error: "signin_unreachable" });
  assert.equal(syncDue(activeSource(userId)!, Date.now() + 11 * 60_000), true);
  answer = grant;
  restart();
});

test("signed in again: the same mailbox and its copy, the new sign-in in place of the old, the error gone", async () => {
  const id = activeSource(userId)!.id;
  const again = await app.inject({ method: "POST", url: "/email/account", headers, payload: signedIn("ms-refresh-again") });
  assert.equal(again.statusCode, 200, again.body);
  await syncMailbox(userId);
  assert.equal(activeSource(userId)!.id, id);
  assert.equal(tokenRequests.at(-1)!.refresh_token, "ms-refresh-again");
  assert.equal(kept().length, 1);
  assert.match(kept()[0]!.refresh_token!, /^ms-refresh-\d+$/);
  const body = await status();
  assert.equal(body.sync.last_error, null);
  assert.deepEqual(body.counts, { inbox: 1, sent: 1, unread: 1 });
});

test("a draft the person allowed is appended over XOAUTH2, never sent", async () => {
  const before = mail.log.length;
  const draft = { from: { name: "Claire Martin", address: ADDRESS }, to: [{ name: null, address: "facturation@tessane.fr" }], cc: [], subject: "Facture d'octobre", body: "Bonjour,\n\nC'est noté.\n\nClaire", inReplyTo: null, references: [] };
  assert.deepEqual(await saveDraft(userId, activeSource(userId)!, draft), { ok: true, folder: "Drafts", uid: 1 });
  assert.deepEqual(mail.log.slice(before), [`AUTHENTICATE XOAUTH2 ${ADDRESS}`, "APPEND Drafts", "LOGOUT"]);
});

test("E-mails switched off: no token asked of Microsoft, no connection", async () => {
  await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers, payload: { enabled: false } });
  restart();
  const [requests, connections] = [tokenRequests.length, mail.connections];
  assert.deepEqual(await syncMailbox(userId), { ok: false, error: "email_off" });
  // The door itself: E-mails on, and a mailbox that signs in with Microsoft.
  await assert.rejects(microsoftAccess("ms-refresh-x", { microsoftMailbox: true, emailOn: false }), (err: unknown) => err instanceof MailError && err.code === "email_off");
  await assert.rejects(microsoftAccess("ms-refresh-x", { microsoftMailbox: false, emailOn: true }), (err: unknown) => err instanceof MailError && err.code === "not_configured");
  assert.equal(tokenRequests.length, requests);
  assert.equal(mail.connections, connections);
  await app.inject({ method: "PATCH", url: "/local_capabilities/email", headers, payload: { enabled: true } });
});

test("removed: the sign-in forgotten, in the file and in memory; a refresh token Microsoft gives back afterwards is not kept", async () => {
  await syncMailbox(userId);
  const last = kept()[0]!.refresh_token!;
  assert.equal((await app.inject({ method: "DELETE", url: "/email/account?keep_messages=true", headers })).statusCode, 200);
  assert.ok(!existsSync(credentialsFile));
  // Linked again with that same token: memory forgot it, Microsoft is asked.
  const before = tokenRequests.length;
  assert.equal((await app.inject({ method: "POST", url: "/email/account", headers, payload: signedIn(last) })).statusCode, 200);
  assert.deepEqual(tokenRequests.slice(before).map((form) => form.refresh_token), [last]);
  await syncMailbox(userId);
  // Removed while Microsoft answers: the token it gives back goes nowhere.
  restart();
  answer = () => ({ ...grant(), delayMs: 300 });
  const asked = tokenRequests.length;
  const syncing = syncMailbox(userId);
  while (tokenRequests.length === asked) await sleep(5);
  assert.equal((await app.inject({ method: "DELETE", url: "/email/account?keep_messages=true", headers })).statusCode, 200);
  await syncing;
  assert.ok(!existsSync(credentialsFile), "nothing written back");
  answer = grant;
});
