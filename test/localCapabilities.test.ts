import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Capabilities, each switched on by the person (Jimmy, 02/10/2026): off on a
// new installation, kept on where an older one was using them, and nothing
// read while off — documents, contacts, the agenda.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-capabilities-"));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { localCapabilities } = await import("../src/localCapabilities.js");
const { loadPersonalData } = await import("../src/routes/localSync.js");
const { scopedFolders } = await import("../src/documents/retrieval.js");
const { applyDiscovery } = await import("../src/memory/discover.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
assert.equal(paired.statusCode, 201);
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };

test("a new installation has every capability off, but Mémoire, on as Twoody always was (04/10/2026)", async () => {
  const response = await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop });
  // The app asks under /api/v1, as for everything else.
  assert.equal((await app.inject({ method: "GET", url: "/api/v1/local_capabilities", headers: desktop })).statusCode, 200);
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().capabilities, { documents: false, contacts: false, calendar: false, web: false, dictation: false, agent: false, home: false, connectors: false, memory: true });
});

test("off, documents, contacts and the agenda are not read; on, they are", async (t) => {
  // Not under the system's temporary folder, which is never searched.
  const folder = mkdtempSync(join(process.cwd(), "tmp-capabilities-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  sqlite.prepare("INSERT INTO document_folders (id, user_id, path, created_at) VALUES ('f1', ?, ?, ?)").run(owner, folder, Date.now());
  assert.deepEqual(scopedFolders(owner, { mode: "all" }), []);
  await app.inject({ method: "POST", url: "/contacts", headers: desktop, payload: { contact: { name: "Lina", birthday: "2019-03-02" } } });
  const now = Date.now();
  sqlite.prepare("INSERT INTO events (id, user_id, name, status, kind, start_time, all_day, created_at, updated_at) VALUES ('e1', ?, 'Mariage', 'confirmed', 'event', ?, 1, ?, ?)").run(owner, now + 86_400_000, now, now);
  assert.deepEqual(loadPersonalData(owner), { contacts: [], events: [] });

  for (const id of ["documents", "contacts", "calendar"]) {
    const changed = await app.inject({ method: "PATCH", url: `/local_capabilities/${id}`, headers: desktop, payload: { enabled: true } });
    assert.equal(changed.statusCode, 200);
  }
  assert.equal(scopedFolders(owner, { mode: "all" }).length, 1);
  const personal = loadPersonalData(owner);
  assert.equal(personal.contacts[0]?.name, "Lina");
  assert.equal(personal.contacts[0]?.birthday, "2019-03-02");
  assert.equal(personal.events[0]?.title, "Mariage");
});

test("only this computer's app changes them; a phone reads them", async () => {
  assert.equal((await app.inject({ method: "PATCH", url: "/local_capabilities/web", headers: phone, payload: { enabled: true } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PATCH", url: "/local_capabilities/bank", headers: desktop, payload: { enabled: true } })).statusCode, 404);
  assert.equal((await app.inject({ method: "GET", url: "/local_capabilities", headers: phone })).json().capabilities.web, false);
});

test("an installation from before the switches keeps what it used", () => {
  const user = "older-user";
  const seconds = Date.now();
  sqlite.prepare("INSERT INTO users (id, email, name, prefs, created_at) VALUES (?, 'ancien@example.com', 'Ancien', '{}', ?)").run(user, seconds);
  sqlite.prepare("INSERT INTO contacts (id, user_id, name, origin, created_at, updated_at) VALUES ('c-old', ?, 'Paul', 'local', ?, ?)").run(user, seconds, seconds);
  assert.deepEqual(localCapabilities(user), { documents: false, contacts: true, calendar: false, web: false, dictation: false, agent: false, home: false, connectors: false, memory: true });
});

test("people and dates kept after an import switch Contacts and Agenda on", () => {
  const user = "importer";
  const seconds = Date.now();
  sqlite.prepare("INSERT INTO users (id, email, name, prefs, created_at) VALUES (?, 'steeve@example.com', 'Steeve', '{}', ?)").run(user, seconds);
  assert.equal(localCapabilities(user).contacts, false);
  applyDiscovery(user, { contacts: [{ key: "k", name: "Sarah", relation: "partner", detail: null, birthday: null, memory_ids: [] }], events: [{ key: "e", name: "Mariage", date: "2027-06-14", memory_ids: [] }] });
  assert.equal(localCapabilities(user).contacts, true);
  assert.equal(localCapabilities(user).calendar, true);
});

test("adding a folder turns Documents on (Jimmy, 04/10/2026); turning it off stays possible", async (t) => {
  const folder = mkdtempSync(join(process.cwd(), "tmp-capabilities-add-"));
  t.after(() => rmSync(folder, { recursive: true, force: true }));
  await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: false } });
  assert.equal(localCapabilities(owner).documents, false);
  const added = await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: folder } });
  assert.equal(added.statusCode, 201);
  assert.equal(localCapabilities(owner).documents, true);
  await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: false } });
  assert.equal(localCapabilities(owner).documents, false);
});

