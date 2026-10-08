import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// Google Analytics and Search Console (Connecteurs › Google, 08/10/2026):
// their door (src/outbound.ts) opens Google's token endpoint and, read only,
// the seven addresses the tools ask — only while the link is kept and on,
// each only with its permission, over https, never redirected. Here, the
// proof that nothing else gets through, however the address is written, and
// that the Gmail mailbox's door is unchanged by sharing the token endpoint.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-google-data-door-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const {
  GOOGLE_DATA_URLS, googleDataDoor, GoogleDataDoorClosedError, googleDataFetch, googleDataRoute, validSearchConsoleSite,
  GmailDoorClosedError, GOOGLE_TOKEN_URL, googleTokenDoor, googleTokenFetch,
} = await import("../src/outbound.js");

const open = { googleDataLinked: true, googleDataEnabled: true, granted: ["analytics", "search_console"] as const };
const refusal = (fn: () => void) => {
  try {
    fn();
  } catch (err) {
    if (err instanceof GoogleDataDoorClosedError) return err.reason;
    if (err instanceof GmailDoorClosedError) return `gmail:${err.reason}`;
    return `other: ${String(err)}`;
  }
  return null;
};
const door = (target: string, method = "GET", state: Parameters<typeof googleDataDoor>[2] = open) => refusal(() => googleDataDoor(target, method, state));

test("the seven addresses the tools ask, each with its one method", () => {
  for (const [target, method] of [
    [GOOGLE_DATA_URLS.accountSummaries(), "GET"],
    [GOOGLE_DATA_URLS.accountSummaries("next-page_1"), "GET"],
    [GOOGLE_DATA_URLS.metadata("123456789"), "GET"],
    [GOOGLE_DATA_URLS.runReport("123456789"), "POST"],
    [GOOGLE_DATA_URLS.runRealtimeReport("123456789"), "POST"],
    [GOOGLE_DATA_URLS.sites(), "GET"],
    [GOOGLE_DATA_URLS.searchAnalytics("https://www.tessane.example/"), "POST"],
    [GOOGLE_DATA_URLS.searchAnalytics("sc-domain:tessane.example"), "POST"],
    [GOOGLE_DATA_URLS.inspectUrl(), "POST"],
  ] as const) assert.equal(door(target, method), null, `${method} ${target}`);
  assert.equal(GOOGLE_DATA_URLS.runReport("42"), "https://analyticsdata.googleapis.com/v1beta/properties/42:runReport");
  assert.equal(GOOGLE_DATA_URLS.searchAnalytics("sc-domain:tessane.example"), "https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Atessane.example/searchAnalytics/query");
  assert.equal(GOOGLE_DATA_URLS.inspectUrl(), "https://searchconsole.googleapis.com/v1/urlInspection/index:inspect");
});

test("only while the link is kept and on, and each address only with its permission", () => {
  assert.equal(door(GOOGLE_DATA_URLS.sites(), "GET", { ...open, googleDataLinked: false }), "not_linked");
  assert.equal(door(GOOGLE_DATA_URLS.sites(), "GET", { ...open, googleDataEnabled: false }), "google_data_off");
  assert.equal(door(GOOGLE_DATA_URLS.sites(), "GET", { ...open, granted: ["analytics"] }), "scope_missing");
  assert.equal(door(GOOGLE_DATA_URLS.runReport("1"), "POST", { ...open, granted: ["search_console"] }), "scope_missing");
  assert.equal(door(GOOGLE_DATA_URLS.runReport("1"), "POST", { ...open, granted: ["analytics"] }), null);
  assert.equal(googleDataRoute(GOOGLE_DATA_URLS.inspectUrl())?.family, "search_console");
  assert.equal(googleDataRoute(GOOGLE_DATA_URLS.metadata("7"))?.family, "analytics");
});

