import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import test from "node:test";
import { randomBytes } from "node:crypto";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// The files themselves, for the chat (documents/fileListing.ts): asked from
// the iPhone « le fichier le plus récent de mes téléchargements sur mon
// MacBook Air ? », Twoody answered with a 2012 PDF of a folder named
// « Downloads » inside the person's archives, calling it « votre dossier
// Downloads » (30/09/2026). The person's ~/Downloads held screenshots and a
// .dmg, which the document index does not read.
//
// This process is that Mac, with a home folder of its own (HOME) inside a
// folder folderRisk lets be granted.

const realHome = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-listing-data-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;
const { folderRisk } = await import("../src/documents/folderRisk.js");
const base = folderRisk(join(tmpBase, "x"), realHome) === null ? tmpBase : realHome;
const sandbox = realpathSync(mkdtempSync(join(base, "twoody-listing-test-")));
const home = join(sandbox, "jimmy");
process.env.HOME = home;

const downloads = join(home, "Downloads");
const archive = join(home, "Documents", "_Archives", "2012", "Downloads");
mkdirSync(downloads, { recursive: true });
mkdirSync(archive, { recursive: true });
mkdirSync(join(home, "Library"), { recursive: true });
mkdirSync(join(home, "Documents", "notes"), { recursive: true });
const hour = 3_600_000;
const at = (path: string, ms: number) => utimesSync(path, new Date(ms), new Date(ms));
// Named as a Mac names it: accents decomposed (NFD).
const screenshot = join(downloads, "Capture d’écran 2026-09-30 à 10.12.03.png".normalize("NFD"));
const dmg = join(downloads, "Twoody-0.13.22.dmg");
writeFileSync(screenshot, Buffer.alloc(2048));
writeFileSync(dmg, Buffer.alloc(4096));
writeFileSync(join(downloads, ".DS_Store"), "x");
writeFileSync(join(home, "Library", "secret.txt"), "never listed");
at(screenshot, Date.now() - hour);
at(dmg, Date.now() - 2 * hour);
const oldPdf = join(archive, "vieux-rapport.pdf");
writeFileSync(oldPdf, "%PDF-1.4");
at(oldPdf, Date.UTC(2012, 4, 3));
const edf = join(home, "Documents", "notes", "facture-edf.txt");
writeFileSync(edf, "Facture EDF d'octobre : le montant s'élève à 92 euros, prélevé le 5 novembre.");

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { sqlite } = await import("../src/db.js");
const { ensureLocalUser, pairDevice } = await import("../src/pairing.js");
const { listingIntent } = await import("../src/documents/fileListing.js");
const { setSpotlightEnabled, setSpotlightRunner } = await import("../src/documents/spotlight.js");

// The host's own Spotlight is not this test's: off, except where stubbed.
setSpotlightEnabled(false);

const runtime = await startFakeRuntime({ models: ["qwen3.5:9b"], reply: () => "Voici." });
const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktop.token };
await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: runtime.url, model: "qwen3.5:9b" } });
await app.inject({ method: "PATCH", url: "/me", headers: auth, payload: { user: { memory_enabled: false } } });
const user = ensureLocalUser();

function grant(id: string, path: string) {
  sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run(id, user.id, path, Date.now());
}
function ungrantAll() {
  sqlite.prepare("DELETE FROM document_chunks WHERE user_id = ?").run(user.id);
  sqlite.prepare("DELETE FROM documents WHERE user_id = ?").run(user.id);
  sqlite.prepare("DELETE FROM document_folders WHERE user_id = ?").run(user.id);
}
function indexOldPdf(folderId: string) {
  sqlite
    .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
    .run("old-pdf", user.id, folderId, oldPdf, "vieux-rapport.pdf", ".pdf", 8, Date.UTC(2012, 4, 3), "indexed", 60);
  sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run("old-pdf", user.id, 1, 0, "Rapport annuel 2012 : le fichier le plus récent des téléchargements de l'équipe.");
}

test.after(async () => {
  setSpotlightRunner(null);
  await app.close();
  await runtime.close();
  if (process.platform === "darwin" && base === realHome) {
    const trash = join(realHome, ".Trash");
    mkdirSync(trash, { recursive: true });
    renameSync(sandbox, join(trash, basename(sandbox)));
  } else rmSync(sandbox, { recursive: true, force: true });
});

