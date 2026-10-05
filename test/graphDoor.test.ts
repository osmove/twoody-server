import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Microsoft Graph (04/10/2026), read for Outlook's calendar and contacts
// (Capacités → Agenda and Contacts) and for the mailbox (E-mails): the
// server goes there through its own door — https://graph.microsoft.com/v1.0/me/
// and the paths each capability that reads Graph declares, with what may be
// done there (read only, but for a draft created in Drafts), while that
// capability is on and the link is kept, never redirected. The link's
// sign-in is renewed at Microsoft's token endpoint through the door the
// IMAP mailbox's uses, with its own state: a capability that reads Graph
// on, and the link kept (or being made). Nothing sends an e-mail.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-graph-door-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const { GRAPH_ME, graphDoor, GraphDoorClosedError, graphFetch, graphRoute, MailDoorClosedError, MICROSOFT_TOKEN_URL, microsoftTokenDoor, microsoftTokenFetch } = await import("../src/outbound.js");
const { GRAPH_CAPABILITIES } = await import("../src/microsoft/link.js");
const graphResource = (target: string) => graphRoute(target)?.capability ?? null;

const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof GraphDoorClosedError) return err.reason;
    if (err instanceof MailDoorClosedError) return `mail: ${err.reason}`;
    return `other: ${String(err)}`;
  }
  return null;
};

type Capability = "calendar" | "contacts" | "email";
const open = { linked: true, capabilitiesOn: { calendar: true, contacts: true, email: true } };
const only = (on: Partial<Record<Capability, boolean>>) => ({ ...open, capabilitiesOn: { calendar: false, contacts: false, email: false, ...on } });
const calendarView = `${GRAPH_ME}/calendars/AAMkAGI2TG93AAA%3D/calendarView?startDateTime=2026-09-04T00%3A00%3A00.000Z&endDateTime=2027-10-04T00%3A00%3A00.000Z`;
/// A folder's changes, as asked first, then as Graph writes the next page and the next round.
const inboxDelta = `${GRAPH_ME}/mailFolders/AQMkADNkNAAAgEMAAAA%3D/messages/delta?%24select=id%2Csubject&%24filter=receivedDateTime+ge+2026-07-06T22%3A00%3A00Z`;
const nextPage = "https://graph.microsoft.com/v1.0/me/mailfolders('AQMkADNkNAAAgEMAAAA')/messages/delta?$skiptoken=GwcBoTmPuoTQWfcsAbkYM";
const nextRound = "https://graph.microsoft.com/v1.0/me/mailFolders/AQMkADNkNAAAgEMAAAA/messages/delta?$deltatoken=GwcBoTmPuoGNlgXgF1nyUNMXY";

test("Microsoft's token endpoint, for the link: that address only, while a capability that reads Graph is on and the link is kept or being made", () => {
  const door = (target: string, graphLinked: boolean, capabilitiesOn: Partial<Record<Capability, boolean>>) => refusal(() => microsoftTokenDoor(target, { graphLinked, capabilitiesOn }));
  assert.equal(door(MICROSOFT_TOKEN_URL, true, { calendar: true, contacts: false }), null);
  assert.equal(door(MICROSOFT_TOKEN_URL, true, { calendar: false, contacts: true }), null);
  assert.equal(door(MICROSOFT_TOKEN_URL, true, { calendar: false, contacts: false, email: true }), null, "E-mails alone");
  assert.equal(door(MICROSOFT_TOKEN_URL, true, { calendar: false, contacts: false, email: false }), "capability_off");
  assert.equal(door(MICROSOFT_TOKEN_URL, true, {}), "capability_off");
  assert.equal(door(MICROSOFT_TOKEN_URL, false, { calendar: true, contacts: true }), "not_linked");
  for (const other of [
    "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token?x=1",
    "https://login.microsoftonline.com.evil.example/common/oauth2/v2.0/token",
    "https://graph.microsoft.com/v1.0/me",
    "not a url",
  ]) assert.equal(door(other, true, { calendar: true, contacts: true }), "other_address", other);
  // The mailbox's grant keeps its own door: E-mails, not Agenda.
  assert.equal(refusal(() => microsoftTokenDoor(MICROSOFT_TOKEN_URL, { microsoftMailbox: true, emailOn: false })), "mail: email_off");
});

