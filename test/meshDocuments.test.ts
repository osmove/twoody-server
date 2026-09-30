import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { startFakeRuntime } from "./helpers/fakeBackend.js";

// Documents across the person's trusted computers (docs/mesh-design.md §2,
// §3, lot S4), with two Twoody servers on loopback: this process is the Mac
// (A), which builds the turn; another process is the Raspberry Pi (B), with
// a document of its own, reached through its sealed /tunnel as a computer
// of A's verified vault roster.
//
//   - a question needing a document only on the Pi and one only on the Mac
//     cites both, each under the computer that holds it;
//   - a cited document of the Pi opens through the Mac (twoody://doc/…);
//   - what the fan-out adds to the time to the first token (fake latency);
//   - the Pi out of the roster: never asked;
//   - the Pi offline: the Mac's document still cited, the Pi said missing;
//   - a synchronised conversation caught up from the turns the phone inlined.

const root = fileURLToPath(new URL("..", import.meta.url));
const MAC = "0b8c7d6e-5f4a-4b3c-9d2e-1f0a9b8c7d6e";
const PI = "7a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";

async function freePort(): Promise<number> {
  return new Promise((resolve) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as { port: number }).port;
      server.close(() => resolve(port));
    });
  });
}

process.env.TWOODY_DATA_DIR = mkdtempSync(join(tmpdir(), "twoody-mesh-docs-mac-"));
delete process.env.TWOODY_USER_TOKEN;
delete process.env.TWOODY_DEVICE_TOKEN;
delete process.env.TWOODY_BACKEND_URL;

const { buildApp } = await import("../src/app.js");
const { ensureSetupToken } = await import("../src/auth.js");
const { accountPeers, db, sqlite } = await import("../src/db.js");
const { ensureLocalUser } = await import("../src/pairing.js");
const { setDesktopAccount } = await import("../src/account/service.js");
const { folderRisk } = await import("../src/documents/folderRisk.js");
const { closeAllPeerLinks, peerById, refreshPeerStatus, setPeerHandshakeTimeouts } = await import("../src/peers/index.js");
const { forgetUnreachable, setFanOutDeadlines, setPeerSearch, tunnelPeerSearch } = await import("../src/documents/remote.js");
const { tunnelIdentity } = await import("../src/tunnel/identity.js");
const { setRosterSource } = await import("../src/vault/roster.js");
const { meshVault } = await import("./helpers/meshVault.js");

setDesktopAccount({ backendUrl: "http://127.0.0.1:9", userToken: "unused", computerId: MAC, computerName: "Mac de Jimmy" });
// The whole suite runs in parallel: the Pi may be slow to its first hello.
setPeerHandshakeTimeouts({ lan: 15_000, relay: 1_000 });

// Folders where folderRisk lets them be granted (not under /private/var on a Mac).
const home = realpathSync(homedir());
const tmpBase = realpathSync(tmpdir());
const base = folderRisk(join(tmpBase, "x"), home) === null ? tmpBase : home;
const docsRoot = realpathSync(mkdtempSync(join(base, "twoody-mesh-docs-test-")));
const macDocs = join(docsRoot, "Mac");
const piDocs = join(docsRoot, "Pi");
mkdirSync(macDocs);

const runtime = await startFakeRuntime({ models: ["gemma3:4b"], reply: () => "Voici ce que disent vos documents [1] [2]." });
const app = await buildApp();
await app.listen({ port: 0, host: "127.0.0.1" });
const macUrl = `http://127.0.0.1:${(app.server.address() as { port: number }).port}`;

