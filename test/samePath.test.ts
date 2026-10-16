import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

import { foldPath, holds, identitiesOn, pathPlace, realPathOf, spelledFrom, spellingsOf, within } from "../src/documents/samePath.js";

// One comparison for every wall of a walled-off project (src/documents/samePath.ts,
// copied into Twoody Desktop for its Agent and Twoody Code). Attack-style: each
// case is a walled-off folder written another way — another case, « / », a
// device prefix, a trailing dot or an NTFS stream suffix Windows drops, a link,
// a firmlink — and it must still be found « inside ». A neighbour whose name
// only starts the same is never inside. Windows' spellings are folded here on
// any system; Windows itself (8.3 names, junctions, subst drives, this
// computer's own shares) runs in Twoody Desktop's CI (test/samePath.test.mjs).

const TESSANE = "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL";

test("Windows: every way to write the walled-off folder or a file in it is inside it", () => {
  for (const path of [
    TESSANE,
    "c:\\users\\claire\\documents\\clients\\tessane sarl",
    "C:/Users/Claire/Documents/Clients/Tessane SARL/lettre.txt",
    "C:\\USERS\\CLAIRE\\DOCUMENTS\\CLIENTS\\TESSANE SARL\\",
    "\\\\?\\C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL\\lettre.txt",
    "\\\\.\\C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL.\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL . \\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL::$INDEX_ALLOCATION\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL:$I30:$INDEX_ALLOCATION\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Varlin\\..\\Tessane SARL\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\.\\Tessane SARL\\Pièces\\bilan.pdf",
    "C:\\Users\\Claire\\Documents\\Clients\\\\Tessane SARL\\lettre.txt",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL\\lettre.txt::$DATA",
  ]) {
    assert.equal(within(TESSANE, path, "win32"), true, path);
  }
  // A share and its long form are one.
  assert.equal(within("\\\\nas\\cabinet\\Clients\\Tessane", "\\\\?\\UNC\\NAS\\Cabinet\\clients\\tessane\\x.pdf", "win32"), true);
});

test("Windows: a neighbour, a parent, another drive or share is not inside", () => {
  for (const path of [
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARL 2",
    "C:\\Users\\Claire\\Documents\\Clients\\Tessane SARLs\\x",
    "C:\\Users\\Claire\\Documents\\Clients",
    "D:\\Users\\Claire\\Documents\\Clients\\Tessane SARL",
    "\\\\nas\\Users\\Claire\\Documents\\Clients\\Tessane SARL",
    "C:\\Users\\Claire\\Documents\\Clients\\Varlin\\Tessane SARL",
  ]) {
    assert.equal(within(TESSANE, path, "win32"), false, path);
  }
});

test("macOS: another case, another Unicode form, « ß » for « SS »; Linux tells case and forms apart", () => {
  assert.equal(within("/Users/claire/Clients/Tessane", "/users/CLAIRE/clients/tessane/lettre.txt", "darwin"), true);
  assert.equal(within("/Users/claire/Clients/Téssane", "/Users/claire/Clients/Te\u0301ssane/x".normalize("NFD"), "darwin"), true);
  assert.equal(within("/Users/claire/Clients/Großmann", "/Users/claire/Clients/GROSSMANN/x", "darwin"), true);
  assert.equal(within("/Users/claire/Clients/Tessane", "/Users/claire/Clients//./Tessane/x", "darwin"), true);
  assert.equal(within("/Users/claire/Clients/Tessane", "/Users/claire/Clients/Tessane 2", "darwin"), false);
  assert.equal(within("/home/claire/Clients/Tessane", "/home/claire/clients/tessane", "linux"), false);
  assert.equal(within("/home/claire/Clients/Tessane", "/home/claire/Clients/Tessane/x", "linux"), true);
  assert.equal(within("/", "/home", "linux"), true);
  assert.equal(foldPath("/a/b/../c/", "linux"), "/a/c");
});

// The real file system, as this computer has it.
const scratch = mkdtempSync(join(process.cwd(), "tmp-same-path-"));
test.after(() => rmSync(scratch, { recursive: true, force: true }));
const firm = join(realPathOf(scratch), "Cabinet");
const tessane = join(firm, "Clients", "Tessane SARL");
mkdirSync(join(tessane, "Pieces"), { recursive: true });
mkdirSync(join(firm, "Clients", "Varlin"), { recursive: true });
writeFileSync(join(tessane, "lettre-de-mission.txt"), "Honoraires : 7 450 euros.");
// Another way to the firm: a link, as a mapped drive or a short name is on Windows.
const alias = join(realPathOf(scratch), "alias");
symlinkSync(firm, alias);

test("the real path: links followed, the disk's own spelling, the missing rest kept as asked", () => {
  assert.equal(realPathOf(join(alias, "Clients", "Tessane SARL")), tessane);
  assert.equal(realPathOf(join(alias, "Clients", "Tessane SARL", "nouveau", "note.txt")), join(tessane, "nouveau", "note.txt"));
  if (process.platform === "darwin") assert.equal(realPathOf(join(firm, "CLIENTS", "tessane sarl")), tessane, "the disk's own case");
});

test("a walled-off folder reached through a link: inside, however each is written", () => {
  const wall = pathPlace(join(alias, "Clients", "Tessane SARL"));
  for (const path of [join(tessane, "lettre-de-mission.txt"), join(alias, "Clients", "Tessane SARL", "Pieces"), join(firm, "Clients", "Varlin", "..", "Tessane SARL")]) {
    assert.equal(holds(wall, pathPlace(path)), true, path);
  }
  assert.equal(holds(wall, pathPlace(join(firm, "Clients", "Varlin"))), false);
  // The firm's general folder, written the other way, holds it.
  assert.equal(holds(pathPlace(firm), wall), true);
  assert.equal(holds(pathPlace(alias), pathPlace(tessane)), true);
  // Written from the general folder as a walk from it meets it.
  assert.equal(spelledFrom(pathPlace(alias), pathPlace(tessane)), join(alias, "Clients", "Tessane SARL"));
  assert.ok(spellingsOf(pathPlace(tessane), [pathPlace(alias)]).includes(join(alias, "Clients", "Tessane SARL")));
});

test("identity: the same folder under a spelling the real path does not change (macOS: /System/Volumes/Data)", { skip: process.platform !== "darwin" && "a firmlink exists on macOS only" }, () => {
  const dataSpelling = `/System/Volumes/Data${tessane}`;
  const wall = pathPlace(tessane);
  const other = pathPlace(dataSpelling);
  assert.notEqual(foldPath(other.real), foldPath(wall.real), "realpath keeps the firmlink's spelling");
  assert.equal(holds(wall, other), true, "the identity says it is the same folder");
  assert.equal(holds(wall, pathPlace(join(dataSpelling, "lettre-de-mission.txt"))), true);
  assert.ok(identitiesOn(join(dataSpelling, "Pieces")).includes(wall.id!));
});
