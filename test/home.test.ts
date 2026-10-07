import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// « Maison » (Jimmy, 02/10/2026): the lights of the person's Home
// Assistant from the chat, as in the cloud in April–May — « allume la
// lumière du salon » done at once, the rest through the control_home tool.

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-home-"));

const { buildApp } = await import("../src/app.js");
const { createAuthSession, ensureSetupToken } = await import("../src/auth.js");
const { homeShortcut, homeBlock, homeDoneSentence, serviceFor } = await import("../src/home/homeAssistant.js");

// Jimmy's Home Assistant, as its /api/states lists it (02/10/2026), plus a
// lock Twoody must never be given.
const STATES = [
  { entity_id: "light.lumiere_salon", state: "off", attributes: { friendly_name: "Lumière Salon" } },
  { entity_id: "switch.bibliotheque_salon", state: "on", attributes: { friendly_name: "Bibliothèque salon" } },
  { entity_id: "switch.bibliotheque_salon_2", state: "unavailable", attributes: { friendly_name: "Bibliothèque salon" } },
  { entity_id: "switch.guirlande_salon", state: "off", attributes: { friendly_name: "Guirlande salon" } },
  { entity_id: "switch.lumiere_bureau", state: "unavailable", attributes: { friendly_name: "Lumière bureau" } },
  { entity_id: "lock.porte", state: "locked", attributes: { friendly_name: "Porte d'entrée" } },
  { entity_id: "sensor.temperature", state: "21", attributes: { friendly_name: "Température" } },
];
const TOKEN = "good-token";
const called: Array<{ path: string; body: Record<string, unknown> }> = [];
const ha = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.headers.authorization !== `Bearer ${TOKEN}`) { res.writeHead(401); res.end(); return; }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    if (req.method === "GET" && req.url === "/api/states") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(STATES)); return; }
    if (req.method === "POST" && req.url?.startsWith("/api/services/")) { called.push({ path: req.url, body: JSON.parse(body || "{}") }); res.writeHead(200, { "content-type": "application/json" }); res.end("[]"); return; }
    res.writeHead(404); res.end();
  });
});
await new Promise<void>((resolve) => ha.listen(0, "127.0.0.1", resolve));
const haUrl = `http://127.0.0.1:${(ha.address() as AddressInfo).port}`;

// A llama.cpp that keeps what it was asked and says « C'est fait. ».
const asked: Array<{ messages: Array<{ role: string; content: string }>; tools?: Array<{ function: { name: string } }> }> = [];
const runtime = createServer((req: IncomingMessage, res: ServerResponse) => {
  if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ object: "list", data: [{ id: "qwen3", object: "model" }] })); return; }
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    asked.push(JSON.parse(body));
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "C'est fait." } }] })}\n\n`);
    res.end("data: [DONE]\n\n");
  });
});
await new Promise<void>((resolve) => runtime.listen(0, "127.0.0.1", resolve));
const runtimeUrl = `http://127.0.0.1:${(runtime.address() as AddressInfo).port}`;

const app = await buildApp();
const paired = await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } });
const owner = paired.json().user_id as string;
const desktop = { authorization: `Bearer ${paired.json().token}` };
const phone = { authorization: `Bearer ${createAuthSession(owner, "pair:iPhone").token}` };
test.after(async () => {
  await app.close();
  await new Promise((resolve) => ha.close(resolve));
  await new Promise((resolve) => runtime.close(resolve));
});

const entities = STATES.filter((s) => !/^(lock|sensor)\./.test(s.entity_id)).map((s) => ({ entity_id: s.entity_id, name: s.attributes.friendly_name, domain: s.entity_id.split(".")[0]!, state: s.state, brightness: null }));

