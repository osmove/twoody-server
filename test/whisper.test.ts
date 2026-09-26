import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Voice messages reach whisper.cpp as WAV. The desktop app sends WAV; the
// iPhone sends m4a, which a Mac converts with its own afconvert when
// ffmpeg is not there — and on a person's Mac it is not.

test("the kind of a recording is read from its first bytes", async () => {
  const { audioKind } = await import("../src/whisper.js");
  const bytes = (text: string, length = 16) => Buffer.concat([Buffer.from(text, "latin1"), Buffer.alloc(length)]);
  assert.equal(audioKind(bytes("RIFF\0\0\0\0WAVE")), "wav");
  assert.equal(audioKind(bytes("\0\0\0\x20ftypM4A ")), "m4a");
  assert.equal(audioKind(bytes("caff")), "caf");
  assert.equal(audioKind(bytes("OggS")), "ogg");
  assert.equal(audioKind(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), "webm");
  assert.equal(audioKind(bytes("ID3")), "mp3");
  assert.equal(audioKind(bytes("hello")), "unknown");
});

test("WAV goes as it is; ffmpeg converts anything; afconvert what it reads", async () => {
  const { converterFor } = await import("../src/whisper.js");
  assert.equal(converterFor("wav", { ffmpeg: false, afconvert: false }), "passthrough");
  assert.equal(converterFor("webm", { ffmpeg: true, afconvert: true }), "ffmpeg");
  assert.equal(converterFor("m4a", { ffmpeg: false, afconvert: true }), "afconvert");
  assert.equal(converterFor("webm", { ffmpeg: false, afconvert: true }), null, "afconvert does not read WebM");
  assert.equal(converterFor("m4a", { ffmpeg: false, afconvert: false }), null);
});

// A stand-in for whisper-cli: it checks it was handed a WAV and writes
// the transcript where it was told to.
test("an iPhone's m4a is converted on the Mac and transcribed by the whisper-cli it is given", { skip: process.platform !== "darwin" }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "twoody-whisper-"));
  try {
    const fake = join(dir, "whisper-cli");
    writeFileSync(
      fake,
      `#!/bin/sh
while [ $# -gt 0 ]; do case "$1" in -f) in="$2"; shift;; -of) out="$2"; shift;; esac; shift; done
head -c 4 "$in" | grep -q RIFF || { echo "not a WAV: $in" >&2; exit 3; }
echo "Bonjour depuis l'iPhone." > "$out.txt"
`,
    );
    chmodSync(fake, 0o755);
    const model = join(dir, "ggml-test.bin");
    writeFileSync(model, "model");
    // A second of silence, as the iPhone would send it: AAC in an m4a.
    const wav = join(dir, "silence.wav");
    const header = Buffer.alloc(44);
    header.write("RIFF", 0, "latin1"); header.writeUInt32LE(36 + 32000, 4); header.write("WAVEfmt ", 8, "latin1");
    header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36, "latin1"); header.writeUInt32LE(32000, 40);
    writeFileSync(wav, Buffer.concat([header, Buffer.alloc(32000)]));
    const m4a = join(dir, "voice.m4a");
    execFileSync("/usr/bin/afconvert", ["-f", "m4af", "-d", "aac", wav, m4a]);

    process.env.TWOODY_WHISPER_BINARY = fake;
    process.env.TWOODY_WHISPER_MODEL = model;
    // No ffmpeg: afconvert has to do it.
    const path = process.env.PATH;
    process.env.PATH = "/usr/bin:/bin";
    try {
      const { transcribeWavWithWhisperCpp, audioKind } = await import(`../src/whisper.js?binary=${Date.now()}`);
      const audio = readFileSync(m4a);
      assert.equal(audioKind(audio), "m4a");
      assert.equal(await transcribeWavWithWhisperCpp(audio), "Bonjour depuis l'iPhone.");
    } finally {
      process.env.PATH = path;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
