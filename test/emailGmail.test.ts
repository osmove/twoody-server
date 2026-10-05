import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeMailServer, rfc822 } from "./helpers/fakeMailServer.js";

// A Gmail mailbox read through the Gmail API (« Se connecter avec Google »,
// Capacités → E-mails, 05/10/2026), not over IMAP: the sign-in the Desktop's
// main process hands over (a refresh token) is kept as a password is, INBOX
// and SENT are copied from the window, then from Gmail's history, and a
// draft is created — never sent. Google's token endpoint and the Gmail API
// are played by fakes in this process, the IMAP mailbox the person had
// before by a fake server in memory: no Google account, and no network
// beyond this machine (fetch refuses any other host). A fictional account:
// Claire Martin, Tessane.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-email-gmail-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
// Twoody's client at Google, made up for the tests.
process.env.TWOODY_GOOGLE_CLIENT_ID = "twoody-test-client";
process.env.TWOODY_GOOGLE_CLIENT_SECRET = "twoody-test-not-secret";
delete process.env.BRIDGE_LOCAL_LLM_ENDPOINT;
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const network = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.hostname !== "127.0.0.1") throw new Error(`no network in the tests: ${target.host}`);
  return network(input, init);
}) as typeof fetch;

const ADDRESS = "claire.martin@gmail.com";
const READONLY = "https://www.googleapis.com/auth/gmail.readonly";
const COMPOSE = "https://www.googleapis.com/auth/gmail.compose";
const SCOPES = `openid ${READONLY} ${COMPOSE} https://www.googleapis.com/auth/userinfo.email`;
const DAY = 86_400_000;
const now = Date.now();

// ── Google's token endpoint ─────────────────────────────────────────────
const tokenForms: Array<Record<string, string>> = [];
const accessTokens = new Set<string>();
const revoked = new Set<string>();
const restricted = new Set<string>();
let issued = 0;
const tokenEndpoint = async (init: RequestInit) => {
  const form = Object.fromEntries(new URLSearchParams(String(init.body)));
  tokenForms.push(form);
  if (revoked.has(form.refresh_token ?? "")) return Response.json({ error: "invalid_grant", error_description: `Token has been expired or revoked for ${ADDRESS}.` }, { status: 400 });
  if (restricted.has(form.refresh_token ?? "")) return Response.json({ error: "admin_policy_enforced", error_description: "Restricted by the administrator." }, { status: 400 });
  issued += 1;
  const token = `g-access-${issued}`;
  accessTokens.add(token);
  return Response.json({ access_token: token, expires_in: 3599, token_type: "Bearer", scope: `${READONLY} ${COMPOSE}` });
};

// ── The Gmail API ───────────────────────────────────────────────────────
type Part = Record<string, unknown>;
const data = (text: string | Buffer) => Buffer.from(text).toString("base64url");
const headers = (list: Record<string, string | undefined>) => Object.entries(list).filter(([, value]) => value !== undefined).map(([name, value]) => ({ name, value }));
function textPart(type: "text/plain" | "text/html", text: string, charset = "UTF-8"): Part {
  return { partId: "", mimeType: type, filename: "", headers: headers({ "Content-Type": `${type}; charset="${charset}"`, "Content-Transfer-Encoding": "quoted-printable" }), body: { size: Buffer.byteLength(text), data: data(text) } };
}

interface FakeMessage { id: string; threadId: string; labels: Set<string>; internalDate: number; historyId: number; payload: Part; deleted: boolean }
const messages = new Map<string, FakeMessage>();
/// Kept apart by Gmail: a large text part, and an attachment's content (never to be asked).
const apart = new Map<string, string>();
let history = 5_000;
const records: Array<{ id: number; key: "messagesAdded" | "messagesDeleted" | "labelsAdded" | "labelsRemoved"; message: string }> = [];
const world = {
  /// Gmail forgot the history before this id (a mailbox long unread).
  floor: 0,
  /// Messages per page of a list.
  pageSize: 2,
  /// The account's address, as Google says it.
  address: ADDRESS,
  drafts: [] as Array<Record<string, unknown>>,
  /// 429s still to answer.
  throttle: 0,
  /// Said with each 429 (seconds), or nothing.
  retryAfter: null as string | null,
  /// Messages Gmail still reads whole before its quota runs out (null: no quota):
  /// past it, every request is answered 429 until it is lifted.
  quota: null as number | null,
};
function deliver(one: { id: string; thread: string; labels: string[]; at: number; payload: Part }) {
  history += 1;
  messages.set(one.id, { id: one.id, threadId: one.thread, labels: new Set(one.labels), internalDate: one.at, historyId: history, payload: one.payload, deleted: false });
  records.push({ id: history, key: "messagesAdded", message: one.id });
}
function relabel(id: string, add: string[], remove: string[]) {
  const message = messages.get(id)!;
  history += 1;
  for (const label of add) message.labels.add(label);
  for (const label of remove) message.labels.delete(label);
  message.historyId = history;
  if (add.length) records.push({ id: history, key: "labelsAdded", message: id });
  if (remove.length) records.push({ id: history, key: "labelsRemoved", message: id });
}

