import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Memories through the vault (docs/mesh-design.md §3, lot S5), between two
// computers sharing one stand-in for the account: the Mac (this process's
// server, inside Twoody Desktop, with the keys the Desktop handed over)
// and the Pi (a second server database, its own memory vault). The P0 LWW
// vectors are played end to end through both; a memory learned on one is
// on the other after a sync; a deletion goes everywhere, is never learned
// again and holds even when the account withholds it; nothing of the
// memories ever goes on the conversations stream.

const macDir = mkdtempSync(join(tmpdir(), "twoody-memories-mac-"));
process.env.TWOODY_DATA_DIR = macDir;
process.env.TWOODY_BONJOUR_DISABLED = "1";
const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { setBackendFetch, backendCall } = await import("../src/account/backend.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const crypto = await import("../src/vault/crypto.js");
const contracts = await import("../src/vault/contracts.js");
const client = await import("../src/vault/client.js");
const service = await import("../src/vault/service.js");
const memoriesVault = await import("../src/vault/memories.js");
const { rememberFacts } = await import("../src/memoryLearning.js");
const { createVaultSync } = await import("../src/vault/sync.js");
const { memoryStore } = await import("../src/vault/store.js");
const { fakeVaultBackend } = await import("./helpers/fakeVault.js");

// The Pi: the same schema in its own data directory (a second copy of db.ts).
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-memories-pi-"));
const piDb = (await import("../src/db.js?computer=pi")) as typeof import("../src/db.js");
process.env.TWOODY_DATA_DIR = macDir;
assert.notEqual(piDb.sqlite, sqlite);

const vectors = JSON.parse(readFileSync(new URL("./fixtures/memory-lww-vectors.json", import.meta.url), "utf8"));
const EPOCH_ONE = crypto.fromHex(vectors.epoch_one_key);
const STREAM = contracts.memoriesStreamId(EPOCH_ONE);
const USER_ID = 42;
const BACKEND = "https://account.test";

// The account, which can be told to withhold tombstones of the memories
// stream (a malicious backend: it keeps them from everyone).
const fake = fakeVaultBackend({ userId: USER_ID, computers: [] });
let withholdTombstones = false;
setBackendFetch((async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
  if (withholdTombstones && url.pathname.endsWith("/vault/events")) {
    if ((init?.method || "GET").toUpperCase() === "POST") {
      const body = JSON.parse(String(init!.body));
      const kept = body.events.filter((e: { stream?: string; kind: string }) => !(e.stream === "memories" && e.kind === "tombstone"));
      if (kept.length === 0) return new Response(JSON.stringify({ stored: body.events.length, duplicates: 0, conflicts: [] }), { status: 200 });
      return fake.fetch(input, { ...init, body: JSON.stringify({ ...body, events: kept }) });
    }
    const answer = await (await fake.fetch(input, init)).json();
    answer.events = (answer.events ?? []).filter((e: { stream: string; kind: string }) => !(e.stream === "memories" && e.kind === "tombstone"));
    return new Response(JSON.stringify(answer), { status: 200, headers: { "Content-Type": "application/json" } });
  }
  return fake.fetch(input, init);
}) as typeof fetch);

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Mac" } });
const owner = paired.json().user_id as string;
const local = { authorization: `Bearer ${paired.json().token}` };
piDb.sqlite.prepare("INSERT INTO users (id, email, created_at) VALUES (?, ?, ?)").run("pi-owner", "owner@self-hosted.twoody", Date.now());

