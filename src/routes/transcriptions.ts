// `/audio/transcriptions` — local speech-to-text via whisper.cpp.
//
// Wire-compatible with the subset of OpenAI's
// `POST /v1/audio/transcriptions` used by the iPhone/Watch app:
// multipart upload of an audio file, optional `model`, optional
// `language`, returns `{ text: "…" }`. Keeps the household voice
// path local when the user pins the speaker at the Pi instead of
// Google STT / OpenAI's hosted Whisper.
//
// Backed by whisper.cpp's `whisper-cli` binary; configurable via:
//   WHISPER_BIN=/path/to/whisper-cli   (default /home/pi/whisper.cpp/build/bin/whisper-cli)
//   WHISPER_MODEL=/path/to/ggml.bin    (default /home/pi/whisper.cpp/models/ggml-base.bin)
//   WHISPER_THREADS=<n>                (default 4)
//
// The route silently returns 503 `whisper_not_configured` if the
// binary or model isn't on disk, so a vanilla twoody-server install
// without the whisper.cpp dependency keeps booting.

import type { FastifyInstance } from "fastify";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { requireAuth } from "../auth.js";

const DEFAULT_BIN   = "/home/pi/whisper.cpp/build/bin/whisper-cli";
const DEFAULT_MODEL = "/home/pi/whisper.cpp/models/ggml-base.bin";
const DEFAULT_THREADS = 4;
// Match the multipart limit of /queries — 25 MB is also OpenAI's cap.
const MAX_AUDIO_BYTES = 25 * 1024 * 1024;

function whisperConfig() {
  return {
    bin: process.env.WHISPER_BIN?.trim() || DEFAULT_BIN,
    model: process.env.WHISPER_MODEL?.trim() || DEFAULT_MODEL,
    threads: Math.max(1, Math.min(parseInt(process.env.WHISPER_THREADS ?? "", 10) || DEFAULT_THREADS, 16)),
  };
}

function runWhisper(opts: { audioPath: string; outBase: string; language?: string }): Promise<string> {
  const { bin, model, threads } = whisperConfig();
  // -nt (no timestamps), -otxt (write outBase.txt), -of <out prefix>,
  // -l <lang> "auto" lets whisper detect. We pass it explicitly to
  // mirror OpenAI's `language` param when set.
  const args = [
    "-m", model,
    "-f", opts.audioPath,
    "-of", opts.outBase,
    "-otxt",
    "-nt",
    "-t", String(threads),
    "-l", opts.language?.trim() || "auto",
  ];
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    proc.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code === 0) resolve(stderr);
      else reject(new Error(`whisper exit=${code}: ${stderr.slice(-400)}`));
    });
  });
}

export async function transcriptionRoutes(app: FastifyInstance) {
  app.post("/audio/transcriptions", {
    schema: {
      tags: ["queries"],
      summary: "Local speech-to-text via whisper.cpp",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;

      const { bin, model } = whisperConfig();
      if (!existsSync(bin) || !existsSync(model)) {
        return reply.code(503).send({
          error: "whisper_not_configured",
          hint: "Install whisper.cpp and set WHISPER_BIN / WHISPER_MODEL, or run scripts/install-linux.sh on a fresh host.",
        });
      }

      let file: { filename?: string; mimetype?: string; toBuffer: () => Promise<Buffer> } | null = null;
      let language: string | undefined;
      try {
        // @fastify/multipart is already registered in app.ts (25 MB cap).
        const data = await (req as unknown as { file: () => Promise<typeof file> }).file();
        if (!data) {
          return reply.code(422).send({ error: "audio file required" });
        }
        file = data;

        // Multipart fields appear on the file object's `.fields` map
        // for @fastify/multipart; pull `language` if the client set it.
        const fields = (data as unknown as { fields?: Record<string, { value?: string }> }).fields;
        if (fields && typeof fields.language?.value === "string") {
          language = fields.language.value;
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "multipart parse failed";
        return reply.code(422).send({ error: "invalid_multipart", message });
      }

      const buffer = await file!.toBuffer();
      if (buffer.byteLength > MAX_AUDIO_BYTES) {
        return reply.code(413).send({ error: "audio_too_large", max_bytes: MAX_AUDIO_BYTES });
      }

      const dir = await mkdtemp(join(tmpdir(), "twoody-stt-"));
      const inputExt = (file!.filename && extname(file!.filename)) || ".wav";
      const audioPath = join(dir, `input${inputExt}`);
      const outBase = join(dir, "out");
      await writeFile(audioPath, buffer);

      try {
        await runWhisper({ audioPath, outBase, language });
        const txt = await readFile(`${outBase}.txt`, "utf8");
        const text = txt.trim();
        return reply.send({ text });
      } catch (error) {
        const message = error instanceof Error ? error.message : "whisper_failed";
        return reply.code(502).send({ error: "whisper_failed", message });
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => undefined);
      }
    },
  });
}