const CLAIRE = `Claire Martin <${ADDRESS}>`;
// Léa's question: plain and HTML, unread, its subject in UTF-8 as Gmail gives it.
deliver({
  id: "18c0000000000a01", thread: "18c0000000000a01", labels: ["INBOX", "UNREAD", "CATEGORY_PERSONAL"], at: now - 3 * DAY,
  payload: {
    mimeType: "multipart/alternative", filename: "",
    headers: headers({ From: "Léa Fontaine <lea.fontaine@example.net>", To: CLAIRE, Subject: "Dîner du 10 octobre", Date: new Date(now - 3 * DAY).toUTCString(), "Message-ID": "<diner-10-octobre@example.net>" }),
    body: { size: 0 },
    parts: [textPart("text/plain", "Coucou Claire !\n\nTu viens dîner à la maison le samedi 10 octobre ? Dis-moi avant mercredi.\n\nLéa"), textPart("text/html", "<p>Coucou Claire !</p><p>Tu viens dîner à la maison le samedi 10 octobre ?</p>")],
  },
});
// Tessane's invoice, read, with a PDF whose content stays at Gmail.
apart.set("ANGjdJ_pdf", data("%PDF-1.4 fictional Tessane invoice"));
deliver({
  id: "18c0000000000b01", thread: "18c0000000000b01", labels: ["INBOX", "IMPORTANT"], at: now - 10 * DAY,
  payload: {
    mimeType: "multipart/mixed", filename: "",
    headers: headers({ From: "Tessane - Service facturation <facturation@tessane.fr>", To: CLAIRE, Subject: "=?UTF-8?Q?Votre_facture_F-2026-0912_=E2=80=94_Tessane?=", Date: new Date(now - 10 * DAY).toUTCString(), "Message-ID": "<facture-0912@tessane.fr>" }),
    body: { size: 0 },
    parts: [
      textPart("text/plain", "Bonjour Claire,\n\nVotre facture F-2026-0912 : 1 248,00 € TTC, à régler avant le 12 octobre.\n\nTessane"),
      { partId: "1", mimeType: "application/pdf", filename: "F-2026-0912.pdf", headers: headers({ "Content-Type": "application/pdf; name=\"F-2026-0912.pdf\"", "Content-Disposition": "attachment; filename=\"F-2026-0912.pdf\"" }), body: { attachmentId: "ANGjdJ_pdf", size: 90_112 } },
    ],
  },
});
// Claire's answer, in the same conversation.
deliver({
  id: "18c0000000000b02", thread: "18c0000000000b01", labels: ["SENT"], at: now - 9 * DAY,
  payload: {
    mimeType: "text/plain", filename: "",
    headers: headers({ From: CLAIRE, To: "Tessane <facturation@tessane.fr>", Subject: "Re: Votre facture F-2026-0912", Date: new Date(now - 9 * DAY).toUTCString(), "Message-ID": "<reponse-facture@mail.gmail.com>", "In-Reply-To": "<facture-0912@tessane.fr>", References: "<facture-0912@tessane.fr>" }),
    body: { size: 19, data: data("Merci, c'est réglé.") },
  },
});
// A newsletter, HTML only.
deliver({
  id: "18c0000000000c01", thread: "18c0000000000c01", labels: ["INBOX", "UNREAD", "CATEGORY_PROMOTIONS"], at: now - 2 * DAY,
  payload: {
    mimeType: "text/html", filename: "",
    headers: headers({ From: "La Lettre du Vélo <newsletter@lalettreduvelo.example>", To: CLAIRE, Subject: "Octobre : préparez votre vélo", Date: new Date(now - 2 * DAY).toUTCString(), "Message-ID": "<lettre-octobre@lalettreduvelo.example>", "List-Unsubscribe": "<https://lalettreduvelo.example/u>" }),
    body: { size: 80, data: data("<h1>Octobre</h1><p>Éclairage, pneus, freins : notre <a href=\"https://track.example/x\">check-list</a>.</p>") },
  },
});
// Marc's long message: Gmail keeps its text apart.
apart.set("ANGjdJ_text", data("Bonjour Claire,\n\nPeux-tu me rappeler la date de fin de notre contrat de maintenance ?\n\nMarc"));
deliver({
  id: "18c0000000000d01", thread: "18c0000000000d01", labels: ["INBOX"], at: now - 6 * DAY,
  payload: {
    mimeType: "text/plain", filename: "",
    headers: headers({ From: "Marc Dubois <marc.dubois@example.fr>", To: CLAIRE, Subject: "Question sur le contrat de maintenance", Date: new Date(now - 6 * DAY).toUTCString(), "Message-ID": "<devis@example.fr>", "Content-Type": "text/plain; charset=UTF-8" }),
    body: { attachmentId: "ANGjdJ_text", size: 120 },
  },
});
// A reminder the IMAP copy holds already.
deliver({
  id: "18c0000000000a00", thread: "18c0000000000a00", labels: ["INBOX"], at: now - 12 * DAY,
  payload: { mimeType: "text/plain", filename: "", headers: headers({ From: "Cabinet Ravel <rdv@cabinet-ravel.example>", To: CLAIRE, Subject: "Rendez-vous du 8 octobre", "Message-ID": "<rdv-8-octobre@cabinet-ravel.example>" }), body: { size: 30, data: data("Rendez-vous le 8 octobre à 9 h.") } },
});
// Older than the window.
deliver({
  id: "18c0000000000e01", thread: "18c0000000000e01", labels: ["INBOX"], at: now - 45 * DAY,
  payload: { mimeType: "text/plain", filename: "", headers: headers({ From: "Marc Dubois <marc.dubois@example.fr>", To: CLAIRE, Subject: "Un vieux message", "Message-ID": "<vieux@example.fr>" }), body: { size: 18, data: data("Hors de la fenêtre.") } },
});