// The iPhone founds the vault (epoch 1 = the vectors' key, so that their
// learned ids hold) and gives the key to the Mac and to the Pi.
const as = (creds: { backendUrl: string; userToken: string }) => (path: string, body: unknown) => backendCall(creds, path, { body }).then((r) => r.body as Record<string, any>);
const phoneCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const macCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const piCreds = { backendUrl: BACKEND, userToken: fake.personSession() };
const phone = { keys: crypto.createDeviceKeys(), id: "" };
const mac = { keys: crypto.createDeviceKeys(), id: "" };
const pi = { keys: crypto.createDeviceKeys(), id: "" };
const epochs = new Map([[1, EPOCH_ONE]]);
const enrol = async (creds: typeof phoneCreds, who: typeof phone, label: string) => {
  who.id = (await as(creds)("vault/devices", { label, enc_public: crypto.toHex(who.keys.encPublic), sign_public: crypto.toHex(who.keys.signPublic) })).device.id;
  await as(phoneCreds)("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey: EPOCH_ONE, epoch: 1, userId: USER_ID, to: { deviceId: who.id, encPublic: who.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
};
phone.id = (await as(phoneCreds)("vault/devices", { label: "iPhone", enc_public: crypto.toHex(phone.keys.encPublic), sign_public: crypto.toHex(phone.keys.signPublic) })).device.id;
await as(phoneCreds)("vault/envelopes", { envelopes: [crypto.wrapEpochKey({ epochKey: EPOCH_ONE, epoch: 1, userId: USER_ID, to: { deviceId: phone.id, encPublic: phone.keys.encPublic }, from: { deviceId: phone.id, signPrivate: phone.keys.signPrivate } })] });
await enrol(macCreds, mac, "Mac");
await enrol(piCreds, pi, "Pi");

const macVault = memoriesVault.serverMemoryVault();
const piAccess = () => ({ api: client.accountVaultApi(() => piCreds), userId: String(USER_ID), deviceId: pi.id, epochKeys: new Map(epochs) });
const piVault = memoriesVault.createMemoryVault({ sqlite: piDb.sqlite, owner: () => "pi-owner", access: piAccess });

type Held = { id: string; kind: string; title: string | null; content: string; tags: string[]; source: string; superseded_by: string | null; hlc: string | null; vault_event_id: string | null };
const held = (db: typeof sqlite): Held[] =>
  (db.prepare("SELECT id, kind, title, content, tags_json, source, superseded_by_id, hlc, vault_event_id FROM memories ORDER BY id").all() as Array<Record<string, any>>).map((r) => ({
    id: r.id, kind: r.kind, title: r.title, content: r.content, tags: JSON.parse(r.tags_json), source: r.source, superseded_by: r.superseded_by_id, hlc: r.hlc, vault_event_id: r.vault_event_id,
  }));
const contents = (db: typeof sqlite) => held(db).map((m) => m.content).sort();
const legacyId = () => Buffer.from(globalThis.crypto.getRandomValues(new Uint8Array(16))).toString("hex");
const insertLegacy = (db: typeof sqlite, user: string, row: { title: string | null; content: string; source?: string }) => {
  const id = legacyId();
  db.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags_json, source, created_at, updated_at) VALUES (?, ?, 'user', ?, ?, '[]', ?, ?, ?)")
    .run(id, user, row.title, row.content, row.source ?? "manual", Math.floor(Date.now() / 1000), Math.floor(Date.now() / 1000));
  return id;
};
const syncBoth = async () => {
  await memoriesVault.syncMemories();
  await piVault.sync();
  await memoriesVault.syncMemories();
};

/// Every memory event is in the memories stream, and nothing of it on the conversations stream.
function assertStreamsApart() {
  for (const e of fake.events) {
    if (e.conversation_id === STREAM || e.kind === "memory") assert.equal(e.stream, "memories", `${e.kind} ${e.event_id}`);
    if (e.stream === "conversations") assert.ok(["turn", "title", "tombstone"].includes(e.kind) && e.conversation_id !== STREAM);
  }
}

test("not a vault member: memories stay on this computer, as before", async () => {
  const created = await app.inject({ method: "POST", url: "/memories", headers: local, payload: { memory: { title: "Chien", content: "Le chien s'appelle Pixel" } } });
  assert.equal(created.statusCode, 201);
  assert.match(created.json().id, /^[0-9a-f]{8}-[0-9a-f]{4}-4/);
  assert.deepEqual(await memoriesVault.syncMemories(), { status: "off" });
  assert.equal(fake.events.length, 0);
  assert.equal(held(sqlite)[0]!.vault_event_id, null);
});

