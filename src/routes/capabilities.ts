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
            has_emails:         { type: "boolean" },
            providers_writable: { type: "boolean" },
            deployment_kind:    { type: "string" },
          },
          required: [
            "has_billing", "has_org", "has_memory", "has_browser_agent",
            "has_local_files", "has_devices", "has_skills", "has_emails",
            "providers_writable", "deployment_kind",
          ],
        },
      },
    },
    handler: async (_req, reply) => {
      reply.send({
        has_billing:        false,
        has_org:            false,
        // Memories ship in v0.3+ (the /memories CRUD added in Phase 2
        // of the OSS roadmap). Older twoody-server builds without
        // these routes will report this flag as false and the desktop
        // hides the tab — capability-driven nav handles the rollout.
        has_memory:         true,
        has_browser_agent:  false,
        has_local_files:    true,
        has_devices:        true,
        // Static capability catalogue ships in v0.3+ via
        // /built_in_capabilities. MCP-discovered tools will fold in
        // when twoody-mcp gets a discovery endpoint; until then the
        // OSS list (memory/tasks/reminders/contacts/calendar/notes/discussions/local_llm) is
        // enough to drive the desktop's Capabilities tab.
        has_skills:         true,
        // No Postmark wiring on twoody-server — inbox / compose /
        // identities / mail_domains all stay hidden. A future build
        // could route through a self-hosted SMTP and flip this on.
        has_emails:         false,
        providers_writable: true,
        deployment_kind:    "local",
      });
    },
  });
}