test("« allume la lumière du salon », « éteins la bibliothèque »: one device, at once; anything vaguer goes to the model", () => {
  assert.deepEqual(homeShortcut("Allume la lumière du salon", entities)?.entities.map((e) => e.entity_id), ["light.lumiere_salon"]);
  assert.equal(homeShortcut("Allume la lumière du salon", entities)?.action, "on");
  // Two devices of the same name: the one that answers.
  assert.deepEqual(homeShortcut("éteins la bibliothèque", entities)?.entities.map((e) => e.entity_id), ["switch.bibliotheque_salon"]);
  assert.equal(homeShortcut("éteins la bibliothèque", entities)?.action, "off");
  assert.deepEqual(homeShortcut("Turn on the guirlande", entities)?.entities.map((e) => e.entity_id), ["switch.guirlande_salon"]);
  assert.equal(homeShortcut("allume le salon", entities), null, "three devices in the salon");
  assert.equal(homeShortcut("allume la lumière", entities), null, "which one?");
  assert.equal(homeShortcut("est-ce que la lumière du salon est allumée ?", entities), null);
  assert.equal(homeShortcut("parle-moi du salon de l'auto", entities), null);
});

test("Jimmy's scripts: « allume la télé » runs Allume Télé, « éteins la télé » runs Éteins Télé", () => {
  const tv = [
    { entity_id: "script.allume_tele", name: "Allume Télé", domain: "script", state: "off", brightness: null },
    { entity_id: "script.eteins_tele", name: "Éteins Télé", domain: "script", state: "off", brightness: null },
    { entity_id: "media_player.lg_webos_tv_ut73006la", name: "Téléviseur LG", domain: "media_player", state: "unavailable", brightness: null },
  ];
  assert.deepEqual(homeShortcut("allume la télé", tv)?.entities.map((e) => e.entity_id), ["script.allume_tele"]);
  assert.deepEqual(homeShortcut("éteins la télé", tv)?.entities.map((e) => e.entity_id), ["script.eteins_tele"]);
});

test("what was done is said with the state before and after: « already » only when it was", () => {
  const garland = { entity_id: "switch.guirlande_salon", name: "Guirlande salon", domain: "switch", state: "on", brightness: null };
  assert.equal(homeDoneSentence({ entity: garland, action: "off", brightness: null }), "« Guirlande salon » was on; Twoody has just switched it: it is now off.");
  assert.equal(homeDoneSentence({ entity: garland, action: "on", brightness: null }), "« Guirlande salon » was already on; the command was sent anyway: it is on.");
});

test("what a word does, by domain; a lock is never offered", () => {
  assert.equal(serviceFor("light", "on"), "turn_on");
  assert.equal(serviceFor("cover", "close"), "close_cover");
  assert.equal(serviceFor("script", "off"), "turn_on", "« Éteins Télé » is run");
  assert.match(homeBlock("allume la guirlande", entities)!, /switch\.guirlande_salon « Guirlande salon »: off/);
  assert.equal(homeBlock("quelle heure est-il ?", entities), null);
});

test("set up from this computer's app: a wrong token is refused, the token never comes back", async () => {
  assert.equal((await app.inject({ method: "PUT", url: "/api/v1/home/config", headers: phone, payload: { url: haUrl, token: TOKEN } })).statusCode, 403);
  const wrong = await app.inject({ method: "PUT", url: "/api/v1/home/config", headers: desktop, payload: { url: haUrl, token: "nope" } });
  assert.equal(wrong.statusCode, 422);
  assert.equal(wrong.json().error, "unauthorized");
  const right = await app.inject({ method: "PUT", url: "/api/v1/home/config", headers: desktop, payload: { url: `${haUrl}/`, token: TOKEN } });
  assert.equal(right.statusCode, 200, right.body);
  assert.equal(right.json().devices, 5);
  const shown = await app.inject({ method: "GET", url: "/api/v1/home", headers: desktop });
  assert.doesNotMatch(shown.body, new RegExp(TOKEN));
  assert.deepEqual(shown.json().devices.map((d: { entity_id: string }) => d.entity_id).sort(), entities.map((e) => e.entity_id).sort());
  assert.equal(shown.json().enabled, false, "set up, but Maison is still off");
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/home/control", headers: desktop, payload: { entity_id: "light.lumiere_salon", action: "on" } })).statusCode, 403);
});

