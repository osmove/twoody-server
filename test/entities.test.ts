import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Mémoire v2, lot L2 (docs/memory-v2-design.md §2): the people, projects and
// places of the person's memories — /entities, their aliases and
// relations, « Fusionner » — and the links from each memory to the
// entities it names, by name, alias or a kinship phrase of the person's
// (« ma femme » → the relation « épouse » from their own entity). Like the
// memories, the person's only: the owner or one of their own devices.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-entities-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";
delete process.env.TWOODY_EMBEDDING_BINARY;
delete process.env.TWOODY_EMBEDDING_MODEL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { pairDevice } = await import("../src/pairing.js");
const { sqlite } = await import("../src/db.js");
const { KINSHIP, kinshipIn, normaliseName, entitiesInText } = await import("../src/memory/entities.js");
const { flushMemoryWork } = await import("../src/memory/changes.js");

const app = await buildApp();
test.after(() => app.close());

const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;

const post = (entity: unknown) => app.inject({ method: "POST", url: "/api/v1/entities", headers, payload: { entity } });
const get = async (id: string) => (await app.inject({ url: `/api/v1/entities/${id}`, headers })).json();
const memory = async (content: string) => (await app.inject({ method: "POST", url: "/api/v1/memories", headers, payload: { memory: { content } } })).json().id as string;

test("the kinship lexicon: about forty phrases of the person's own, French and English", () => {
  const own = [...KINSHIP.keys()].filter((phrase) => /^(ma|mon|mes|my|maman|papa|mamie|papi|chez) /.test(`${phrase} `));
  assert.ok(own.length >= 40, `${own.length} phrases`);
  assert.equal(normaliseName("Ma Belle-Sœur"), "ma belle soeur");
  const labels = (text: string) => kinshipIn(text).flatMap((k) => [...k.labels]);
  assert.ok(labels("Ma femme adore le jazz").includes("epouse"));
  assert.ok(labels("My wife loves jazz").includes("epouse"));
  assert.ok(labels("Notre fille entre en sixième").includes("fille"));
  assert.ok(labels("mon beau-frère Karim").includes("beau frere"));
  assert.deepEqual(labels("La femme du boulanger"), [], "only the person's own: « ma », « mon », « my »…");
  assert.deepEqual(labels("Mamiexpress livre demain"), [], "whole words only");
});

test("create, read, update, delete; a relation to a name not there yet is filled in when it comes", async () => {
  const self = await post({ kind: "self", name: "Mathieu Garnier", aliases: ["Mathieu", "Mat"], relations: [{ to: "Élodie Garnier", label: "épouse" }, { to: "Léa Garnier", label: "fille" }] });
  assert.equal(self.statusCode, 201, self.body);
  const me = self.json().entity;
  assert.deepEqual(me.aliases, ["Mathieu", "Mat"]);
  assert.deepEqual(me.relations.map((r: { to_name: string; label: string }) => [r.to_name, r.label]), [["Élodie Garnier", "épouse"], ["Léa Garnier", "fille"]]);
  const stubId = me.relations[0].to;
  assert.equal((await get(stubId)).source, "stub");

  // Élodie, written in turn: the same entity, filled in.
  const elodie = await post({ kind: "person", name: "Élodie Garnier", aliases: ["Élo", "Élodie Roux"], note: "née Roux" });
  assert.equal(elodie.statusCode, 200, "the stub, filled in");
  assert.equal(elodie.json().entity.id, stubId);
  assert.equal(elodie.json().entity.source, "manual");
  assert.deepEqual(elodie.json().entity.related_from.map((r: { from_name: string; label: string }) => [r.from_name, r.label]), [["Mathieu Garnier", "épouse"]]);

  // The same name twice, a second « self »: refused.
  const twice = await post({ name: "elodie garnier" });
  assert.equal(twice.statusCode, 409);
  assert.deepEqual(twice.json(), { error: "name_taken", entity_id: stubId });
  assert.equal((await post({ kind: "self", name: "Moi" })).json().error, "self_exists");
  for (const bad of [{ name: "" }, { name: "X", kind: "alien" }, { name: "X", aliases: [42] }, { name: "X", relations: [{ to: "Y" }] }]) {
    assert.equal((await post(bad)).statusCode, 422, JSON.stringify(bad));
  }

  // PATCH: the fields given; aliases replaced whole.
  const patched = await app.inject({ method: "PATCH", url: `/api/v1/entities/${stubId}`, headers, payload: { entity: { aliases: ["Élo"], note: null } } });
  assert.equal(patched.statusCode, 200, patched.body);
  assert.deepEqual(patched.json().entity.aliases, ["Élo"]);
  assert.equal(patched.json().entity.note, null);
  assert.equal(patched.json().entity.name, "Élodie Garnier");

  const list = (await app.inject({ url: "/api/v1/entities", headers })).json() as Array<{ name: string; kind: string }>;
  assert.equal(list[0].kind, "self", "the person's own entity first");
  assert.deepEqual(list.map((e) => e.name).sort(), ["Léa Garnier", "Mathieu Garnier", "Élodie Garnier"].sort());

  const lea = list.find((e) => e.name === "Léa Garnier") as unknown as { id: string };
  assert.equal((await app.inject({ method: "DELETE", url: `/api/v1/entities/${lea.id}`, headers })).statusCode, 204);
  assert.equal((await app.inject({ url: `/api/v1/entities/${lea.id}`, headers })).statusCode, 404);
  assert.deepEqual((await get(me.id)).relations.map((r: { label: string }) => r.label), ["épouse"], "its relations went with it");
});