test("nothing that changes a property, a site, a sitemap or a user; no other method, path, query or host", () => {
  const refused: Array<[string, string, string]> = [
    // Another method on an address opened.
    [GOOGLE_DATA_URLS.sites(), "POST", "method_not_allowed"],
    [GOOGLE_DATA_URLS.runReport("1"), "GET", "method_not_allowed"],
    [GOOGLE_DATA_URLS.accountSummaries(), "DELETE", "method_not_allowed"],
    [GOOGLE_DATA_URLS.inspectUrl(), "GET", "method_not_allowed"],
    // Writes of the Admin API and of Search Console.
    ["https://analyticsadmin.googleapis.com/v1beta/properties", "POST", "other_address"],
    ["https://analyticsadmin.googleapis.com/v1beta/properties/123", "PATCH", "other_address"],
    ["https://analyticsadmin.googleapis.com/v1beta/properties/123", "DELETE", "other_address"],
    ["https://analyticsadmin.googleapis.com/v1alpha/accounts/1/accessBindings", "POST", "other_address"],
    ["https://analyticsadmin.googleapis.com/v1beta/accounts", "GET", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.tessane.example%2F", "PUT", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.tessane.example%2F", "DELETE", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fwww.tessane.example%2F/sitemaps/https%3A%2F%2Fwww.tessane.example%2Fsitemap.xml", "PUT", "other_address"],
    ["https://searchconsole.googleapis.com/v1/urlTestingTools/mobileFriendlyTest:run", "POST", "other_address"],
    // Other properties' paths, other versions, batches, other Google APIs.
    ["https://analyticsdata.googleapis.com/v1beta/properties/abc:runReport", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com/v1beta/properties/123:batchRunReports", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com/v1beta/properties/123:runPivotReport", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com/v1alpha/properties/123:runReport", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com/v1beta/properties/123/audienceExports", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com/v1beta/properties/123:runReport?alt=media", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites?fields=x", "GET", "other_address"],
    ["https://www.googleapis.com/gmail/v1/users/me/messages/send", "POST", "other_address"],
    ["https://www.googleapis.com/drive/v3/files", "GET", "other_address"],
    ["https://www.googleapis.com/oauth2/v4/token", "POST", "other_address"],
    ["https://analyticsadmin.googleapis.com/v1beta/accountSummaries?pageSize=200&key=x", "GET", "other_address"],
    // A site that is no site: a path, a dot segment, a user, spelled otherwise.
    ["https://www.googleapis.com/webmasters/v3/sites/..%2F..%2Fdrive%2Fv3%2Ffiles/searchAnalytics/query", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fa.example%2F%3Fq%3D1/searchAnalytics/query", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/https%3A%2F%2Fuser%40a.example%2F/searchAnalytics/query", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/sc-domain:a.example/searchAnalytics/query", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/sc-domain%3Aa.example/searchAnalytics/query/../../../../drive/v3/files", "POST", "other_address"],
    ["https://www.googleapis.com/webmasters/v3/sites/javascript%3Aalert(1)/searchAnalytics/query", "POST", "other_address"],
    // Other origins, a user, cleartext, a port, a look-alike.
    ["http://analyticsdata.googleapis.com/v1beta/properties/1:runReport", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com:8443/v1beta/properties/1:runReport", "POST", "other_address"],
    ["https://user@analyticsdata.googleapis.com/v1beta/properties/1:runReport", "POST", "other_address"],
    ["https://analyticsdata.googleapis.com.evil.example/v1beta/properties/1:runReport", "POST", "other_address"],
    ["https://evil.example/v1beta/properties/1:runReport", "POST", "other_address"],
    ["https://searchconsole.googleapis.com/v1/urlInspection/index:inspect#x", "POST", "other_address"],
    ["not a url", "GET", "other_address"],
  ];
  for (const [target, method, reason] of refused) assert.equal(door(target, method), reason, `${method} ${target}`);
});

test("a Search Console site is an address as written, or a domain property", () => {
  for (const site of ["https://www.tessane.example/", "http://tessane.example/blog/", "sc-domain:tessane.example"]) assert.equal(validSearchConsoleSite(site), true, site);
  for (const site of ["tessane.example", "https://tessane.example", "https://a.example/?q=1", "https://u:p@a.example/", "ftp://a.example/", "sc-domain:a example", "sc-domain:", "https://a.example/#x"]) assert.equal(validSearchConsoleSite(site), false, site);
});

test("Google's token endpoint: for the Gmail mailbox as before, and for this link while it is kept and on", () => {
  const gmail = { gmailMailbox: true, emailOn: true };
  assert.equal(refusal(() => googleTokenDoor(GOOGLE_TOKEN_URL, gmail)), null);
  assert.equal(refusal(() => googleTokenDoor(GOOGLE_TOKEN_URL, { gmailMailbox: true, emailOn: false })), "gmail:email_off");
  assert.equal(refusal(() => googleTokenDoor("https://oauth2.googleapis.com/revoke", gmail)), "gmail:other_address");
  assert.equal(refusal(() => googleTokenDoor(GOOGLE_TOKEN_URL, { googleDataLinked: true, googleDataEnabled: true })), null);
  assert.equal(refusal(() => googleTokenDoor("https://OAUTH2.googleapis.com:443/x/../token", { googleDataLinked: true, googleDataEnabled: true })), null);
  assert.equal(refusal(() => googleTokenDoor(GOOGLE_TOKEN_URL, { googleDataLinked: false, googleDataEnabled: true })), "not_linked");
  assert.equal(refusal(() => googleTokenDoor(GOOGLE_TOKEN_URL, { googleDataLinked: true, googleDataEnabled: false })), "google_data_off");
  for (const other of ["https://oauth2.googleapis.com/token?x=1", "https://oauth2.googleapis.com/revoke", "http://oauth2.googleapis.com/token", "https://www.googleapis.com/oauth2/v4/token", "not a url"]) {
    assert.equal(refusal(() => googleTokenDoor(other, { googleDataLinked: true, googleDataEnabled: true })), "other_address", other);
  }
});

test("a request refused never leaves this machine; one let through is never redirected", async () => {
  let reached = 0;
  const local = createServer((_req, res) => {
    reached += 1;
    res.end("{}");
  });
  await new Promise<void>((resolve) => local.listen(0, "127.0.0.1", resolve));
  const elsewhere = `http://127.0.0.1:${(local.address() as AddressInfo).port}`;
  const refused = (reason: string) => (err: unknown) => err instanceof GoogleDataDoorClosedError && err.reason === reason;
  await assert.rejects(googleDataFetch(`${elsewhere}/v1beta/properties/1:runReport`, { method: "POST" }, open), refused("other_address"));
  await assert.rejects(googleDataFetch(GOOGLE_DATA_URLS.sites(), { method: "DELETE" }, open), refused("method_not_allowed"));
  await assert.rejects(googleDataFetch(GOOGLE_DATA_URLS.sites(), {}, { ...open, googleDataEnabled: false }), refused("google_data_off"));
  await assert.rejects(googleTokenFetch(`${elsewhere}/token`, { method: "POST" }, { googleDataLinked: true, googleDataEnabled: true }), refused("other_address"));
  assert.equal(reached, 0);
  await new Promise((resolve) => local.close(resolve));

  const network = globalThis.fetch;
  const asked: RequestInit[] = [];
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    asked.push(init ?? {});
    return Response.json({ siteEntry: [] });
  }) as typeof fetch;
  try {
    await googleDataFetch(GOOGLE_DATA_URLS.sites(), { method: "GET" }, open);
    await googleTokenFetch(GOOGLE_TOKEN_URL, { method: "POST" }, { googleDataLinked: true, googleDataEnabled: true });
  } finally {
    globalThis.fetch = network;
  }
  assert.deepEqual(asked.map((init) => init.redirect), ["error", "error"]);
});