const gmailRequests: Array<{ method: string; path: string; params: URLSearchParams; authorization: string | null; body: string | null; at: number; status: number }> = [];
/// Twoody's time, as the tests keep it: it moves only when Twoody waits.
let clock = now;
const waits: number[] = [];
let inFlight = 0;
let mostInFlight = 0;
const json = (body: unknown, status = 200) => Response.json(body, { status });
const notFound = () => json({ error: { code: 404, message: "Requested entity was not found.", errors: [{ reason: "notFound" }], status: "NOT_FOUND" } }, 404);
const visible = (message: FakeMessage) => !message.deleted && !message.labels.has("TRASH") && !message.labels.has("SPAM");
const minimal = (message: FakeMessage) => ({ id: message.id, threadId: message.threadId, labelIds: [...message.labels], historyId: String(message.historyId), internalDate: String(message.internalDate) });

const fakeGmail = async (target: string, init: RequestInit): Promise<Response> => {
  const url = new URL(target);
  const request = { method: init.method ?? "GET", path: url.pathname, params: url.searchParams, authorization: new Headers(init.headers).get("authorization"), body: typeof init.body === "string" ? init.body : null, at: clock, status: 200 };
  gmailRequests.push(request);
  inFlight += 1;
  mostInFlight = Math.max(mostInFlight, inFlight);
  try {
    // Answered a moment later: the requests made meanwhile overlap.
    await new Promise((resolve) => setImmediate(resolve));
    const response = await answerGmail(url, init, request);
    request.status = response.status;
    return response;
  } finally {
    inFlight -= 1;
  }
};
const tooMany = () => new Response(JSON.stringify({ error: { code: 429, message: "Too many requests.", errors: [{ reason: "rateLimitExceeded" }], status: "RESOURCE_EXHAUSTED" } }), {
  status: 429, headers: { "content-type": "application/json", ...(world.retryAfter ? { "retry-after": world.retryAfter } : {}) },
});
const answerGmail = async (url: URL, init: RequestInit, request: { method: string; authorization: string | null }): Promise<Response> => {
  const { method, authorization } = request;
  if (world.throttle > 0) {
    world.throttle -= 1;
    return tooMany();
  }
  if (world.quota !== null && world.quota <= 0) return tooMany();
  if (world.quota !== null && /\/messages\/[0-9a-f]+$/.test(url.pathname) && url.searchParams.get("format") === "full") world.quota -= 1;
  if (!accessTokens.has(authorization?.replace(/^Bearer /, "") ?? "")) return json({ error: { code: 401, message: "Invalid Credentials", status: "UNAUTHENTICATED" } }, 401);
  const path = url.pathname.replace(/^\/gmail\/v1\/users\/me/, "");
  let match: RegExpExecArray | null;
  if (method === "GET" && path === "/profile") return json({ emailAddress: world.address, messagesTotal: messages.size, threadsTotal: 5, historyId: String(history) });
  if (method === "GET" && path === "/labels") return json({ labels: ["INBOX", "SENT", "DRAFT", "TRASH", "SPAM", "UNREAD", "STARRED", "IMPORTANT"].map((id) => ({ id, name: id, type: "system" })) });
  if (method === "GET" && (match = /^\/labels\/([A-Z_]+)$/.exec(path))) {
    const id = match[1]!;
    return json({ id, name: id, messagesTotal: [...messages.values()].filter((one) => visible(one) && one.labels.has(id)).length });
  }
  if (method === "GET" && path === "/messages") {
    const label = url.searchParams.get("labelIds");
    const after = /^after:(\d+)$/.exec(url.searchParams.get("q") ?? "");
    const list = [...messages.values()].filter((one) => visible(one) && (!label || one.labels.has(label)) && (!after || one.internalDate > Number(after[1]) * 1_000)).sort((a, b) => b.internalDate - a.internalDate);
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const size = Math.min(world.pageSize, Number(url.searchParams.get("maxResults") ?? 100));
    const page = list.slice(offset, offset + size);
    return json({ messages: page.map((one) => ({ id: one.id, threadId: one.threadId })), resultSizeEstimate: list.length, ...(offset + size < list.length ? { nextPageToken: String(offset + size) } : {}) });
  }
  if (method === "GET" && (match = /^\/messages\/([0-9a-f]+)$/.exec(path))) {
    const message = messages.get(match[1]!);
    if (!message || message.deleted) return notFound();
    const format = url.searchParams.get("format");
    if (format === "minimal") return json(minimal(message));
    return json({ ...minimal(message), snippet: "…", sizeEstimate: 4_096, payload: message.payload });
  }
  if (method === "GET" && (match = /^\/messages\/([0-9a-f]+)\/attachments\/([A-Za-z0-9_-]+)$/.exec(path))) {
    const content = apart.get(match[2]!);
    return content ? json({ size: Buffer.from(content, "base64url").length, data: content }) : notFound();
  }
  if (method === "GET" && path === "/history") {
    const start = Number(url.searchParams.get("startHistoryId"));
    if (!Number.isFinite(start) || start < world.floor) return notFound();
    const types = new Set(url.searchParams.getAll("historyTypes").map((type) => ({ messageAdded: "messagesAdded", messageDeleted: "messagesDeleted", labelAdded: "labelsAdded", labelRemoved: "labelsRemoved" })[type]));
    const list = records.filter((record) => record.id > start && types.has(record.key));
    const offset = Number(url.searchParams.get("pageToken") ?? 0);
    const page = list.slice(offset, offset + world.pageSize);
    return json({
      history: page.map((record) => ({ id: String(record.id), messages: [{ id: record.message }], [record.key]: [{ message: { id: record.message, threadId: messages.get(record.message)?.threadId } }] })),
      historyId: String(history),
      ...(offset + world.pageSize < list.length ? { nextPageToken: String(offset + world.pageSize) } : {}),
    });
  }
  if (method === "POST" && path === "/drafts") {
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    world.drafts.push(body);
    return json({ id: `r-draft-${world.drafts.length}`, message: { id: `18d000000000000${world.drafts.length}`, labelIds: ["DRAFT"] } });
  }
  return notFound();
};

