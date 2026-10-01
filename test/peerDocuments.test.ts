import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, isAbsolute, join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";
import { validate } from "./helpers/jsonSchema.js";

// This computer's documents for the account's other computers it trusts
// (docs/mesh-design.md §2, lot S3): who may ask, what leaves (never an
// absolute path), which folders a search sees, the file itself with Range
// and its caps, 30 requests a minute, and the audit the owner sees.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-peer-documents-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken, generateToken, generateId, sha256 } = await import("../src/auth.js");
const { pairDevice, ensureLocalUser } = await import("../src/pairing.js");
const { accountPeers, db, devices, sqlite } = await import("../src/db.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { retrieveDocuments, scopedFolders } = await import("../src/documents/retrieval.js");
const { beginGeneration } = await import("../src/account/inflight.js");
const { setSemantic } = await import("../src/documents/semantic.js");
const { parseRange, RELAY_RAW_CAP, LAN_RAW_CAP } = await import("../src/peerDocuments/raw.js");
const { setTrustCheck } = await import("../src/peerDocuments/trust.js");
const { setDesktopAccount } = await import("../src/account/service.js");

// This computer in the account (a UUID, as account_computers ids are): what
// every source is named after. Without an account nobody is trusted.
const SELF = "9f3d5b72-4c6e-4a8f-8b2d-3e5f7a9b1c22";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: SELF, computerName: "Mac" });

// The P0 contract (test/fixtures/peer-documents-search.schema.json): every
// search answer and error below is checked against it once it is there.
const schemaPath = new URL("./fixtures/peer-documents-search.schema.json", import.meta.url);
const contract = existsSync(schemaPath) ? JSON.parse(readFileSync(schemaPath, "utf8")) : null;
function fits(definition: "request" | "response" | "error", value: unknown, label = "") {
  if (!contract) return;
  assert.deepEqual(validate(contract.definitions[definition], value, contract), [], `${definition} ${label}: ${JSON.stringify(value).slice(0, 2000)}`);
}

// Real files must sit where folderRisk lets a folder be granted: on a Mac
// the temporary directory is under /private/var, which it refuses.
const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const root = realpathSync(mkdtempSync(join(base, "twoody-peer-docs-test-")));

const app = await buildApp();
await app.ready();
test.after(async () => {
  await app.close();
  if (process.platform === "darwin") {
    const trash = join(homedir(), ".Trash");
    mkdirSync(trash, { recursive: true });
    renameSync(root, join(trash, basename(root)));
  } else rmSync(root, { recursive: true, force: true });
});

const owner = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const user = ensureLocalUser();

// ── fixtures ────────────────────────────────────────────────────────────────

const contracts = join(root, "Contrats");
const nested = join(contracts, "Clients");
const invoices = join(root, "Factures");
for (const dir of [contracts, nested, invoices]) mkdirSync(dir, { recursive: true });
const outside = join(root, "Ailleurs");
mkdirSync(outside);
writeFileSync(join(outside, "secret.txt"), "hors du dossier accordé");

function grant(id: string, path: string) {
  sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run(id, user.id, path, Date.now());
}
function indexDoc(id: string, folderId: string, path: string, texts: string[], bytes?: Buffer) {
  if (bytes) writeFileSync(path, bytes);
  else if (!existsSync(path)) writeFileSync(path, texts.join("\n"));
  const name = basename(path);
  sqlite
    .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run(id, user.id, folderId, path, name, name.slice(name.lastIndexOf(".")), 100, 1_750_000_000_000, "indexed", texts.join("").length);
  texts.forEach((text, i) => sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run(id, user.id, i + 1, i, text));
}

grant("f-contracts", contracts);
grant("f-nested", nested);
grant("f-invoices", invoices);
// Granted before folderRisk refused it: never served, whatever the caller asks.
grant("f-risky", "/etc/twoody-grant");

indexDoc("bail", "f-contracts", join(contracts, "bail-appartement.txt"), ["Contrat de bail : loyer mensuel de 900 euros, préavis de trois mois.", "Le locataire paie le loyer le premier du mois."]);
indexDoc("client", "f-nested", join(nested, "contrat-client-dupont.txt"), ["Contrat client Dupont : prestation de conseil, loyer du matériel inclus."]);
indexDoc("facture", "f-invoices", join(invoices, "facture-2026-09.txt"), ["Facture de septembre : loyer du bureau 1200 euros."]);
sqlite
  .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("risky", user.id, "f-risky", "/etc/twoody-grant/passwd-loyer.txt", "passwd-loyer.txt", ".txt", 10, 1, "indexed", 10);
sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run("risky", user.id, 1, 0, "loyer secret du système");

const pdfBytes = Buffer.alloc(100_000);
for (let i = 0; i < pdfBytes.length; i++) pdfBytes[i] = (i * 31 + 7) % 256;
indexDoc("scan", "f-contracts", join(contracts, "scan-bail.pdf"), ["Scan du bail signé, loyer."], pdfBytes);