const srcDir = fileURLToPath(new URL("../src", import.meta.url));
function sources(dir = srcDir): Array<{ path: string; text: string }> {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sources(path);
    return name.endsWith(".ts") && !name.endsWith(".d.ts") ? [{ path, text: readFileSync(path, "utf8") }] : [];
  });
}

test("Google's statistics addresses are written in the doors' file alone; the tools ask after the door", () => {
  assert.deepEqual(sources().filter(({ text }) => /analytics(?:data|admin)\.googleapis\.com|searchconsole\.googleapis\.com|www\.googleapis\.com\/webmasters/i.test(text)).map(({ path }) => path), [join(srcDir, "outbound.ts")]);
  const tools = readFileSync(join(srcDir, "google", "dataTools.ts"), "utf8");
  const doorAt = tools.indexOf("googleDataDoor(url, method, this.door());\n        response = await transport(");
  assert.ok(doorAt > 0, "the door is asked right before each request");
  // Read only: no request of the tools is anything but a report, a listing or an inspection;
  // nothing is written with `session.post`.
  assert.doesNotMatch(tools, /session\.post\(/);
  const posts = [...tools.matchAll(/session\.query\(GOOGLE_DATA_URLS\.(\w+)/g)].map((match) => match[1]).sort();
  assert.deepEqual([...new Set(posts)], ["inspectUrl", "runRealtimeReport", "runReport", "searchAnalytics"]);
});