// ── The IMAP mailbox the person had set up before ───────────────────────
const mail = new FakeMailServer();
mail.folder("INBOX", "\\Inbox", null);
mail.folder("[Gmail]/Messages envoyés", "\\Sent");
mail.folder("[Gmail]/Brouillons", "\\Drafts");
mail.deliver("INBOX", rfc822({ from: "Cabinet Ravel <rdv@cabinet-ravel.example>", to: CLAIRE, subject: "Rendez-vous du 8 octobre", messageId: "<rdv-8-octobre@cabinet-ravel.example>", date: new Date(now - 12 * DAY), text: "Rendez-vous le 8 octobre à 9 h." }), { at: now - 12 * DAY, flags: ["\\Seen"] });

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { useMailConnectorForTests } = await import("../src/email/imap.js");
const { googleErrorCode, useGoogleTokenEndpointForTests } = await import("../src/google/token.js");
const { gmailRefusal, gmailThreadId, gmailUnits, GMAIL_CONCURRENCY, GMAIL_UNITS_PER_SECOND, useGmailForTests } = await import("../src/email/gmailMailbox.js");
const { needsThePerson, syncMailbox } = await import("../src/email/sync.js");
const { activeSource, gmailSyncState, saveGmailSyncState } = await import("../src/email/store.js");
const { saveDraft } = await import("../src/email/chat.js");
useGoogleTokenEndpointForTests(tokenEndpoint);
useGmailForTests(fakeGmail, { sleep: async (ms) => { waits.push(ms); clock += ms; }, now: () => clock, random: () => 0.5 });
useMailConnectorForTests(mail.connector);

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const auth = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const phone = { authorization: `Bearer ${createAuthSession(userId, "pair:iPhone").token}` };
test.after(async () => {
  useGoogleTokenEndpointForTests(null);
  useGmailForTests(null);
  useMailConnectorForTests(null);
  globalThis.fetch = network;
  await app.close();
});

const credentialsFile = join(process.env.TWOODY_DATA_DIR!, "email-credentials.json");
const credentials = () => (existsSync(credentialsFile) ? (JSON.parse(readFileSync(credentialsFile, "utf8")) as Record<string, Record<string, unknown>>) : {});
const status = async () => (await app.inject({ url: "/email/status", headers: auth })).json();
const capability = (enabled: boolean) => app.inject({ method: "PATCH", url: "/local_capabilities/email", headers: auth, payload: { enabled } });
/// What the Desktop's main process hands over once Google's sign-in is done on the E-mails page.
const signedIn = (refreshToken: string, extra: Record<string, unknown> = {}) => ({ auth: "gmail", address: ADDRESS, refresh_token: refreshToken, scopes: SCOPES, window_days: 30, preset: "gmail", ...extra });
const setUp = (body: Record<string, unknown>, who = auth) => app.inject({ method: "POST", url: "/api/v1/email/account", headers: who, payload: body });
const rows = (where = "1 = 1") => sqlite.prepare(`SELECT e.*, f.role FROM emails e JOIN email_folders f ON f.id = e.email_folder_id WHERE e.user_id = ? AND ${where} ORDER BY e.provider_internal_date`).all(userId) as Array<Record<string, unknown>>;
const bySubject = (subject: string) => rows().find((row) => row.subject === subject);
async function settled() {
  for (let i = 0; i < 300; i += 1) {
    if (!(await status()).sync?.running) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test("off until Capacités → E-mails is on: nothing kept, no token asked, Gmail never called", async () => {
  const refused = await setUp(signedIn("g-refresh-1"));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, "email_off");
  assert.equal(tokenForms.length + gmailRequests.length, 0);
});

test("only from this computer's app; a sign-in without both Gmail permissions, or none at all with nothing kept, sets up nothing and asks nothing", async () => {
  await capability(true);
  assert.equal((await setUp(signedIn("g-refresh-1"), phone)).statusCode, 403);
  const narrow = await setUp(signedIn("g-refresh-1", { scopes: `openid ${READONLY}` }));
  assert.equal(narrow.statusCode, 422);
  assert.equal(narrow.json().error, "scope_missing");
  const none = await app.inject({ method: "POST", url: "/email/test", headers: auth, payload: { auth: "gmail", address: ADDRESS } });
  assert.equal(none.statusCode, 409);
  assert.equal(none.json().error, "signin_required");
  assert.equal(tokenForms.length + gmailRequests.length, 0);
  assert.equal((await status()).configured, false);
});

test("a sign-in that is another Google account than the address: « other_account », nothing kept", async () => {
  world.address = "someone.else@gmail.com";
  const refused = await setUp(signedIn("g-refresh-1"));
  world.address = ADDRESS;
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error, "other_account");
  assert.doesNotMatch(refused.body, /someone\.else/);
  assert.equal((await status()).configured, false);
  assert.deepEqual(credentials(), {});
});

