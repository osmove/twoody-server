import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Outlook's or Microsoft 365's calendar and contacts (Capacités → Agenda and
// Contacts, 04/10/2026): linked with the refresh token the Desktop's main
// process got from Microsoft's sign-in, read through Microsoft Graph into
// the same tables as the Mac's (source « microsoft »). Microsoft's token
// endpoint and Graph are played by fakes in this process: no Microsoft
// account, no network. A fictional account (Claire Martin, Tessane).

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-microsoft-graph-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const CLIENT_ID = "804f73f0-5611-4e2e-a8da-fd5efb0293ea";
const ADDRESS = "claire.martin@outlook.fr";
const CALENDARS_READ = "https://graph.microsoft.com/Calendars.Read";
const CONTACTS_READ = "https://graph.microsoft.com/Contacts.Read";
const DAY = 86_400_000;
const HOUR = 3_600_000;

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { GRAPH_ME } = await import("../src/outbound.js");
const { useMicrosoftTokenEndpointForTests } = await import("../src/microsoft/token.js");
const { birthdayOf, graphHeldUntil, graphRefusal, retryAfterMs, useGraphForTests } = await import("../src/microsoft/graph.js");
const { GRAPH_CAPABILITIES, GRAPH_SCOPES, graphLink, graphPermissions, graphScope, linkGrants } = await import("../src/microsoft/link.js");
const { graphSyncDue, needsThePerson, startMicrosoftGraphSync, syncMicrosoftGraph } = await import("../src/microsoft/sync.js");
const { loadPersonalData } = await import("../src/routes/localSync.js");
const { storedValues } = await import("../src/contactFields.js");

// ── Microsoft's token endpoint ──────────────────────────────────────────
type Answer = { status: number; body: Record<string, unknown>; delayMs?: number };
const tokenRequests: Array<Record<string, string>> = [];
/// The access tokens Graph takes.
const accepted = new Set<string>();
let issued = 0;
let lifetime = 3_599;
/// An access token, and a new refresh token in place of the one used, as Microsoft does.
const grant = (): Answer => {
  issued += 1;
  const accessToken = `graph-access-${issued}`;
  accepted.add(accessToken);
  return { status: 200, body: { token_type: "Bearer", scope: `${CALENDARS_READ} ${CONTACTS_READ}`, expires_in: lifetime, access_token: accessToken, refresh_token: `graph-refresh-${issued + 1}` } };
};
let answer: () => Answer = grant;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
/// Waits for `check`, a few seconds at most: a test never hangs.
const until = async (check: () => boolean | Promise<boolean>, what: string) => {
  for (let tries = 0; !(await check()); tries += 1) {
    if (tries > 600) throw new Error(`waited too long: ${what}`);
    await sleep(5);
  }
};
const tokenEndpoint = async (init: RequestInit) => {
  tokenRequests.push(Object.fromEntries(new URLSearchParams(String(init.body))));
  const { status, body, delayMs } = answer();
  if (delayMs) await sleep(delayMs);
  return Response.json(body, { status });
};

// ── Microsoft Graph ─────────────────────────────────────────────────────
type Item = Record<string, unknown>;
/// As Graph writes a time when asked in UTC: seven decimals, no zone.
const at = (ms: number) => ({ dateTime: new Date(ms).toISOString().replace("Z", "0000"), timeZone: "UTC" });
const today = Math.floor(Date.now() / DAY) * DAY;
const WEEKLY = [7, 14, 21].map((days) => today + days * DAY + 7 * HOUR);
const SALON = today + 20 * DAY;
const DINNER = today + 3 * DAY + 18 * HOUR;
/// An all-day event made in Paris, as Graph may give it seen from UTC: 22:00 the day before.
const BIRTHDAY_PARTY = today + 40 * DAY;

const world = {
  calendars: [[{ id: "AAMkCal-Travail=", name: "Travail" }], [{ id: "AAMkCal-Perso=", name: "Perso" }]] as Item[][],
  views: new Map<string, Item[][]>([
    ["AAMkCal-Travail=", [
      // A repeating event: once per occurrence in the view, each its own id.
      WEEKLY.map((start, index) => ({ id: `AAMkOcc-${index}=`, seriesMasterId: "AAMkSeries=", type: "occurrence", subject: "Point hebdo Tessane", start: at(start), end: at(start + HOUR), isAllDay: false, isCancelled: false, location: { displayName: "Visio" }, bodyPreview: "Ordre du jour : planning" })),
      [
        { id: "AAMkSalon=", subject: "Salon Tessane", start: at(SALON), end: at(SALON + 2 * DAY), isAllDay: true, isCancelled: false, location: { displayName: "" }, bodyPreview: "" },
        { id: "AAMkCancelled=", subject: "Annulé : réunion Tessane", start: at(SALON + 9 * HOUR), end: at(SALON + 10 * HOUR), isAllDay: false, isCancelled: true },
      ],
    ]],
    ["AAMkCal-Perso=", [[
      { id: "AAMkDinner=", subject: "Dîner avec Claire", start: at(DINNER), end: at(DINNER + 2 * HOUR), isAllDay: false, isCancelled: false, location: { displayName: "Paris" }, bodyPreview: "" },
      { id: "AAMkParty=", subject: "Anniversaire Tessane", start: at(BIRTHDAY_PARTY - 2 * HOUR), end: at(BIRTHDAY_PARTY + DAY - 2 * HOUR), isAllDay: true, isCancelled: false },
    ]]],
  ]),
  contacts: [
    [{ id: "AAMkClaire=", displayName: "Claire Martin", givenName: "Claire", surname: "Martin", companyName: "Tessane", emailAddresses: [{ name: "Claire Martin", address: ADDRESS }, { name: "Claire", address: "claire@tessane.fr" }], mobilePhone: "+33 6 00 00 00 01", businessPhones: ["+33 1 00 00 00 02"], homePhones: [], birthday: "1990-05-17T11:59:00Z", homeAddress: { street: "1 rue de l'Exemple", city: "Paris", postalCode: "75002", countryOrRegion: "France" }, businessAddress: {}, otherAddress: {} }],
    [{ id: "AAMkTessane=", displayName: "", companyName: "Tessane", emailAddresses: [{ address: "contact@tessane.fr" }], businessPhones: ["+33 1 00 00 00 03"], birthday: null }],
  ] as Item[][],
  folders: [[{ id: "AQMkFolder-Clients" }]] as Item[][],
  folderContacts: new Map<string, Item[][]>([["AQMkFolder-Clients", [[{ id: "AAMkFacturation=", displayName: "Tessane Facturation", emailAddresses: [{ address: "facturation@tessane.fr" }], birthday: "1604-03-14T00:00:00Z" }]]]]),
  /// A nextLink handed in place of Graph's own.
  nextOverride: null as string | null,
  /// 429s still to answer, and their Retry-After.
  throttle: 0,
  retryAfter: "3",
  /// Every request answered with this status.
  status: 0,
  /// The answer to an address containing `path`, given `ms` late.
  delay: null as { path: string; ms: number } | null,
};

const graphRequests: Array<{ path: string; params: URLSearchParams; method: string; authorization: string | null; prefer: string | null }> = [];
const pagesFor = (path: string): Item[][] | null => {
  const rest = path.slice("/v1.0/me".length);
  let match: RegExpExecArray | null;
  if (/^\/calendars$/i.test(rest)) return world.calendars;
  if ((match = /^\/calendars\/([^/]+)\/calendarView$/i.exec(rest))) return world.views.get(decodeURIComponent(match[1]!)) ?? [[]];
  if (/^\/contacts$/i.test(rest)) return world.contacts;
  if (/^\/contactFolders$/i.test(rest)) return world.folders;
  if ((match = /^\/contactFolders\/([^/]+)\/contacts$/i.exec(rest))) return world.folderContacts.get(decodeURIComponent(match[1]!)) ?? null;
  return null;
};
const fakeGraph = async (target: string, init: RequestInit): Promise<Response> => {
  const url = new URL(target);
  const headers = new Headers(init.headers);
  graphRequests.push({ path: url.pathname, params: url.searchParams, method: init.method ?? "GET", authorization: headers.get("authorization"), prefer: headers.get("prefer") });
  if (world.throttle > 0) {
    world.throttle -= 1;
    return Response.json({ error: { code: "TooManyRequests", message: "Please retry." } }, { status: 429, headers: { "retry-after": world.retryAfter } });
  }
  if (!accepted.has(headers.get("authorization")?.replace(/^Bearer /, "") ?? "")) {
    return Response.json({ error: { code: "InvalidAuthenticationToken", message: `Access token has expired (${ADDRESS}).` } }, { status: 401 });
  }
  if (world.status) return Response.json({ error: { code: "ErrorAccessDenied", message: `Access is denied for ${ADDRESS}.` } }, { status: world.status });
  if (world.delay && url.pathname.includes(world.delay.path)) await sleep(world.delay.ms);
  const pages = pagesFor(url.pathname);
  if (!pages) return Response.json({ error: { code: "ErrorItemNotFound" } }, { status: 404 });
  const index = Number(url.searchParams.get("$skiptoken") ?? "0");
  const body: Record<string, unknown> = { value: pages[index] ?? [] };
  if (index + 1 < pages.length) {
    const next = new URL(url);
    next.searchParams.set("$skiptoken", String(index + 1));
    body["@odata.nextLink"] = world.nextOverride ?? next.toString();
  }
  return Response.json(body);
};
/// The waits Graph asked for, made at once.
const waits: number[] = [];
const useFakes = () => {
  useMicrosoftTokenEndpointForTests(tokenEndpoint);
  useGraphForTests(fakeGraph, { sleep: async (ms) => void waits.push(ms) });
};
useFakes();

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
const phone = { authorization: `Bearer ${createAuthSession(userId, "pair:iPhone").token}` };
test.after(async () => {
  useMicrosoftTokenEndpointForTests(null);
  useGraphForTests(null);
  await app.close();
});

const linkFile = join(process.env.TWOODY_DATA_DIR!, "microsoft-graph.json");
const kept = () => (existsSync(linkFile) ? (JSON.parse(readFileSync(linkFile, "utf8")) as Record<string, Record<string, unknown>>)[userId] : undefined);
const status = async () => (await app.inject({ url: "/api/v1/microsoft_graph/status", headers })).json();
const capability = (id: string, enabled: boolean) => app.inject({ method: "PATCH", url: `/local_capabilities/${id}`, headers, payload: { enabled } });
/// What the Desktop's main process hands over once Microsoft's sign-in is done.
const signedIn = (refreshToken: string, scopes: string, extra: Record<string, unknown> = {}) => ({ address: ADDRESS, refresh_token: refreshToken, scopes, ...extra });
const link = (body: Record<string, unknown>, who = headers) => app.inject({ method: "POST", url: "/api/v1/microsoft_graph/account", headers: who, payload: body });
const rows = (table: "events" | "contacts", source: string | null) =>
  sqlite.prepare(`SELECT id, ${table === "events" ? "name, start_time, end_time, all_day, location, calendar, notes" : "name, first_name, last_name, organization, phones, emails, birthday, addresses"} FROM ${table} WHERE user_id = ? AND source IS ? ORDER BY ${table === "events" ? "start_time" : "name"}`).all(userId, source) as Array<Record<string, unknown>>;
/// The sync under way, or a new one, waited for.
const synced = () => syncMicrosoftGraph(userId);

test("off until Agenda or Contacts is on: no link, no token asked of Microsoft, nothing read", async () => {
  const refused = await link(signedIn("graph-refresh-1", `${CALENDARS_READ} openid profile email`));
  assert.equal(refused.statusCode, 403);
  assert.equal(refused.json().error, "capability_off");
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/microsoft_graph/sync", headers })).statusCode, 403);
  assert.equal(tokenRequests.length + graphRequests.length, 0);
  assert.equal(existsSync(linkFile), false);
});

test("this computer's app only; what is handed over is checked before anything is asked", async () => {
  await capability("calendar", true);
  for (const [method, url] of [["GET", "/api/v1/microsoft_graph/status"], ["POST", "/api/v1/microsoft_graph/sync"], ["DELETE", "/api/v1/microsoft_graph/account"]] as const) {
    assert.equal((await app.inject({ method, url, headers: phone })).statusCode, 403, `${method} ${url}`);
  }
  assert.equal((await link(signedIn("graph-refresh-1", CALENDARS_READ), phone)).statusCode, 403);
  const answers = [
    [signedIn("graph-refresh-1", CALENDARS_READ, { address: "" }), 422, "address_required"],
    [signedIn("graph-refresh-1", CALENDARS_READ, { address: "claire" }), 422, "invalid_address"],
    [signedIn("", CALENDARS_READ), 409, "signin_required"],
    [signedIn("graph-refresh-1", "openid profile email offline_access https://graph.microsoft.com/Mail.Read"), 422, "scope_missing"],
  ] as const;
  for (const [body, code, error] of answers) {
    const response = await link(body);
    assert.equal(response.statusCode, code, response.body);
    assert.equal(response.json().error, error);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/microsoft_graph/sync", headers })).statusCode, 409, "nothing linked");
  assert.equal(tokenRequests.length + graphRequests.length, 0);
});

test("linked from Agenda: the refresh token traded for Graph's calendar permission (no secret), kept apart (0600), never shown; the calendar read at once", async () => {
  const response = await link(signedIn("graph-refresh-1", `${CALENDARS_READ} openid profile email`));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await synced()).ok, true);
  assert.deepEqual(tokenRequests, [{ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "graph-refresh-1", scope: `${CALENDARS_READ} offline_access` }], "the token got to try the link serves the first sync");
  assert.equal(statSync(linkFile).mode & 0o777, 0o600);
  assert.deepEqual(Object.keys(kept()!).sort(), ["address", "id", "linked_at", "refresh_token", "saved_at", "scopes", "sync"]);
  assert.equal(kept()!.refresh_token, "graph-refresh-2", "the one Microsoft gave back");
  const body = await status();
  assert.deepEqual(body.account.scopes, ["Calendars.Read"]);
  assert.equal(body.account.address, ADDRESS);
  assert.equal(body.calendar.enabled, true);
  assert.equal(body.calendar.granted, true);
  assert.equal(body.calendar.last_error, null);
  assert.ok(body.calendar.last_synced_at > 0);
  assert.equal(body.contacts.granted, false);
  assert.doesNotMatch(response.body + JSON.stringify(body), /graph-refresh|graph-access/, "never shown");
  for (const file of ["local.db", "local.db-wal"]) {
    const path = join(process.env.TWOODY_DATA_DIR!, file);
    if (existsSync(path)) assert.ok(!readFileSync(path).includes("graph-refresh") && !readFileSync(path).includes("graph-access"), `not in ${file}`);
  }
  // Read only, every time in UTC, with the access token; nothing of the contacts.
  assert.ok(graphRequests.every((one) => one.method === "GET" && one.prefer === 'outlook.timezone="UTC"' && one.authorization === "Bearer graph-access-1"));
  assert.ok(graphRequests.every((one) => !/contact/i.test(one.path)), "Contacts is off and not granted");
  // Every calendar, every page.
  const paths = graphRequests.map((one) => `${one.path}${one.params.has("$skiptoken") ? `#${one.params.get("$skiptoken")}` : ""}`);
  for (const path of ["/v1.0/me/calendars", "/v1.0/me/calendars#1", "/v1.0/me/calendars/AAMkCal-Travail%3D/calendarView", "/v1.0/me/calendars/AAMkCal-Travail%3D/calendarView#1", "/v1.0/me/calendars/AAMkCal-Perso%3D/calendarView"]) {
    assert.ok(paths.includes(path), `${path} in ${paths.join(" ")}`);
  }
  // The window of the Mac's helper: 30 days back, 365 ahead.
  const view = graphRequests.find((one) => one.path.endsWith("/calendarView"))!;
  assert.ok(Math.abs(Date.parse(view.params.get("startDateTime")!) - (Date.now() - 30 * DAY)) < 60_000);
  assert.ok(Math.abs(Date.parse(view.params.get("endDateTime")!) - (Date.now() + 365 * DAY)) < 60_000);
  assert.match(view.params.get("$select")!, /subject/);
});

test("each occurrence of a repeating event, with its calendar's name; all-day events on their date (midnight UTC, as the app keeps them); nothing cancelled", async () => {
  const events = rows("events", "microsoft");
  assert.deepEqual(events.map((event) => event.name), ["Dîner avec Claire", "Point hebdo Tessane", "Point hebdo Tessane", "Salon Tessane", "Point hebdo Tessane", "Anniversaire Tessane"]);
  assert.equal(new Set(events.map((event) => event.id)).size, 6);
  const weekly = events.filter((event) => event.name === "Point hebdo Tessane");
  assert.deepEqual(weekly.map((event) => event.start_time), WEEKLY);
  assert.deepEqual(weekly.map((event) => event.end_time), WEEKLY.map((start) => start + HOUR));
  assert.ok(weekly.every((event) => event.calendar === "Travail" && event.location === "Visio" && event.notes === "Ordre du jour : planning" && event.all_day === 0));
  const salon = events.find((event) => event.name === "Salon Tessane")!;
  assert.deepEqual([salon.start_time, salon.end_time, salon.all_day, salon.location], [SALON, SALON + 2 * DAY, 1, null]);
  // Made in Paris, given from UTC as 22:00 the day before: its own date all the same.
  const party = events.find((event) => event.name === "Anniversaire Tessane")!;
  assert.deepEqual([party.start_time, party.end_time, party.calendar], [BIRTHDAY_PARTY, BIRTHDAY_PARTY + DAY, "Perso"]);
  // In the agenda: Outlook's, read-only, changed there.
  const agenda = (await app.inject({ url: `/events?start_time=${new Date(today).toISOString()}&end_time=${new Date(today + 60 * DAY).toISOString()}`, headers })).json();
  const dinner = agenda.events.find((event: { name: string }) => event.name === "Dîner avec Claire");
  assert.deepEqual([dinner.source, dinner.provider, dinner.source_label, dinner.read_only], ["microsoft", "microsoft", "Perso", true]);
  assert.match(dinner.id, /^microsoft:/);
  assert.equal((await app.inject({ method: "PATCH", url: `/events/${dinner.id}`, headers, payload: { event: { name: "X" } } })).statusCode, 409);
  assert.equal((await app.inject({ method: "DELETE", url: `/events/${dinner.id}`, headers })).statusCode, 404);
  assert.equal((await app.inject({ url: `/events/${dinner.id}`, headers })).json().name, "Dîner avec Claire");
});

test("from Contacts: a second sign-in, asking Contacts and what the link holds, replaces the link with one covering both; the folders read too", async () => {
  await capability("contacts", true);
  // Contacts on, not granted yet: nothing of the contacts is read.
  const before = graphRequests.length;
  await synced();
  assert.ok(graphRequests.slice(before).every((one) => !/contact/i.test(one.path)));
  assert.equal((await status()).contacts.granted, false);
  const oldLink = graphLink(userId)!.id;
  const response = await link(signedIn("graph-refresh-again", `${CALENDARS_READ} ${CONTACTS_READ} openid profile email`));
  assert.equal(response.statusCode, 200, response.body);
  assert.equal((await synced()).ok, true);
  assert.deepEqual(tokenRequests.at(-1), { client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: "graph-refresh-again", scope: `${CALENDARS_READ} ${CONTACTS_READ} offline_access` });
  assert.notEqual(graphLink(userId)!.id, oldLink);
  const body = await status();
  assert.deepEqual(body.account.scopes, ["Calendars.Read", "Contacts.Read"]);
  assert.equal(body.contacts.granted, true);
  assert.equal(body.contacts.count, 3);
  assert.equal(body.calendar.count, 6);
  const contacts = rows("contacts", "microsoft");
  assert.deepEqual(contacts.map((contact) => contact.name), ["Claire Martin", "Tessane", "Tessane Facturation"]);
  const claire = contacts[0]!;
  assert.deepEqual([claire.first_name, claire.last_name, claire.organization, claire.birthday], ["Claire", "Martin", "Tessane", "1990-05-17"]);
  assert.deepEqual(storedValues(String(claire.phones)), ["+33 6 00 00 00 01", "+33 1 00 00 00 02"]);
  assert.deepEqual(storedValues(String(claire.emails)), [ADDRESS, "claire@tessane.fr"]);
  assert.deepEqual(storedValues(String(claire.addresses)), ["1 rue de l'Exemple, 75002 Paris, France"]);
  assert.equal(contacts[2]!.birthday, "--03-14", "Outlook's year 1604: none");
  // In the list: read-only, from Outlook.
  const listed = (await app.inject({ url: "/contacts", headers })).json() as Array<Record<string, unknown>>;
  const fromOutlook = listed.find((contact) => contact.name === "Claire Martin")!;
  assert.deepEqual([fromOutlook.source, fromOutlook.read_only], ["microsoft", true]);
  assert.equal((await app.inject({ method: "PATCH", url: `/contacts/${fromOutlook.id}`, headers, payload: { contact: { name: "X" } } })).statusCode, 409);
});

test("only Outlook's copy is replaced: the Mac's rows and the person's own stay as they were; the app cannot send Outlook's", async () => {
  const mac = await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers, payload: { source: "macos", contacts: [{ id: "MAC-1", name: "Tessane Accueil", phones: ["+33 1 00 00 00 04"] }] } });
  assert.equal(mac.statusCode, 200, mac.body);
  await app.inject({ method: "PUT", url: "/api/v1/local_sync/events", headers, payload: { source: "macos", events: [{ id: "MAC-E1", title: "Cours de piano", start: new Date(today + 5 * DAY).toISOString(), all_day: false, calendar: "Maison" }] } });
  assert.equal((await app.inject({ method: "POST", url: "/contacts", headers, payload: { contact: { name: "Claire M.", phone_number: "0600000005" } } })).statusCode, 201);
  await app.inject({ method: "POST", url: "/events", headers, payload: { event: { name: "Rendez-vous Tessane", start_time: new Date(today + 6 * DAY).toISOString() } } });
  const before = { mac: rows("contacts", "macos"), mine: rows("contacts", null), macEvents: rows("events", "macos"), myEvents: rows("events", null) };
  // Tessane left the address book at Microsoft, a weekly occurrence too.
  const saved = { contacts: world.contacts, travail: world.views.get("AAMkCal-Travail=")! };
  world.contacts = [world.contacts[0]!];
  world.views.set("AAMkCal-Travail=", [saved.travail[0]!.slice(1), saved.travail[1]!]);
  assert.equal((await synced()).ok, true);
  assert.deepEqual(rows("contacts", "microsoft").map((contact) => contact.name), ["Claire Martin", "Tessane Facturation"]);
  assert.equal(rows("events", "microsoft").length, 5);
  assert.deepEqual({ mac: rows("contacts", "macos"), mine: rows("contacts", null), macEvents: rows("events", "macos"), myEvents: rows("events", null) }, before);
  world.contacts = saved.contacts;
  world.views.set("AAMkCal-Travail=", saved.travail);
  // The app sends the Mac's copy, never Outlook's.
  const refused = await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers, payload: { source: "microsoft", contacts: [] } });
  assert.equal(refused.statusCode, 422);
  assert.equal(rows("contacts", "microsoft").length, 2);
  // The chat reads them all.
  assert.equal((await synced()).ok, true);
  const personal = loadPersonalData(userId);
  assert.ok(personal.contacts.some((contact) => contact.name === "Claire Martin") && personal.contacts.some((contact) => contact.name === "Tessane Accueil"));
  assert.ok(personal.events.some((event) => event.title === "Dîner avec Claire" && event.calendar === "Perso") && personal.events.some((event) => event.title === "Cours de piano"));
});

