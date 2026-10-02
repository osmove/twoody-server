import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// Dictation (Jimmy, 02/10/2026): the device's own recognizer first where
// there is one (twoody-desktop native/speech on a Mac), Whisper otherwise —
// told the person's language rather than left to guess it.

const dir = mkdtempSync(join(tmpdir(), "twoody-speech-test-"));
const script = (name: string, body: string) => {
  const path = join(dir, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
};
const heard = script("helper-ok", `const a = process.argv.slice(2); console.log(JSON.stringify(a.includes("fr-FR") ? { text: "Allume la guirlande." } : { error: "failed" }));`);
const refused = script("helper-refused", `console.log(JSON.stringify({ error: "not_authorized" })); process.exit(3);`);
const silent = script("helper-silent", `console.log(JSON.stringify({ error: "no_speech" })); process.exit(3);`);
// A whisper that hears English, sure of it at 0.6 (a poor recording of French).
const whisper = script("whisper-cli", `const a = process.argv.slice(2); const l = a[a.indexOf("-l") + 1]; if (l === "auto") process.stderr.write("auto-detected language: en (p = 0.600000)\\n"); require("fs").writeFileSync(a[a.indexOf("-of") + 1] + ".txt", "langue " + l);`);
const model = join(dir, "ggml-small.bin");
writeFileSync(model, "model");
process.env.TWOODY_WHISPER_BINARY = whisper;
process.env.TWOODY_WHISPER_MODEL = model;

const { keepDetected, speechLanguage, speechLocale, transcribeOnDevice, transcribeSpeech } = await import("../src/whisper.js");

const wav = (() => {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "latin1");
  header.writeUInt32LE(36 + 3200, 4);
  header.write("WAVEfmt ", 8, "latin1");
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16_000, 24); header.writeUInt32LE(32_000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write("data", 36, "latin1"); header.writeUInt32LE(3200, 40);
  return Buffer.concat([header, Buffer.alloc(3200)]);
})();

test("the language a person speaks, for each recognizer", () => {
  assert.equal(speechLanguage("fr-FR"), "fr");
  assert.equal(speechLanguage(null), null);
  assert.equal(speechLocale("fr"), "fr-FR");
  assert.equal(speechLocale("fr-CA"), "fr-CA");
  assert.equal(speechLocale(null), "fr-FR");
});

test("the Mac's recognizer first: its words, nothing for silence, and Whisper when it cannot", async () => {
  assert.equal(await transcribeOnDevice(wav, "fr", heard), "Allume la guirlande.");
  assert.equal(await transcribeOnDevice(wav, "fr", silent), "");
  assert.equal(await transcribeOnDevice(wav, "fr", refused), null);
  assert.equal(await transcribeOnDevice(Buffer.from("not a wav"), "fr", heard), null);
  assert.equal(await transcribeOnDevice(wav, "fr", join(dir, "missing")), null);
});

test("Whisper's guess stands for the person's language, or another it is sure of", () => {
  assert.equal(keepDetected("auto-detected language: fr (p = 0.71)", "fr"), true);
  assert.equal(keepDetected("auto-detected language: en (p = 0.962386)", "fr"), true, "someone dictating in English keeps it");
  assert.equal(keepDetected("auto-detected language: en (p = 0.908244)", "fr"), false, "French heard as English: heard again in French");
  assert.equal(keepDetected("", "fr"), false);
});

test("without it, Whisper is told the language when unsure", async () => {
  delete process.env.TWOODY_SPEECH_HELPER;
  assert.equal(await transcribeSpeech(wav, { locale: "fr-FR" }), "langue fr");
  assert.equal(await transcribeSpeech(wav, {}), "langue auto");
  process.env.TWOODY_SPEECH_HELPER = refused;
  assert.equal(await transcribeSpeech(wav, { locale: "fr" }), "langue fr");
  process.env.TWOODY_SPEECH_HELPER = heard;
  assert.equal(await transcribeSpeech(wav, { locale: "fr" }), "Allume la guirlande.");
});