// ── the Pi, in its own process ──────────────────────────────────────────
const piPort = await freePort();
const pi: ChildProcess = fork(join(root, "test", "helpers", "meshPeerServer.ts"), [], {
  cwd: root,
  execArgv: ["--import", "tsx"],
  env: {
    ...process.env,
    TWOODY_DATA_DIR: mkdtempSync(join(tmpdir(), "twoody-mesh-docs-pi-")),
    PORT: String(piPort),
    LOG_LEVEL: "warn",
    TWOODY_BONJOUR_DISABLED: "1",
    MESH_SELF_ID: PI,
    MESH_SELF_NAME: "Raspberry Pi",
    MESH_PEER_ID: MAC,
    MESH_PEER_KEY: tunnelIdentity().publicKey.toString("hex"),
    MESH_DOCS_DIR: piDocs,
  },
  stdio: ["ignore", "pipe", "pipe", "ipc"],
});
let piOutput = "";
pi.stdout!.on("data", (chunk) => (piOutput += chunk));
pi.stderr!.on("data", (chunk) => (piOutput += chunk));
const piReady = await new Promise<{ url: string; token: string; tunnelKey: string }>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error(`the Pi did not start: ${piOutput}`)), 30_000);
  pi.on("message", (m: { type: string; url: string; token: string; tunnelKey: string }) => {
    if (m.type === "ready") {
      clearTimeout(timer);
      resolve(m);
    }
  });
  pi.on("exit", (code) => reject(new Error(`the Pi exited (${code}): ${piOutput}`)));
});
function askPi<T>(message: Record<string, unknown>, reply: string): Promise<T> {
  return new Promise((resolve) => {
    const on = (m: { type: string }) => {
      if (m.type !== reply) return;
      pi.off("message", on);
      resolve(m as T);
    };
    pi.on("message", on);
    pi.send(message);
  });
}
const piSearches = async () => (await askPi<{ count: number }>({ type: "searches" }, "searches")).count;
await askPi({ type: "trust", ids: [MAC] }, "trusted");

test.after(async () => {
  setPeerSearch(null);
  setRosterSource(null);
  closeAllPeerLinks();
  if (pi.exitCode === null) pi.kill("SIGTERM");
  await app.close();
  await runtime.close();
  if (process.platform === "darwin") {
    const trash = join(homedir(), ".Trash");
    mkdirSync(trash, { recursive: true });
    renameSync(docsRoot, join(trash, basename(docsRoot)));
  } else rmSync(docsRoot, { recursive: true, force: true });
});

// ── the Mac: its person, model, documents, and the Pi as a mesh peer ────
const desktop = (await app.inject({ method: "POST", url: "/auth/pair", payload: { setup_token: ensureSetupToken()!.token, device_name: "Twoody Desktop" } })).json();
const auth = { "x-user-token": desktop.token };
await app.inject({ method: "POST", url: "/providers/local", headers: auth, payload: { url: runtime.url, model: "gemma3:4b" } });
await app.inject({ method: "PATCH", url: "/me", headers: auth, payload: { user: { memory_enabled: false } } });
const user = ensureLocalUser();
sqlite.prepare("INSERT INTO document_folders(id,user_id,path,created_at) VALUES(?,?,?,?)").run("mac-folder", user.id, macDocs, Date.now());
const macFile = join(macDocs, "facture-electricite.txt");
writeFileSync(macFile, "Facture d'électricité de septembre : 84 euros.");
sqlite
  .prepare("INSERT INTO documents(id,user_id,folder_id,path,name,ext,size,mtime_ms,status,chars) VALUES(?,?,?,?,?,?,?,?,?,?)")
  .run("mac-facture", user.id, "mac-folder", macFile, "facture-electricite.txt", ".txt", 50, 1_790_000_000_000, "indexed", 50);
sqlite.prepare("INSERT INTO document_chunks(document_id,user_id,page,position,text) VALUES(?,?,?,?,?)").run("mac-facture", user.id, null, 0, "Facture d'électricité de septembre : la facture s'élève à 84 euros.");

const now = new Date();
db.insert(accountPeers)
  .values({ computerId: PI, userId: user.id, name: "Raspberry Pi", state: "linked", enabled: true, url: piReady.url, token: piReady.token, tunnelKey: piReady.tunnelKey, origin: "mesh", createdAt: now, updatedAt: now })
  .run();
