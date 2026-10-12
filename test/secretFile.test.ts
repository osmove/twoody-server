// The secret files next to the database sealed at rest inside Twoody Desktop
// (12/10/2026, secretFile.ts): HKDF-SHA256 of the database key with an info
// per file, AES-256-GCM with the file's name as associated data. Files an
// earlier version wrote in clear are sealed in place — sealed, read back,
// then the clear file put aside for the Trash, never deleted — and a sealed
// file this run cannot open is never written over. Without a key (a server
// on its own) the files stay as they were.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-secret-files-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const {
  fileKey,
  isSealedText,
  openText,
  readSecretFile,
  removeSecretFile,
  sealSecretFilesInPlace,
  sealText,
  SECRET_FILES,
  secretFileContent,
  SecretFileLockedError,
  unsealedAsides,
  useSecretFileKey,
  writeSecretFile,
} = await import("../src/secretFile.ts");

const KEY = "7e".repeat(32);
const ROOT = Buffer.from(KEY, "hex");
const TOKEN = "1//refresh-Zanzibar-portail-4317";

function dir(): string {
  return mkdtempSync(join(tmpdir(), "twoody-secret-files-"));
}

test("the format: HKDF-SHA256 then AES-256-GCM, the same vector as the Desktop's", () => {
  // twoody-desktop test/secretFile.test.mjs holds the same two lines.
  assert.equal(fileKey(ROOT, "connectors.json").toString("hex"), "c1a57f3a71000b7db8a9c28de1093d8e7699a32a3dca13873d5b6ddf406f00de");
  assert.equal(
    sealText(ROOT, "connectors.json", '{"a":1}', Buffer.alloc(12, 1)),
    '{"twoody":"sealed-file","v":1,"alg":"HKDF-SHA256+AES-256-GCM","iv":"AQEBAQEBAQEBAQEB","tag":"jHwZYpoqstlw3DIiVFTxSQ==","data":"3orJKnz3uw=="}',
  );
  // A different key per file, none the database's.
  assert.notEqual(fileKey(ROOT, "account.json").toString("hex"), fileKey(ROOT, "connectors.json").toString("hex"));
  assert.notEqual(fileKey(ROOT, "account.json").toString("hex"), KEY);
});

test("a sealed file opens only with its key, under its own name, unaltered", () => {
  const sealed = sealText(ROOT, "google-data.json", JSON.stringify({ refresh: TOKEN }));
  assert.ok(isSealedText(sealed));
  assert.ok(!sealed.includes(TOKEN));
  assert.equal(JSON.parse(openText(ROOT, "google-data.json", sealed)).refresh, TOKEN);
  // Another file's place, another key, a byte changed: none opens.
  assert.throws(() => openText(ROOT, "microsoft-graph.json", sealed));
  assert.throws(() => openText(Buffer.from("c4".repeat(32), "hex"), "google-data.json", sealed));
  const envelope = JSON.parse(sealed);
  const data = Buffer.from(envelope.data, "base64");
  data[0] ^= 1;
  assert.throws(() => openText(ROOT, "google-data.json", JSON.stringify({ ...envelope, data: data.toString("base64") })));
  // Two seals of the same text differ (a nonce drawn each time).
  assert.notEqual(sealText(ROOT, "a.json", "x"), sealText(ROOT, "a.json", "x"));
});

test("with the key, what is written is sealed and reads back; without it, a sealed file is never written over", () => {
  const at = dir();
  const path = join(at, "email-credentials.json");
  useSecretFileKey(KEY);
  writeSecretFile(path, JSON.stringify({ box: { refreshToken: TOKEN } }));
  const raw = readFileSync(path, "utf8");
  assert.ok(isSealedText(raw) && !raw.includes(TOKEN));
  if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(JSON.parse(readSecretFile(path)!).box.refreshToken, TOKEN);
  assert.equal(readSecretFile(join(at, "missing.json")), null);

  useSecretFileKey(null);
  assert.throws(() => readSecretFile(path), SecretFileLockedError);
  assert.throws(() => secretFileContent(path, "{}"), SecretFileLockedError);
  assert.throws(() => writeSecretFile(path, "{}"), SecretFileLockedError);
  assert.throws(() => removeSecretFile(path), SecretFileLockedError);
  assert.equal(readFileSync(path, "utf8"), raw);
  // A clear file without a key: as before (a server on its own).
  const clear = join(at, "warm-seeds.json");
  writeSecretFile(clear, '{"seed":1}');
  assert.equal(readFileSync(clear, "utf8"), '{"seed":1}');
  assert.equal(readSecretFile(clear), '{"seed":1}');
});

