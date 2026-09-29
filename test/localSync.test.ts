import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The Mac's Contacts and Calendar, copied by the desktop app when the person
// turns them on (29/09/2026): only this computer's app may send them, each
// copy replaces the previous one, and what the person added by hand stays.
// The chat of this computer then reads the ones a message is about.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-local-sync-"));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { db, tunnelPeers } = await import("../src/db.js");
const { forgetRuntimeProbes } = await import("../src/localRuntime.js");
const { localParts, zonedTime } = await import("../src/usagePeriods.js");

// A llama.cpp that keeps what it was asked.
const asked: Array<{ messages: Array<{ role: string; content: string }> }> = [];
const runtime = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3", object: "model" }] }));
    return;
  }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    asked.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Noté." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };
// A phone that named itself like the app is still a phone: it has a tunnel key.
const impostor = createAuthSession(owner, "pair:Twoody Desktop");
db.insert(tunnelPeers).values({ publicKey: "cd".repeat(32), userId: owner, name: "Twoody Desktop", pairedAt: new Date(), sessionId: impostor.sessionId }).run();

test.after(async () => {
  await app.close();
  await new Promise((resolve) => runtime.close(resolve));
});

// As twoody-personal-data prints them (test/fixtures in the desktop app).
const MAC_CONTACTS = [
  { id: "ABC:ABPerson", name: "Paul Motte", given_name: "Paul", family_name: "Motte", organization: "Secrétaire", phones: ["+33 6 12 34 56 78"], emails: ["paul@example.com"], birthday: "1988-10-02" },
  { id: "DEF:ABPerson", name: "Jacky Azran", given_name: "Jacky", family_name: "Azran", organization: "2CG Consulting", phones: [], emails: ["jacky@example.com"], birthday: "--03-14", addresses: ["1 rue de la Paix, 75002 Paris, France"] },
  // Nothing to call it by: skipped.
  { id: "EMPTY:ABPerson", name: "", phones: [], emails: [] },
];

test("only this computer's app may send the copy", async () => {
  for (const headers of [phone, { authorization: `Bearer ${impostor.token}` }]) {
    const refused = await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers, payload: { contacts: MAC_CONTACTS } });
    assert.equal(refused.statusCode, 403, refused.body);
    assert.equal((await app.inject({ method: "PUT", url: "/api/v1/local_sync/events", headers, payload: { events: [] } })).statusCode, 403);
  }
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", payload: { contacts: [] } })).statusCode, 401);
  const invalid = await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers: desktop, payload: { source: "gmail", contacts: [] } });
  assert.equal(invalid.statusCode, 422);
});

test("each copy replaces the last, and a contact added by hand stays", async () => {
  const manual = await app.inject({ method: "POST", url: "/contacts", headers: desktop, payload: { contact: { name: "Nadine", phone_number: "0102030405" } } });
  assert.equal(manual.statusCode, 201);

  const first = await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers: desktop, payload: { source: "macos", contacts: MAC_CONTACTS } });
  assert.equal(first.statusCode, 200, first.body);
  assert.deepEqual(first.json(), { source: "macos", contacts: 2 });

  let listed = (await app.inject({ method: "GET", url: "/contacts", headers: desktop })).json() as Array<Record<string, unknown>>;
  assert.deepEqual(listed.map((row) => row.name).sort(), ["Jacky Azran", "Nadine", "Paul Motte"]);
  const paul = listed.find((row) => row.name === "Paul Motte")!;
  assert.equal(paul.source, "macos");
  assert.equal(paul.read_only, true);
  assert.deepEqual(paul.phones, ["+33 6 12 34 56 78"]);
  assert.equal(paul.birthday, "1988-10-02");
  assert.equal(listed.find((row) => row.name === "Nadine")!.read_only, false);
  // Changed in the Mac's Contacts, not here.
  assert.equal((await app.inject({ method: "PATCH", url: `/contacts/${paul.id}`, headers: desktop, payload: { contact: { name: "X" } } })).statusCode, 409);

  // Paul left the Mac's contacts: gone here too, with the same id for Jacky.
  const jackyId = listed.find((row) => row.name === "Jacky Azran")!.id;
  await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers: desktop, payload: { contacts: [MAC_CONTACTS[1]] } });
  listed = (await app.inject({ method: "GET", url: "/contacts", headers: desktop })).json();
  assert.deepEqual(listed.map((row) => row.name).sort(), ["Jacky Azran", "Nadine"]);
  assert.equal(listed.find((row) => row.name === "Jacky Azran")!.id, jackyId);

  // The switch turned off: an empty copy, and only Nadine is left.
  await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers: desktop, payload: { contacts: [] } });
  listed = (await app.inject({ method: "GET", url: "/contacts", headers: desktop })).json();
  assert.deepEqual(listed.map((row) => row.name), ["Nadine"]);
});