test("Graph: the calendars and their view for Agenda, the contacts and their folders for Contacts, the mailbox's folders, changes, attachments and drafts for E-mails — however written", () => {
  assert.equal(graphResource(`${GRAPH_ME}/calendars?$select=id,name&$top=100`), "calendar");
  assert.equal(graphResource(calendarView), "calendar");
  assert.equal(graphResource(`${GRAPH_ME}/calendars/AAMk-x_y%3D/calendarview?%24skip=250`), "calendar", "Graph's own nextLink, its case and its %24");
  assert.equal(graphResource(`${GRAPH_ME}/contacts?$select=id&$top=250`), "contacts");
  assert.equal(graphResource(`${GRAPH_ME}/contactFolders?$select=id`), "contacts");
  assert.equal(graphResource(`${GRAPH_ME}/contactFolders/AQMkADAw/contacts?%24skiptoken=abc`), "contacts");
  assert.equal(graphResource("https://GRAPH.microsoft.com:443/v1.0/me/contacts"), "contacts");
  assert.equal(graphResource(`${GRAPH_ME}/calendars/x/../../contacts`), "contacts", "« .. » resolved first: where it really goes");
  for (const folder of ["inbox", "sentitems", "drafts", "Inbox", "SentItems"]) assert.equal(graphResource(`${GRAPH_ME}/mailFolders/${folder}?$select=id,displayName,totalItemCount`), "email", folder);
  assert.equal(graphResource(inboxDelta), "email");
  assert.equal(graphResource(nextPage), "email", "Graph's own next page: mailfolders('…'), its $");
  assert.equal(graphResource(nextPage.replace(/'/g, "%27")), "email", "its quotes escaped");
  assert.equal(graphResource(nextRound), "email");
  assert.equal(graphResource(`${GRAPH_ME}/messages/AAMkAGVmMDEzMTM4LTZmYWUtNDdkNC1hMDZiLTU1OGY5OTZhYmY4OAAuAAAAAAAiQ8W967B7TKBjgx9rVEURAQAiIsqMbYjsT5e-T7KzowPTAAAAAAFNAAA%3D/attachments?%24select=name%2CcontentType%2Csize%2CisInline`), "email");
  assert.equal(graphResource(`${GRAPH_ME}/messages`), "email", "a draft is created there");
});

test("Graph: nothing else — no other path, no other host, port or scheme, no user, no slash hidden in an id", () => {
  for (const other of [
    `${GRAPH_ME}`,
    // Of the mailbox: no other folder, no list of its messages, no message
    // itself or its content, nothing that sends, answers, moves or copies.
    `${GRAPH_ME}/mailFolders`,
    `${GRAPH_ME}/mailFolders/archive`,
    `${GRAPH_ME}/mailFolders/deleteditems`,
    `${GRAPH_ME}/mailFolders/inbox/childFolders`,
    `${GRAPH_ME}/mailFolders/inbox/messages`,
    `${GRAPH_ME}/mailFolders/inbox/messages/AAMk`,
    `${GRAPH_ME}/mailFolders/inbox/messages/AAMk/send`,
    `${GRAPH_ME}/mailFolders('AQMk')/messages`,
    `${GRAPH_ME}/mailFolders('AQMk')/messages/delta/x`,
    `${GRAPH_ME}/mailFolders('AQMk'/messages/delta`,
    `${GRAPH_ME}/mailFolders('AQMk%27)/messages/delta%2Fsend`,
    `${GRAPH_ME}/mailFolders/inbox/childFolders/x/messages/delta`,
    `${GRAPH_ME}/messages/delta`,
    `${GRAPH_ME}/messages/AAMk`,
    `${GRAPH_ME}/messages/AAMk/$value`,
    `${GRAPH_ME}/messages/AAMk/send`,
    `${GRAPH_ME}/messages/AAMk/reply`,
    `${GRAPH_ME}/messages/AAMk/replyAll`,
    `${GRAPH_ME}/messages/AAMk/forward`,
    `${GRAPH_ME}/messages/AAMk/createReply`,
    `${GRAPH_ME}/messages/AAMk/move`,
    `${GRAPH_ME}/messages/AAMk/copy`,
    `${GRAPH_ME}/messages/AAMk/attachments/AAMkFile`,
    `${GRAPH_ME}/messages/AAMk/attachments/AAMkFile/$value`,
    `${GRAPH_ME}/sendMail`,
    `${GRAPH_ME}/messages/AAMk%2Fsend/attachments`,
    `${GRAPH_ME}/mailFolders/x%2F..%2F..%2Fmessages/messages/delta`,
    `${GRAPH_ME}/mailFolders/%2e%2e/messages/delta`,
    "https://graph.microsoft.com/v1.0/users/claire.martin@outlook.fr/messages",
    "https://graph.microsoft.com/v1.0/users('claire.martin@outlook.fr')/mailFolders('AQMk')/messages/delta",
    "https://graph.microsoft.com/beta/me/messages",
    `${GRAPH_ME}/events`,
    `${GRAPH_ME}/calendar/events`,
    `${GRAPH_ME}/calendars/x/events`,
    `${GRAPH_ME}/calendars/x/calendarView/delta`,
    `${GRAPH_ME}/contacts/x`,
    `${GRAPH_ME}/contactFolders/x/childFolders`,
    `${GRAPH_ME}/drive/root/children`,
    `${GRAPH_ME}/calendars/x%2F..%2F..%2Fmessages/calendarView`,
    `${GRAPH_ME}/calendars/x%5C..%5Cmessages/calendarView`,
    `${GRAPH_ME}/calendars/%2e%2e/calendarView`,
    "https://graph.microsoft.com/v1.0/users/claire.martin@tessane.fr/contacts",
    "https://graph.microsoft.com/beta/me/contacts",
    "https://graph.microsoft.com/v1.0/me2/contacts",
    "http://graph.microsoft.com/v1.0/me/contacts",
    "https://graph.microsoft.com:8443/v1.0/me/contacts",
    "https://claire@graph.microsoft.com/v1.0/me/contacts",
    "https://graph.microsoft.com.evil.example/v1.0/me/contacts",
    "https://evil.example/v1.0/me/contacts",
    "https://outlook.office.com/api/v2.0/me/contacts",
    "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    "not a url",
  ]) assert.equal(graphResource(other), null, other);
});

test("the door: what each path allows (read only, but for a draft created in Drafts), the capability it serves on, the link kept", () => {
  assert.equal(graphDoor(calendarView, "GET", open), "calendar");
  assert.equal(graphDoor(`${GRAPH_ME}/contacts`, undefined, open), "contacts", "a fetch with no method is a GET");
  for (const method of ["POST", "PATCH", "PUT", "DELETE", "HEAD"]) assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/contacts`, method, open)), "method_not_allowed", method);
  // The mailbox: read, and one write — a draft, created; never changed, moved or deleted.
  assert.equal(graphDoor(nextPage, "GET", open), "email");
  assert.equal(graphDoor(`${GRAPH_ME}/messages`, "POST", open), "email");
  for (const method of ["GET", "PATCH", "PUT", "DELETE"]) assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/messages`, method, open)), "method_not_allowed", `${method} /messages`);
  for (const method of ["POST", "PATCH", "PUT", "DELETE"]) {
    for (const target of [nextRound, `${GRAPH_ME}/mailFolders/drafts`, `${GRAPH_ME}/messages/AAMk/attachments`]) assert.equal(refusal(() => graphDoor(target, method, open)), "method_not_allowed", `${method} ${target}`);
  }
  for (const [method, target] of [["POST", `${GRAPH_ME}/messages/AAMk/send`], ["POST", `${GRAPH_ME}/sendMail`], ["PATCH", `${GRAPH_ME}/messages/AAMk`], ["DELETE", `${GRAPH_ME}/messages/AAMk`], ["POST", `${GRAPH_ME}/messages/AAMk/move`], ["POST", `${GRAPH_ME}/mailFolders/inbox/messages`]] as const) {
    assert.equal(refusal(() => graphDoor(target, method, open)), "other_address", `${method} ${target}`);
  }
  assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/messages`, "POST", only({ calendar: true, contacts: true }))), "capability_off", "E-mails off: no draft");
  assert.equal(refusal(() => graphDoor(nextPage, "GET", only({ email: true }))), null, "E-mails alone");
  assert.equal(refusal(() => graphDoor(calendarView, "GET", only({ email: true }))), "capability_off", "E-mails opens nothing of the calendar");
  assert.equal(refusal(() => graphDoor(calendarView, "GET", only({ contacts: true }))), "capability_off");
  assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/contacts`, "GET", only({ contacts: true }))), null, "Contacts stays open");
  assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/contactFolders`, "GET", only({ calendar: true }))), "capability_off");
  assert.equal(refusal(() => graphDoor(calendarView, "GET", only({ calendar: true }))), null, "Agenda stays open");
  assert.equal(refusal(() => graphDoor(calendarView, "GET", { ...open, capabilitiesOn: {} })), "capability_off", "a switch nobody gave is off");
  assert.equal(refusal(() => graphDoor(calendarView, "GET", { ...open, linked: false })), "not_linked");
  assert.equal(refusal(() => graphDoor(`${GRAPH_ME}/messages/AAMk`, "GET", open)), "other_address");
  // Every capability that reads Graph declares its paths, each read only
  // but for the drafts' one, which only creates.
  const samples = [`${GRAPH_ME}/calendars`, calendarView, `${GRAPH_ME}/contacts`, `${GRAPH_ME}/contactFolders`, `${GRAPH_ME}/contactFolders/x/contacts`, `${GRAPH_ME}/mailFolders/inbox`, inboxDelta, nextPage, `${GRAPH_ME}/messages/x/attachments`];
  assert.deepEqual([...new Set([...samples, `${GRAPH_ME}/messages`].map((one) => graphRoute(one)!.capability))].sort(), [...GRAPH_CAPABILITIES].sort());
  for (const one of samples) assert.deepEqual(graphRoute(one)!.methods, ["GET"], one);
  assert.deepEqual(graphRoute(`${GRAPH_ME}/messages`)!.methods, ["POST"]);
});

test("a request refused at these doors never leaves this machine; one let through is never redirected", async (t) => {
  // Whatever a door let through would come here, never to the network.
  const sent: Array<{ target: string; init: RequestInit | undefined }> = [];
  const network = globalThis.fetch;
  globalThis.fetch = (async (target: string | URL | Request, init?: RequestInit) => {
    sent.push({ target: String(target), init });
    return new Response("{}");
  }) as typeof fetch;
  t.after(() => {
    globalThis.fetch = network;
  });
  const refused = (reason: string) => (err: unknown) => err instanceof GraphDoorClosedError && err.reason === reason;
  await assert.rejects(graphFetch("http://127.0.0.1:9/v1.0/me/contacts", { method: "GET" }, open), refused("other_address"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/contacts`, { method: "DELETE" }, open), refused("method_not_allowed"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/contacts`, { method: "GET" }, only({ calendar: true })), refused("capability_off"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/contacts`, { method: "GET" }, { ...open, linked: false }), refused("not_linked"));
  await assert.rejects(microsoftTokenFetch("http://127.0.0.1:9/common/oauth2/v2.0/token", { method: "POST" }, { graphLinked: true, capabilitiesOn: { calendar: true } }), refused("other_address"));
  await assert.rejects(microsoftTokenFetch(MICROSOFT_TOKEN_URL, { method: "POST" }, { graphLinked: true, capabilitiesOn: { calendar: false, contacts: false } }), refused("capability_off"));
  await assert.rejects(microsoftTokenFetch(MICROSOFT_TOKEN_URL, { method: "POST" }, { graphLinked: false, capabilitiesOn: { calendar: true } }), refused("not_linked"));
  // Nothing that sends, changes or deletes an e-mail gets out, however asked.
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages/AAMk/send`, { method: "POST" }, open), refused("other_address"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/sendMail`, { method: "POST", body: "{}" }, open), refused("other_address"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages/AAMk`, { method: "PATCH", body: "{}" }, open), refused("other_address"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages/AAMk`, { method: "DELETE" }, open), refused("other_address"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages`, { method: "GET" }, open), refused("method_not_allowed"));
  await assert.rejects(graphFetch(nextRound, { method: "DELETE" }, open), refused("method_not_allowed"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages`, { method: "POST", body: "TUlNRQ==" }, only({ calendar: true })), refused("capability_off"));
  await assert.rejects(graphFetch(`${GRAPH_ME}/messages`, { method: "POST", body: "TUlNRQ==" }, { ...open, linked: false }), refused("not_linked"));
  assert.deepEqual(sent, []);
  await graphFetch(`${GRAPH_ME}/contacts`, { method: "GET", redirect: "follow" }, open);
  assert.equal(sent.length, 1);
  assert.equal(sent[0]!.target, `${GRAPH_ME}/contacts`);
  assert.equal(sent[0]!.init?.redirect, "error", "never followed, whatever was asked");
  await graphFetch(`${GRAPH_ME}/messages`, { method: "POST", body: "TUlNRQ==", redirect: "follow" }, open);
  assert.equal(sent[1]!.init?.redirect, "error", "a draft's request no more than the others");
});

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir = srcDir): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

