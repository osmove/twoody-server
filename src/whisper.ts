import { spawn } from "node:child_process";
import { access, mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { constants, existsSync } from "node:fs";

// whisper-cpp shell-out for the local audio path. Twoody Desktop ships the
// binary and names it, with its model, in TWOODY_WHISPER_BINARY and
// TWOODY_WHISPER_MODEL; elsewhere we assume `whisper-cli` on PATH (brew
// install whisper-cpp) and at least one ggml model under
// `~/.twoody/whisper-models/` or pointed at by `TWOODY_WHISPER_MODEL`. Failure modes are surfaced
// as a dedicated `WhisperUnavailableError` so the route handler can
// return a 501 (vs 422 for "ran but no speech") and the client UI
// can guide the user toward the install step.
//
// Why shell-out vs an N-API binding: whisper.cpp's Node bindings are
// either out-of-date with current model formats or require manual
// build steps that break Docker / brew installs. The CLI is stable
// across whisper.cpp versions and one less native module to maintain.

export class WhisperUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WhisperUnavailableError";
  }
}

const DEFAULT_BINARY = process.env.TWOODY_WHISPER_BINARY ?? "whisper-cli";
const DEFAULT_MODEL_DIR = process.env.TWOODY_WHISPER_MODEL_DIR
  ?? join(process.env.HOME ?? "", ".twoody", "whisper-models");

/// « fr-FR », « fr » → the language whisper.cpp is told (« fr »); null
/// lets it guess — which a few seconds of French often get wrong.
export function speechLanguage(locale: string | null | undefined): string | null {
  const primary = locale?.trim().split(/[-_]/)[0]?.toLowerCase();
  return primary && /^[a-z]{2,3}$/.test(primary) ? primary : null;
}