test("the app password a Gmail mailbox had, read over IMAP: its copy kept for later", async () => {
  // Pasted with Google's spaces, a zero-width space and a byte order mark.
  const typed = `﻿${mail.password.replace(" ", "​ ")}`;
  const done = await app.inject({ method: "POST", url: "/email/account", headers: auth, payload: { address: ADDRESS, host: "imap.gmail.com", port: 993, password: typed, preset: "gmail", window_days: 30 } });
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json().warnings, []);
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 1 });
  assert.equal(credentials()[activeSource(userId)!.id]!.password, mail.password.replace(/\s+/g, ""));
  // Not 16 letters: said, not refused.
  const odd = await app.inject({ method: "POST", url: "/email/test", headers: auth, payload: { address: ADDRESS, host: "imap.gmail.com", port: 993, password: "abcd-efgh-ijkl", preset: "gmail" } });
  assert.equal(odd.json().error, "auth_failed");
  const shaped = await app.inject({ method: "POST", url: "/email/test", headers: auth, payload: { address: ADDRESS, host: "imap.gmail.com", port: 993, password: typed, preset: "gmail" } });
  assert.deepEqual(shaped.json().warnings, []);
  mail.password = "abcd-efgh-ijkl-mnop";
  const other = await app.inject({ method: "POST", url: "/email/test", headers: auth, payload: { address: ADDRESS, host: "imap.gmail.com", port: 993, password: "abcd-efgh-ijkl-mnop", preset: "gmail" } });
  assert.equal(other.statusCode, 200, other.body);
  assert.deepEqual(other.json().warnings, ["gmail_app_password_shape"]);
  mail.password = "abcd efgh ijkl mnop";
});

test("« Se connecter avec Google »: the same mailbox moves to the Gmail API — its copy kept, nothing twice; the sign-in kept in the password's place (0600, never shown); no IMAP any more", async () => {
  const before = { id: activeSource(userId)!.id, reminder: rows()[0]!.id };
  const connections = mail.connections;
  const done = await setUp(signedIn("g-refresh-1"));
  assert.equal(done.statusCode, 200, done.body);
  assert.deepEqual(done.json().folders, { inbox: "INBOX", sent: "SENT", drafts: "DRAFT" });
  await settled();
  assert.equal((await syncMailbox(userId)).ok, true);
  assert.equal(activeSource(userId)!.id, before.id, "the same mailbox");
  assert.equal(activeSource(userId)!.auth, "gmail");
  // Google's sign-in, renewed with Twoody's client — no scope asked again.
  const form = tokenForms[0]!;
  assert.deepEqual(Object.keys(form).sort(), ["client_id", "client_secret", "grant_type", "refresh_token"]);
  assert.equal(form.grant_type, "refresh_token");
  assert.equal(form.client_id, "twoody-test-client");
  // Kept as a password is: Google's kind, its file only this account can read, never in the status.
  assert.deepEqual(credentials()[before.id], { kind: "google", refreshToken: "g-refresh-1", saved_at: credentials()[before.id]!.saved_at });
  if (process.platform !== "win32") assert.equal(statSync(credentialsFile).mode & 0o777, 0o600);
  const shown = await status();
  assert.equal(shown.account.auth, "gmail");
  assert.equal(shown.account.signin_kept, true);
  assert.equal(shown.account.password_kept, false);
  assert.doesNotMatch(JSON.stringify(shown), /g-refresh|g-access/);
  assert.equal(mail.connections, connections, "no IMAP once signed in with Google");
  // The window's messages, the old one left out; the reminder read over IMAP kept, now Gmail's.
  const all = rows();
  assert.deepEqual(all.map((row) => row.subject), ["Rendez-vous du 8 octobre", "Votre facture F-2026-0912 — Tessane", "Re: Votre facture F-2026-0912", "Question sur le contrat de maintenance", "Dîner du 10 octobre", "Octobre : préparez votre vélo"]);
  const reminder = bySubject("Rendez-vous du 8 octobre")!;
  assert.equal(reminder.id, before.reminder, "kept, not read twice");
  assert.equal(JSON.parse(String(reminder.metadata)).gmail_id, "18c0000000000a00");
  assert.ok(all.every((row) => row.uid === null && JSON.parse(String(row.metadata)).gmail_id));
});

