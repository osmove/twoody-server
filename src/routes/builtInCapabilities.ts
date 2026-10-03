import type { FastifyInstance } from "fastify";
import { eq } from "drizzle-orm";
import { db, users } from "../db.js";
import { requireAuth } from "../auth.js";
import { BUILT_IN_CAPABILITIES, findCapability } from "../capabilities.js";

// Cloud-shape /built_in_capabilities for twoody-server. Mirrors the
// Rails skills_controller wire shape so the desktop's Capabilities
// tab and the iPhone's SkillsScreen can drive both backends with one
// codepath.
//
//   GET    /built_in_capabilities                    → array of skills
//   PATCH  /built_in_capabilities/:slug              {enabled} → {slug, enabled}
//   PATCH  /built_in_capabilities/:slug/tools/:tool  {enabled} → {slug, tool_name, enabled}
//
// Per-user opt-out lives in `users.prefs`:
//   disabled_capabilities: string[]   (slugs)
//   disabled_tools:        string[]   (tool names)
// Everything is enabled by default; lists are pure opt-out so a fresh
// install behaves like Rails on cloud-default.

interface UserPrefs {
  disabled_capabilities?: unknown;
  disabled_tools?:        unknown;
  [k: string]: unknown;
}

function readPrefs(userId: string): UserPrefs {
  const [user] = db.select().from(users).where(eq(users.id, userId)).limit(1).all();
  if (!user) return {};
  try {
    const parsed = JSON.parse(user.prefsJson || "{}");
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function writePrefs(userId: string, prefs: UserPrefs): void {
  db.update(users)
    .set({ prefsJson: JSON.stringify(prefs) })
    .where(eq(users.id, userId))
    .run();
}

function readStringArray(prefs: UserPrefs, key: keyof UserPrefs): string[] {
  const value = prefs[key];
  if (!Array.isArray(value)) return [];
  return value.filter((v): v is string => typeof v === "string");
}

function isCapabilityEnabled(prefs: UserPrefs, slug: string): boolean {
  return !readStringArray(prefs, "disabled_capabilities").includes(slug);
}

function isToolEnabled(prefs: UserPrefs, toolName: string): boolean {
  return !readStringArray(prefs, "disabled_tools").includes(toolName);
}

function setCapabilityEnabled(prefs: UserPrefs, slug: string, enabled: boolean): UserPrefs {
  const list = readStringArray(prefs, "disabled_capabilities");
  const next = enabled ? list.filter((s) => s !== slug) : Array.from(new Set([...list, slug]));
  return { ...prefs, disabled_capabilities: next };
}

function setToolEnabled(prefs: UserPrefs, toolName: string, enabled: boolean): UserPrefs {
  const list = readStringArray(prefs, "disabled_tools");
  const next = enabled ? list.filter((t) => t !== toolName) : Array.from(new Set([...list, toolName]));
  return { ...prefs, disabled_tools: next };
}

export async function builtInCapabilitiesRoutes(app: FastifyInstance) {
  app.get("/built_in_capabilities", {
    schema: {
      tags: ["capabilities"],
      summary: "List built-in capabilities (skills)",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const prefs = readPrefs(auth.userId);

      const built_in_capabilities = BUILT_IN_CAPABILITIES.map((cap) => ({
        slug:           cap.slug,
        label:          cap.label,
        description:    cap.description,
        icon:           cap.icon,
        cost:           cap.cost,
        requires_setup: cap.requires_setup,
        tools:          cap.tools.map((t) => t.name),
        functions: cap.tools.map((t) => ({
          name:        t.name,
          description: t.description,
          enabled:     isToolEnabled(prefs, t.name),
        })),
        enabled:    isCapabilityEnabled(prefs, cap.slug),
        default_on: cap.default_on,
      }));

      // Rails returns `{built_in_capabilities, skills}` (skills is a
      // legacy alias, same payload). Match it so the iPhone's older
      // codepaths keep working when they land on twoody-server.
      reply.send({ built_in_capabilities, skills: built_in_capabilities });
    },
  });

  app.patch<{ Params: { id: string }; Body: { enabled?: boolean } }>("/built_in_capabilities/:id", {
    schema: {
      tags: ["capabilities"],
      summary: "Toggle a built-in capability",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const cap = findCapability(req.params.id);
      if (!cap) return reply.code(404).send({ error: "unknown built-in capability" });

      const enabled = Boolean(req.body?.enabled);
      const next = setCapabilityEnabled(readPrefs(auth.userId), cap.slug, enabled);
      writePrefs(auth.userId, next);
      reply.send({ slug: cap.slug, enabled });
    },
  });

  app.patch<{
    Params: { id: string; tool_name: string };
    Body:   { enabled?: boolean };
  }>("/built_in_capabilities/:id/tools/:tool_name", {
    schema: {
      tags: ["capabilities"],
      summary: "Toggle a single tool inside a capability",
      security: [{ bearerAuth: [] }, { userTokenAuth: [] }],
      body: {
        type: "object",
        properties: { enabled: { type: "boolean" } },
        required: ["enabled"],
      },
    },
    handler: async (req, reply) => {
      const auth = await requireAuth(req, reply);
      if (!auth) return;
      const cap = findCapability(req.params.id);
      if (!cap) return reply.code(404).send({ error: "unknown built-in capability" });
      const tool = cap.tools.find((t) => t.name === req.params.tool_name);
      if (!tool) return reply.code(404).send({ error: "unknown tool for this built-in capability" });

      const enabled = Boolean(req.body?.enabled);
      const next = setToolEnabled(readPrefs(auth.userId), tool.name, enabled);
      writePrefs(auth.userId, next);
      reply.send({ slug: cap.slug, tool_name: tool.name, enabled });
    },
  });
}
