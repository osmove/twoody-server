import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

// whisper-cpp shell-out for the local audio path. We assume the user
// has the `whisper-cpp` binary on PATH (brew install whisper-cpp) and
// at least one ggml model under `~/.twoody/whisper-models/` or pointed
// at by the `TWOODY_WHISPER_MODEL` env var. Failure modes are surfaced
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

export async function transcribeWavWithWhisperCpp(audio: Buffer): Promise<string> {
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
  const inputPath = join(workDir, "input.wav");
  const outputPath = join(workDir, "out");
  try {
    await writeFile(inputPath, audio);
    await runWhisper(DEFAULT_BINARY, [
      "-m", modelPath,
      "-f", inputPath,
      "-otxt",
      "-of", outputPath,
      "-l", "auto",
      // -nt: no timestamps in the output text
      "-nt",
    ]);
    const text = await readFile(`${outputPath}.txt`, "utf-8").catch(() => "");
    return text.trim();
  } finally {
    await rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
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
  return new Promise((resolve) => {
    const child = spawn("which", [name], { stdio: "ignore" });
    child.on("error", () => resolve(false));
    child.on("exit", (code) => resolve(code === 0));
  });
}

async function runWhisper(binary: string, args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`whisper exited ${code}: ${stderr.trim().slice(0, 400)}`));
    });
  });
}