test("each message as over IMAP: its text, its conversation, its state; the attachments' names, never their content", async () => {
  const lea = bySubject("Dîner du 10 octobre")!;
  assert.equal(lea.role, "inbox");
  assert.equal(lea.from_email, "lea.fontaine@example.net");
  assert.equal(lea.from_name, "Léa Fontaine");
  assert.equal(lea.is_read, 0);
  assert.match(String(lea.text_body), /samedi 10 octobre \? Dis-moi avant mercredi\./);
  assert.equal(lea.body_format, "text");
  const answer = bySubject("Re: Votre facture F-2026-0912")!;
  assert.equal(answer.role, "sent");
  assert.equal(answer.direction, "outbound");
  // Gmail's thread, said as its IMAP server says it (X-GM-THRID): the answer in the invoice's conversation.
  assert.equal(answer.provider_thread_id, `server:${BigInt("0x18c0000000000b01").toString(10)}`);
  assert.equal(bySubject("Votre facture F-2026-0912 — Tessane")!.provider_thread_id, answer.provider_thread_id);
  const invoice = bySubject("Votre facture F-2026-0912 — Tessane")!;
  assert.deepEqual(JSON.parse(String(invoice.attachment_metadata)).attachments, [{ filename: "F-2026-0912.pdf", mime_type: "application/pdf", size: 90_112 }]);
  assert.ok(!gmailRequests.some((one) => one.path.endsWith("/attachments/ANGjdJ_pdf")), "an attachment's content is never asked");
  // A text Gmail keeps apart, read alone.
  assert.match(String(bySubject("Question sur le contrat de maintenance")!.text_body), /date de fin de notre contrat de maintenance/);
  const letter = bySubject("Octobre : préparez votre vélo")!;
  assert.equal(letter.body_format, "html");
  assert.match(String(letter.text_body), /Éclairage, pneus, freins : notre check-list\./);
  assert.doesNotMatch(String(letter.text_body), /track\.example/);
  assert.equal(JSON.parse(String(letter.metadata)).automated, true);
  assert.equal(gmailThreadId("18c0000000000b01"), BigInt("0x18c0000000000b01").toString(10));
  assert.equal(gmailThreadId("not hex"), null);
});

test("every 10 minutes, what changed since (history): a new message, one read and starred elsewhere, one trashed — nothing listed again", async () => {
  const from = gmailRequests.length;
  deliver({
    id: "18c0000000000f01", thread: "18c0000000000a01", labels: ["INBOX", "UNREAD"], at: now - 60_000,
    payload: { mimeType: "text/plain", filename: "", headers: headers({ From: "Léa Fontaine <lea.fontaine@example.net>", To: CLAIRE, Subject: "Re: Dîner du 10 octobre", "Message-ID": "<diner-2@example.net>", "In-Reply-To": "<diner-10-octobre@example.net>" }), body: { size: 20, data: data("Et apporte le dessert !") } },
  });
  relabel("18c0000000000a01", ["STARRED"], ["UNREAD"]);
  relabel("18c0000000000c01", ["TRASH"], ["INBOX"]);
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 1 });
  const asked = gmailRequests.slice(from);
  assert.ok(asked.some((one) => one.path.endsWith("/history")));
  assert.ok(!asked.some((one) => one.path.endsWith("/messages") && one.method === "GET"), "the window is not listed again");
  const lea = bySubject("Dîner du 10 octobre")!;
  assert.equal(lea.is_read, 1);
  assert.equal(lea.important, 1);
  assert.notEqual(bySubject("Octobre : préparez votre vélo")!.trashed_at, null, "hidden, not purged");
  assert.equal(bySubject("Re: Dîner du 10 octobre")!.provider_thread_id, lea.provider_thread_id);
  // Nothing new: nothing read again.
  const quiet = gmailRequests.length;
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 0 });
  assert.ok(gmailRequests.slice(quiet).every((one) => one.path.endsWith("/history")));
});

test("Gmail no longer has the history asked: the window listed again, what is kept not read twice", async () => {
  world.floor = history + 1;
  deliver({ id: "18c0000000000f02", thread: "18c0000000000f02", labels: ["INBOX"], at: now - 30_000, payload: { mimeType: "text/plain", filename: "", headers: headers({ From: "Marc Dubois <marc.dubois@example.fr>", To: CLAIRE, Subject: "Contrat signé", "Message-ID": "<signe@example.fr>" }), body: { size: 13, data: data("C'est signé.") } } });
  const from = gmailRequests.length;
  const count = rows().length;
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 1 });
  assert.equal(rows().length, count + 1);
  const full = gmailRequests.slice(from).filter((one) => /\/messages\/[0-9a-f]+$/.test(one.path) && one.params.get("format") === "full");
  assert.deepEqual(full.map((one) => one.path.split("/").at(-1)), ["18c0000000000f02"]);
  world.floor = 0;
});

test("Gmail asks to wait: it waits as long as it says (Retry-After) — else 1 s, then 2 s — then reads", async () => {
  world.throttle = 1;
  world.retryAfter = "7";
  let from = gmailRequests.length;
  assert.deepEqual(await syncMailbox(userId), { ok: true, imported: 0 });
  let asked = gmailRequests.slice(from);
  assert.equal(asked[0]!.status, 429);
  assert.equal(asked[1]!.path, asked[0]!.path, "the same request again");
  assert.ok(asked[1]!.at - asked[0]!.at >= 7_000, `waited ${asked[1]!.at - asked[0]!.at} ms`);
  world.retryAfter = null;
  world.throttle = 2;
  from = gmailRequests.length;
  assert.equal((await syncMailbox(userId)).ok, true);
  asked = gmailRequests.slice(from);
  assert.deepEqual(asked.slice(0, 3).map((one) => one.status), [429, 429, 200]);
  assert.ok(asked[1]!.at - asked[0]!.at >= 1_000);
  assert.ok(asked[2]!.at - asked[1]!.at >= 2_000);
  assert.equal((await status()).sync.last_error, null);
});