test("first upload: memories from before get content-hash ids, the same on both computers is one, possible duplicates listed", async () => {
  // From before the vault: legacy ids, on both computers.
  insertLegacy(sqlite, owner, { title: "Travail", content: "Jimmy dirige Osmove" });
  insertLegacy(sqlite, owner, { title: "Voiture", content: "Une Hyundai Tucson" });
  insertLegacy(sqlite, owner, { title: "Je m'appelle Jimmy.", content: "Je m'appelle Jimmy.", source: "conversation" });
  insertLegacy(piDb.sqlite, "pi-owner", { title: "Travail", content: "Jimmy  dirige OSMOVE !" });
  insertLegacy(piDb.sqlite, "pi-owner", { title: "Voiture", content: "Une Hyundai Kona" });
  insertLegacy(piDb.sqlite, "pi-owner", { title: "Nom", content: "je m’appelle jimmy", source: "conversation" });

  // The Desktop hands its keys over: the Mac is a member.
  setDesktopAccount({ backendUrl: BACKEND, userToken: macCreds.userToken, computerId: null, computerName: "Mac de Jimmy" });
  assert.equal(service.setDesktopVault({
    type: "vault", deviceId: mac.id, userId: USER_ID,
    keys: { encPrivate: crypto.toHex(mac.keys.encPrivate), encPublic: crypto.toHex(mac.keys.encPublic), signPrivate: crypto.toHex(mac.keys.signPrivate), signPublic: crypto.toHex(mac.keys.signPublic) },
    epochs: { 1: vectors.epoch_one_key },
  }), true);
  await syncBoth();
  await piVault.sync();

  const mine = held(sqlite);
  assert.deepEqual(mine.map((m) => m.id), held(piDb.sqlite).map((m) => m.id), "the same memories on both");
  const travail = contracts.learnedMemoryId(EPOCH_ONE, contracts.memoryContentHash("Jimmy dirige Osmove")!);
  const nom = contracts.learnedMemoryId(EPOCH_ONE, contracts.memoryContentHash("Je m'appelle Jimmy.")!);
  assert.equal(nom, vectors.learned_ids[0].memory_id);
  assert.equal(mine.filter((m) => m.id === travail).length, 1, "written on both before, one memory now");
  assert.equal(mine.filter((m) => m.id === nom).length, 1, "learned on both, one memory");
  assert.equal(mine.find((m) => m.id === nom)!.source, "conversation");
  // The dog, created here with a random UUID, kept it.
  assert.ok(mine.some((m) => m.content === "Le chien s'appelle Pixel" && /-4[0-9a-f]{3}-/.test(m.id)));
  assert.equal(mine.length, 5);
  for (const m of mine) assert.match(`${m.hlc} ${m.vault_event_id}`, /^\d{13}-\d{4} [0-9a-f-]{36}$/);
  // The learned fact travelled once: one event_id, whichever computer said it first.
  assert.equal(fake.events.filter((e) => e.event_id === contracts.eventIdFor(STREAM, "memory", `learned\n${nom}`)).length, 1);

  const duplicates = await app.inject({ url: "/memories/duplicates", headers: local });
  assert.equal(duplicates.statusCode, 200);
  assert.deepEqual(duplicates.json().groups.map((g: { title: string; memories: Array<{ content: string }> }) => [g.title, g.memories.map((m) => m.content).sort()]), [
    ["Voiture", ["Une Hyundai Kona", "Une Hyundai Tucson"]],
  ]);
  assert.deepEqual(piVault.possibleDuplicates("pi-owner").map((g) => g.title), ["Voiture"]);
  assertStreamsApart();
});

test("a memory learned on one computer is on the other after a sync; learned on both, it is one", async () => {
  assert.equal(rememberFacts(owner, ["J'habite à Paris"]), 1);
  const paris = contracts.learnedMemoryId(EPOCH_ONE, contracts.memoryContentHash("J'habite à Paris")!);
  assert.equal(paris, vectors.learned_ids[1].memory_id);
  assert.ok(held(sqlite).some((m) => m.id === paris && m.vault_event_id));

  // The Pi learns another fact on its own, which the Mac learns too.
  const claire = contracts.learnedMemoryId(EPOCH_ONE, contracts.memoryContentHash("Ma fille s'appelle Claire")!);
  piDb.sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags_json, source, created_at, updated_at) VALUES (?, 'pi-owner', 'user', ?, ?, '[]', 'conversation', ?, ?)")
    .run(claire, "Ma fille s'appelle Claire", "Ma fille s'appelle Claire", 1, 1);
  assert.equal(piVault.record(claire), claire);
  assert.equal(rememberFacts(owner, ["Ma fille s’appelle Claire."]), 1);

  await syncBoth();
  const onPi = held(piDb.sqlite);
  assert.ok(onPi.some((m) => m.id === paris && m.content === "J'habite à Paris" && m.source === "conversation"));
  assert.equal(onPi.filter((m) => m.id === claire).length, 1);
  assert.deepEqual(contents(sqlite), contents(piDb.sqlite));
  // And the Mac's screens show what the Pi learned.
  const listed = (await app.inject({ url: "/memories", headers: local })).json() as Array<{ id: string }>;
  assert.ok(listed.some((m) => m.id === claire));
  // Known here already: not learned twice.
  assert.equal(rememberFacts(owner, ["j'habite a paris"]), 0);
  assertStreamsApart();
});

test("an edit on one computer is the memory everywhere", async () => {
  const [travail] = held(sqlite).filter((m) => m.title === "Travail");
  const edited = await app.inject({ method: "PATCH", url: `/memories/${travail!.id}`, headers: local, payload: { memory: { content: "Jimmy dirige Osmove, SASU de conseil" } } });
  assert.equal(edited.statusCode, 200);
  assert.equal(edited.json().id, travail!.id);
  await syncBoth();
  assert.equal(held(piDb.sqlite).find((m) => m.id === travail!.id)!.content, "Jimmy dirige Osmove, SASU de conseil");
});