test("Graph asks to wait (429): the time it says is waited before asking again; longer than a round, the copies stop until then", async () => {
  assert.equal(retryAfterMs("3"), 3_000);
  assert.equal(retryAfterMs(new Date(Date.now() + 60_000).toUTCString())! > 55_000, true);
  assert.equal(retryAfterMs("soon"), null);
  waits.length = 0;
  world.throttle = 2;
  world.retryAfter = "3";
  assert.equal((await synced()).ok, true);
  assert.deepEqual(waits, [3_000, 3_000]);
  assert.equal((await status()).calendar.last_error, null);
  // Ten minutes: not waited here; nothing asked of Graph before then.
  const counts = { events: rows("events", "microsoft").length, contacts: rows("contacts", "microsoft").length };
  world.throttle = 1;
  world.retryAfter = "600";
  assert.deepEqual(await synced(), { ok: false, error: "throttled" });
  assert.deepEqual(waits, [3_000, 3_000]);
  assert.ok(graphHeldUntil(userId)! > Date.now() + 590_000);
  const body = await status();
  assert.equal(body.calendar.last_error, "throttled");
  assert.equal(body.contacts.last_error, "throttled", "the contacts wait too");
  const asked = graphRequests.length;
  assert.deepEqual(await synced(), { ok: false, error: "throttled" });
  assert.equal(graphRequests.length, asked, "nothing asked meanwhile");
  assert.deepEqual({ events: rows("events", "microsoft").length, contacts: rows("contacts", "microsoft").length }, counts, "the copies kept as they were");
  useFakes();
  assert.equal((await synced()).ok, true);
});