test("on: the chat switches the light at once, says what it did, and never touches a lock", async () => {
  assert.equal((await app.inject({ method: "PATCH", url: "/api/v1/local_capabilities/home", headers: desktop, payload: { enabled: true } })).statusCode, 200);
  assert.equal((await app.inject({ method: "POST", url: "/providers/local", headers: desktop, payload: { url: `${runtimeUrl}/v1`, model: "qwen3", name: "llama.cpp" } })).statusCode, 201);
  called.length = 0;
  asked.length = 0;
  const response = await app.inject({ method: "POST", url: "/queries", headers: phone, payload: { text: "Allume la lumière du salon", channel: "desktop", force_new_discussion: true } });
  assert.equal(response.statusCode, 200, response.body);
  assert.deepEqual(called, [{ path: "/api/services/light/turn_on", body: { entity_id: "light.lumiere_salon" } }]);
  assert.match(asked[0]!.messages.at(-1)!.content, /« Lumière Salon » was off; Twoody has just switched it: it is now on\./);
  assert.doesNotMatch(asked[0]!.messages.at(-1)!.content, /\[The user's home devices/, "done already: no list of the states from before");
  assert.ok(!asked[0]!.tools?.some((tool) => tool.function.name === "control_home"), "done already: not offered again");
  assert.match(response.body, /"type":"home"/);

  // A device that does not answer is said so, not tried.
  called.length = 0;
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "allume la lumière du bureau", channel: "desktop", force_new_discussion: true } });
  assert.deepEqual(called, []);
  assert.match(asked[0]!.messages.at(-1)!.content, /« Lumière bureau » does not answer Home Assistant/);

  // Vaguer: the model gets the devices and the tool — never the lock.
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "allume tout dans le salon", channel: "desktop", force_new_discussion: true } });
  assert.ok(asked[0]!.tools?.some((tool) => tool.function.name === "control_home"));
  assert.doesNotMatch(asked[0]!.messages.at(-1)!.content, /lock\.porte/);
  assert.equal((await app.inject({ method: "POST", url: "/api/v1/home/control", headers: desktop, payload: { entity_id: "lock.porte", action: "off" } })).statusCode, 404);

  // Left out of this message by its icon in the chat (capabilities_off,
  // 04/10/2026): nothing switched, no device nor tool given to the model.
  called.length = 0;
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Allume la lumière du salon", channel: "desktop", force_new_discussion: true, capabilities_off: ["home"] } });
  assert.deepEqual(called, []);
  assert.ok(!asked[0]!.tools?.some((tool) => tool.function.name === "control_home"));
  assert.doesNotMatch(asked[0]!.messages.at(-1)!.content, /Lumière Salon/);
  // …and the model is told why, so that it does not answer « je suis une
  // intelligence artificielle… » (Jimmy, 06/10/2026).
  assert.match(asked[0]!.messages.at(-1)!.content, /Maison is left out of this message by its icon/);
  const traced = await app.inject({ method: "GET", url: "/diagnostics/turns?kind=chat", headers: desktop });
  assert.equal(traced.statusCode, 200, traced.body);
  assert.deepEqual((traced.json().traces as Array<{ detail: { home?: unknown } }>)[0]!.detail.home, { state: "left_out", devices: 0 });
  // A message that does not ask the home anything is told nothing of it.
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Rappelle-moi d'éteindre la lumière ce soir", channel: "desktop", force_new_discussion: true, capabilities_off: ["home"] } });
  assert.doesNotMatch(asked[0]!.messages.at(-1)!.content, /Maison is left out/);
});