// ── who asks ────────────────────────────────────────────────────────────────

// Who is trusted is the vault roster's business (lot S2, vault/roster.ts,
// test/meshRoster.test.ts); here a stand-in for it: the computers in
// `inRoster`, through the one replaceable check the routes ask.
const inRoster = new Set<string>();
const rosterStandIn = async (id: string) => inRoster.has(id);
setTrustCheck(rosterStandIn);

/// What the tunnel puts on every request it serves (tunnel/host.ts): its
/// marker and the key of the device at the other end.
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });

function peer(computerId: string | null, trusted: boolean | null, state = "linked", options: { plain?: boolean } = {}) {
  const tunnelKey = randomBytes(32).toString("hex");
  const session = pairDevice({ deviceName: `Computer ${computerId}`, role: "peer", origin: "account", requesterComputerId: computerId, tunnelPublicKey: tunnelKey });
  if (computerId && trusted !== null) {
    const now = new Date();
    db.insert(accountPeers)
      .values({ computerId, userId: user.id, name: `Computer ${computerId}`, state, trusted, enabled: true, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: accountPeers.computerId, set: { trusted, state, updatedAt: now } })
      .run();
    // Removed from the account: not in the roster either.
    if (trusted && state === "linked") inRoster.add(computerId);
    else inRoster.delete(computerId);
  }
  return { authorization: `Bearer ${session.token}`, ...(options.plain ? {} : sealedFrom(tunnelKey)) };
}

let trustedCount = 0;
/// A fresh trusted computer (its own rate-limit budget).
function trustedPeer() {
  trustedCount += 1;
  return peer(String(4000 + trustedCount), true);
}

async function search(headers: Record<string, string>, body: Record<string, unknown>) {
  const response = await app.inject({ method: "POST", url: "/api/v1/peer/documents/search", headers, payload: { q: "loyer", scope: { mode: "all" }, ...body } });
  if (response.statusCode === 200) fits("response", response.json(), JSON.stringify(body));
  else if (response.statusCode !== 401) fits("error", response.json(), `${response.statusCode}`);
  return response;
}

// ── authorization ───────────────────────────────────────────────────────────

test("a trusted computer's peer session searches; an untrusted, removed or unknown one is 403", async () => {
  const trusted = peer("41", true);
  const ok = await search(trusted, {});
  assert.equal(ok.statusCode, 200, ok.body);
  assert.ok(ok.json().passages.length > 0);

  for (const [who, headers] of [
    ["untrusted", peer("42", false)],
    ["removed from the account", peer("43", true, "removed")],
    ["unknown to this computer", peer("44", null)],
    ["a peer session with no computer id", peer(null, null)],
  ] as const) {
    const refused = await search(headers, {});
    assert.equal(refused.statusCode, 403, who);
    assert.deepEqual(refused.json(), { error: "not_trusted" }, who);
    for (const url of ["/api/v1/peer/documents/folders", "/api/v1/peer/documents/files/bail", "/api/v1/peer/documents/files/scan/raw"]) {
      assert.equal((await app.inject({ url, headers })).statusCode, 403, `${who} ${url}`);
    }
    const listed = await app.inject({ method: "POST", url: "/api/v1/peer/documents/list", headers, payload: { folder: "downloads", scope: { mode: "all" } } });
    assert.equal(listed.statusCode, 403, `${who} list`);
  }
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/peer/documents/search", payload: { q: "loyer", scope: { mode: "all" } } })).statusCode, 401);
});

test("a trusted computer's peer token over plain HTTP, or through another key's tunnel, reaches nothing", async () => {
  const plain = peer("47", true, "linked", { plain: true });
  const refused = await search(plain, {});
  assert.equal(refused.statusCode, 403, "no tunnel: a sniffed or replayed peer token");
  assert.deepEqual(refused.json(), { error: "not_trusted" });
  const other = randomBytes(32).toString("hex");
  assert.equal((await search({ ...plain, ...sealedFrom(other) }, {})).statusCode, 403, "the tunnel of another key");
  // The tunnel's stamp typed by someone on the network is no tunnel.
  const typed = await app.inject({ method: "POST", url: "/api/v1/peer/documents/search", headers: peer("48", true), remoteAddress: "192.168.1.30", payload: { q: "loyer", scope: { mode: "all" } } });
  assert.equal(typed.statusCode, 403);
  for (const url of ["/api/v1/peer/documents/folders", "/api/v1/peer/documents/files/bail", "/api/v1/peer/documents/files/scan/raw"]) {
    assert.equal((await app.inject({ url, headers: plain })).statusCode, 403, url);
  }
  assert.equal((await search(peer("49", true), {})).statusCode, 200, "the same, through its own tunnel");
});

test("trust is switched off (the computer leaves the roster): 403 from the next request on", async () => {
  const headers = peer("45", true);
  assert.equal((await search(headers, {})).statusCode, 200);
  inRoster.delete("45");
  assert.equal((await search(headers, {})).statusCode, 403);
});

