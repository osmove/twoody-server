import { test } from "node:test";
import assert from "node:assert/strict";
import { folderRisk } from "../src/documents/folderRisk.js";

test("on the Mac: a disk, the home folder and what holds it, the system, ~/Library and hidden folders are refused", () => {
  const home = "/Users/claire";
  assert.equal(folderRisk("/", home, "darwin"), "too_broad");
  assert.equal(folderRisk(home, home, "darwin"), "too_broad");
  assert.equal(folderRisk("/Users", home, "darwin"), "too_broad");
  assert.equal(folderRisk("/private/tmp/scans", home, "darwin"), "sensitive");
  assert.equal(folderRisk("/Users/claire/Library/Mail", home, "darwin"), "sensitive");
  assert.equal(folderRisk("/Users/claire/Documents/.git", home, "darwin"), "sensitive");
  assert.equal(folderRisk("/Users/claire/Documents/Contrats", home, "darwin"), null);
  assert.equal(folderRisk("/Volumes/Archives/Dossiers", home, "darwin"), null);
});

test("on Linux: the same, with /home", () => {
  const home = "/home/claire";
  assert.equal(folderRisk("/home", home, "linux"), "too_broad");
  assert.equal(folderRisk("/etc", home, "linux"), "sensitive");
  assert.equal(folderRisk("/home/claire/.config/app", home, "linux"), "sensitive");
  assert.equal(folderRisk("/home/claire/Documents", home, "linux"), null);
  assert.equal(folderRisk("/mnt/data/Contrats", home, "linux"), null);
});

test("on Windows: a drive, C:\\Users, the system folders and AppData are refused, whatever the case", () => {
  const home = "C:\\Users\\Claire";
  assert.equal(folderRisk("C:\\", home, "win32"), "too_broad");
  assert.equal(folderRisk("D:\\", home, "win32"), "too_broad");
  assert.equal(folderRisk("C:\\Users", home, "win32"), "too_broad");
  assert.equal(folderRisk("c:\\users\\claire", home, "win32"), "too_broad");
  assert.equal(folderRisk("C:\\Windows\\Temp", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\Program Files\\Twoody", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\ProgramData\\Microsoft", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\Users\\Claire\\AppData\\Roaming\\Mozilla", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\Users\\Claire\\appdata\\Local", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\Users\\Claire\\Documents\\.secrets", home, "win32"), "sensitive");
  assert.equal(folderRisk("C:\\Users\\Claire\\Documents\\Contrats", home, "win32"), null);
  assert.equal(folderRisk("D:\\Archives\\Dossiers", home, "win32"), null);
  assert.equal(folderRisk("\\\\nas\\partage\\Contrats", home, "win32"), null);
});

test("personal-files opt-in permits only the exact home, never a disk or an ancestor", () => {
 for (const [home,root,ancestor,platform] of [["/Users/alex","/","/Users","darwin"],["C:\\Users\\Alex","C:\\","C:\\Users","win32"]] as const) {
  assert.equal(folderRisk(home,home,platform,true),null);
  assert.equal(folderRisk(root,home,platform,true),"too_broad");
  assert.equal(folderRisk(ancestor,home,platform,true),"too_broad");
 }
 assert.equal(folderRisk('/Users/alex/.ssh','/Users/alex','darwin',true),'sensitive');
});