const vault = meshVault(user.id);
const iphone = vault.person("iPhone");
vault.computer("Raspberry Pi", PI, iphone, { tunnelKey: piReady.tunnelKey });
const withPi = async () => setRosterSource(async () => vault.input([iphone])).refresh();
const withoutPi = async () => setRosterSource(async () => ({ ...vault.input([iphone]), devices: vault.input([iphone]).devices.filter((d) => d.kind !== "computer") })).refresh();
await withPi();
// The link is opened before the turns: the handshake is not the fan-out's.
assert.ok(await refreshPeerStatus(peerById(user.id, PI)!).then(() => true));

const QUESTION = "Combien coûte la facture d'électricité et jusqu'à quand court le contrat de location de la voiture ?";

function final(payload: string) {
  const block = payload.split("\n\n").find((b) => b.startsWith("event: final"));
  assert.ok(block, payload.slice(-800));
  return JSON.parse(block!.split("\n").find((l) => l.startsWith("data: "))!.slice(6));
}
const ask = async (payload: Record<string, unknown>, headers: Record<string, string> = auth) =>
  app.inject({ method: "POST", url: "/queries", headers, payload: { content: QUESTION, ...payload } });
const lastPrompt = () => JSON.stringify(runtime.calls.filter((c) => c.body.x_purpose !== "background").at(-1)!.body.messages);

test("a question needing a document on the Pi and one on the Mac cites both, each under its computer", async () => {
  // Generous here (the whole suite runs at once); the defaults are measured below.
  setFanOutDeadlines({ direct: 10_000, relay: 10_000 });
  const before = await piSearches();
  const answer = final((await ask({})).payload);
  const byComputer = new Map<string, { computer_id: string; computer_name: string; document_id: string; url: string; source_id: string; path?: string }>(
    answer.sources.map((s: { computer_id: string }) => [s.computer_id, s]),
  );
  assert.equal(byComputer.get(PI)?.document_id, "pi-voiture", JSON.stringify(answer.sources));
  assert.equal(byComputer.get(PI)?.computer_name, "Raspberry Pi");
  assert.equal(byComputer.get(PI)?.url, `twoody://doc/${PI}/pi-voiture`);
  assert.equal(byComputer.get(PI)?.source_id, `${PI}:pi-voiture`);
  assert.equal(byComputer.get(MAC)?.document_id, "mac-facture");
  assert.equal(byComputer.get(MAC)?.url, `twoody://doc/${MAC}/mac-facture`);
  for (const source of answer.sources) assert.equal(source.path, undefined, "no path once other computers take part");
  assert.ok(!JSON.stringify(answer.sources).includes(docsRoot), "no absolute path");
  assert.deepEqual(answer.documents.computers.map((c: { computer_id: string; status: string }) => [c.computer_id, c.status]), [[MAC, "answered"], [PI, "answered"]]);
  // The model read both, each named after its computer.
  const prompt = lastPrompt();
  assert.ok(prompt.includes("12 mars 2027") && prompt.includes("84 euros"), prompt);
  assert.ok(prompt.includes("(on Raspberry Pi)") && prompt.includes("(on Mac de Jimmy)"), prompt);
  assert.ok(prompt.includes("running entirely on the user's own computers"));
  assert.equal(await piSearches(), before + 1);
  // Stored as sent: the next turn's history carries no path either.
  const stored = sqlite.prepare("SELECT sources_json FROM messages WHERE role = 'assistant' ORDER BY rowid DESC LIMIT 1").get() as { sources_json: string };
  assert.ok(!stored.sources_json.includes(docsRoot));
});

test("this computer alone, shown to its own Desktop and not shared, still gives its path", async () => {
  await withoutPi();
  const answer = final((await ask({ content: "Montre la facture d'électricité" })).payload);
  assert.equal(answer.sources[0].computer_id, MAC);
  assert.equal(answer.sources[0].path, macFile);
  // Shared (a synchronised exchange): no path.
  const synced = final((await ask({ content: "Montre la facture d'électricité", vault_ref: "ref-path-1" })).payload);
  assert.equal(synced.sources[0].path, undefined);
  await withPi();
});