test("clear files of an earlier version sealed in place: read back, the clear copies put aside together, nothing deleted", () => {
  const at = dir();
  const contents: Record<string, string> = {
    "connectors.json": JSON.stringify({ u: [{ id: "c1", oauth: { refresh_token: TOKEN } }] }, null, 2),
    "account.json": JSON.stringify({ device_token: "d", pairing_key: { priv: "ab".repeat(32), pub: "cd".repeat(32) }, approvers: [] }),
    "warm-seeds.json": JSON.stringify({ k: { input: { name: "Claire Martin", folders: ["/Users/claire/Factures"] } } }),
  };
  for (const [name, text] of Object.entries(contents)) writeFileSync(join(at, name), text, { mode: 0o600 });
  writeFileSync(join(at, "unrelated.json"), "{}");
  useSecretFileKey(KEY);
  const result = sealSecretFilesInPlace(at, SECRET_FILES, { now: new Date("2026-10-12T09:00:00Z") });
  assert.deepEqual(result.sealed.sort(), Object.keys(contents).sort());
  assert.deepEqual(result.failed, []);
  assert.equal(result.aside, join(at, "secrets.unsealed-2026-10-12T09-00-00-000Z"));
  for (const [name, text] of Object.entries(contents)) {
    const raw = readFileSync(join(at, name), "utf8");
    assert.ok(isSealedText(raw), name);
    assert.ok(!raw.includes("Claire") && !raw.includes(TOKEN), name);
    assert.equal(readSecretFile(join(at, name)), text);
    // The clear copy, whole, in the folder for the Trash.
    assert.equal(readFileSync(join(result.aside!, name), "utf8"), text);
  }
  assert.equal(readFileSync(join(at, "unrelated.json"), "utf8"), "{}");
  assert.deepEqual(unsealedAsides(at), [result.aside]);
  assert.ok(!readdirSync(at).some((name) => name.endsWith(".sealing")));
  // Again: nothing more to do.
  assert.deepEqual(sealSecretFilesInPlace(at).sealed, []);
  useSecretFileKey(null);
});

test("cut off between the two renames: the checked sealed copy goes in; one that does not open gives the clear file back", () => {
  const at = dir();
  useSecretFileKey(KEY);
  // The clear file already put aside, the sealed copy waiting.
  const aside = join(at, "secrets.unsealed-2026-10-12T08-00-00-000Z");
  mkdirSync(aside);
  writeFileSync(join(aside, "google-data.json"), '{"g":1}');
  writeFileSync(join(at, "google-data.json.sealing"), sealText(ROOT, "google-data.json", '{"g":1}'));
  // The same, but its sealed copy damaged.
  writeFileSync(join(aside, "microsoft-graph.json"), '{"m":1}');
  writeFileSync(join(at, "microsoft-graph.json.sealing"), "garbage");
  const result = sealSecretFilesInPlace(at);
  assert.equal(readSecretFile(join(at, "google-data.json")), '{"g":1}');
  assert.ok(isSealedText(readFileSync(join(at, "google-data.json"), "utf8")));
  // Given back, then sealed in this same run.
  assert.equal(readSecretFile(join(at, "microsoft-graph.json")), '{"m":1}');
  assert.ok(result.sealed.includes("microsoft-graph.json"));
  assert.ok(!existsSync(join(at, "microsoft-graph.json.sealing")));
  // A file the person removed never comes back from a copy put aside.
  writeFileSync(join(aside, "connectors.json"), '{"old":1}');
  sealSecretFilesInPlace(at);
  assert.equal(existsSync(join(at, "connectors.json")), false);
  useSecretFileKey(null);
});

test("without a key nothing is sealed", () => {
  const at = dir();
  writeFileSync(join(at, "connectors.json"), "{}");
  useSecretFileKey(null);
  assert.deepEqual(sealSecretFilesInPlace(at), { sealed: [], aside: null, failed: [] });
  assert.equal(readFileSync(join(at, "connectors.json"), "utf8"), "{}");
});

test("the server's own files go through it: a Google link and a mailbox's secret sealed on disk, read back", async () => {
  const dataDir = process.env.TWOODY_DATA_DIR!;
  const { keepGoogleDataLink, googleDataRefreshToken, forgetGoogleDataLink } = await import("../src/google/dataLink.ts");
  const { keepMailSecret, mailSecret } = await import("../src/email/credentials.ts");
  const { ensureAccountFile, readAccountFile } = await import("../src/account/store.ts");
  useSecretFileKey(KEY);
  const link = keepGoogleDataLink("u1", { address: "claire.martin@tessane.example", scopes: ["https://www.googleapis.com/auth/analytics.readonly"], refreshToken: TOKEN });
  keepMailSecret("box-1", { kind: "password", password: "Zanzibar-portail-4317" });
  const account = ensureAccountFile();
  for (const name of ["google-data.json", "email-credentials.json", "account.json"]) {
    const raw = readFileSync(join(dataDir, name), "utf8");
    assert.ok(isSealedText(raw), name);
    assert.ok(!raw.includes("Zanzibar") && !raw.includes("tessane") && !raw.includes(account.pairing_key.priv), name);
  }
  assert.equal(googleDataRefreshToken("u1", link.id), TOKEN);
  assert.deepEqual(mailSecret("box-1"), { kind: "password", password: "Zanzibar-portail-4317" });
  assert.equal(readAccountFile()?.pairing_key.priv, account.pairing_key.priv);
  // Without the key, the account file is not made again over the sealed one.
  useSecretFileKey(null);
  assert.equal(readAccountFile(), null);
  assert.throws(() => ensureAccountFile(), SecretFileLockedError);
  useSecretFileKey(KEY);
  assert.equal(readAccountFile()?.pairing_key.priv, account.pairing_key.priv);
  assert.equal(forgetGoogleDataLink("u1"), true);
  assert.equal(existsSync(join(dataDir, "google-data.json")), false);
  useSecretFileKey(null);
  // Renaming the sealed file in another's place does not open it.
  renameSync(join(dataDir, "email-credentials.json"), join(dataDir, "microsoft-graph.json"));
  useSecretFileKey(KEY);
  assert.throws(() => readSecretFile(join(dataDir, "microsoft-graph.json")));
  useSecretFileKey(null);
});