test("the trust check is one replaceable function (lot S2 puts the vault roster there)", async () => {
  const headers = peer("46", false);
  assert.equal((await search(headers, {})).statusCode, 403);
  setTrustCheck(async (id) => id === "46");
  try {
    assert.equal((await search(headers, {})).statusCode, 200);
    assert.equal((await search(trustedPeer(), {})).statusCode, 403, "the roster, not account_peers, decides then");
  } finally {
    setTrustCheck(rosterStandIn);
  }
  // Put back, it is the verified vault roster: no vault here, nobody —
  // whatever account_peers.trusted says.
  setTrustCheck(null);
  try {
    assert.equal((await search(trustedPeer(), {})).statusCode, 403);
  } finally {
    setTrustCheck(rosterStandIn);
  }
});

test("device sessions: the phone and the Desktop are not computers here, a firmware token is never a session", async () => {
  const phone = { authorization: `Bearer ${pairDevice({ deviceName: "iPhone", role: "device", origin: "code" }).token}` };
  const deviceGivenToComputer = { authorization: `Bearer ${pairDevice({ deviceName: "Mac", role: "device", origin: "account", requesterComputerId: "41" }).token}` };
  const firmwareToken = generateToken();
  db.insert(devices).values({ id: generateId(), userId: user.id, name: "Enceinte", tokenDigest: sha256(firmwareToken), createdAt: new Date() }).run();
  const firmware = { authorization: `Bearer ${firmwareToken}` };
  const desktop = { authorization: `Bearer ${owner.token}` };

  for (const [who, headers] of [["phone", phone], ["device session of computer 41", deviceGivenToComputer], ["firmware", firmware], ["Desktop", desktop]] as const) {
    const refused = await search(headers, {});
    assert.equal(refused.statusCode, 403, who);
    assert.deepEqual(refused.json(), { error: "not_trusted" }, who);
  }

  // The file itself for the phone or the Desktop: /local_documents/…/raw,
  // a person's session only.
  for (const headers of [phone, desktop]) {
    const raw = await app.inject({ url: "/api/v1/local_documents/files/scan/raw", headers });
    assert.equal(raw.statusCode, 200);
    assert.deepEqual(raw.rawPayload, pdfBytes);
  }
  assert.equal((await app.inject({ url: "/local_documents/files/scan/raw", headers: phone })).statusCode, 200, "at the root too");
  assert.equal((await app.inject({ url: "/api/v1/local_documents/files/scan/raw", headers: firmware })).statusCode, 403);
  assert.equal((await app.inject({ url: "/api/v1/local_documents/files/scan/raw" })).statusCode, 401);
  assert.equal((await app.inject({ url: "/api/v1/local_documents/files/scan/raw", headers: trustedPeer() })).statusCode, 403, "a peer session stays in /api/v1/peer/*");
  assert.equal((await app.inject({ url: "/api/v1/local_documents/files/risky/raw", headers: phone })).statusCode, 404, "folderRisk here too");
});

// ── what leaves ─────────────────────────────────────────────────────────────

test("a search answers the contract's shape: source ids, folder names, paths inside the grant, ranks", async () => {
  const response = await search(trustedPeer(), { q: "contrat client Dupont", limit: 8 });
  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.deepEqual(Object.keys(body).sort(), ["computer_id", "embed_model", "files", "index", "passages", "took_ms"]);
  assert.equal(body.computer_id, SELF);
  assert.equal(typeof body.took_ms, "number");
  assert.deepEqual(body.index, { documents: 4, pending: 0, semantic: "unavailable" }, "indexed documents in scope, not the risky grant's");
  assert.equal(body.embed_model, null);
  const client = body.passages.find((p: { document_id: string }) => p.document_id === "client");
  assert.ok(client, JSON.stringify(body.passages));
  assert.equal(client.source_id, `${SELF}:client`);
  assert.equal(client.folder, "Clients");
  assert.equal(client.rel_path, "contrat-client-dupont.txt");
  assert.equal(client.path, undefined);
  body.passages.forEach((p: { rank: number }, i: number) => assert.equal(p.rank, i + 1));
  assert.ok(body.files.length <= 20);
  for (const file of body.files) {
    assert.deepEqual(Object.keys(file).sort(), ["chars", "document_id", "folder", "modified_at", "name", "rel_path", "source_id"]);
    assert.equal(file.source_id, `${SELF}:${file.document_id}`);
  }

  const folders = (await app.inject({ url: "/api/v1/peer/documents/folders", headers: trustedPeer() })).json();
  assert.deepEqual(folders.folders.map((f: { name: string }) => f.name).sort(), ["Clients", "Contrats", "Factures"]);
  for (const folder of folders.folders) assert.deepEqual(Object.keys(folder).sort(), ["documents", "id", "indexed", "name"]);

  const read = (await app.inject({ url: "/api/v1/peer/documents/files/client", headers: trustedPeer() })).json();
  assert.equal(read.file.folder, "Clients");
  assert.equal(read.file.rel_path, "contrat-client-dupont.txt");
  assert.equal(read.passages.length, 1);
  assert.equal(read.next_offset, null);
});

