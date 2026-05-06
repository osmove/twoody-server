import type { FastifyInstance } from "fastify";

// Public feature-flag surface. Mirrors the JSON shape returned by Rails
// (`/api/v1/capabilities`) so a single client codepath can introspect
// either backend without branching. Twoody-server is single-user and
// ships without billing/orgs/memory/skills/browser-agent — clients are
// expected to hide those screens when the corresponding flag is false.
export async function capabilitiesRoutes(app: FastifyInstance) {
  app.get("/capabilities", {
    schema: {
      tags: ["health"],
      summary: "Server capabilities",
      response: {
        200: {
          type: "object",
          properties: {
            has_billing:        { type: "boolean" },
            has_org:            { type: "boolean" },
            has_memory:         { type: "boolean" },
            has_browser_agent:  { type: "boolean" },
            has_local_files:    { type: "boolean" },
            has_devices:        { type: "boolean" },
            has_skills:         { type: "boolean" },
            providers_writable: { type: "boolean" },
            deployment_kind:    { type: "string" },
          },
          required: [
            "has_billing", "has_org", "has_memory", "has_browser_agent",
            "has_local_files", "has_devices", "has_skills",
            "providers_writable", "deployment_kind",
          ],
        },
      },
    },
    handler: async (_req, reply) => {
      reply.send({
        has_billing:        false,
        has_org:            false,
        has_memory:         false,
        has_browser_agent:  false,
        has_local_files:    true,
        has_devices:        true,
        has_skills:         false,
        providers_writable: true,
        deployment_kind:    "local",
      });
    },
  });
}