const QUESTION = "le fichier le plus récent de mes téléchargements sur mon MacBook Air ?";

function final(payload: string) {
  const block = payload.split("\n\n").find((b) => b.startsWith("event: final"));
  assert.ok(block, payload.slice(-800));
  return JSON.parse(block!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
}
const ask = (content: string, headers: Record<string, string> = auth) => app.inject({ method: "POST", url: "/queries", headers, payload: { content } });
const lastPrompt = () => {
  const messages = runtime.calls.filter((c) => c.body.x_purpose !== "background").at(-1)!.body.messages as Array<{ role: string; content: string }>;
  return messages.at(-1)!.content;
};
const systemPrompt = () => (runtime.calls.filter((c) => c.body.x_purpose !== "background").at(-1)!.body.messages as Array<{ content: string }>)[0]!.content;

test("a question about files themselves is told from one about what they say", () => {
  assert.deepEqual(listingIntent(QUESTION), { folder: "downloads", folderName: null, sort: "recent", kinds: [], limit: 5, count: false });
  assert.equal(listingIntent("What are the latest files in my Downloads?")?.folder, "downloads");
  const pdfs = listingIntent("Combien de PDF sur mon Bureau ?");
  assert.equal(pdfs?.folder, "desktop");
  assert.equal(pdfs?.count, true);
  assert.deepEqual(pdfs?.kinds, ["pdf"]);
  assert.equal(listingIntent("les captures d'écran les plus récentes de mes téléchargements")?.kinds.join(), "screenshot");
  assert.equal(listingIntent("Liste le dossier Factures")?.folderName, "Factures");
  assert.equal(listingIntent("quel est le plus gros fichier de mon iCloud Drive ?")?.sort, "largest");
  assert.equal(listingIntent("Combien coûte la facture d'électricité ?"), null);
  assert.equal(listingIntent("le document le plus récent sur le bail de l'appartement"), null);
  assert.equal(listingIntent("Résume ce document"), null);
});

test("the newest download is the real ~/Downloads' newest file, not an archive folder named Downloads", async () => {
  ungrantAll();
  grant("home", home);
  indexOldPdf("home");
  const answer = final((await ask(QUESTION)).payload);
  const prompt = lastPrompt();
  assert.match(prompt, /\[File listing from the file system: Downloads \(~\/Downloads\), at jimmy\/Downloads, newest first/);
  const shot = prompt.normalize("NFC").indexOf("Capture d’écran 2026-09-30");
  const disk = prompt.indexOf("Twoody-0.13.22.dmg");
  assert.ok(shot > 0 && disk > shot, prompt);
  assert.match(prompt, /· screenshot · 2\.0 KB · .* · in jimmy\/Downloads/);
  assert.match(prompt, /· installer · 4\.0 KB/);
  assert.ok(!prompt.includes("vieux-rapport.pdf"), "the archive's « Downloads » is not given");
  assert.ok(!prompt.includes(".DS_Store") && !prompt.includes("secret.txt"));
  assert.ok(!prompt.includes(sandbox), "no absolute path");
  assert.deepEqual(answer.sources, [], "nothing of another folder cited");
  assert.deepEqual(answer.documents.listing.map((c: { status: string; total: number }) => [c.status, c.total]), [["ok", 2]]);
  assert.match(systemPrompt(), /never call it « votre dossier Téléchargements »/);
});

test("an excerpt and an indexed file say the folder they are in", async () => {
  await ask("Que dit le rapport annuel 2012 ?");
  const prompt = lastPrompt();
  assert.match(prompt, /\[1\] vieux-rapport\.pdf, p\. 1 — in jimmy\/Documents\/_Archives\/2012\/Downloads/);
});

test("the person's iPhone, through the Mac, gets the same listing", async () => {
  const phone = pairDevice({ deviceName: "iPhone de Jimmy", tunnelPublicKey: randomBytes(32).toString("hex"), origin: "code" });
  final((await ask(QUESTION, { "x-user-token": phone.token })).payload);
  const prompt = lastPrompt();
  assert.ok(prompt.normalize("NFC").includes("Capture d’écran 2026-09-30") && prompt.includes("in jimmy/Downloads"), prompt);
});

test("a folder that is not granted is said so, with how to grant it, and nothing else is listed", async () => {
  ungrantAll();
  grant("documents", join(home, "Documents"));
  indexOldPdf("documents");
  const answer = final((await ask(QUESTION)).payload);
  const prompt = lastPrompt();
  assert.match(prompt, /The user asked about Downloads \(~\/Downloads\), which is not among the folders the user granted to Twoody/);
  assert.match(prompt, /« Ajouter un dossier »/);
  assert.ok(!prompt.includes("Twoody-0.13.22.dmg") && !prompt.normalize("NFC").includes("Capture d’écran"));
  assert.ok(!prompt.includes("vieux-rapport.pdf"), "not answered from another folder named Downloads");
  assert.deepEqual(answer.sources, []);
  assert.deepEqual(answer.documents.listing.map((c: { status: string }) => c.status), ["not_granted"]);
});

test("files are never listed outside the granted folders", async () => {
  final((await ask("Quels sont les fichiers les plus récents ?")).payload);
  const prompt = lastPrompt();
  assert.match(prompt, /File listing from the file system: every granted folder/);
  assert.ok(prompt.includes("vieux-rapport.pdf · pdf"), prompt);
  assert.ok(prompt.includes("facture-edf.txt"));
  assert.ok(!prompt.includes("Twoody-0.13.22.dmg") && !prompt.includes("secret.txt"));
  // Not even through ~/Library under a granted home folder.
  ungrantAll();
  grant("home", home);
  final((await ask("liste les fichiers de mon iCloud Drive")).payload);
  assert.match(lastPrompt(), /The user asked about iCloud Drive, which (is not among the folders|does not exist)/);
});

test("the list_files tool lists a granted folder, and only that", async () => {
  const listed = (await app.inject({ method: "POST", url: "/tool_calls", headers: auth, payload: { name: "list_files", arguments: { folder: "downloads", sort: "largest" } } })).json();
  assert.equal(listed.result.status, "ok");
  assert.deepEqual(listed.result.files.map((f: { name: string }) => f.name), ["Twoody-0.13.22.dmg", "Capture d’écran 2026-09-30 à 10.12.03.png"], "names given composed (NFC)");
  assert.ok(!JSON.stringify(listed).includes(sandbox), "no absolute path");
  const named = (await app.inject({ method: "POST", url: "/tool_calls", headers: auth, payload: { name: "list_files", arguments: { folder: "_Archives" } } })).json();
  assert.equal(named.result.files[0].folder, "jimmy/Documents/_Archives/2012/Downloads");
  ungrantAll();
  grant("documents", join(home, "Documents"));
  const refused = (await app.inject({ method: "POST", url: "/tool_calls", headers: auth, payload: { name: "list_files", arguments: { folder: "downloads" } } })).json();
  assert.equal(refused.result.status, "not_granted");
  assert.deepEqual(refused.result.files, []);
});

test("with Spotlight: only the granted folder is asked, what it says is filtered, and the day a file arrived counts", async () => {
  ungrantAll();
  grant("home", home);
  const asked: Array<{ command: string; args: string[] }> = [];
  setSpotlightRunner(async (command, args) => {
    asked.push({ command, args });
    if (command === "mdfind") return [dmg, join(home, "Library", "secret.txt"), "/etc/passwd", join(downloads, ".cache", "x.png"), ""].join("\0");
    // mdls: the .dmg arrived a minute ago (its own date is older), the screenshot has none.
    const files = args.slice(args.indexOf("kMDItemDateAdded") + 1);
    return files.map((file) => (file === dmg ? new Date(Date.now() - 60_000).toISOString().replace("T", " ").slice(0, 19) + " +0000" : "")).join("\0");
  });
  try {
    final((await ask(QUESTION)).payload);
    const prompt = lastPrompt();
    const shot = prompt.normalize("NFC").indexOf("Capture d’écran 2026-09-30");
    const disk = prompt.indexOf("Twoody-0.13.22.dmg");
    assert.ok(disk > 0 && shot > disk, `the .dmg arrived last: ${prompt}`);
    assert.match(prompt, /Twoody-0\.13\.22\.dmg · installer · 4\.0 KB · modified .* · added /);
    assert.ok(shot > 0, "the folder's first level is read too: Spotlight may not know a new file yet");
    assert.ok(!prompt.includes("secret.txt") && !prompt.includes("passwd") && !prompt.includes("x.png"));
    const finds = asked.filter((a) => a.command === "mdfind");
    assert.ok(finds.length >= 1);
    for (const find of finds) {
      const onlyIn = find.args.flatMap((arg, i) => (find.args[i - 1] === "-onlyin" ? [arg] : []));
      assert.ok(onlyIn.length >= 1 && onlyIn.every((dir) => dir === downloads || dir === home), JSON.stringify(find.args));
    }
  } finally {
    setSpotlightRunner(null);
    setSpotlightEnabled(false);
  }
});

test("with Spotlight: a matching file the index has not read yet is read now, kept, and cited", async () => {
  ungrantAll();
  grant("documents", join(home, "Documents"));
  const asked: string[][] = [];
  setSpotlightRunner(async (command, args) => {
    if (command !== "mdfind") return null;
    asked.push(args);
    return [edf, join(home, "Library", "secret.txt"), dmg].join("\0");
  });
  try {
    const answer = final((await ask("Combien coûte la facture EDF d'octobre ?")).payload);
    assert.ok(lastPrompt().includes("92 euros"), lastPrompt());
    assert.deepEqual(answer.sources.map((s: { name: string }) => s.name), ["facture-edf.txt"]);
    const row = sqlite.prepare("SELECT status, folder_id FROM documents WHERE path = ?").get(edf) as { status: string; folder_id: string } | undefined;
    assert.deepEqual(row, { status: "indexed", folder_id: "documents" }, "kept in the index for the next question");
    assert.equal(sqlite.prepare("SELECT id FROM documents WHERE path = ?").get(dmg), undefined, "nothing read outside the grants");
    for (const args of asked) {
      const onlyIn = args.flatMap((arg, i) => (args[i - 1] === "-onlyin" ? [arg] : []));
      assert.deepEqual(onlyIn, [join(home, "Documents")]);
      // The query holds letters and digits only, as words.
      assert.match(args.at(-1)!, /^[()\w\s=*"|&ÀÉÈÊéèêàçôûîïëü]+$/u);
    }
  } finally {
    setSpotlightRunner(null);
    setSpotlightEnabled(false);
  }
});

test("« voilà c'est activé, tu peux maintenant ? » lists what the message before asked, Documents having been off (07/10/2026)", async () => {
  const { retriesPrevious } = await import("../src/documents/query.js");
  assert.equal(retriesPrevious("voila c'est activé, tu peux maintenant?"), true);
  assert.equal(retriesPrevious("Et maintenant ?"), true);
  assert.equal(retriesPrevious("maintenant liste mes téléchargements"), false, "a question of its own");
  assert.equal(retriesPrevious("tu peux maintenant me dire ce que dit mon CV ?"), false);
  assert.equal(retriesPrevious("salut ça va"), false);
  assert.equal(listingIntent("quels sont les fichiers sur mon bureau ?")?.folder, "desktop");
  assert.equal(listingIntent("il y a quoi dans mes téléchargements ?")?.folder, "downloads");
  ungrantAll();
  grant("home", home);
  const first = await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "tu peux me lister quels fichiers j'ai dans mes téléchargements ?", document_access: { mode: "off" } } });
  assert.ok(!lastPrompt().includes("Twoody-0.13.22.dmg"), "Documents off: nothing listed");
  const discussion = first.payload.match(/"discussion_id":"([^"]+)"/)![1];
  await app.inject({ method: "POST", url: "/queries", headers: auth, payload: { content: "voila c'est activé, tu peux maintenant?", discussion_id: discussion, document_access: { mode: "all" } } });
  assert.match(lastPrompt(), /\[File listing from the file system: Downloads \(~\/Downloads\)/);
  assert.ok(lastPrompt().includes("Twoody-0.13.22.dmg"));
});