test("limit, budget_chars and deadline_ms are kept; a body outside the contract is 400 bad_request, an unknown field too", async () => {
  // Long passages, so that the budget bites.
  indexDoc("long", "f-invoices", join(invoices, "releve-loyers.txt"), Array.from({ length: 4 }, (_, i) => `Relevé ${i} des loyers : ${"loyer payé en temps et en heure. ".repeat(12)}`));
  const headers = trustedPeer();
  const one = (await search(headers, { q: "relevé loyers", limit: 1 })).json();
  assert.equal(one.passages.length, 1);
  const budgeted = (await search(headers, { q: "relevé loyers payé", limit: 8, budget_chars: 200 })).json();
  const total = budgeted.passages.reduce((n: number, p: { text: string }) => n + p.text.length, 0);
  assert.ok(total <= 200 && budgeted.passages.length >= 1, String(total));
  const defaults = (await search(headers, { q: "relevé loyers payé", limit: 8 })).json();
  assert.ok(defaults.passages.reduce((n: number, p: { text: string }) => n + p.text.length, 0) <= 6000, "6000 by default");
  for (const bad of [
    { limit: 9 }, { limit: 0 }, { budget_chars: 10_001 }, { budget_chars: 199 }, { deadline_ms: 3001 }, { deadline_ms: 99 },
    { scope: { mode: "everything" } }, { scope: { mode: "off" } }, { scope: { mode: "selected" } }, { scope: { mode: "selected", folder_ids: [] } },
    { scope: { mode: "selected", folder_ids: ["f-invoices", "f-invoices"] } }, { scope: { mode: "selected", folder_ids: ["../f-contracts"] } },
    { scope: { mode: "all", folder_ids: ["f-invoices"] } }, { scope: { mode: "all", extra: 1 } },
    { q: "" }, { q: "x".repeat(2001) }, { requester_computer_id: "41" }, { computer_id: SELF },
  ]) {
    const refused = await search(headers, bad);
    assert.equal(refused.statusCode, 400, JSON.stringify(bad));
    assert.deepEqual(refused.json(), { error: "bad_request" });
  }
  sqlite.prepare("DELETE FROM document_chunks WHERE document_id='long'").run();
  sqlite.prepare("DELETE FROM documents WHERE id='long'").run();
});

test("a computer that shares no folder says documents_off", async () => {
  sqlite.prepare("INSERT OR IGNORE INTO users(id,email,created_at) VALUES('elsewhere','elsewhere@test.invalid',?)").run(Date.now());
  sqlite.prepare("UPDATE document_folders SET user_id='elsewhere' WHERE user_id=?").run(user.id);
  try {
    const off = await search(trustedPeer(), {});
    assert.equal(off.statusCode, 403);
    assert.deepEqual(off.json(), { error: "documents_off" });
  } finally {
    sqlite.prepare("UPDATE document_folders SET user_id=? WHERE user_id='elsewhere'").run(user.id);
  }
});

