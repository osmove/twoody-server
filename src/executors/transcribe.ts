// `transcribe` bridge task — local speech-to-text via whisper.cpp.
//
// Counterpart to the HTTP `/audio/transcriptions` route, but routed
// through the cloud bridge queue so an iPhone talking to
// api.twoody.com can have STT done on the user's household Pi
// instead of an OpenAI / Google service.
//
// Args: { audio_base64, language?, mime? }
// Returns: { text }
//
// Audio is decoded from base64 (5 MB cap to stay friendly to the
// bridge JSON envelope) and written to a temp file. Same env-driven
// whisper config as the HTTP route: WHISPER_BIN / WHISPER_MODEL /
// WHISPER_THREADS.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DEFAULT_BIN   = "/home/pi/whisper.cpp/build/bin/whisper-cli";
const DEFAULT_MODEL = "/home/pi/whisper.cpp/models/ggml-base.bin";
const DEFAULT_THREADS = 4;
const MAX_AUDIO_BYTES = 5 * 1024 * 1024;

function whisperBin(): string {
  return process.env.WHISPER_BIN?.trim() || DEFAULT_BIN;
}
function whisperModel(): string {
  return process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL;
}
function whisperThreads(): number {
  const n = parseInt(process.env.WHISPER_THREADS ?? "", 10);
  return Math.max(1, Math.min(Number.isFinite(n) ? n : DEFAULT_THREADS, 16));
}

export function whisperReady(): boolean {
  return existsSync(whisperBin()) && existsSync(whisperModel());
}

function runWhisper(audioPath: string, outBase: string, language: string | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const args = [
      "-m", whisperModel(),
      "-f", audioPath,
      "-of", outBase,
      "-otxt",
      "-nt",
      "-t", String(whisperThreads()),
      "-l", language?.trim() || "auto",
    ];
    const proc = spawn(whisperBin(), args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper exit=${code}: ${stderr.slice(-400)}`));
    });
  });
}

export async function runTranscribe(args: Record<string, unknown>) {
  if (!whisperReady()) {
    throw new Error("whisper_not_configured");
  }

  const raw = String(args.audio_base64 ?? "");
  if (!raw) throw new Error("audio_base64 is required");
  const language = typeof args.language === "string" ? args.language : undefined;
  const mime = typeof args.mime === "string" ? args.mime : "audio/wav";

  const buffer = Buffer.from(raw, "base64");
  if (buffer.byteLength === 0) throw new Error("audio_base64_decode_failed");
  if (buffer.byteLength > MAX_AUDIO_BYTES) {
    throw new Error(`audio_too_large size=${buffer.byteLength} cap=${MAX_AUDIO_BYTES}`);
  }

  // Pick a reasonable extension so whisper.cpp's loader (which sniffs
  // by content but still respects the filename) finds the right
  // demuxer. Defaults to .wav.
  const ext = mime.includes("mp3") ? ".mp3"
    : mime.includes("m4a") || mime.includes("aac") ? ".m4a"
    : mime.includes("ogg") || mime.includes("opus") ? ".ogg"
    : mime.includes("webm") ? ".webm"
    : ".wav";

  const dir = await mkdtemp(join(tmpdir(), "twoody-bridge-stt-"));
  const audioPath = join(dir, `input${ext}`);
  const outBase = join(dir, "out");
  await writeFile(audioPath, buffer);

  try {
    await runWhisper(audioPath, outBase, language);
    const text = (await readFile(`${outBase}.txt`, "utf8")).trim();
    return { text };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}