test("tokens: one serves until shortly before it expires, then a new one with the newest refresh token, which is kept; one Graph refuses gets a new one, once", async () => {
  lifetime = 60;
  useFakes();
  const before = tokenRequests.length;
  const keptBefore = String(kept()!.refresh_token);
  assert.equal((await synced()).ok, true);
  assert.equal((await synced()).ok, true);
  const used = tokenRequests.slice(before).map((form) => form.refresh_token);
  assert.equal(used.length, 2);
  assert.equal(used[0], keptBefore);
  assert.equal(String(kept()!.refresh_token), `graph-refresh-${issued + 1}`);
  assert.equal(used[1], `graph-refresh-${issued}`);
  // None given back: the one used stays.
  lifetime = 3_599;
  answer = () => {
    const given = grant();
    delete given.body.refresh_token;
    return given;
  };
  const keptNow = String(kept()!.refresh_token);
  assert.equal((await synced()).ok, true);
  assert.equal(tokenRequests.at(-1)!.refresh_token, keptNow);
  assert.equal(String(kept()!.refresh_token), keptNow);
  answer = grant;
  // Withdrawn before its time: Graph says 401, a new token is got, once.
  accepted.clear();
  const asked = tokenRequests.length;
  assert.equal((await synced()).ok, true);
  assert.equal(tokenRequests.length - asked, 1);
  assert.equal((await status()).calendar.last_error, null);
});