// Deterministic generator, so a failure can be replayed.
function prng(seed: number) {
  return () => {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
}

test("property: no response of the peer document API carries an absolute path", async () => {
  // Deeper and odder names, created for this test.
  const deep = join(invoices, "2026", "Q3 — été");
  mkdirSync(deep, { recursive: true });
  indexDoc("deep", "f-invoices", join(deep, "reçu loyer #3.txt"), ["Reçu de loyer du trimestre, payé."]);

  const absolute = [root, home, contracts, nested, invoices, deep, "/etc/twoody-grant"];
  const words = ["loyer", "contrat", "facture", "Dupont", "bail", "reçu", "préavis", "résume-le", "ce document", "dossiers accès", "Contrats", "2026"];
  const folderIds = ["f-contracts", "f-nested", "f-invoices", "f-risky", "foreign"];
  const random = prng(20260930);
  const pick = <T,>(list: T[]) => list[Math.floor(random() * list.length)]!;
  const offenders = (value: unknown, at = "$"): string[] => {
    if (typeof value === "string") {
      const bad = isAbsolute(value) || /^[A-Za-z]:[\\/]/.test(value) || absolute.some((path) => value.includes(path));
      return bad ? [`${at}: ${value}`] : [];
    }
    if (Array.isArray(value)) return value.flatMap((v, i) => offenders(v, `${at}[${i}]`));
    if (value && typeof value === "object") return Object.entries(value).flatMap(([k, v]) => [...(isAbsolute(k) ? [`${at} key ${k}`] : []), ...offenders(v, `${at}.${k}`)]);
    return [];
  };

  const ids = new Set<string>();
  let headers = trustedPeer();
  for (let run = 0; run < 60; run++) {
    if (run % 20 === 19) headers = trustedPeer();
    const q = Array.from({ length: 1 + Math.floor(random() * 3) }, () => pick(words)).join(" ");
    const mode = pick(["all", "selected"] as const);
    const chosen = folderIds.filter(() => random() < 0.5);
    const scope = mode === "all" ? { mode } : { mode, folder_ids: chosen.length ? chosen : [pick(folderIds)] };
    const body = { q, scope, limit: 1 + Math.floor(random() * 8), budget_chars: 200 + Math.floor(random() * 9_801), ...(random() < 0.5 ? { hint: pick(words) } : {}) };
    fits("request", body);
    const response = await search(headers, body);
    assert.equal(response.statusCode, 200, `${JSON.stringify(body)} → ${response.body}`);
    assert.deepEqual(offenders(response.json()), [], JSON.stringify(body));
    for (const p of response.json().passages) ids.add(p.document_id);
    for (const f of response.json().files) ids.add(f.document_id);
  }
  assert.ok(ids.has("deep"), "the generator reached the nested document");
  assert.ok(!ids.has("risky"), "never the folder folderRisk refuses");

  // A file listing: names and folders from the grant, never a path.
  for (const body of [{ scope: { mode: "all" } }, { folder: "home", scope: { mode: "all" } }, { folder_name: "2026", scope: { mode: "all" } }, { scope: { mode: "selected", folder_ids: ["f-risky", "f-invoices"] } }]) {
    const response = await app.inject({ method: "POST", url: "/api/v1/peer/documents/list", headers: trustedPeer(), payload: body });
    assert.equal(response.statusCode, 200, `${JSON.stringify(body)} → ${response.body}`);
    assert.deepEqual(offenders(response.json()), [], JSON.stringify(body));
  }
  const unknownField = await app.inject({ method: "POST", url: "/api/v1/peer/documents/list", headers: trustedPeer(), payload: { path: "/etc", scope: { mode: "all" } } });
  assert.equal(unknownField.statusCode, 400);

  for (const id of [...ids, "risky", "unknown"]) {
    const headers = trustedPeer();
    for (const url of [`/api/v1/peer/documents/files/${encodeURIComponent(id)}`, `/api/v1/peer/documents/files/${encodeURIComponent(id)}?offset=20`, "/api/v1/peer/documents/folders"]) {
      const response = await app.inject({ url, headers });
      assert.deepEqual(offenders(response.json()), [], url);
    }
  }
});

// ── scope ───────────────────────────────────────────────────────────────────

test("the caller's scope meets this computer's grants: selected folders and those nested in them, never a foreign id or a risky grant", async () => {
  const docsOf = async (scope: Record<string, unknown>) =>
    new Set<string>((await search(trustedPeer(), { q: "loyer contrat facture", limit: 8, scope })).json().passages.map((p: { document_id: string }) => p.document_id));

  const all = await docsOf({ mode: "all" });
  assert.ok(all.has("bail") && all.has("facture"));
  assert.ok(!all.has("risky"));
  assert.deepEqual(await docsOf({ mode: "selected", folder_ids: ["foreign"] }), new Set());
  assert.deepEqual(await docsOf({ mode: "selected", folder_ids: ["f-risky"] }), new Set());
  const invoicesOnly = await docsOf({ mode: "selected", folder_ids: ["f-invoices", "foreign"] });
  assert.ok(invoicesOnly.has("facture"));
  assert.ok(!invoicesOnly.has("bail") && !invoicesOnly.has("client"));
  const contractsTree = await docsOf({ mode: "selected", folder_ids: ["f-contracts"] });
  assert.ok(contractsTree.has("client"), "a nested grant comes with its parent");
  assert.ok(!contractsTree.has("facture"));

  assert.deepEqual(scopedFolders(user.id, { mode: "all" }).map((f) => f.id).sort(), ["f-contracts", "f-invoices", "f-nested"]);
  assert.deepEqual(scopedFolders(user.id, { mode: "selected", folderIds: ["f-nested"] }).map((f) => f.id), ["f-nested"]);
});

test("retrieveDocuments with absolutePaths:false says folder and rel_path, never path", async () => {
  const found = await retrieveDocuments(user.id, "contrat client Dupont", [], ["f-contracts", "f-nested"], { absolutePaths: false });
  assert.ok(found.passages.length > 0);
  for (const passage of found.passages) {
    assert.equal("path" in passage, false);
    assert.ok(!isAbsolute(passage.rel_path));
  }
  const withPaths = await retrieveDocuments(user.id, "contrat client Dupont", [], ["f-contracts", "f-nested"]);
  assert.ok(withPaths.passages.every((p) => isAbsolute(p.path)), "the local default is unchanged");
});

test("the semantic half: used, skipped while this computer generates, given up at the deadline, unavailable", async () => {
  const headers = trustedPeer();
  assert.equal((await search(headers, {})).json().index.semantic, "unavailable", "switched off");
  // « Available » needs the embedding files to exist; these are not
  // runnable, so the embedding fails fast and the lexical half answers.
  const fixture = new URL("./fixtures/contrat-dupont.txt", import.meta.url).pathname;
  process.env.TWOODY_EMBEDDING_BINARY = fixture;
  process.env.TWOODY_EMBEDDING_MODEL = fixture;
  setSemantic(user.id, true);
  try {
    const idle = (await search(headers, { q: "bail loyer préavis" })).json();
    assert.equal(idle.index.semantic, "used");
    assert.equal(typeof idle.embed_model, "string");
    const late = (await search(headers, { q: "bail loyer préavis", deadline_ms: 100 })).json();
    assert.equal(late.index.semantic, "skipped_deadline");
    assert.equal(late.embed_model, null);
    assert.ok(late.passages.length > 0, "the lexical half still answers");
    const done = beginGeneration("chat");
    try {
      const busy = (await search(headers, { q: "bail loyer préavis" })).json();
      assert.equal(busy.index.semantic, "skipped_generating");
      assert.equal(busy.embed_model, null);
      assert.ok(busy.passages.length > 0, "the lexical half still answers");
    } finally {
      done();
    }
  } finally {
    setSemantic(user.id, false);
    delete process.env.TWOODY_EMBEDDING_BINARY;
    delete process.env.TWOODY_EMBEDDING_MODEL;
  }
});

// ── the file itself ─────────────────────────────────────────────────────────

test("raw: whole file, Range, suffix, past the end, and the file's own headers", async () => {
  const headers = trustedPeer();
  const url = "/api/v1/peer/documents/files/scan/raw";
  const whole = await app.inject({ url, headers });
  assert.equal(whole.statusCode, 200);
  assert.deepEqual(whole.rawPayload, pdfBytes);
  assert.equal(whole.headers["content-type"], "application/pdf");
  assert.equal(whole.headers["accept-ranges"], "bytes");
  assert.equal(whole.headers["x-content-type-options"], "nosniff");
  assert.match(String(whole.headers["content-disposition"]), /filename\*=UTF-8''scan-bail\.pdf/);

  const part = await app.inject({ url, headers: { ...headers, range: "bytes=10-19" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.headers["content-range"], `bytes 10-19/${pdfBytes.length}`);
  assert.deepEqual(part.rawPayload, pdfBytes.subarray(10, 20));

  const tail = await app.inject({ url, headers: { ...headers, range: "bytes=-5" } });
  assert.equal(tail.statusCode, 206);
  assert.deepEqual(tail.rawPayload, pdfBytes.subarray(pdfBytes.length - 5));

  const open = await app.inject({ url, headers: { ...headers, range: `bytes=${pdfBytes.length - 3}-` } });
  assert.deepEqual(open.rawPayload, pdfBytes.subarray(pdfBytes.length - 3));

  const past = await app.inject({ url, headers: { ...headers, range: `bytes=${pdfBytes.length}-` } });
  assert.equal(past.statusCode, 416);
  assert.equal(past.headers["content-range"], `bytes */${pdfBytes.length}`);

  assert.equal((await app.inject({ url: "/api/v1/peer/documents/files/risky/raw", headers })).statusCode, 404);
  assert.equal((await app.inject({ url: "/api/v1/peer/documents/files/nothing/raw", headers })).statusCode, 404);

  assert.deepEqual(parseRange("bytes=0-0", 10), { start: 0, end: 0 });
  assert.deepEqual(parseRange("bytes=5-100", 10), { start: 5, end: 9 });
  assert.equal(parseRange("bytes=0-1,4-5", 10), null, "several ranges: the whole file");
  assert.equal(parseRange("items=0-1", 10), null);
  assert.equal(parseRange("bytes=5-2", 10), null);
  assert.equal(parseRange("bytes=-0", 10), "unsatisfiable");
});

test("raw: 25 MB an answer through the relay, 32 MB on the local network", async () => {
  const bigPath = join(invoices, "archive-scannee.pdf");
  const big = Buffer.alloc(RELAY_RAW_CAP + 1024 * 1024, 7);
  indexDoc("big", "f-invoices", bigPath, ["archive"], big);
  const url = "/api/v1/peer/documents/files/big/raw";
  const headers = trustedPeer();

  const relayed = await app.inject({ url, headers: { ...headers, "x-twoody-via-tunnel": "relay" } });
  assert.equal(relayed.statusCode, 413);
  assert.deepEqual(relayed.json(), { error: "range_required", size: big.length, max_bytes: RELAY_RAW_CAP });
  // An older tunnel's marker ("1") counts as the relay.
  assert.equal((await app.inject({ url, headers: { ...headers, "x-twoody-via-tunnel": "1" } })).statusCode, 413);

  const cut = await app.inject({ url, headers: { ...headers, "x-twoody-via-tunnel": "relay", range: "bytes=0-" } });
  assert.equal(cut.statusCode, 206);
  assert.equal(cut.rawPayload.length, RELAY_RAW_CAP);
  assert.equal(cut.headers["content-range"], `bytes 0-${RELAY_RAW_CAP - 1}/${big.length}`);

  const direct = await app.inject({ url, headers: { ...headers, "x-twoody-via-tunnel": "direct" } });
  assert.equal(direct.statusCode, 200);
  assert.equal(direct.rawPayload.length, big.length);
  assert.ok(big.length <= LAN_RAW_CAP);
  const { "x-twoody-via-tunnel": _marker, "x-twoody-tunnel-peer": _key, ...plain } = headers;
  assert.equal((await app.inject({ url, headers: plain })).statusCode, 403, "plain HTTP on the local network: a peer reaches nothing");
});

test("raw: a document swapped for a symlink out of its grant is not served", async () => {
  const path = join(contracts, "lien.txt");
  indexDoc("link", "f-contracts", path, ["lien"]);
  unlinkSync(path);
  symlinkSync(join(outside, "secret.txt"), path);
  const response = await app.inject({ url: "/api/v1/peer/documents/files/link/raw", headers: trustedPeer() });
  assert.equal(response.statusCode, 404);
  assert.ok(!response.body.includes("hors du dossier"));
  assert.equal(readFileSync(path, "utf8"), "hors du dossier accordé", "the fixture really points outside");
});

test("raw: a folder on the way swapped for a link out of the grant is not served (the file opened is the one checked)", async () => {
  const sub = join(contracts, "Annexes");
  mkdirSync(sub);
  const path = join(sub, "secret.txt");
  indexDoc("annex", "f-contracts", path, ["annexe"]);
  // The last component is a plain file, so O_NOFOLLOW lets it open: the
  // folder above it now leads outside the grant.
  rmSync(sub, { recursive: true });
  symlinkSync(outside, sub);
  const response = await app.inject({ url: "/api/v1/peer/documents/files/annex/raw", headers: trustedPeer() });
  assert.equal(response.statusCode, 404);
  assert.ok(!response.body.includes("hors du dossier"));
  assert.equal(readFileSync(path, "utf8"), "hors du dossier accordé", "the fixture really leads outside");
  unlinkSync(sub);
});

// ── rate limit and audit ────────────────────────────────────────────────────

test("30 requests a minute per session, then 429 with Retry-After; another session is not affected", async () => {
  const headers = trustedPeer();
  for (let i = 0; i < 30; i++) assert.equal((await app.inject({ url: "/api/v1/peer/documents/folders", headers })).statusCode, 200, `request ${i + 1}`);
  const limited = await search(headers, {});
  assert.equal(limited.statusCode, 429);
  assert.ok(Number(limited.headers["retry-after"]) > 0);
  assert.equal(limited.json().error, "rate_limited");
  assert.ok(limited.json().retry_after_s >= 1);
  assert.equal((await search(trustedPeer(), {})).statusCode, 200);
});

test("audit: which computer read which document, shown to the owner, never to a peer", async () => {
  const headers = peer("77", true);
  await search(headers, { q: "contrat client Dupont" });
  await app.inject({ url: "/api/v1/peer/documents/files/bail", headers });
  await app.inject({ url: "/api/v1/peer/documents/files/scan/raw", headers: { ...headers, range: "bytes=0-99" } });

  const desktop = { authorization: `Bearer ${owner.token}` };
  const audit = await app.inject({ url: "/api/v1/peers/77/audit", headers: desktop });
  assert.equal(audit.statusCode, 200);
  const entries = audit.json().entries as Array<{ action: string; document_id: string | null; name: string | null; bytes: number | null; at: string }>;
  assert.equal(entries[0]!.action, "raw", "newest first");
  assert.deepEqual({ ...entries[0], at: undefined, id: undefined }, { action: "raw", document_id: "scan", name: "scan-bail.pdf", bytes: 100, at: undefined, id: undefined, requester: null, requester_name: null });
  assert.ok(entries.some((e) => e.action === "read" && e.document_id === "bail"));
  assert.ok(entries.some((e) => e.action === "search" && e.document_id === "client"));
  assert.ok(entries.every((e) => !Number.isNaN(Date.parse(e.at))));
  assert.doesNotMatch(audit.body, /Dupont : prestation|\/Contrats\//, "no text, no path");

  const page = (await app.inject({ url: "/api/v1/peers/77/audit?limit=1", headers: desktop })).json();
  assert.equal(page.entries.length, 1);
  const next = (await app.inject({ url: `/api/v1/peers/77/audit?limit=1&before=${page.next_before}`, headers: desktop })).json();
  assert.notEqual(next.entries[0].id, page.entries[0].id);

  // Passed on for one of the person's devices (documents/remote.ts): the
  // audit names it too, as that computer says.
  await app.inject({ url: "/api/v1/peer/documents/files/scan/raw", headers: { ...headers, range: "bytes=0-9", "x-twoody-requester": "person:1a6f0c2e-7d41-4b8a-9e53-2f0c6d8a1b01", "x-twoody-requester-name": encodeURIComponent("iPhone de Jimmy") } });
  const passedOn = (await app.inject({ url: "/api/v1/peers/77/audit?limit=1", headers: desktop })).json().entries[0];
  assert.deepEqual([passedOn.requester, passedOn.requester_name, passedOn.bytes], ["person:1a6f0c2e-7d41-4b8a-9e53-2f0c6d8a1b01", "iPhone de Jimmy", 10]);
  await app.inject({ url: "/api/v1/peer/documents/files/scan/raw", headers: { ...headers, range: "bytes=0-9", "x-twoody-requester": "../../etc", "x-twoody-requester-name": "%E0%A4%A" } });
  assert.equal((await app.inject({ url: "/api/v1/peers/77/audit?limit=1", headers: desktop })).json().entries[0].requester, null, "a requester that is none is not written");

  assert.equal((await app.inject({ url: "/api/v1/peers/77/audit", headers })).statusCode, 403, "a peer session does not read the audit");
  assert.equal((await app.inject({ url: "/api/v1/peers/77/audit" })).statusCode, 401);
  const refused = await search(peer("78", false), {});
  assert.equal(refused.statusCode, 403);
  assert.deepEqual((await app.inject({ url: "/api/v1/peers/78/audit", headers: desktop })).json().entries, [], "a refused request reads nothing, so nothing is logged");
});

// ── the contract fixture (P0) ───────────────────────────────────────────────

test("the contract's own examples fit, and the route's request schema is the contract's", { skip: !contract && "fixture not written yet" }, async () => {
  const { SEARCH_REQUEST_SCHEMA, SEARCH_DEFAULTS } = await import("../src/peerDocuments/contract.js");
  const request = contract.definitions.request;
  for (const example of request.examples) fits("request", example);
  for (const example of contract.definitions.response.examples) fits("response", example);
  const strip = (value: unknown): unknown =>
    Array.isArray(value) ? value.map(strip)
    : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([k]) => !["description", "examples", "default", "$ref"].includes(k)).map(([k, v]) => [k, strip(v)]))
    : value;
  const expected = strip(request) as Record<string, any>;
  expected.properties.scope.properties.folder_ids.items = contract.definitions.local_id;
  assert.deepEqual(strip(SEARCH_REQUEST_SCHEMA), strip(expected));
  assert.deepEqual(SEARCH_DEFAULTS, { limit: request.properties.limit.default, budget_chars: request.properties.budget_chars.default, deadline_ms: request.properties.deadline_ms.default });
  // The answer to the contract's own request examples, from this computer.
  const headers = trustedPeer();
  for (const example of request.examples) {
    const body = example.scope.mode === "selected" ? { ...example, scope: { mode: "selected", folder_ids: ["f-contracts"] } } : example;
    assert.equal((await search(headers, body)).statusCode, 200);
  }
});

test("the tunnel says what carried a request: relay unless it is the local network's socket, whatever the other end claims", async () => {
  const { Channel, createIdentity, startHandshake } = await import("../src/tunnel/channel.js");
  const { createTunnelHost, VIA_TUNNEL_HEADER } = await import("../src/tunnel/host.js");
  const { encode } = await import("../src/tunnel/protocol.js");
  for (const [transport, expected] of [[undefined, "relay"], ["relay", "relay"], ["direct", "direct"]] as const) {
    const phone = createIdentity();
    const computer = createIdentity();
    const phoneHandshake = startHandshake();
    const computerHandshake = startHandshake();
    const phoneChannel = new Channel({ role: "initiator", handshake: phoneHandshake, identity: phone, peerEphemeral: computerHandshake.ephemeralPublicKey, peerStatic: computer.publicKey });
    const computerChannel = new Channel({ role: "responder", handshake: computerHandshake, identity: computer, peerEphemeral: phoneHandshake.ephemeralPublicKey, peerStatic: phone.publicKey });
    let seen: string | null = null;
    const host = createTunnelHost({
      channel: computerChannel,
      localBaseUrl: "http://127.0.0.1:9",
      ...(transport ? { transport } : {}),
      send: () => undefined,
      fetchImpl: (async (_url: unknown, init: RequestInit) => {
        seen = new Headers(init.headers).get(VIA_TUNNEL_HEADER);
        return new Response("{}", { status: 200 });
      }) as typeof fetch,
    });
    try {
      await host.receive(phoneChannel.seal(encode({ t: "req", id: 1, method: "GET", path: "/api/v1/peer/documents/folders", headers: { [VIA_TUNNEL_HEADER]: "direct" } })));
      const deadline = Date.now() + 2_000;
      while (seen === null && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(seen, expected, String(transport));
    } finally {
      host.close();
    }
  }
});
