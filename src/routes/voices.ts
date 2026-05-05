import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";

// `/voices/:slug/sample` is the cloud's voice-preview endpoint — the
// app's voice picker calls it when the user taps a voice tile to
// audition it. Self-hosted mode doesn't ship a TTS library by default
// (would mean shelling out to coqui / piper / system AVSpeech, all
// platform-specific), so we surface a 501 with a clear message rather
// than silently 404'ing. The picker UI gracefully shows "Aperçu
// indisponible" on that response.
//
// When a future release wires a local TTS path, swap the 501 for a
// streaming WAV and clients keep working with no further change.
export async function voiceRoutes(app: FastifyInstance) {
  app.post<{ Params: { slug: string } }>("/voices/:slug/sample", {
    schema: {
      tags: ["queries"],
      summary: "Voice preview (not implemented in self-hosted mode)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      params: {
        type: "object",
        required: ["slug"],
        properties: { slug: { type: "string" } },
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      void req.params.slug;
      reply.code(501).send({
        error: "voice_preview_not_supported",
        message:
          "Self-hosted mode doesn't ship a TTS engine yet. " +
          "Pick a voice on the cloud account if you need previews; " +
          "answers still play through your watch's native voice.",
      });
    },
  });
}