test("deleted on one computer: gone everywhere, never learned again", async () => {
  const paris = vectors.learned_ids[1].memory_id;
  assert.equal((await app.inject({ method: "DELETE", url: `/memories/${paris}`, headers: local })).statusCode, 204);
  await syncBoth();
  assert.ok(!held(piDb.sqlite).some((m) => m.id === paris));
  assert.ok(!held(sqlite).some((m) => m.id === paris));
  // Learned again, in other words, on either computer: refused.
  assert.equal(rememberFacts(owner, ["J’HABITE À PARIS !"]), 0);
  piDb.sqlite.prepare("INSERT INTO memories (id, user_id, kind, title, content, tags_json, source, created_at, updated_at) VALUES (?, 'pi-owner', 'user', 'Paris', 'J habite a Paris', '[]', 'conversation', 1, 1)").run(paris);
  assert.equal(piVault.record(paris), null);
  assert.ok(!held(piDb.sqlite).some((m) => m.id === paris));
  await syncBoth();
  assert.ok(!held(sqlite).some((m) => m.id === paris));
  assertStreamsApart();
});

test("a tombstone stays here when the account withholds it, across a restart and a full pull", async () => {
  withholdTombstones = true;
  try {
    const [dog] = held(sqlite).filter((m) => m.content === "Le chien s'appelle Pixel");
    assert.equal((await app.inject({ method: "DELETE", url: `/memories/${dog!.id}`, headers: local })).statusCode, 204);
    await syncBoth();
    assert.ok(!held(sqlite).some((m) => m.id === dog!.id), "still deleted here");
    // The Pi never heard of it: a withholding account can do that much.
    assert.ok(held(piDb.sqlite).some((m) => m.id === dog!.id));
    // A new memory vault on the same database (a restart), from the start of the stream.
    sqlite.prepare("DELETE FROM memory_vault_state WHERE key LIKE 'cursor:%'").run();
    const restarted = memoriesVault.createMemoryVault({
      sqlite, owner: () => owner,
      access: () => ({ api: client.accountVaultApi(() => macCreds), userId: String(USER_ID), deviceId: mac.id, epochKeys: new Map(epochs) }),
    });
    const again = await restarted.sync();
    assert.equal(again.status, "synced");
    assert.ok(!held(sqlite).some((m) => m.id === dog!.id));
    assert.ok(restarted.isForgotten("le chien s appelle pixel"));
  } finally {
    withholdTombstones = false;
  }
});

test("the LWW vectors, end to end through the two computers", async () => {
  const reset = () => {
    for (const db of [sqlite, piDb.sqlite]) {
      db.prepare("DELETE FROM memories").run();
      db.prepare("DELETE FROM memory_vault_events").run();
      db.prepare("DELETE FROM memory_vault_state").run();
    }
    fake.events.splice(0, fake.events.length);
  };
  const expectedHere = (s: { expected: { memories: Array<Record<string, any>> } }) =>
    s.expected.memories.map((m) => ({ id: m.id, kind: m.kind, title: m.title, content: m.content, tags: m.tags, source: m.source === "learned" ? "conversation" : m.source, superseded_by: m.superseded_by, hlc: m.hlc }));
  const shape = (rows: Held[]) => rows.map(({ vault_event_id: _v, ...rest }) => rest);

  for (const s of vectors.scenarios) {
    reset();
    // Each computer sends its share, as if it had written it; the Mac first.
    s.events.forEach((e: { event_id: string; payload: unknown }, i: number) => assert.ok((i % 2 === 0 ? macVault : piVault).enqueueRaw(e.event_id, e.payload), s.name));
    await memoriesVault.syncMemories();
    await piVault.sync();
    await memoriesVault.syncMemories();
    assert.deepEqual(shape(held(sqlite)), expectedHere(s), `${s.name} (Mac)`);
    assert.deepEqual(shape(held(piDb.sqlite)), expectedHere(s), `${s.name} (Pi)`);
  }
  assertStreamsApart();
});

test("a conversation turn and the memories never share a stream", async () => {
  const phoneSync = createVaultSync({ api: client.accountVaultApi(() => phoneCreds), epochKeys: () => epochs, userId: USER_ID, store: memoryStore() });
  await phoneSync.recordTurn("0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e", { ref: "q1", text: "Bonjour", reply: "Bonjour !" });
  await phoneSync.flush();
  await syncBoth();
  assert.ok(fake.events.some((e) => e.stream === "conversations" && e.kind === "turn"));
  assert.ok(fake.events.some((e) => e.stream === "memories"));
  assertStreamsApart();
  // The conversations sync reads its stream only: no memory there.
  await phoneSync.pull();
  assert.deepEqual((await phoneSync.conversations()).map((c) => c.id), ["0b1c2d3e-4f5a-4b6c-8d7e-9f0a1b2c3d4e"]);
});

test.after(() => service.resetVaultForTests());