test("a cited document of the Pi opens through the Mac, with Range; outside the roster, nothing", async () => {
  const whole = await fetch(`${macUrl}/local_documents/remote/${PI}/files/pi-voiture/raw`, { headers: auth });
  assert.equal(whole.status, 200, await whole.clone().text());
  assert.match(await whole.text(), /12 mars 2027/);
  assert.equal(whole.headers.get("x-content-type-options"), "nosniff");
  const part = await fetch(`${macUrl}/api/v1/local_documents/remote/${PI}/files/pi-voiture/raw`, { headers: { ...auth, range: "bytes=0-7" } });
  assert.equal(part.status, 206);
  assert.equal(await part.text(), "Contrat ");
  assert.match(part.headers.get("content-range") ?? "", /^bytes 0-7\//);
  // This computer's own id: its own file.
  const own = await fetch(`${macUrl}/local_documents/remote/${MAC}/files/mac-facture/raw`, { headers: auth });
  assert.equal(own.status, 200);
  assert.match(await own.text(), /84 euros/);
  // Not in the roster: as if there were no such document.
  await withoutPi();
  const refused = await fetch(`${macUrl}/local_documents/remote/${PI}/files/pi-voiture/raw`, { headers: auth });
  assert.equal(refused.status, 404);
  await withPi();
  assert.equal((await fetch(`${macUrl}/local_documents/remote/${PI}/files/pi-voiture/raw`)).status, 401);
});

test("what the fan-out adds to the time to the first token, with the Pi 20 ms and 300 ms away", async () => {
  setFanOutDeadlines({ direct: 1_500, relay: 3_000 });
  async function ttft(): Promise<number> {
    const started = performance.now();
    const response = await fetch(`${macUrl}/queries`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ content: QUESTION }) });
    const reader = response.body!.getReader();
    let seen = "";
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error(`no token: ${seen.slice(-300)}`);
      seen += Buffer.from(value).toString("utf8");
      if (seen.includes("event: message")) {
        const at = performance.now() - started;
        await reader.cancel();
        return at;
      }
    }
  }
  const p50 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
  const p95 = (values: number[]) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * 0.95) - 1)]!;
  const runs = async (n: number) => {
    const out: number[] = [];
    await ttft();
    for (let i = 0; i < n; i++) out.push(await ttft());
    return out;
  };
  await withoutPi();
  const alone = await runs(15);
  await withPi();
  const measured: Record<string, { p50: number; p95: number }> = {};
  for (const latency of [20, 300]) {
    setPeerSearch(async (peer, body, signal) => {
      await new Promise((resolve) => setTimeout(resolve, latency));
      return tunnelPeerSearch(peer, body, signal);
    });
    const times = await runs(15);
    measured[`${latency} ms`] = { p50: Math.round(p50(times) - p50(alone)), p95: Math.round(p95(times) - p50(alone)) };
  }
  setPeerSearch(null);
  console.log(`[mesh fan-out] time to first token alone p50 ${Math.round(p50(alone))} ms; added: ${JSON.stringify(measured)}`);
  // docs/mesh-design.md §2: ≤ 400 ms p50 added on the local network.
  assert.ok(measured["20 ms"]!.p50 <= 400, JSON.stringify(measured));
});

test("the Pi taken out of the roster is never asked", async () => {
  setFanOutDeadlines({ direct: 10_000, relay: 10_000 });
  await withoutPi();
  const before = await piSearches();
  const answer = final((await ask({})).payload);
  assert.deepEqual(answer.sources.map((s: { computer_id: string }) => s.computer_id), [MAC]);
  assert.deepEqual(answer.documents.computers.map((c: { computer_id: string }) => c.computer_id), [MAC]);
  assert.equal(await piSearches(), before, "no search reached the Pi");
  assert.ok(!lastPrompt().includes("Raspberry Pi"));
  await withPi();
});