test("« éteins-la » right after « allume la lumière du salon »: the same device, at once (07/10/2026)", async () => {
  const { homeFollowUp } = await import("../src/home/homeAssistant.js");
  const last = { entities: entities.filter((e) => e.entity_id === "light.lumiere_salon"), action: "on" as const };
  const follow = (message: string) => {
    const found = homeFollowUp(message, entities, last);
    return found ? `${found.action} ${found.entities.map((e) => e.entity_id).join(",")}${found.brightness ? ` ${found.brightness}%` : ""}` : null;
  };
  assert.equal(follow("éteins la"), "off light.lumiere_salon");
  assert.equal(follow("Éteins-la maintenant stp"), "off light.lumiere_salon");
  assert.equal(follow("rallume-la"), "on light.lumiere_salon");
  assert.equal(follow("tu peux l'éteindre ?"), "off light.lumiere_salon");
  assert.equal(follow("en fait non, éteins"), "off light.lumiere_salon");
  assert.equal(follow("mets-la à 30 %"), "on light.lumiere_salon 30%");
  assert.equal(follow("baisse-la à 20%"), "on light.lumiere_salon 20%");
  assert.equal(follow("remets-la comme avant"), "off light.lumiere_salon");
  assert.equal(follow("et la guirlande aussi"), "on switch.guirlande_salon");
  assert.equal(follow("éteins la lumière"), "off light.lumiere_salon");
  assert.equal(follow("monte-la au maximum"), "on light.lumiere_salon 100%");
  assert.equal(follow("éteins tout"), null, "everything is not the last one");
  assert.equal(follow("éteins la lumière du bureau"), null, "another device");
  assert.equal(follow("éteins la télé"), null);
  assert.equal(follow("est-ce qu'elle est allumée ?"), null);
  assert.equal(follow("rappelle-moi de l'éteindre à 23 h"), null);
  assert.equal(homeFollowUp("éteins-la", entities, null), null, "nothing switched before");

  called.length = 0;
  asked.length = 0;
  const first = await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Allume la lumière du salon", channel: "desktop", force_new_discussion: true } });
  const discussion = first.body.match(/"discussion_id":"([^"]+)"/)![1];
  assert.deepEqual(called.map((call) => call.path), ["/api/services/light/turn_on"]);
  called.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "éteins la", channel: "desktop", discussion_id: discussion } });
  assert.deepEqual(called, [{ path: "/api/services/light/turn_off", body: { entity_id: "light.lumiere_salon" } }]);
  // In another conversation, « éteins-la » names nothing.
  called.length = 0;
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "éteins-la", channel: "desktop", force_new_discussion: true } });
  assert.deepEqual(called, []);
  assert.doesNotMatch(asked[0]!.messages.at(-1)!.content, /Just switched/);
});

test("Home Assistant refusing the token: nothing switched, the reason said and traced", async () => {
  const { homeUnusedNote, asksHome } = await import("../src/home/homeAssistant.js");
  assert.equal(asksHome("éteins la lumière du salon"), true);
  assert.equal(asksHome("Allume la télé"), true);
  assert.equal(asksHome("ouvre le document de Yoav"), false);
  assert.equal(asksHome("est-ce que la lumière est allumée ?"), false);
  assert.match(homeUnusedNote("off"), /Capacités → Maison/);
  // The token Home Assistant knows changes: Twoody's is refused.
  const { setHomeConfig } = await import("../src/home/homeAssistant.js");
  setHomeConfig(owner, { url: haUrl, token: "revoked" });
  called.length = 0;
  asked.length = 0;
  await app.inject({ method: "POST", url: "/queries", headers: desktop, payload: { text: "Éteins la guirlande du salon", channel: "desktop", force_new_discussion: true } });
  assert.deepEqual(called, []);
  assert.match(asked[0]!.messages.at(-1)!.content, /Home Assistant refused Twoody's access token/);
  assert.ok(!asked[0]!.tools?.some((tool) => tool.function.name === "control_home"));
  const traced = await app.inject({ method: "GET", url: "/diagnostics/turns?kind=chat", headers: desktop });
  assert.deepEqual((traced.json().traces as Array<{ detail: { home?: unknown } }>)[0]!.detail.home, { state: "unauthorized", devices: 0 });
  setHomeConfig(owner, { url: haUrl, token: TOKEN });
});