test("a sign-in Microsoft no longer honours: both copies wait for the person, kept as they were, and nothing of Microsoft's own words", async () => {
  const counts = { events: rows("events", "microsoft").length, contacts: rows("contacts", "microsoft").length };
  answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: `AADSTS70008: The refresh token has expired due to inactivity. ${ADDRESS}\r\nTrace ID: 0000`, error_codes: [70008] } });
  useFakes();
  const asked = graphRequests.length;
  assert.deepEqual(await synced(), { ok: false, error: "signin_required" });
  assert.equal(graphRequests.length, asked, "Graph never asked without a token");
  const body = await status();
  assert.equal(body.calendar.last_error, "signin_required");
  assert.equal(body.contacts.last_error, "signin_required");
  assert.equal(body.calendar.next_at, null);
  assert.doesNotMatch(JSON.stringify(body) + readFileSync(linkFile, "utf8"), /AADSTS|inactivity|Trace/);
  const now = graphLink(userId)!;
  assert.equal(graphSyncDue(now, "calendar", Date.now() + 3_600_000), false, "not asked again and again");
  assert.deepEqual({ events: rows("events", "microsoft").length, contacts: rows("contacts", "microsoft").length }, counts);
  // An approval it waits for, said apart; Microsoft out of reach, tried again next round.
  answer = () => ({ status: 400, body: { error: "invalid_grant", error_description: "AADSTS65001: The user or administrator has not consented.", error_codes: [65001] } });
  assert.deepEqual(await synced(), { ok: false, error: "admin_consent_required" });
  useMicrosoftTokenEndpointForTests(async () => {
    throw new TypeError("fetch failed");
  });
  assert.deepEqual(await synced(), { ok: false, error: "signin_unreachable" });
  assert.equal(graphSyncDue(graphLink(userId)!, "calendar", Date.now() + 16 * 60_000), true);
  answer = grant;
  useFakes();
  // Graph refusing this account's calendar: said so, and it waits for the person.
  world.status = 403;
  assert.deepEqual(await synced(), { ok: false, error: "graph_refused" });
  assert.equal(needsThePerson((await status()).calendar.last_error), true);
  world.status = 0;
  assert.equal((await synced()).ok, true);
  assert.equal((await status()).calendar.last_error, null);
});

