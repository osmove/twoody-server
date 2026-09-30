// The request of POST /api/v1/peer/documents/search as the contract fixes
// it (test/fixtures/peer-documents-search.schema.json, lot P0 —
// definitions/request; the tests check this copy against it). Refused, not
// trimmed: an unknown field is a 400 (the route checks the keys before
// Fastify's Ajv, which would drop them).

const LOCAL_ID = { type: "string", pattern: "^[A-Za-z0-9_-]{1,64}$" } as const;

export const SEARCH_REQUEST_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["q", "scope"],
  properties: {
    q: { type: "string", minLength: 1, maxLength: 2000 },
    hint: { type: "string", maxLength: 2000 },
    scope: {
      type: "object",
      additionalProperties: false,
      required: ["mode"],
      properties: {
        mode: { enum: ["all", "selected"] },
        folder_ids: { type: "array", minItems: 1, maxItems: 200, uniqueItems: true, items: LOCAL_ID },
      },
      if: { properties: { mode: { const: "selected" } } },
      then: { required: ["folder_ids"] },
      else: { not: { required: ["folder_ids"] } },
    },
    limit: { type: "integer", minimum: 1, maximum: 8 },
    budget_chars: { type: "integer", minimum: 200, maximum: 10000 },
    deadline_ms: { type: "integer", minimum: 100, maximum: 3000 },
  },
} as const;

export const SEARCH_DEFAULTS = { limit: 6, budget_chars: 6000, deadline_ms: 3000 } as const;

const REQUEST_KEYS = new Set(Object.keys(SEARCH_REQUEST_SCHEMA.properties));
const SCOPE_KEYS = new Set(Object.keys(SEARCH_REQUEST_SCHEMA.properties.scope.properties));

/// Whether the body names only the contract's fields.
export function onlyKnownFields(body: unknown): boolean {
  if (!body || typeof body !== "object" || Array.isArray(body)) return true; // the schema says what is wrong
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !REQUEST_KEYS.has(key))) return false;
  const scope = record.scope;
  if (scope && typeof scope === "object" && !Array.isArray(scope)) {
    if (Object.keys(scope).some((key) => !SCOPE_KEYS.has(key))) return false;
  }
  return true;
}

export type PeerDocumentsError = "bad_request" | "not_trusted" | "documents_off" | "rate_limited";