test("a first reading Gmail cuts short: no failure — « paused », Sent read alongside Inbox — and the next round carries on where it stood, nothing read twice, at Gmail's pace", async () => {
  const source = activeSource(userId)!;
  // Twelve more received, six more sent, within the window; the copy read again from its start.
  for (let i = 0; i < 12; i += 1) {
    deliver({ id: `18c00000000010${String(i).padStart(2, "0")}`, thread: `18c00000000010${String(i).padStart(2, "0")}`, labels: ["INBOX"], at: now - (20 + i) * 3_600_000, payload: { mimeType: "text/plain", filename: "", headers: headers({ From: "Marc Dubois <marc.dubois@example.fr>", To: CLAIRE, Subject: `Point ${i}`, "Message-ID": `<point-${i}@example.fr>` }), body: { size: 8, data: data(`Point ${i}`) } } });
  }
  for (let i = 0; i < 6; i += 1) {
    deliver({ id: `18c00000000020${String(i).padStart(2, "0")}`, thread: `18c00000000020${String(i).padStart(2, "0")}`, labels: ["SENT"], at: now - (20 + i) * 3_600_000, payload: { mimeType: "text/plain", filename: "", headers: headers({ From: CLAIRE, To: "Marc Dubois <marc.dubois@example.fr>", Subject: `Réponse ${i}`, "Message-ID": `<reponse-${i}@mail.gmail.com>` }), body: { size: 10, data: data(`Réponse ${i}`) } } });
  }
  saveGmailSyncState(source.id, null);
  const before = rows().length;
  const from = gmailRequests.length;
  const started = clock;
  mostInFlight = 0;
  world.pageSize = 4;
  // Gmail's quota runs out after seven messages, and asks for longer than a round waits.
  world.quota = 7;
  world.retryAfter = "600";
  const first = await syncMailbox(userId);
  assert.deepEqual(first, { ok: true, imported: 7, paused: "rate_limited" });
  const shown = await status();
  assert.equal(shown.sync.last_error, null, "not a failure");
  assert.equal(shown.sync.status, "active");
  assert.equal(shown.sync.paused, "rate_limited");
  assert.equal(shown.sync.first_read, true);
  assert.ok(shown.sync.next_at - shown.sync.last_synced_at <= 3 * 60_000, "the next round comes sooner");
  assert.ok(rows("e.status = 'sent' AND e.subject LIKE 'Réponse %'").length > 0, "Sent read alongside Inbox");
  assert.equal(rows().length, before + 7, "what was read is kept");
  assert.ok(gmailSyncState(source.id)!.backfill, "where the lists stand is kept");
  // The quota is back: the next round carries on, from the page it stood at.
  world.quota = null;
  world.retryAfter = null;
  const middle = gmailRequests.length;
  const second = await syncMailbox(userId);
  assert.deepEqual(second, { ok: true, imported: 11 });
  assert.equal(rows().length, before + 18);
  assert.ok(gmailRequests.slice(middle).filter((one) => one.path.endsWith("/messages")).some((one) => one.params.get("pageToken")), "carried on, not listed again from the start only");
  assert.equal(gmailSyncState(source.id)!.backfill, null, "the first reading is done");
  const done = await status();
  assert.equal(done.sync.paused, null);
  assert.equal(done.sync.first_read, false);
  // Each message read whole once, across both rounds.
  const reads = gmailRequests.slice(from).filter((one) => one.status === 200 && one.params.get("format") === "full").map((one) => one.path.split("/").at(-1));
  assert.equal(reads.length, 18);
  assert.equal(new Set(reads).size, reads.length, "nothing read twice");
  // A few at a time, and never more units in a second than Gmail's pace allows (the bucket's second, and the next).
  assert.ok(mostInFlight <= GMAIL_CONCURRENCY && mostInFlight > 1, `in flight: ${mostInFlight}`);
  const asked = gmailRequests.slice(from).map((one) => ({ at: one.at, units: gmailUnits(one.method, `https://gmail.googleapis.com${one.path}`) }));
  for (const one of asked) {
    const inASecond = asked.filter((other) => other.at >= one.at && other.at < one.at + 1_000).reduce((sum, other) => sum + other.units, 0);
    assert.ok(inASecond <= 2 * GMAIL_UNITS_PER_SECOND, `${inASecond} units in a second`);
  }
  const spent = asked.reduce((sum, one) => sum + one.units, 0);
  assert.ok(spent <= GMAIL_UNITS_PER_SECOND * ((clock - started) / 1_000 + 1), `${spent} units in ${clock - started} ms`);
  world.pageSize = 2;
});

test("what each request costs at Gmail, in its units", () => {
  const me = "https://gmail.googleapis.com/gmail/v1/users/me";
  assert.equal(gmailUnits("GET", `${me}/messages/18c0000000000a01?format=full`), 5);
  assert.equal(gmailUnits("GET", `${me}/messages?labelIds=INBOX`), 5);
  assert.equal(gmailUnits("GET", `${me}/history?startHistoryId=1`), 2);
  assert.equal(gmailUnits("GET", `${me}/profile`), 1);
  assert.equal(gmailUnits("GET", `${me}/labels/INBOX`), 1);
  assert.equal(gmailUnits("POST", `${me}/drafts`), 10);
});