test("a page that leads anywhere else is refused at the door: nothing goes there, the copy stays as it was", async () => {
  const count = rows("contacts", "microsoft").length;
  world.nextOverride = "https://evil.example/v1.0/me/contacts?%24skiptoken=1";
  const asked = graphRequests.length;
  assert.deepEqual(await synced(), { ok: false, error: "other_address" });
  assert.ok(graphRequests.slice(asked).every((one) => one.path.startsWith("/v1.0/me/")));
  assert.equal(rows("contacts", "microsoft").length, count);
  assert.equal((await status()).contacts.last_error, "other_address");
  world.nextOverride = null;
  assert.equal((await synced()).ok, true);
});

test("Agenda turned off: its copy of Outlook's goes, the Mac's and Contacts' stay, nothing of the calendar is read; back on, read at once", async () => {
  const macEvents = rows("events", "macos");
  assert.equal((await capability("calendar", false)).statusCode, 200);
  assert.equal(rows("events", "microsoft").length, 0);
  assert.deepEqual(rows("events", "macos"), macEvents);
  assert.equal(rows("contacts", "microsoft").length, 3);
  const off = await status();
  assert.deepEqual([off.calendar.enabled, off.calendar.count, off.calendar.last_synced_at], [false, 0, null]);
  const asked = graphRequests.length;
  assert.equal((await synced()).ok, true);
  assert.ok(graphRequests.slice(asked).every((one) => !/calendar/i.test(one.path)));
  assert.equal((await capability("calendar", true)).statusCode, 200);
  await synced();
  assert.equal(rows("events", "microsoft").length, 6);
  // Both off: no link may be renewed, nothing read.
  await capability("calendar", false);
  await capability("contacts", false);
  assert.equal(rows("contacts", "microsoft").length, 0);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/microsoft_graph/sync", headers })).statusCode, 403);
  await capability("calendar", true);
  await capability("contacts", true);
  await synced();
  assert.equal(rows("contacts", "microsoft").length, 3);
});