test("Graph's address is written in the door alone; the one file that sends requests to Graph asks the door before each one; its one write is a draft", () => {
  assert.deepEqual(sources().filter(({ text }) => /graph\.microsoft\.com/i.test(text)).map(({ path }) => path), [join(srcDir, "outbound.ts")]);
  const graph = readFileSync(join(srcDir, "microsoft", "graph.ts"), "utf8");
  assert.equal(graph.match(/await transport\(/g)?.length, 1, "one place sends");
  assert.ok(graph.indexOf("graphDoor(url, method, this.door())") > 0 && graph.indexOf("graphDoor(url, method, this.door())") < graph.indexOf("await transport(url"));
  assert.doesNotMatch(graph, /"(?:PATCH|PUT|DELETE)"/);
  // A write is asked in one place: the draft, at /me/messages (and, for a
  // Gmail mailbox, its own draft through the Gmail door: test/gmailDoor.test.ts).
  const posts = sources().flatMap(({ path, text }) => [...text.matchAll(/\bsession\.post\(([^,]+),/g)].map((match) => `${path}: ${match[1]}`));
  assert.deepEqual(posts, [`${join(srcDir, "email", "gmailMailbox.ts")}: \`\${GMAIL_ME}/drafts\``, `${join(srcDir, "microsoft", "mail.ts")}: \`\${GRAPH_ME}/messages\``]);
  // And the door opens no other write: only POST, once, for E-mails.
  const door = readFileSync(join(srcDir, "outbound.ts"), "utf8");
  const paths = door.slice(door.indexOf("const GRAPH_PATHS"), door.indexOf("export function graphRoute"));
  assert.equal(paths.match(/methods: \["POST"\]/g)?.length, 1);
  assert.doesNotMatch(paths, /"(?:PATCH|PUT|DELETE)"/);
  // No other file of the server sends a request to Graph.
  assert.deepEqual(sources().filter(({ text }) => /\bgraphFetch\b/.test(text)).map(({ path }) => path).sort(), [join(srcDir, "microsoft", "graph.ts"), join(srcDir, "outbound.ts")].sort());
});