/// The region the Mac's recognizer wants: « fr » → « fr-FR ».
export function speechLocale(locale: string | null | undefined): string {
  const tag = locale?.trim().replace(/_/g, "-");
  if (tag && /^[a-z]{2,3}-[A-Za-z]{2}$/i.test(tag)) return tag;
  const language = speechLanguage(tag) ?? "fr";
  return { fr: "fr-FR", en: "en-US", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-PT", nl: "nl-NL" }[language] ?? language;
}

/// This Mac's own speech recognition (twoody-desktop native/speech, named
/// by TWOODY_SPEECH_HELPER), on the computer only: the text, "" for no
/// speech, or null when it cannot (no permission, no on-device model for
/// this language) — Whisper then.
export async function transcribeOnDevice(audio: Buffer, locale: string | null | undefined, helper = process.env.TWOODY_SPEECH_HELPER?.trim()): Promise<string | null> {
  if (!helper || !existsSync(helper) || audioKind(audio) !== "wav") return null;
  const dir = await mkdtemp(join(tmpdir(), "twoody-speech-"));
  try {
    const file = join(dir, "speech.wav");
    await writeFile(file, audio);
    const output = await new Promise<string>((resolve) => {
      const child = spawn(helper, ["transcribe", file, "--locale", speechLocale(locale)], { windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      const timer = setTimeout(() => child.kill(), 120_000);
      child.stdout?.on("data", (chunk) => (out += chunk.toString()));
      child.on("error", () => { clearTimeout(timer); resolve(""); });
      child.on("exit", () => { clearTimeout(timer); resolve(out); });
    });
    const parsed = JSON.parse(output.trim().split("\n").pop() || "{}") as { text?: unknown; error?: unknown };
    if (typeof parsed.text === "string") return parsed.text.trim();
    if (parsed.error === "no_speech") return "";
    return null;
  } catch {
    return null;
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/// A voice message to text: the device's recognizer first where there is
/// one (Jimmy, 02/10/2026: « utiliser la transcription depuis l'appareil
/// si disponible, en priorité »), whisper.cpp otherwise, told the language.
export async function transcribeSpeech(audio: Buffer, options: { locale?: string | null } = {}): Promise<string> {
  const native = await transcribeOnDevice(audio, options.locale);
  if (native !== null) return native;
  return transcribeWavWithWhisperCpp(audio, { language: speechLanguage(options.locale) });
}

export async function transcribeWavWithWhisperCpp(audio: Buffer, options: { language?: string | null } = {}): Promise<string> {
  if (!audio || audio.length === 0) {
    throw new Error("empty_audio");
  }

  // Pick a model: explicit env override first, otherwise the first
  // .bin file we find in the conventional model dir. "first .bin"
  // is good enough for self-hosted use; once we ship a config UI the
  // user picks which one.
  const modelPath = await pickModelPath();
  if (!modelPath) {
    throw new WhisperUnavailableError(
      "No whisper model found. " +
        "Install one via `bash <(curl -L https://raw.githubusercontent.com/ggerganov/whisper.cpp/master/models/download-ggml-model.sh) base.en` " +
        `into ${DEFAULT_MODEL_DIR} or set TWOODY_WHISPER_MODEL.`
    );
  }

  if (!(await binaryExists(DEFAULT_BINARY))) {
    throw new WhisperUnavailableError(
      `whisper binary "${DEFAULT_BINARY}" not on PATH. ` +
        "Install with `brew install whisper-cpp` or set TWOODY_WHISPER_BINARY."
    );
  }

  const workDir = await mkdtemp(join(tmpdir(), "twoody-stt-"));
  // The extension says what the bytes are: afconvert reads it.
  const kind = audioKind(audio);
  const rawPath = join(workDir, `input.${kind === "unknown" ? "raw" : kind}`);
  const wavPath = join(workDir, "converted.wav");
  const outputPath = join(workDir, "out");
  try {
    await writeFile(rawPath, audio);

    // whisper.cpp's CLI only reads 16-bit PCM WAV. Anything else
    // (m4a/aac from iOS, webm/opus from MediaRecorder in the
    // desktop app, mp3 from the firmware fallback) needs a
    // pre-pass through ffmpeg. We always run the conversion when
    // ffmpeg is on PATH — the cost is ~50 ms for a few-second
    // recording and it removes a whole class of "client format
    // happens to match the model" footguns. The original WAV path
    // still works as a fallback when ffmpeg is missing.
    const inputPath = await ensureWavOrPassthrough(audio, rawPath, wavPath);
    await runWhisper(DEFAULT_BINARY, [
      "-m", modelPath,
      "-f", inputPath,
      "-otxt",
      "-of", outputPath,
      "-l", options.language ?? "auto",
      // -nt: no timestamps in the output text
      "-nt",
    ]);
    const text = await readFile(`${outputPath}.txt`, "utf-8").catch(() => "");
    return text.trim();
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

/// Decide whether the input buffer needs an ffmpeg pre-pass before
/// hitting whisper.cpp. WAV (RIFF) bytes go straight through; anything
/// else gets converted to 16 kHz mono 16-bit WAV via ffmpeg. The
/// audio is already on disk at `rawPath`; the converted output (when
/// it happens) lands at `wavPath`. Returns the path whisper should
/// read.
async function ensureWavOrPassthrough(
  audio: Buffer,
  rawPath: string,
  wavPath: string,
): Promise<string> {
  const kind = audioKind(audio);
  const converter = converterFor(kind, {
    ffmpeg: kind !== "wav" && (await binaryExists("ffmpeg")),
    afconvert: kind !== "wav" && process.platform === "darwin" && existsSync(AFCONVERT),
  });
  if (converter === "passthrough") return rawPath;
  if (converter === "afconvert") {
    await run(AFCONVERT, ["-f", "WAVE", "-d", "LEI16@16000", "-c", "1", rawPath, wavPath], "afconvert");
    return wavPath;
  }
  if (converter === null) {
    throw new WhisperUnavailableError(
      "Audio is not WAV and ffmpeg isn't on PATH. " +
        "Install with `brew install ffmpeg` so the server can convert " +
        "iPhone m4a / desktop webm uploads before whisper.cpp."
    );
  }

  await runFfmpeg([
    "-y",
    "-loglevel", "error",
    "-i", rawPath,
    "-ar", "16000",
    "-ac", "1",
    "-c:a", "pcm_s16le",
    wavPath,
  ]);
  return wavPath;
}

/// What whisper.cpp writes for sounds that are not speech — [BLANK_AUDIO],
/// [Music], (silence)… — taken out: a recording of nothing is no message.
export function withoutNonSpeech(text: string): string {
  return text
    .replace(/\[(?:blank_audio|silence|music|noise|inaudible|sound|applause|laughter)[^\]]*\]/gi, " ")
    .replace(/\((?:silence|music|noise|inaudible|bruit|musique)[^)]*\)/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/// macOS's own converter: it reads the iPhone's m4a (not WebM), and it is
/// on every Mac, where ffmpeg is not. The desktop app sends WAV already.
const AFCONVERT = "/usr/bin/afconvert";

export type AudioKind = "wav" | "m4a" | "caf" | "mp3" | "ogg" | "webm" | "unknown";

/// What the bytes are, from their first ones. Cheap sniff — no need to
/// parse the container to decide how to convert it.
export function audioKind(buffer: Buffer): AudioKind {
  const ascii = (start: number, end: number) => buffer.subarray(start, end).toString("latin1");
  if (buffer.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 12) === "WAVE") return "wav";
  if (buffer.length >= 12 && ascii(4, 8) === "ftyp") return "m4a";
  if (buffer.length >= 4 && ascii(0, 4) === "caff") return "caf";
  if (buffer.length >= 4 && ascii(0, 4) === "OggS") return "ogg";
  if (buffer.length >= 4 && buffer[0] === 0x1a && buffer[1] === 0x45 && buffer[2] === 0xdf && buffer[3] === 0xa3) return "webm";
  if (buffer.length >= 3 && (ascii(0, 3) === "ID3" || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0))) return "mp3";
  return "unknown";
}

/// How audio of this kind reaches whisper.cpp: as it is when it is WAV,
/// through ffmpeg when there is one, through afconvert for what it reads
/// (not WebM, not Ogg). Null: nothing here can convert it.
export function converterFor(kind: AudioKind, tools: { ffmpeg: boolean; afconvert: boolean }): "passthrough" | "ffmpeg" | "afconvert" | null {
  if (kind === "wav") return "passthrough";
  if (tools.ffmpeg) return "ffmpeg";
  if (tools.afconvert && (kind === "m4a" || kind === "caf" || kind === "mp3")) return "afconvert";
  return null;
}

function run(binary: string, args: string[], label: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`${label} exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

async function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("ffmpeg", args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}

async function pickModelPath(): Promise<string | null> {
  const explicit = process.env.TWOODY_WHISPER_MODEL?.trim();
  if (explicit && existsSync(explicit)) return explicit;

  if (!existsSync(DEFAULT_MODEL_DIR)) return null;
  const entries = await readdir(DEFAULT_MODEL_DIR);
  const ggml = entries
    .filter((name) => name.endsWith(".bin") || name.endsWith(".gguf"))
    .sort();
  if (ggml.length === 0) return null;
  return join(DEFAULT_MODEL_DIR, ggml[0]);
}

async function binaryExists(name: string): Promise<boolean> {
  // A path (the tool Twoody Desktop ships) is looked at; a name is looked
  // for on PATH — with `where` on Windows, which has no `which`.
  if (isAbsolute(name)) {
    return access(name, constants.X_OK).then(() => true, () => false);
  }
  return new Promise((resolve) => {
    const child = spawn(process.platform === "win32" ? "where" : "which", [name], { windowsHide: true, stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function runWhisper(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    // The text goes to a file (-otxt): nothing read on stdout, which must
    // not fill up and hold the child; and never more than three minutes.
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-4000);
    });
    const timer = setTimeout(() => child.kill(), 180_000);
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(signal ? `whisper stopped (${signal})` : `whisper exited ${code}: ${stderr.trim().split("\n").slice(-3).join(" ").slice(0, 400)}`));
    });
  });
}