test("a synchronised conversation started elsewhere is caught up from the turns the phone inlined", async () => {
  const conversation = "5d3c2b1a-0f9e-4d8c-b7a6-958473625140";
  const prior = [{ ref: "turn-1", text: "Mon garagiste s'appelle Martin.", reply: "Noté, Martin.", created_at: "2026-09-30T08:00:00.000Z", sources: [{ n: 1, name: "a.pdf", path: "/Users/x/a.pdf", computer_id: PI, document_id: "d1" }] }];
  const answer = final((await ask({ content: "Comment s'appelle mon garagiste ?", vault_conversation_id: conversation, known_refs: ["turn-1"], prior_turns: prior, vault_ref: "turn-2" })).payload);
  assert.equal(answer.vault_conversation_id, conversation);
  assert.deepEqual(answer.catch_up, { status: "prior_turns", missing_refs: [] });
  assert.ok(lastPrompt().includes("Mon garagiste s'appelle Martin."), "the earlier exchange is in the history");
  const row = sqlite.prepare("SELECT id FROM discussions WHERE vault_id = ?").get(conversation) as { id: string };
  assert.equal(answer.discussion_id, row.id);
  const imported = sqlite.prepare("SELECT sources_json FROM messages WHERE discussion_id = ? AND vault_ref = 'turn-1#reply'").get(row.id) as { sources_json: string };
  assert.ok(!imported.sources_json.includes("/Users/x"), "an inlined source keeps no path");
  // Again, with the conversation here: complete, nothing imported twice.
  const again = final((await ask({ content: "Et son prénom ?", vault_conversation_id: conversation, known_refs: ["turn-1", "turn-2"], prior_turns: prior, vault_ref: "turn-3" })).payload);
  assert.deepEqual(again.catch_up, { status: "complete", missing_refs: [] });
  assert.equal(again.discussion_id, row.id);
  const tooMany = Array.from({ length: 21 }, (_, i) => ({ ref: `t${i}`, text: "q", reply: "r" }));
  const refused = await ask({ vault_conversation_id: conversation, prior_turns: tooMany });
  assert.equal(refused.statusCode, 422);
  assert.equal(refused.json().error, "invalid_prior_turns");
  assert.equal((await ask({ vault_conversation_id: "not-a-uuid" })).statusCode, 422);
});

test("with the Pi offline, the Mac's document is still cited and the Pi said missing", async () => {
  setFanOutDeadlines({ direct: 1_500, relay: 3_000 });
  // A socket nobody answers any more fails well within the deadline.
  setPeerHandshakeTimeouts({ lan: 1_000, relay: 1_000 });
  forgetUnreachable();
  pi.kill("SIGTERM");
  await new Promise((resolve) => pi.once("exit", resolve));
  closeAllPeerLinks();
  const started = Date.now();
  const answer = final((await ask({})).payload);
  assert.ok(Date.now() - started < 5_000);
  assert.deepEqual(answer.sources.map((s: { computer_id: string; document_id: string }) => [s.computer_id, s.document_id]), [[MAC, "mac-facture"]]);
  const piOutcome = answer.documents.computers.find((c: { computer_id: string }) => c.computer_id === PI);
  assert.ok(["unreachable", "late"].includes(piOutcome.status), JSON.stringify(answer.documents));
  const prompt = lastPrompt();
  assert.match(prompt, /Documents on Raspberry Pi \((could not be reached|did not answer in time)\) were not searched/);
  // Asked again at once: not waited for, still said missing.
  const quick = Date.now();
  const next = final((await ask({})).payload);
  assert.ok(Date.now() - quick < 1_500);
  assert.equal(next.documents.computers.find((c: { computer_id: string }) => c.computer_id === PI).status, "unreachable");
});