test("Agenda turned off, or the link removed, while Graph gives its last answer: what it answered is not kept", async () => {
  await synced();
  assert.equal(rows("events", "microsoft").length, 6);
  // The last address the calendar's copy reads: nothing is asked of Graph
  // after it, only the copy is left to write.
  world.delay = { path: "AAMkCal-Perso", ms: 150 };
  const lastAnswer = async (change: () => Promise<unknown>) => {
    const asked = graphRequests.length;
    const syncing = synced();
    await until(() => graphRequests.slice(asked).some((one) => one.path.includes("AAMkCal-Perso")), "the calendar's last address");
    await change();
    await syncing;
  };
  await lastAnswer(() => capability("calendar", false));
  assert.equal(rows("events", "microsoft").length, 0, "nothing written after the switch");
  await capability("calendar", true);
  await synced();
  assert.equal(rows("events", "microsoft").length, 6);
  await lastAnswer(() => app.inject({ method: "DELETE", url: "/api/v1/microsoft_graph/account", headers }));
  assert.equal(rows("events", "microsoft").length, 0, "nothing written after the link was removed");
  world.delay = null;
  assert.equal((await link(signedIn("graph-refresh-relinked", `${CALENDARS_READ} ${CONTACTS_READ}`))).statusCode, 200);
  assert.equal((await synced()).ok, true);
  assert.equal(rows("events", "microsoft").length, 6);
});

