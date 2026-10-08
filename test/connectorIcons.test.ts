import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// A connector's icon (« Outils » and Connecteurs, Jimmy, 08/10/2026): asked
// of the connector's own origin only — its /favicon.ico, /favicon.png,
// /apple-touch-icon.png and the icons its home page declares there — never
// of another host, never redirected, never with its token; the best kept as
// a data URI of 64 KB at most, refreshed at most once a day. Google
// Analytics and Search Console have theirs shipped with Twoody. Sites are
// fakes on this machine; no network beyond it.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-connector-icons-"));
process.env.TWOODY_BONJOUR_DISABLED = "1";

const network = globalThis.fetch;
const asked: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const target = new URL(input instanceof Request ? input.url : String(input));
  if (target.hostname !== "127.0.0.1" && target.hostname !== "localhost") throw new Error(`no network in the tests: ${target.host}`);
  return network(input, init);
}) as typeof fetch;

// A PNG of `size`×`size`: the signature and IHDR are what is read.
const png = (size: number, extra = 0) => {
  const bytes = Buffer.alloc(33 + extra);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(size, 16);
  bytes.writeUInt32BE(size, 20);
  return bytes;
};
// An ICO with one 32×32 entry.
const ico = () => {
  const bytes = Buffer.alloc(6 + 16 + 8);
  bytes.writeUInt16LE(0, 0);
  bytes.writeUInt16LE(1, 2);
  bytes.writeUInt16LE(1, 4);
  bytes[6] = 32;
  bytes[7] = 32;
  return bytes;
};