test("calendar events: replaced as a set, read-only in the agenda, events made here kept", async () => {
  const mine = await app.inject({ method: "POST", url: "/events", headers: desktop, payload: { event: { name: "Piano", start_time: "2026-10-01T16:00:00Z" } } });
  assert.equal(mine.statusCode, 201, mine.body);
  const events = [
    { id: "E1@1790000000", title: "Réunion Ordatel", start: "2026-10-01T08:00:00Z", end: "2026-10-01T09:00:00Z", all_day: false, location: "Tour Nova", calendar: "Travail" },
    // A repeating event: one row per occurrence.
    { id: "E2@1790086400", title: "Standup", start: "2026-10-02T07:00:00Z", end: "2026-10-02T07:15:00Z", all_day: false, calendar: "Travail" },
    { id: "E2@1790086400", title: "Standup (twice)", start: "2026-10-02T07:00:00Z", all_day: false },
    { id: "bad", title: "No start" },
  ];
  const synced = await app.inject({ method: "PUT", url: "/api/v1/local_sync/events", headers: desktop, payload: { events } });
  assert.deepEqual(synced.json(), { source: "macos", events: 2 });
  const agenda = (await app.inject({ method: "GET", url: "/events?start_time=2026-09-30T00:00:00Z&end_time=2026-10-10T00:00:00Z", headers: desktop })).json();
  assert.deepEqual(agenda.events.map((row: { name: string }) => row.name), ["Réunion Ordatel", "Piano", "Standup"]);
  const meeting = agenda.events.find((row: { name: string }) => row.name === "Réunion Ordatel");
  assert.equal(meeting.source, "macos");
  assert.equal(meeting.read_only, true);
  assert.equal(meeting.calendar, "Travail");
  assert.equal((await app.inject({ method: "DELETE", url: `/events/${meeting.id}`, headers: desktop })).statusCode, 404);

  await app.inject({ method: "PUT", url: "/api/v1/local_sync/events", headers: desktop, payload: { events: [] } });
  const after = (await app.inject({ method: "GET", url: "/events?start_time=2026-09-30T00:00:00Z&end_time=2026-10-10T00:00:00Z", headers: desktop })).json();
  assert.deepEqual(after.events.map((row: { name: string }) => row.name), ["Piano"]);
});

test("the chat of this computer reads tomorrow's events and the contact it is asked about", async () => {
  assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: `${runtimeUrl}/v1`, model: "qwen3", name: "llama.cpp" } })).statusCode, 201);
  forgetRuntimeProbes();
  const tz = "Asia/Tokyo";
  const today = localParts(Date.now(), tz);
  const tomorrowNoon = new Date(zonedTime(tz, today.year, today.month, today.day + 1, 12)).toISOString();
  await app.inject({ method: "PUT", url: "/api/v1/local_sync/events", headers: desktop, payload: { events: [{ id: "T1", title: "Déjeuner avec Paul", start: tomorrowNoon, all_day: false, calendar: "Perso" }] } });
  await app.inject({ method: "PUT", url: "/api/v1/local_sync/contacts", headers: desktop, payload: { contacts: MAC_CONTACTS } });

  asked.length = 0;
  const response = await app.inject({ method: "POST", url: "/queries", headers: phone, payload: { text: "Qu'est-ce que j'ai demain ?", channel: "desktop", force_new_discussion: true, time_zone: tz } });
  assert.equal(response.statusCode, 200, response.body);
  const last = asked[0].messages.at(-1)!.content;
  assert.match(last, /Times are in Asia\/Tokyo/);
  assert.match(last, /"title":"Déjeuner avec Paul","start":"\w{3} \d{4}-\d{2}-\d{2} 12:00"/);

  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Quel est l'e-mail de Jacky ?", channel: "desktop", force_new_discussion: true } });
  assert.match(asked[0].messages.at(-1)!.content, /contact: \{"name":"Jacky Azran","organization":"2CG Consulting","emails":\["jacky@example\.com"\],"birthday":"03-14"\}/);
  // Never in the system prompt, which stays the same from turn to turn.
  assert.doesNotMatch(asked[0].messages[0].content, /Jacky/);
});