test("memories are linked to the entities they name: by name, alias, or « ma femme »", async () => {
  const [self] = (await app.inject({ url: "/api/v1/entities", headers })).json() as Array<{ id: string }>;
  const elodie = ((await app.inject({ url: "/api/v1/entities", headers })).json() as Array<{ id: string; name: string }>).find((e) => e.name === "Élodie Garnier")!;
  const byKinship = await memory("Ma femme est allergique aux noix.");
  const byAlias = await memory("Élo commence un nouveau travail en janvier.");
  const none = await memory("La femme du boulanger vend des croissants.");
  await flushMemoryWork();
  const ids = (await get(elodie.id)).memory_ids as string[];
  assert.ok(ids.includes(byKinship), "« ma femme » is the person's « épouse »");
  assert.ok(ids.includes(byAlias), "« Élo » is one of her names");
  assert.ok(!ids.includes(none));
  const how = sqlite.prepare("SELECT memory_id, how FROM memory_entities WHERE entity_id = ?").all(elodie.id) as Array<{ memory_id: string; how: string }>;
  assert.equal(how.find((r) => r.memory_id === byKinship)?.how, "kinship");
  assert.equal(how.find((r) => r.memory_id === byAlias)?.how, "alias");
  // A message is read the same way (what retrieval will expand).
  assert.deepEqual(entitiesInText(userId, "Qu'est-ce que Mat offre à sa femme ?").map((l) => l.entity_id), [self.id]);
  assert.deepEqual(entitiesInText(userId, "Qu'offrir à ma femme ?").map((l) => l.entity_id), [elodie.id]);
  // An entity written after the memory links it too.
  const pilou = await memory("Pilou a ses vaccins en mars.");
  const dog = (await post({ kind: "pet", name: "Pilou" })).json().entity;
  assert.deepEqual((await get(dog.id)).memory_ids, [pilou]);
});

test("« Fusionner »: names become aliases, relations and memories move, the merged one points to the other", async () => {
  const leo = (await post({ kind: "person", name: "Léo", relations: [{ to: "Élodie Garnier", label: "cousin" }] })).json().entity;
  const leonard = (await post({ kind: "person", name: "Léonard Petit", aliases: ["Nono"] })).json().entity;
  const m = await memory("Léo vient dîner samedi.");
  await flushMemoryWork();
  const merged = await app.inject({ method: "POST", url: `/api/v1/entities/${leo.id}/merge`, headers, payload: { into: leonard.id } });
  assert.equal(merged.statusCode, 200, merged.body);
  const into = merged.json().entity;
  assert.deepEqual(into.aliases.sort(), ["Léo", "Nono"]);
  assert.deepEqual(into.relations.map((r: { to_name: string; label: string }) => [r.to_name, r.label]), [["Élodie Garnier", "cousin"]]);
  assert.ok((await get(leonard.id)).memory_ids.includes(m), "the memory naming « Léo » is linked to Léonard now");
  // The merged one: out of the list, and its id leads to the other.
  const list = (await app.inject({ url: "/api/v1/entities", headers })).json() as Array<{ id: string }>;
  assert.ok(!list.some((e) => e.id === leo.id));
  assert.equal((await get(leo.id)).id, leonard.id);
  assert.ok(((await app.inject({ url: "/api/v1/entities?include_merged=1", headers })).json() as Array<{ id: string; merged_into: string | null }>).some((e) => e.id === leo.id && e.merged_into === leonard.id));
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/entities/${leonard.id}/merge`, headers, payload: { into: leonard.id } })).statusCode, 422);
  assert.equal((await app.inject({ method: "POST", url: `/api/v1/entities/${leonard.id}/merge`, headers, payload: { into: "nope" } })).statusCode, 404);
});

test("a household member's phone, a device paired by code or one the console approved: no entities", async () => {
  const [any] = (await app.inject({ url: "/api/v1/entities", headers })).json() as Array<{ id: string }>;
  const tunnel = { "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": "ab".repeat(32) };
  const others = [
    pairDevice({ deviceName: "iPhone de Claire", tunnelPublicKey: "ab".repeat(32), origin: "account", approvalRule: "endorsed" }),
    pairDevice({ deviceName: "iPad de la cuisine", origin: "code" }),
    pairDevice({ deviceName: "Appareil", tunnelPublicKey: "ab".repeat(32), origin: "account", approvalRule: "console" }),
  ];
  const before = sqlite.prepare("SELECT COUNT(*) AS n FROM entities").get() as { n: number };
  for (const session of others) {
    const h = { authorization: `Bearer ${session.token}`, ...tunnel };
    for (const [method, url, payload] of [
      ["GET", "/api/v1/entities", undefined],
      ["GET", `/api/v1/entities/${any.id}`, undefined],
      ["POST", "/api/v1/entities", { entity: { name: "Planted" } }],
      ["PATCH", `/api/v1/entities/${any.id}`, { entity: { name: "Overwritten" } }],
      ["DELETE", `/api/v1/entities/${any.id}`, undefined],
      ["POST", `/api/v1/entities/${any.id}/merge`, { into: any.id }],
    ] as const) {
      const res = await app.inject({ method, url, headers: h, ...(payload ? { payload } : {}) });
      assert.equal(res.statusCode, 403, `${method} ${url} ${res.body}`);
      assert.deepEqual(res.json(), { error: "person_device_required" });
    }
  }
  assert.deepEqual(sqlite.prepare("SELECT COUNT(*) AS n FROM entities").get(), before);
});