type Route = (req: IncomingMessage, res: ServerResponse) => void;
async function site(routes: Record<string, Route>) {
  const seen: Array<{ path: string; authorization: string | undefined }> = [];
  const server = createServer((req, res) => {
    seen.push({ path: req.url ?? "", authorization: req.headers.authorization });
    asked.push(`${server.address() && (server.address() as AddressInfo).port}${req.url}`);
    const route = routes[(req.url ?? "").split("?")[0]!];
    if (!route) { res.writeHead(404); res.end(); return; }
    route(req, res);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return { origin, seen, close: () => new Promise((resolve) => server.close(resolve)) };
}
const body = (type: string, bytes: Buffer | string): Route => (_req, res) => { res.writeHead(200, { "content-type": type }); res.end(bytes); };

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { fetchConnectorIcon, declaredIcons, safeSvg, ICON_MAX_BYTES } = await import("../src/connectors/icons.js");
const { refreshConnectorIcon, listConnectors, useIconFetchForTests } = await import("../src/connectors/connectors.js");
const { connectorOriginFetch, webBridgeFetch, webBridgeOrigin, OriginDoorClosedError } = await import("../src/outbound.js");
const { GOOGLE_DATA_ICON } = await import("../src/google/dataTools.js");
const { keepGoogleDataLink, forgetGoogleDataLink } = await import("../src/google/dataLink.js");

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const headers = { authorization: `Bearer ${paired.json().token}` };
const userId = paired.json().user_id as string;
test.after(async () => {
  globalThis.fetch = network;
  await app.close();
});

test("the best icon of the connector's origin: a sharp PNG the page declares before the usual addresses", async () => {
  const other = await site({ "/big.png": body("image/png", png(512)) });
  const served = await site({
    "/": body("text/html; charset=utf-8", `<!doctype html><html><head>
      <link rel="icon" href="${other.origin}/big.png" sizes="512x512">
      <link rel="shortcut icon" href="/static/small.png" sizes="16x16">
      <link rel="apple-touch-icon" href="/static/touch.png">
      <link rel="icon" href="data:image/png;base64,AAAA">
    </head></html>`),
    "/static/small.png": body("image/png", png(16)),
    "/static/touch.png": body("image/png", png(180)),
    "/favicon.ico": body("image/x-icon", ico()),
  });
  const icon = await fetchConnectorIcon(`${served.origin}/mcp`);
  assert.equal(icon, `data:image/png;base64,${png(180).toString("base64")}`);
  assert.equal(other.seen.length, 0, "the icon declared on another host is never asked for");
  assert.ok(served.seen.every((request) => request.authorization === undefined), "never with a token");
  // The page's declared icons, on its own origin only, the largest first.
  assert.deepEqual(declaredIcons(`<link rel="icon" href="/a.png" sizes="32x32"><link rel=icon href=//evil.example/b.png><link rel="apple-touch-icon" href="/c.png">`, served.origin), [`${served.origin}/c.png`, `${served.origin}/a.png`]);
  await other.close();
  await served.close();
});

test("the usual addresses when the page declares none; an ICO kept when nothing is better", async () => {
  const onlyIco = await site({ "/favicon.ico": body("image/vnd.microsoft.icon", ico()) });
  assert.equal(await fetchConnectorIcon(`${onlyIco.origin}/mcp`), `data:image/x-icon;base64,${ico().toString("base64")}`);
  assert.deepEqual(onlyIco.seen.map((request) => request.path), ["/", "/apple-touch-icon.png", "/favicon.png", "/favicon.ico"]);
  await onlyIco.close();
  const nothing = await site({});
  assert.equal(await fetchConnectorIcon(`${nothing.origin}/mcp`), null);
  await nothing.close();
});

test("what is refused: a redirect (even to the same origin), too big, not a picture, an SVG that is more than a drawing", async () => {
  const away = await site({ "/favicon.ico": body("image/x-icon", ico()) });
  const served = await site({
    "/apple-touch-icon.png": (_req, res) => { res.writeHead(302, { location: `${away.origin}/favicon.ico` }); res.end(); },
    "/favicon.png": body("image/png", png(64, ICON_MAX_BYTES)),
    "/favicon.ico": body("text/html", "<html>not an icon</html>"),
  });
  assert.equal(await fetchConnectorIcon(`${served.origin}/mcp`), null);
  assert.equal(away.seen.length, 0, "a redirect is never followed");
  await away.close();
  await served.close();

  const drawing = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 8 8"><circle cx="4" cy="4" r="3" fill="#E37400"/></svg>';
  assert.equal(safeSvg(drawing), true);
  for (const unsafe of [
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><image href="https://tracker.example/p.png"/></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><a href="javascript:alert(1)"><rect/></a></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><foreignObject><div/></foreignObject></svg>',
    '<svg xmlns="http://www.w3.org/2000/svg"><rect style="fill:url(https://tracker.example/x)"/></svg>',
    '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x SYSTEM "file:///etc/passwd">]><svg>&x;</svg>',
    "<html><svg></svg></html>",
  ]) assert.equal(safeSvg(unsafe), false, unsafe);
  const svgSite = await site({ "/": body("text/html", '<link rel="icon" href="/icon.svg">'), "/icon.svg": body("image/svg+xml", drawing) });
  assert.equal(await fetchConnectorIcon(`${svgSite.origin}/mcp`), `data:image/svg+xml;base64,${Buffer.from(drawing).toString("base64")}`);
  // The same drawing served as something else is not taken for an SVG.
  const mislabelled = await site({ "/": body("text/html", '<link rel="icon" href="/icon.svg">'), "/icon.svg": body("text/plain", drawing) });
  assert.equal(await fetchConnectorIcon(`${mislabelled.origin}/mcp`), null);
  await svgSite.close();
  await mislabelled.close();
});

test("the door opens to the connector's origin only, in every mode; the web search's to loopback only", async () => {
  const served = await site({ "/favicon.ico": body("image/x-icon", ico()) });
  const door = connectorOriginFetch(served.origin);
  assert.equal((await door(`${served.origin}/favicon.ico`)).status, 200);
  for (const elsewhere of ["https://example.com/favicon.ico", `http://localhost:${new URL(served.origin).port}/favicon.ico`, "http://127.0.0.1:9/favicon.ico", "file:///etc/passwd"]) {
    await assert.rejects(door(elsewhere), OriginDoorClosedError, elsewhere);
  }
  await served.close();

  assert.equal(webBridgeOrigin("http://127.0.0.1:51234"), "http://127.0.0.1:51234");
  assert.equal(webBridgeOrigin("http://[::1]:51234/"), "http://[::1]:51234");
  for (const refused of ["http://192.168.1.10:51234", "https://127.0.0.1:51234", "http://localhost:51234", "http://127.0.0.1", "http://evil.example:51234", "", null]) {
    assert.equal(webBridgeOrigin(refused), null, String(refused));
  }
  const bridge = webBridgeFetch("http://127.0.0.1:9");
  await assert.rejects(bridge("http://127.0.0.1:10/research"), OriginDoorClosedError);
  await assert.rejects(bridge("https://example.com/research"), OriginDoorClosedError);
  await assert.rejects(webBridgeFetch("http://192.168.1.10:9")("http://192.168.1.10:9/research"), OriginDoorClosedError);
});

test("kept with the connector when it is added, shown in GET /connectors; asked again at most once a day; none for a command", async () => {
  const served = await site({ "/apple-touch-icon.png": body("image/png", png(180)) });
  const added = await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Notes", url: `${served.origin}/mcp`, headers: { Authorization: "Bearer s3cr3t" } } } });
  assert.equal(added.statusCode, 201, added.body);
  const id = added.json().connector.id as string;
  await refreshConnectorIcon(userId, id);
  const listed = async () => ((await app.inject({ url: "/connectors", headers })).json().connectors as Array<{ id: string; icon: string | null }>).find((one) => one.id === id)!;
  assert.equal((await listed()).icon, `data:image/png;base64,${png(180).toString("base64")}`);
  assert.ok(served.seen.every((request) => request.path === "/mcp" || request.authorization === undefined), "the token goes to the MCP address only");

  // Within the day: not asked again; the day after: asked, and a failure keeps the one it had.
  const before = served.seen.length;
  await refreshConnectorIcon(userId, id, Date.now() + 3600 * 1000);
  assert.equal(served.seen.length, before);
  let fetched = 0;
  useIconFetchForTests(async () => { fetched += 1; return null; });
  await refreshConnectorIcon(userId, id, Date.now() + 25 * 3600 * 1000);
  useIconFetchForTests(null);
  assert.equal(fetched, 1);
  assert.match((await listed()).icon ?? "", /^data:image\/png;base64,/);
  const stored = listConnectors(userId).find((one) => one.id === id)!;
  assert.ok(stored.icon_checked_at);

  // Another address: the old icon goes with it.
  await app.inject({ method: "PATCH", url: `/connectors/${id}`, headers, payload: { url: "http://127.0.0.1:9/mcp" } });
  assert.equal(listConnectors(userId).find((one) => one.id === id)!.icon ?? null, null);
  await app.inject({ method: "DELETE", url: `/connectors/${id}`, headers });
  await served.close();

  const command = await app.inject({ method: "POST", url: "/connectors", headers, payload: { connector: { name: "Carnet", command: process.execPath, args: [join(import.meta.dirname, "fixtures", "fake-mcp.mjs")] } } });
  assert.equal(command.json().connector.icon, null);
  await app.inject({ method: "DELETE", url: `/connectors/${command.json().connector.id}`, headers });
});

test("Google Analytics and Search Console: a small drawing shipped with Twoody, never fetched", async () => {
  keepGoogleDataLink(userId, { address: "claire.martin@tessane.example", scopes: ["https://www.googleapis.com/auth/analytics.readonly"], refreshToken: "g-refresh-claire" });
  const before = asked.length;
  const google = ((await app.inject({ url: "/connectors", headers })).json().connectors as Array<{ id: string; icon: string | null }>).find((one) => one.id === "google")!;
  assert.equal(google.icon, GOOGLE_DATA_ICON);
  assert.equal(asked.length, before, "nothing asked of any site");
  assert.match(GOOGLE_DATA_ICON, /^data:image\/svg\+xml;base64,/);
  assert.equal(safeSvg(Buffer.from(GOOGLE_DATA_ICON.split(",")[1]!, "base64").toString("utf8")), true);
  forgetGoogleDataLink(userId);
});
