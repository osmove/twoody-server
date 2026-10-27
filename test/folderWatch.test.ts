import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Watching the granted folders (docs/project-overview-design.md §2): a
// document added or changed is noticed by itself — the ordinary pass runs
// once the folder has been quiet a while; what is never indexed (a lock, a
// hidden or temporary file, Library) wakes nothing; nothing is watched with
// Documents off.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-watch-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { indexStatus } = await import("../src/documents/library.js");
const { setSpotlightEnabled } = await import("../src/documents/spotlight.js");
const { concernsIndex, startWatching, syncWatches, watchRoots, watchedFolders } = await import("../src/documents/watch.js");
setSpotlightEnabled(false);

const app = await buildApp();
await app.ready();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };

const home = mkdtempSync(join(process.cwd(), "tmp-watch-"));
const projekte = join(home, "Projekte");
mkdirSync(join(projekte, "Kunde A"), { recursive: true });
writeFileSync(join(projekte, "Kunde A", "Briefing.txt"), "Briefing des Kunden A.");

test.after(async () => {
  await app.close();
  rmSync(home, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const documentNames = () => (sqlite.prepare("SELECT name FROM documents WHERE user_id = ? ORDER BY name").all(owner) as Array<{ name: string }>).map((row) => row.name);
async function until(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) return false;
    await sleep(50);
  }
  return true;
}

test("what wakes the watch", () => {
  assert.equal(concernsIndex("Kunde A/Briefing.docx"), true);
  assert.equal(concernsIndex("Kunde A\\Protokoll.pdf"), true);
  assert.equal(concernsIndex("Kunde A"), true, "a folder renamed or removed");
  assert.equal(concernsIndex(null), true, "the system did not say what: a pass");
  assert.equal(concernsIndex("Kunde A/~$Briefing.docx"), false);
  assert.equal(concernsIndex("Kunde A/.DS_Store"), false);
  assert.equal(concernsIndex("Kunde A/Briefing.docx.tmp"), false);
  assert.equal(concernsIndex("Kunde A/~WRL0001.tmp"), false);
  assert.equal(concernsIndex("Library/Caches/foo.txt"), false);
  assert.equal(concernsIndex("node_modules/pkg/readme.md"), false);
  assert.equal(concernsIndex("Fotos/IMG_0001.heic"), false);
  assert.deepEqual(watchRoots(["/a/b", "/a", "/c", "/a/b/c", "/cd"]), ["/a", "/c", "/cd"]);
});

test("a document added to a granted folder is indexed by itself, a lock file wakes nothing", async () => {
  const added = await app.inject({ method: "POST", url: "/local_documents/folders", headers: desktop, payload: { path: projekte } });
  assert.ok(added.statusCode < 300, added.body);
  assert.ok(await until(() => documentNames().includes("Briefing.txt") && !indexStatus(owner).running));

  let passes = 0;
  const { reindex } = await import("../src/documents/library.js");
  const watching = startWatching({ quietMs: 200, gapMs: 0, pass: async (userId) => { passes += 1; return reindex(userId); } });
  try {
    assert.deepEqual(watchedFolders(owner), ["Projekte"]);
    await sleep(300);
    passes = 0;
    writeFileSync(join(projekte, "Kunde A", "~$Protokoll.docx"), "lock");
    writeFileSync(join(projekte, "Kunde A", ".hidden.txt"), "hidden");
    await sleep(800);
    assert.equal(passes, 0, "a lock or hidden file wakes nothing");

    writeFileSync(join(projekte, "Kunde A", "Protokoll.txt"), "Protokoll: die Richtung Natur wurde gewählt.");
    writeFileSync(join(projekte, "Kunde A", "Mail.txt"), "Mail des Kunden.");
    assert.ok(await until(() => documentNames().includes("Protokoll.txt") && documentNames().includes("Mail.txt")), `indexed: ${documentNames().join(", ")}`);
    assert.equal(passes, 1, "a burst of changes: one pass, once the folder is quiet");

    // Documents off: nothing watched any more.
    await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: false } });
    syncWatches(owner);
    assert.deepEqual(watchedFolders(owner), []);
    passes = 0;
    writeFileSync(join(projekte, "Kunde A", "Neu.txt"), "Neu.");
    await sleep(800);
    assert.equal(passes, 0);
    await app.inject({ method: "PATCH", url: "/local_capabilities/documents", headers: desktop, payload: { enabled: true } });
    syncWatches(owner);
    assert.deepEqual(watchedFolders(owner), ["Projekte"]);
  } finally {
    watching.stop();
  }
});