test("the timer: every round while a capability is on; never again after a refusal only the person can mend", async () => {
  const views = () => graphRequests.filter((one) => one.path.endsWith("/calendarView")).length;
  const before = views();
  const timer = startMicrosoftGraphSync({ checkEveryMs: 10, intervalMs: 40 });
  try {
    await until(() => views() >= before + 6, "three rounds");
    assert.ok(views() >= before + 6, "read again, round after round");
    answer = () => ({ status: 400, body: { error: "invalid_grant", error_codes: [70008] } });
    useFakes();
    await until(async () => (await status()).calendar.last_error === "signin_required", "the refusal noted");
    // The link's sign-in refused: both copies wait for the person at once.
    assert.equal((await status()).contacts.last_error, "signin_required", "the other copy too");
    const tokens = tokenRequests.length;
    await sleep(200);
    assert.equal(tokenRequests.length, tokens, "not asked again and again");
  } finally {
    timer.stop();
    answer = grant;
    useFakes();
  }
  await synced();
  assert.equal((await status()).calendar.last_error, null, "« Synchroniser maintenant » tries again");
});

test("a new account: the copies of the one before go at once; a permission no longer granted takes its copy along", async () => {
  // Graph down after the link: what is seen is what the link did.
  world.status = 500;
  const other = await link(signedIn("graph-refresh-tessane", `${CALENDARS_READ} ${CONTACTS_READ}`, { address: "claire@tessane.fr" }));
  assert.equal(other.statusCode, 200, other.body);
  await synced();
  assert.equal(rows("events", "microsoft").length + rows("contacts", "microsoft").length, 0);
  assert.equal((await status()).account.address, "claire@tessane.fr");
  world.status = 0;
  assert.equal((await synced()).ok, true);
  assert.equal(rows("contacts", "microsoft").length, 3);
  // Signed in again with the calendar only: the contacts' copy goes.
  const narrower = await link(signedIn("graph-refresh-narrow", CALENDARS_READ, { address: "claire@tessane.fr" }));
  assert.equal(narrower.statusCode, 200, narrower.body);
  await synced();
  assert.equal(rows("contacts", "microsoft").length, 0);
  assert.equal(rows("events", "microsoft").length, 6);
  // And back as it was.
  assert.equal((await link(signedIn("graph-refresh-both", `${CALENDARS_READ} ${CONTACTS_READ}`))).statusCode, 200);
  assert.equal((await synced()).ok, true);
});

test("unlinked: the sign-in forgotten, in the file and in memory; both copies removed, the Mac's rows and the person's own kept; a token given back afterwards is not kept", async () => {
  await synced();
  const others = { mac: rows("contacts", "macos"), mine: rows("contacts", null), macEvents: rows("events", "macos"), myEvents: rows("events", null) };
  const last = String(kept()!.refresh_token);
  const removed = await app.inject({ method: "DELETE", url: "/api/v1/microsoft_graph/account", headers });
  assert.equal(removed.statusCode, 200);
  assert.equal(removed.json().linked, false);
  assert.equal(existsSync(linkFile), false);
  assert.equal(rows("events", "microsoft").length + rows("contacts", "microsoft").length, 0);
  assert.deepEqual({ mac: rows("contacts", "macos"), mine: rows("contacts", null), macEvents: rows("events", "macos"), myEvents: rows("events", null) }, others);
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/microsoft_graph/account", headers })).statusCode, 404);
  assert.deepEqual(await synced(), { ok: false, error: "not_linked" });
  // Linked again with that same token: memory forgot it, Microsoft is asked.
  const asked = tokenRequests.length;
  assert.equal((await link(signedIn(last, `${CALENDARS_READ} ${CONTACTS_READ}`))).statusCode, 200);
  assert.deepEqual(tokenRequests.slice(asked).map((form) => form.refresh_token), [last]);
  await synced();
  // Unlinked while Microsoft answers: the token it gives back goes nowhere, nothing is written.
  lifetime = 60;
  useFakes();
  answer = () => ({ ...grant(), delayMs: 200 });
  const before = tokenRequests.length;
  const syncing = synced();
  await until(() => tokenRequests.length > before, "a token asked");
  assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/microsoft_graph/account", headers })).statusCode, 200);
  await syncing;
  assert.equal(existsSync(linkFile), false, "nothing written back");
  assert.equal(rows("events", "microsoft").length + rows("contacts", "microsoft").length, 0, "nothing read is kept");
  answer = grant;
  lifetime = 3_599;
});

