import type { FastifyInstance } from "fastify";
import { requireAuth } from "../auth.js";
import { isThisComputersApp } from "./usage.js";
import { cleanAddress } from "../email/parse.js";
import { forgetGoogleDataLink, googleDataLink, googleDataScopes, grantedFamilies, keepGoogleDataLink, setGoogleDataEnabled } from "../google/dataLink.js";
import { googleDataErrorCode } from "../google/dataTools.js";
import { googleAccess } from "../google/token.js";
import { reservedFeatureOffered } from "../reservedFeatures.js";

// The link to Google Analytics and Search Console (Connecteurs › Google,
// 08/10/2026), src/google/dataLink.ts:
//   GET    /google_data        the link (never its token): linked, the address, the permissions granted and
//                              what they open, switched on or off
//   POST   /google_data/link   { address, refresh_token, scopes } → tried, kept, switched on; sent by the app's
//                              main process after Google's sign-in (the page never holds a token)
//   PATCH  /google_data        { enabled } — switched on or off (kept)
//   DELETE /google_data        the sign-in forgotten
// Kept for the accounts Osmove chooses (reservedFeatures.ts, 16/10/2026):
// `offered` says whether it is offered to this person; linking or switching
// it on otherwise is refused (`reserved_feature`); forgetting it never is.
// Read by any of the person's devices (« Outils » lists it); made, changed
// and removed only from this computer's app. No answer carries a token.

const security: Array<Record<string, string[]>> = [{ bearerAuth: [] }, { userTokenAuth: [] }];
const REFRESH_TOKEN_MAX_CHARS = 16_384;

/// How a refusal is answered.
function statusFor(error: string): number {
  if (["desktop_app_only", "admin_consent_required", "reserved_feature"].includes(error)) return 403;
  if (["signin_required"].includes(error)) return 409;
  if (["address_required", "invalid_address", "scope_missing", "invalid_enabled"].includes(error)) return 422;
  return 502;
}

/// What a screen shows: never a token.
export function googleDataStatus(userId: string) {
  const link = googleDataLink(userId);
  return {
    linked: !!link,
    address: link?.address ?? null,
    scopes: link?.scopes ?? [],
    analytics: !!link?.granted.includes("analytics"),
    search_console: !!link?.granted.includes("search_console"),
    enabled: link?.enabled ?? false,
    linked_at: link?.linked_at ?? null,
    offered: reservedFeatureOffered("google_data"),
  };
}

const linkBody = {
  type: "object",
  properties: {
    address: { type: "string", maxLength: 320 },
    refresh_token: { type: "string", maxLength: REFRESH_TOKEN_MAX_CHARS },
    scopes: { type: "string", maxLength: 4096 },
  },
};

export async function googleDataRoutes(app: FastifyInstance) {
  const appOnly = async (req: Parameters<typeof requireAuth>[0], reply: Parameters<typeof requireAuth>[1]) => {
    const auth = await requireAuth(req, reply);
    if (!auth) return null;
    if (!isThisComputersApp(auth)) {
      reply.code(403).send({ error: "desktop_app_only" });
      return null;
    }
    return auth;
  };

  app.get("/google_data", {
    schema: { tags: ["google"], summary: "The link to Google Analytics and Search Console (never its token)", security },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      reply.send(googleDataStatus(auth.userId));
    },
  });

  app.post<{ Body: unknown }>("/google_data/link", {
    schema: { tags: ["google"], summary: "Link Google Analytics and Search Console after Google's sign-in: tried, then kept (this computer's app only)", security, body: linkBody },
    handler: async (req, reply) => {
      const auth = await appOnly(req, reply);
      if (!auth) return;
      if (!reservedFeatureOffered("google_data")) return reply.code(403).send({ error: "reserved_feature" });
      const given = (req.body && typeof req.body === "object" ? req.body : {}) as Record<string, unknown>;
      const typed = typeof given.address === "string" ? given.address.trim() : "";
      if (!typed) return reply.code(422).send({ error: "address_required" });
      const address = cleanAddress(typed);
      if (!address) return reply.code(422).send({ error: "invalid_address" });
      const refreshToken = typeof given.refresh_token === "string" ? given.refresh_token.trim() : "";
      if (!refreshToken || refreshToken.length > REFRESH_TOKEN_MAX_CHARS) return reply.code(409).send({ error: "signin_required" });
      const scopes = googleDataScopes(given.scopes);
      if (grantedFamilies(scopes).length === 0) return reply.code(422).send({ error: "scope_missing" });
      // Tried before it is kept: Google renews it, through the door as it
      // will stand once kept.
      try {
        await googleAccess(refreshToken, { googleDataLinked: true, googleDataEnabled: true }, { fresh: true });
      } catch (err) {
        const code = googleDataErrorCode(err);
        return reply.code(statusFor(code)).send({ error: code });
      }
      keepGoogleDataLink(auth.userId, { address, scopes, refreshToken });
      reply.send({ ok: true, google_data: googleDataStatus(auth.userId) });
    },
  });

  app.patch<{ Body: unknown }>("/google_data", {
    schema: { tags: ["google"], summary: "Switch Google Analytics and Search Console on or off in the chat (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await appOnly(req, reply);
      if (!auth) return;
      const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
      if (typeof enabled !== "boolean") return reply.code(422).send({ error: "invalid_enabled" });
      if (enabled && !reservedFeatureOffered("google_data")) return reply.code(403).send({ error: "reserved_feature" });
      if (!setGoogleDataEnabled(auth.userId, enabled)) return reply.code(404).send({ error: "not_linked" });
      reply.send(googleDataStatus(auth.userId));
    },
  });

  app.delete("/google_data", {
    schema: { tags: ["google"], summary: "Unlink Google Analytics and Search Console: the sign-in forgotten (this computer's app only)", security },
    handler: async (req, reply) => {
      const auth = await appOnly(req, reply);
      if (!auth) return;
      if (!forgetGoogleDataLink(auth.userId)) return reply.code(404).send({ error: "not_linked" });
      reply.send(googleDataStatus(auth.userId));
    },
  });
}
