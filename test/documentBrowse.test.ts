import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { randomBytes } from "node:crypto";
import test from "node:test";

// The file browser over the granted folders (documents/browse.ts,
// docs/mesh-design.md §2b): what a folder holds, indexed or not, sorted and
// paged, searched by name; never outside a grant (no « .. », no absolute
// path, no symbolic link, nothing hidden, no ~/Library), never an absolute
// path in an answer; the file itself, indexed or not; the same for a
// trusted computer of the mesh, written in its audit, and nothing for one
// that is not trusted.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-browse-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { pairDevice, ensureLocalUser } = await import("../src/pairing.js");
const { accountPeers, db, sqlite } = await import("../src/db.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { browsePath, readBrowseRequest, sortEntries } = await import("../src/documents/browse.js");
const { readPeerBrowse } = await import("../src/documents/remote.js");
const { setTrustCheck } = await import("../src/peerDocuments/trust.js");
const { setDesktopAccount } = await import("../src/account/service.js");

const SELF = "5e1f3c2a-7b4d-4c6e-9a8b-0d1e2f3a4b5c";
setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: SELF, computerName: "Mac" });

const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const root = realpathSync(mkdtempSync(join(base, "twoody-browse-test-")));

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
const auth = { authorization: `Bearer ${owner.token}` };
const user = ensureLocalUser();