test("where a capability shows, menu and chat, both on unless the person says otherwise (04/10/2026)", async () => {
  const read = await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop });
  assert.deepEqual(read.json().places.home, { menu: true, chat: true });
  const changed = await app.inject({ method: "PATCH", url: "/local_capabilities/home", headers: desktop, payload: { menu: false } });
  assert.equal(changed.statusCode, 200);
  assert.deepEqual(changed.json().places.home, { menu: false, chat: true });
  assert.deepEqual(changed.json().places.documents, { menu: true, chat: true });
  // Only the place changed, not the switch.
  assert.equal(changed.json().capabilities.documents, localCapabilities(owner).documents);
  assert.equal((await app.inject({ method: "PATCH", url: "/local_capabilities/home", headers: desktop, payload: {} })).statusCode, 400);
  assert.equal((await app.inject({ method: "PATCH", url: "/local_capabilities/home", headers: phone, payload: { chat: false } })).statusCode, 403);
  const { capabilitiesOff } = await import("../src/localCapabilities.js");
  assert.deepEqual([...capabilitiesOff(["home", "nope", "contacts"])], ["home", "contacts"]);
  assert.deepEqual([...capabilitiesOff("calendar,connectors")], ["calendar", "connectors"]);
  assert.equal(capabilitiesOff(null).size, 0);
});

test("Mémoire is the person's memory_enabled; the menu's order is kept, unknown ids dropped", async () => {
  const off = await app.inject({ method: "PATCH", url: "/local_capabilities/memory", headers: desktop, payload: { enabled: false } });
  assert.equal(off.json().capabilities.memory, false);
  assert.equal((await app.inject({ method: "GET", url: "/me", headers: desktop })).json().memory_enabled, false);
  await app.inject({ method: "PATCH", url: "/local_capabilities/memory", headers: desktop, payload: { enabled: true } });
  assert.equal(localCapabilities(owner).memory, true);

  assert.equal((await app.inject({ method: "GET", url: "/local_capabilities", headers: desktop })).json().order, null);
  const arranged = await app.inject({ method: "PUT", url: "/local_capabilities_order", headers: desktop, payload: { order: ["home", "memory", "nope", "home", "documents"] } });
  assert.equal(arranged.statusCode, 200);
  assert.deepEqual(arranged.json().order, ["home", "memory", "documents"]);
  assert.deepEqual((await app.inject({ method: "GET", url: "/local_capabilities", headers: phone })).json().order, ["home", "memory", "documents"]);
  assert.equal((await app.inject({ method: "PUT", url: "/local_capabilities_order", headers: phone, payload: { order: [] } })).statusCode, 403);
  assert.equal((await app.inject({ method: "PUT", url: "/local_capabilities_order", headers: desktop, payload: { order: null } })).json().order, null);
});
