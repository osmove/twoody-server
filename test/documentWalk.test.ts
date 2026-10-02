import { test, after } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { entryKind, folderReadable, skipDirectory, skipFile, walk } from "../src/documents/walk.js";

// What the walk of a granted folder — the home folder above all — never
// enters or reads.

const root = mkdtempSync(join(tmpdir(), "twoody-walk-"));
after(() => {
  try { chmodSync(join(root, "Locked"), 0o755); } catch { /* the permission test was skipped */ }
  rmSync(root, { recursive: true, force: true });
});

function file(path: string, text = "Un document.") {
  mkdirSync(dirname(join(root, path)), { recursive: true });
  writeFileSync(join(root, path), text);
}

test("keys, application data, developer trees, caches, libraries and applications are skipped", () => {
  for (const name of [".ssh", ".gnupg", ".aws", ".git", ".cache", ".Trash", "Library", "library", "AppData", "Keychains", "node_modules", "__pycache__", "Caches", "Applications",
    "Photos Library.photoslibrary", "Music Library.musiclibrary", "Twoody.app", "Morceau.logicx", "Chanson.band"]) {
    assert.equal(skipDirectory(name), true, name);
  }
  for (const name of ["Documents", "Downloads", "Desktop", "Factures 2026", "OneDrive", "Mobile Documents", "Photos", "Music", "app", "Rapport.appendix"]) {
    assert.equal(skipDirectory(name), false, name);
  }
  for (const name of [".env.txt", "~$rapport.docx", "credentials.txt", "secrets.md", "token-github.txt", "passwords.csv", "service-account.json"]) {
    assert.equal(skipFile(name), true, name);
  }
  for (const name of ["Rapport.pdf", "Contrat.docx", "notes.txt"]) assert.equal(skipFile(name), false, name);
});

test("walking a home folder reads the documents and leaves the rest", async () => {
  for (const kept of ["Documents/Contrat.txt", "Downloads/Facture.txt", "Desktop/Notes.md", "Documents/Projets/site/README.md"]) file(kept);
  for (const left of [
    ".ssh/id_ed25519.txt", ".aws/credentials.txt", "Library/Keychains/login.txt", "Library/Mail/message.txt",
    "Documents/Projets/site/node_modules/pkg/README.md", "Documents/Projets/site/.git/HEAD.txt",
    "Pictures/Photos Library.photoslibrary/database/notes.txt", "Music/Music Library.musiclibrary/notes.txt",
    "Applications/Outil.app/Contents/notes.txt", "Documents/secrets.txt", ".notes.txt",
  ]) file(left);
  symlinkSync(join(root, "Library"), join(root, "Documents", "raccourci"));

  const { files, limited, denied } = await walk(root);
  assert.deepEqual(files.map((path) => relative(root, path)).sort(), ["Desktop/Notes.md", "Documents/Contrat.txt", "Documents/Projets/site/README.md", "Downloads/Facture.txt"]);
  assert.equal(limited, false);
  assert.deepEqual(denied, []);
});

test("a folder the system refuses is named, not silently empty", { skip: process.getuid?.() === 0 }, async () => {
  file("Locked/Secret.txt");
  chmodSync(join(root, "Locked"), 0o000);
  assert.equal(await folderReadable(join(root, "Locked")), false);
  assert.equal(await folderReadable(join(root, "Documents")), true);
  assert.equal(await folderReadable(join(root, "Absent")), true); // left to canonicalFolder: not_found
  const { denied } = await walk(root);
  assert.deepEqual(denied, [join(root, "Locked")]);
});

test("a full folder keeps what it indexed, always takes a file added since, and leaves granted subfolders out", async () => {
  const full = mkdtempSync(join(tmpdir(), "twoody-walk-full-"));
  try {
    const { utimesSync } = await import("node:fs");
    const old = new Date("2025-01-01T00:00:00Z");
    for (let index = 0; index < 6; index += 1) {
      writeFileSync(join(full, `vieux-${index}.txt`), "Un document.");
      utimesSync(join(full, `vieux-${index}.txt`), old, old);
    }
    mkdirSync(join(full, "Downloads"));
    writeFileSync(join(full, "Downloads", "facture.txt"), "Une facture.");
    const first = await walk(full, 4, { skip: [join(full, "Downloads")] });
    assert.equal(first.limited, true);
    assert.equal(first.files.length, 4);
    assert.ok(first.files.every((path) => !path.includes("Downloads")));

    // Read at noon; a file arrives afterwards: it is taken, past the limit.
    const since = Date.parse("2025-06-01T12:00:00Z");
    writeFileSync(join(full, "nouveau.txt"), "Ajouté après.");
    const second = await walk(full, 4, { skip: [join(full, "Downloads")], keep: new Set(first.files), since });
    assert.ok(second.files.includes(join(full, "nouveau.txt")));
    for (const path of first.files) assert.ok(second.files.includes(path), path);
    assert.equal(second.files.length, 5);
  } finally {
    rmSync(full, { recursive: true, force: true });
  }
});

test("a OneDrive file on Windows, which Node lists as a link, is read; a real link is still not followed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-walk-onedrive-"));
  try {
    writeFileSync(join(dir, "facture.pdf"), "%PDF");
    mkdirSync(join(dir, "Projets"));
    symlinkSync(join(dir, "facture.pdf"), join(dir, "lien.pdf"));
    // What Windows gives for a OneDrive entry: a reparse point, « a link ».
    const reparse = (name: string) => ({ name, isDirectory: () => false, isFile: () => false, isSymbolicLink: () => true }) as unknown as import("node:fs").Dirent;
    assert.equal(await entryKind(reparse("facture.pdf"), join(dir, "facture.pdf"), "win32"), "file");
    assert.equal(await entryKind(reparse("Projets"), join(dir, "Projets"), "win32"), "dir");
    assert.equal(await entryKind(reparse("lien.pdf"), join(dir, "lien.pdf"), "win32"), null);
    assert.equal(await entryKind(reparse("facture.pdf"), join(dir, "facture.pdf"), "darwin"), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a video dropped in a folder is not a document, and is counted as left out", async () => {
  const dir = mkdtempSync(join(process.cwd(), "tmp-walk-video-"));
  try {
    writeFileSync(join(dir, "vacances.mp4"), "....");
    writeFileSync(join(dir, ".DS_Store"), "");
    const scan = await walk(dir);
    assert.deepEqual(scan.files, []);
    assert.equal(scan.ignored, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