// ── fixtures ────────────────────────────────────────────────────────────────
//   root/Docs (granted)
//     Factures/ facture-01.pdf … facture-12.pdf, Archives/2012/vieille-facture.pdf
//     bail.txt (indexed), photo.png, notes.md, .secret, ~$lock.docx, credentials.json
//     Library/ prefs.txt  (never entered)   Projet.app/ (a bundle)
//     lien-dehors -> root/Ailleurs (a link)  lien-fichier.txt -> root/Ailleurs/secret.txt
//   root/Ailleurs/secret.txt (not granted)
const docs = join(root, "Docs");
const invoices = join(docs, "Factures");
const outside = join(root, "Ailleurs");
for (const dir of [invoices, join(invoices, "Archives", "2012"), outside, join(docs, "Library"), join(docs, "Projet.app"), join(docs, ".cache")]) mkdirSync(dir, { recursive: true });
for (let i = 1; i <= 12; i++) {
  const file = join(invoices, `facture-${String(i).padStart(2, "0")}.pdf`);
  writeFileSync(file, Buffer.alloc(i * 100));
  utimesSync(file, new Date(2026, 0, i), new Date(2026, 0, i));
}
writeFileSync(join(invoices, "Archives", "2012", "vieille-facture.pdf"), "%PDF old");
writeFileSync(join(docs, "bail.txt"), "Contrat de bail : loyer 900 euros.");
writeFileSync(join(docs, "photo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
writeFileSync(join(docs, "notes.md"), "# Notes");
writeFileSync(join(docs, "page.html"), "<script>alert(1)</script>");
writeFileSync(join(docs, "outil.command"), "#!/bin/sh\necho hi");
writeFileSync(join(docs, ".secret"), "caché");
writeFileSync(join(docs, "~$lock.docx"), "lock");
writeFileSync(join(docs, "credentials.json"), "{}");
writeFileSync(join(docs, "Library", "prefs.txt"), "préférences");
writeFileSync(join(docs, ".cache", "x.txt"), "cache");
writeFileSync(join(outside, "secret.txt"), "hors du dossier accordé");
symlinkSync(outside, join(docs, "lien-dehors"));
symlinkSync(join(outside, "secret.txt"), join(docs, "lien-fichier.txt"));

sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run("f-docs", user.id, docs, Date.now());
sqlite
  .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("doc-bail", user.id, "f-docs", join(docs, "bail.txt"), "bail.txt", ".txt", 34, Date.now(), "indexed", 34);
// Granted before folderRisk refused it: never browsed.
sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run("f-risky", user.id, "/etc", Date.now());

async function browse(query: Record<string, string | number>, headers: Record<string, string> = auth, url = "/api/v1/local_documents/browse") {
  const qs = new URLSearchParams(Object.entries(query).map(([k, v]) => [k, String(v)]));
  return app.inject({ url: `${url}?${qs}`, headers });
}

function noAbsolutePath(body: string) {
  assert.ok(!body.includes(root), `an absolute path leaked: ${body.slice(0, 400)}`);
  assert.ok(!body.includes(home + "/"), "the home folder leaked");
}

// ── pure parts ──────────────────────────────────────────────────────────────

test("a path inside a granted folder: relative, no « .. », nothing hidden, no folder the walk skips", () => {
  assert.deepEqual(browsePath(""), []);
  assert.deepEqual(browsePath("Factures/Archives"), ["Factures", "Archives"]);
  for (const bad of ["/etc", "../Ailleurs", "Factures/../..", "Factures//x", "./Factures", "C:/Windows", "Factures\\x", ".ssh", "a/.git/config", "Library/Preferences", "Projet.app/Contents", "node_modules", "a\u0000b"]) {
    assert.equal(browsePath(bad), null, bad);
  }
  assert.deepEqual(browsePath("Factures/facture-01.pdf", true), ["Factures", "facture-01.pdf"]);
  assert.equal(browsePath("", true), null);
  assert.equal(browsePath(".env", true), null);
  assert.equal(browsePath("credentials.json", true), null);
});

test("a browse request is checked: root id, sort, order, page", () => {
  assert.deepEqual(readBrowseRequest({ root: "f-docs" }), { root: "f-docs", path: "", sort: "name", order: "asc", offset: 0, limit: 100, q: null });
  assert.equal(readBrowseRequest({ root: "f-docs", sort: "date" })!.order, "desc");
  assert.equal(readBrowseRequest({ root: "../x" }), null);
  assert.equal(readBrowseRequest({ root: "f-docs", sort: "owner" }), null);
  assert.equal(readBrowseRequest({ root: "f-docs", limit: "500" }), null);
  assert.equal(readBrowseRequest({ root: "f-docs", offset: "-1" }), null);
  assert.equal(readBrowseRequest({ root: "f-docs", q: "  " })!.q, null);
});

test("folders first, then the files in the order asked", () => {
  const e = (name: string, kind: "dir" | "file", size: number | null, mtime: number) => ({ name, kind, size, mtime });
  const list = [e("b.pdf", "file", 10, 3), e("Zeta", "dir", null, 1), e("a10.pdf", "file", 30, 1), e("a2.pdf", "file", 20, 2), e("alpha", "dir", null, 5)];
  assert.deepEqual(sortEntries(list, "name", "asc").map((x) => x.name), ["alpha", "Zeta", "a2.pdf", "a10.pdf", "b.pdf"]);
  assert.deepEqual(sortEntries(list, "size", "desc").map((x) => x.name), ["Zeta", "alpha", "a10.pdf", "a2.pdf", "b.pdf"]);
  assert.deepEqual(sortEntries(list, "date", "desc").map((x) => x.name), ["alpha", "Zeta", "b.pdf", "a2.pdf", "a10.pdf"]);
});

// ── this computer ───────────────────────────────────────────────────────────

test("a granted folder lists its sub-folders and every regular file, indexed or not, without a path", async () => {
  const response = await browse({ root: "f-docs" });
  assert.equal(response.statusCode, 200, response.body);
  noAbsolutePath(response.body);
  const body = response.json();
  assert.equal(body.computer_id, SELF);
  assert.deepEqual(body.root, { id: "f-docs", name: "Docs" });
  assert.deepEqual(body.breadcrumbs, [{ name: "Docs", path: "" }]);
  const names = body.entries.map((e: { name: string }) => e.name);
  assert.deepEqual(names, ["Factures", "bail.txt", "notes.md", "outil.command", "page.html", "photo.png"]);
  const [folder, bail, , , , photo] = body.entries;
  assert.deepEqual({ kind: folder.kind, size: folder.size, type: folder.type, path: folder.path }, { kind: "dir", size: null, type: "folder", path: "Factures" });
  assert.deepEqual({ indexed: bail.indexed, document_id: bail.document_id, type: bail.type, size: bail.size }, { indexed: true, document_id: "doc-bail", type: "document", size: 34 });
  assert.equal(photo.indexed, false);
  assert.equal(photo.document_id, undefined);
  assert.equal(photo.type, "image");
  assert.ok(!Number.isNaN(Date.parse(photo.modified)));
});

test("sub-folders, breadcrumbs, sorting and pages", async () => {
  const first = (await browse({ root: "f-docs", path: "Factures", sort: "date", order: "desc", limit: 5 })).json();
  assert.deepEqual(first.breadcrumbs, [{ name: "Docs", path: "" }, { name: "Factures", path: "Factures" }]);
  assert.equal(first.total, 13);
  assert.deepEqual(first.entries.map((e: { name: string }) => e.name), ["Archives", "facture-12.pdf", "facture-11.pdf", "facture-10.pdf", "facture-09.pdf"]);
  assert.equal(first.entries[1].path, "Factures/facture-12.pdf");
  assert.equal(first.next_offset, 5);
  const last = (await browse({ root: "f-docs", path: "Factures", sort: "date", order: "desc", limit: 5, offset: 10 })).json();
  assert.deepEqual(last.entries.map((e: { name: string }) => e.name), ["facture-03.pdf", "facture-02.pdf", "facture-01.pdf"]);
  assert.equal(last.next_offset, null);
  const bySize = (await browse({ root: "f-docs", path: "Factures", sort: "size", order: "asc", limit: 3 })).json();
  assert.deepEqual(bySize.entries.map((e: { name: string }) => e.name), ["Archives", "facture-01.pdf", "facture-02.pdf"]);
  const deep = (await browse({ root: "f-docs", path: "Factures/Archives/2012" })).json();
  assert.equal(deep.breadcrumbs.length, 4);
  assert.equal(deep.entries[0].path, "Factures/Archives/2012/vieille-facture.pdf");
});

test("a search by name looks inside the folder shown and its sub-folders, never past a link", async () => {
  const found = (await browse({ root: "f-docs", q: "FACTURE" })).json();
  assert.equal(found.query, "FACTURE");
  assert.equal(found.total, 14, JSON.stringify(found.entries.map((e: { path: string }) => e.path)));
  assert.ok(found.entries.some((e: { path: string }) => e.path === "Factures/Archives/2012/vieille-facture.pdf"));
  const secret = (await browse({ root: "f-docs", q: "secret" })).json();
  assert.equal(secret.total, 0, "neither .secret, nor the link, nor what it points to");
  const inside = (await browse({ root: "f-docs", path: "Factures/Archives", q: "facture" })).json();
  assert.deepEqual(inside.entries.map((e: { name: string }) => e.name), ["vieille-facture.pdf"]);
});

test("nothing outside the grant: « .. », absolute paths, links, hidden and skipped folders, another root", async () => {
  for (const path of ["..", "../Ailleurs", "Factures/../../Ailleurs", root, outside, "/etc", "lien-dehors", ".cache", "Library", "Projet.app", "Factures/../Library"]) {
    const response = await browse({ root: "f-docs", path });
    assert.ok([400, 404].includes(response.statusCode), `${path}: ${response.statusCode} ${response.body}`);
    noAbsolutePath(response.body);
  }
  assert.equal((await browse({ root: "f-risky" })).statusCode, 404, "a folder folderRisk refuses now");
  assert.equal((await browse({ root: "f-unknown" })).statusCode, 404);
  // Another user's grant is not this one's.
  assert.equal((await browse({ root: "f-docs", path: "bail.txt" })).statusCode, 404, "a file is not a folder");
});

test("the file itself, indexed or not, with Range; never through a link, never outside", async () => {
  const raw = (path: string, headers: Record<string, string> = auth) => browse({ root: "f-docs", path }, headers, "/api/v1/local_documents/browse/raw");
  const photo = await raw("photo.png");
  assert.equal(photo.statusCode, 200);
  assert.equal(photo.headers["content-type"], "image/png");
  assert.equal(photo.headers["x-content-type-options"], "nosniff");
  const html = await raw("page.html");
  assert.match(String(html.headers["content-type"]), /^text\/plain/, "markup is served as plain text");
  assert.equal((await raw("outil.command")).headers["content-type"], "application/octet-stream");
  const part = await app.inject({ url: `/api/v1/local_documents/browse/raw?root=f-docs&path=${encodeURIComponent("bail.txt")}`, headers: { ...auth, range: "bytes=0-6" } });
  assert.equal(part.statusCode, 206);
  assert.equal(part.body, "Contrat");
  for (const path of ["lien-fichier.txt", "lien-dehors/secret.txt", "../Ailleurs/secret.txt", ".secret", "credentials.json", "Library/prefs.txt", "Factures"]) {
    const refused = await raw(path);
    assert.equal(refused.statusCode, 404, path);
    noAbsolutePath(refused.body);
  }
  assert.equal((await raw("photo.png", {})).statusCode, 401);
});

test("the index's older view of a folder still answers its clients", async () => {
  const response = await app.inject({ url: "/api/v1/local_documents/browse?folder_id=f-docs", headers: auth });
  assert.equal(response.statusCode, 200);
  assert.deepEqual(response.json().entries.map((e: { name: string }) => e.name), ["bail.txt"]);
  assert.equal((await app.inject({ url: "/api/v1/local_documents/browse", headers: auth })).statusCode, 400);
});

test("this computer's own id through the relay route browses here", async () => {
  const response = await browse({ root: "f-docs", path: "Factures", limit: 2 }, auth, `/api/v1/local_documents/remote/${SELF}/browse`);
  assert.equal(response.statusCode, 200, response.body);
  assert.equal(response.json().entries.length, 2);
  const file = await browse({ root: "f-docs", path: "notes.md" }, auth, `/api/v1/local_documents/remote/${SELF}/browse/raw`);
  assert.equal(file.statusCode, 200);
  assert.equal(file.body, "# Notes");
});

// ── another computer of the mesh ───────────────────────────────────────────

const inRoster = new Set<string>();
setTrustCheck(async (id: string) => inRoster.has(id));
const sealedFrom = (key: string) => ({ "x-twoody-via-tunnel": "relay", "x-twoody-tunnel-peer": key });
function peer(computerId: string, trusted: boolean, options: { plain?: boolean } = {}) {
  const tunnelKey = randomBytes(32).toString("hex");
  const session = pairDevice({ deviceName: `Computer ${computerId}`, role: "peer", origin: "account", requesterComputerId: computerId, tunnelPublicKey: tunnelKey });
  const now = new Date();
  db.insert(accountPeers)
    .values({ computerId, userId: user.id, name: `Computer ${computerId}`, state: "linked", trusted, enabled: true, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: accountPeers.computerId, set: { trusted, updatedAt: now } })
    .run();
  if (trusted) inRoster.add(computerId);
  else inRoster.delete(computerId);
  return { authorization: `Bearer ${session.token}`, ...(options.plain ? {} : sealedFrom(tunnelKey)), "x-twoody-requester": "owner" };
}

test("a trusted computer browses and opens a file; it is written in the audit, with no path", async () => {
  const headers = peer("pi-1", true);
  const listed = await browse({ root: "f-docs", path: "Factures", sort: "name", limit: 3 }, headers, "/api/v1/peer/documents/browse");
  assert.equal(listed.statusCode, 200, listed.body);
  noAbsolutePath(listed.body);
  assert.equal(listed.json().computer_id, SELF);
  assert.deepEqual(listed.json().entries.map((e: { name: string }) => e.name), ["Archives", "facture-01.pdf", "facture-02.pdf"]);
  const file = await browse({ root: "f-docs", path: "photo.png" }, headers, "/api/v1/peer/documents/browse/raw");
  assert.equal(file.statusCode, 200);
  assert.equal(file.rawPayload.length, 4);
  assert.equal((await browse({ root: "f-docs", path: "lien-fichier.txt" }, headers, "/api/v1/peer/documents/browse/raw")).statusCode, 404);
  assert.equal((await browse({ root: "f-docs", path: "../Ailleurs" }, headers, "/api/v1/peer/documents/browse")).statusCode, 400);

  const audit = (await app.inject({ url: "/api/v1/peers/pi-1/audit", headers: auth })).json();
  const actions = audit.entries.map((e: { action: string; name: string | null; document_id: string | null }) => [e.action, e.name, e.document_id]);
  assert.deepEqual(actions.slice(0, 2), [["raw", "photo.png", null], ["browse", "Factures", null]]);
  noAbsolutePath(JSON.stringify(audit));
});

test("an untrusted computer, a peer token over plain HTTP, or a person's session on the peer route: nothing", async () => {
  for (const [who, headers] of [
    ["untrusted", peer("pi-2", false)],
    ["no tunnel", peer("pi-3", true, { plain: true })],
    ["the owner on a peer route", auth],
  ] as const) {
    for (const url of ["/api/v1/peer/documents/browse", "/api/v1/peer/documents/browse/raw"]) {
      const response = await browse({ root: "f-docs", path: url.endsWith("raw") ? "photo.png" : "" }, headers, url);
      assert.equal(response.statusCode, 403, `${who} ${url}: ${response.body}`);
    }
  }
  // A peer session never reaches this computer's own routes.
  const trusted = peer("pi-4", true);
  assert.ok([401, 403].includes((await browse({ root: "f-docs" }, trusted)).statusCode));
});

test("another computer's answer is read as the contract says: no absolute path, no « .. »", () => {
  const read = readPeerBrowse({
    computer_id: "x",
    root: { id: "f1", name: "Docs" },
    path: "Factures",
    breadcrumbs: [{ name: "Docs", path: "" }, { name: "Factures", path: "Factures" }],
    entries: [
      { name: "ok.pdf", path: "Factures/ok.pdf", kind: "file", size: 12, modified: "2026-01-01T00:00:00.000Z", type: "pdf", indexed: true, document_id: "d1" },
      { name: "passwd", path: "/etc/passwd", kind: "file", size: 1, modified: "2026-01-01T00:00:00.000Z", type: "file", indexed: false },
      { name: "up", path: "../up", kind: "dir", size: null, modified: "2026-01-01T00:00:00.000Z", type: "folder", indexed: false },
      { name: "C:\\x", path: "Factures/x", kind: "file", size: 1, modified: "x", type: "<b>", indexed: false },
    ],
    total: 4,
    offset: 0,
    next_offset: null,
  })!;
  const entries = read.entries as Array<{ name: string; path: string; type: string }>;
  assert.deepEqual(entries.map((e) => e.path), ["Factures/ok.pdf", "Factures/x"]);
  assert.equal(entries[1]!.name, "x", "a name is a name, not a path");
  assert.equal(entries[1]!.type, "file");
  assert.equal(readPeerBrowse({ root: { id: "f1", name: "Docs" }, path: "/etc", entries: [] }), null);
});
