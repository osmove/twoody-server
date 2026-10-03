import assert from "node:assert/strict";
import test from "node:test";

// Twoody Desktop runs its server in local-only mode, always (03/10/2026:
// every connector on the Web was refused). A connector the person added is
// reached, and the sign-in service it names — over https, nowhere else.

process.env.TWOODY_LOCAL_ONLY = "1";
const { connectorFetch, LocalOnlyError } = await import("../src/outbound.js");
const { connectorOrigins } = await import("../src/connectors/connectors.js");

test("its origins: its address, and the sign-in service it named", () => {
  assert.deepEqual(connectorOrigins({ url: "https://mcp.stripe.com", oauth: { issuer: "https://access.stripe.com/mcp", token_endpoint: "https://access.stripe.com/mcp/oauth2/token", registration_endpoint: null } as never }), ["https://mcp.stripe.com", "https://access.stripe.com", "https://access.stripe.com"]);
  assert.deepEqual(connectorOrigins({ url: "https://jway.live/mcp", oauth: null }), ["https://jway.live"]);
});

test("in local-only mode: the connector's origin goes out; any other is refused", async () => {
  const door = connectorFetch(["https://mcp.twoody-test.invalid"]);
  // Let through: it fails only because the name does not exist.
  await assert.rejects(door("https://mcp.twoody-test.invalid/mcp"), (err: unknown) => !(err instanceof LocalOnlyError));
  await assert.rejects(door("https://elsewhere.twoody-test.invalid/mcp"), LocalOnlyError);
  // The same host over cleartext is not the same origin.
  await assert.rejects(door("http://mcp.twoody-test.invalid/mcp"), LocalOnlyError);
});