test("a draft the person allowed: created in Drafts from its MIME text, never sent; nothing else is ever written", async () => {
  const source = activeSource(userId)!;
  const saved = await saveDraft(userId, source, { from: { name: "Claire Martin", address: ADDRESS }, to: [{ name: "Léa Fontaine", address: "lea.fontaine@example.net" }], cc: [], subject: "Re: Dîner du 10 octobre", body: "Avec plaisir, à samedi !", inReplyTo: "<diner-10-octobre@example.net>", references: ["<diner-10-octobre@example.net>"] });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  assert.equal(world.drafts.length, 1);
  const raw = Buffer.from(String((world.drafts[0]!.message as Record<string, unknown>).raw), "base64url").toString("utf8");
  assert.match(raw, /^Subject: =\?UTF-8\?Q\?Re=3A_D=C3=AEner_du_10_octobre\?=/m);
  assert.match(raw, /^In-Reply-To: <diner-10-octobre@example\.net>/m);
  const writes = gmailRequests.filter((one) => one.method !== "GET");
  assert.deepEqual(writes.map((one) => `${one.method} ${one.path}`), ["POST /gmail/v1/users/me/drafts"]);
  assert.ok(!gmailRequests.some((one) => /\/(?:send|trash|untrash|modify|batchModify|batchDelete|import)$/.test(one.path)));
});

test("a sign-in Google no longer honours: « signin_required », said once, not asked again every 10 minutes; the token never in the error", async () => {
  revoked.add("g-refresh-1");
  useGoogleTokenEndpointForTests(tokenEndpoint);
  const outcome = await syncMailbox(userId);
  assert.deepEqual(outcome, { ok: false, error: "signin_required" });
  assert.equal(needsThePerson((await status()).sync.last_error), true);
  assert.doesNotMatch(JSON.stringify(await status()), /expired or revoked|g-refresh/);
  // Kept until the person signs in again; the page offers it.
  assert.equal((await status()).account.signin_kept, true);
  revoked.delete("g-refresh-1");
});

test("what Google and Gmail refuse, said as a few words", () => {
  assert.equal(googleErrorCode({ error: "invalid_grant", error_description: "Token has been expired or revoked." }), "signin_required");
  assert.equal(googleErrorCode({ error: "invalid_grant", error_subtype: "invalid_rapt" }), "signin_required");
  assert.equal(googleErrorCode({ error: "admin_policy_enforced" }), "admin_consent_required");
  assert.equal(googleErrorCode({ error: "org_internal" }), "admin_consent_required");
  assert.equal(googleErrorCode({ error: "invalid_client" }), "signin_failed");
  assert.equal(googleErrorCode(null), "signin_failed");
  const me = "https://gmail.googleapis.com/gmail/v1/users/me";
  const refusal = (status: number, body: unknown, path: string) => gmailRefusal(status, body, `${me}${path}`).code;
  assert.equal(refusal(404, {}, "/history"), "sync_reset");
  assert.equal(refusal(404, {}, "/messages/18c0000000000a01"), "gone");
  assert.equal(refusal(400, { error: { code: 400, message: `Mail service not enabled for ${ADDRESS}`, errors: [{ reason: "failedPrecondition" }], status: "FAILED_PRECONDITION" } }, "/labels"), "no_mailbox");
  assert.equal(refusal(403, { error: { code: 403, errors: [{ reason: "insufficientPermissions" }], status: "PERMISSION_DENIED" } }, "/messages"), "scope_missing");
  assert.equal(refusal(403, { error: { code: 403, errors: [{ reason: "userRateLimitExceeded" }] } }, "/messages"), "throttled");
  assert.equal(refusal(403, { error: { code: 403, errors: [{ reason: "domainPolicy" }] } }, "/messages"), "gmail_refused");
  assert.equal(refusal(401, {}, "/profile"), "gmail_refused");
  assert.equal(refusal(503, {}, "/messages"), "throttled");
  assert.equal(refusal(400, {}, "/messages"), "gmail_failed");
  // What only the person can mend is not tried again every 10 minutes; too many connections is.
  for (const code of ["app_password_required", "imap_disabled", "web_login_required", "gmail_refused", "other_account", "signin_required"]) assert.equal(needsThePerson(code), true, code);
  for (const code of ["too_many_connections", "throttled", "gmail_unreachable"]) assert.equal(needsThePerson(code), false, code);
});

test("an organisation that restricts Twoody: « admin_consent_required » at setup, nothing kept", async () => {
  restricted.add("g-refresh-restricted");
  const refused = await app.inject({ method: "POST", url: "/email/test", headers: auth, payload: signedIn("g-refresh-restricted") });
  assert.equal(refused.statusCode, 502);
  assert.equal(refused.json().error, "admin_consent_required");
  assert.equal(credentials()[activeSource(userId)!.id]!.refreshToken, "g-refresh-1", "the sign-in kept is not replaced by a test");
});

test("E-mails turned off: not even a token asked; removed: the sign-in forgotten, the copy kept as asked", async () => {
  await capability(false);
  const from = { tokens: tokenForms.length, gmail: gmailRequests.length };
  const outcome = await syncMailbox(userId);
  assert.equal(outcome.ok, false);
  assert.equal(tokenForms.length, from.tokens);
  assert.equal(gmailRequests.length, from.gmail);
  await capability(true);
  const removed = await app.inject({ method: "DELETE", url: "/email/account?keep_messages=true", headers: auth });
  assert.equal(removed.statusCode, 200);
  assert.deepEqual(credentials(), {});
  assert.equal(existsSync(credentialsFile), false);
  assert.ok(rows().length > 0, "the copy kept, searchable");
  assert.equal((await status()).configured, false);
});