test("Outlook's birthdays: the date of the nearest midnight, a year of 1604 for none", () => {
  assert.equal(birthdayOf("1990-05-17T11:59:00Z"), "1990-05-17");
  assert.equal(birthdayOf("1990-05-16T22:00:00Z"), "1990-05-17", "typed in Paris");
  assert.equal(birthdayOf("1990-05-17T05:00:00Z"), "1990-05-17", "typed in New York");
  assert.equal(birthdayOf("1990-05-17T00:00:00Z"), "1990-05-17");
  assert.equal(birthdayOf("1604-03-14T11:59:00Z"), "--03-14");
  assert.equal(birthdayOf("not a date"), null);
  assert.equal(birthdayOf(null), null);
});

test("Graph's refusals become codes in one place: an account without a mailbox told apart from an item gone, never Graph's own words", () => {
  const code = (status: number, error: string | null, path: string) => graphRefusal(status, error ? { error: { code: error, message: `Not found for ${ADDRESS}` } } : null, `${GRAPH_ME}${path}`).code;
  // No mailbox for this account: whatever the address, or nothing at a whole collection.
  assert.equal(code(404, "MailboxNotEnabledForRESTAPI", "/calendars"), "no_mailbox");
  assert.equal(code(400, "MailboxNotEnabledForRESTAPI", "/contacts"), "no_mailbox");
  assert.equal(code(404, "MailboxNotFound", "/contactFolders/x/contacts"), "no_mailbox");
  assert.equal(code(404, "ResourceNotFound", "/calendars"), "no_mailbox");
  // So will the mailbox's own, when it comes to read Graph (not opened by the door today).
  assert.equal(code(404, "ResourceNotFound", "/mailFolders"), "no_mailbox");
  assert.equal(code(404, "ResourceNotFound", "/mailFolders/inbox/messages"), "gone");
  // Something listed earlier, gone since.
  assert.equal(code(404, "ErrorItemNotFound", "/calendars/AAMk=/calendarView"), "gone");
  assert.equal(code(404, null, "/contactFolders/AQMk/contacts"), "gone");
  // Refused to Twoody; asked to wait; anything else.
  assert.equal(code(401, "InvalidAuthenticationToken", "/contacts"), "graph_refused");
  assert.equal(code(403, "ErrorAccessDenied", "/calendars"), "graph_refused");
  assert.equal(code(429, "TooManyRequests", "/contacts"), "throttled");
  assert.equal(code(503, null, "/contacts"), "throttled");
  assert.equal(code(400, "BadRequest", "/calendars"), "graph_failed");
  assert.equal(code(500, null, "/calendars"), "graph_failed");
  assert.equal(graphRefusal(404, null, "not an address").code, "graph_failed");
  assert.doesNotMatch(JSON.stringify(graphRefusal(404, { error: { code: "ErrorItemNotFound", message: ADDRESS } }, `${GRAPH_ME}/contacts`)), /claire/);
});

test("one link for every capability that reads Graph: each declares its permissions, the link holds their union, a refresh asks them all", () => {
  assert.deepEqual(GRAPH_SCOPES, { calendar: ["Calendars.Read"], contacts: ["Contacts.Read"] });
  assert.deepEqual([...GRAPH_CAPABILITIES].sort(), ["calendar", "contacts"]);
  // Only what a capability declares is kept, however Microsoft writes it.
  assert.deepEqual(graphPermissions("openid profile email offline_access https://graph.microsoft.com/User.Read https://graph.microsoft.com/contacts.read Calendars.Read Mail.Read"), ["Calendars.Read", "Contacts.Read"]);
  assert.deepEqual(graphPermissions(["Contacts.Read", 42]), ["Contacts.Read"]);
  assert.deepEqual(graphPermissions(null), []);
  assert.equal(graphScope(["Calendars.Read", "Contacts.Read"]), `${CALENDARS_READ} ${CONTACTS_READ} offline_access`);
  assert.equal(linkGrants({ scopes: ["Calendars.Read"] }, "calendar"), true);
  assert.equal(linkGrants({ scopes: ["Calendars.Read"] }, "contacts"), false);
  assert.equal(linkGrants({ scopes: ["Calendars.Read", "Contacts.Read"] }, "contacts"), true);
});
