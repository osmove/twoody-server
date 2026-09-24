import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { type AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The real server, started the way Twoody Desktop starts it: local-only,
// the tunnel opted into, no token anywhere in its environment, and the
// account's credentials handed over by message once it says it listens.
// The relay is a stand-in on this machine that writes down every request.
//
// This is the path unit tests cannot see — src/index.ts reading its
// parent port — and the one a desktop release depends on.

const root = fileURLToPath(new URL("..", import.meta.url));

interface Hit {
  method: string;
  path: string;
  token: string | undefined;
  device: string | undefined;
  accept: string | undefined;
}

async function standInRelay(): Promise<{ server: Server; url: string; hits: Hit[] }> {
  const hits: Hit[] = [];
  const server = createServer((req: IncomingMessage, res) => {
    hits.push({
      method: req.method ?? "",
      path: req.url ?? "",
      token: req.headers["x-user-token"] as string | undefined,
      device: req.headers["x-device-token"] as string | undefined,
      accept: req.headers.accept,
    });
    // Nothing waiting, after a moment — as a long poll would answer.
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ frames: [], peer_listening: false }));
    }, 100);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { server, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, hits };
}

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const { port } = probe.address() as AddressInfo;
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

function nextMessage(child: ChildProcess, matches: (message: Record<string, unknown>) => boolean, what: string): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.off("message", listener);
      reject(new Error(`timed out waiting for ${what}`));
    }, 30_000);
    const listener = (message: unknown) => {
      if (message && typeof message === "object" && matches(message as Record<string, unknown>)) {
        clearTimeout(timer);
        child.off("message", listener);
        resolve(message as Record<string, unknown>);
      }
    };
    child.on("message", listener);
  });
}

async function until(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("the desktop's server waits at the relay with credentials it was handed, and stops when they are taken back", async () => {
  const relay = await standInRelay();
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "twoody-desktop-handshake-"));
  const child = fork(join(root, "src/index.ts"), [], {
    cwd: root,
    execArgv: ["--import", "tsx", "--import", join(root, "test/fixtures/parentPort.mjs")],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TWOODY_DATA_DIR: dataDir,
      TWOODY_LOCAL_ONLY: "1",
      TWOODY_TUNNEL: "1",
      TWOODY_BONJOUR_DISABLED: "1",
      // What the desktop sets: never a token in the environment.
      TWOODY_USER_TOKEN: "",
      TWOODY_BACKEND_URL: "",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  let stderr = "";
  child.stderr?.on("data", (chunk) => (stderr += chunk));

  try {
    await nextMessage(child, (m) => m.type === "tunnel-ready", "the server to say it listens");

    child.send({ type: "tunnel", backendUrl: `${relay.url}/`, userToken: "jeton-du-compte", deviceToken: "cet-ordinateur" });
    // Nobody paired: nothing waits at the relay, so nothing is known of it.
    assert.deepEqual(await nextMessage(child, (m) => m.type === "tunnel", "the tunnel's first report"), {
      type: "tunnel",
      running: true,
      paired: 0,
      relay: null,
    });
    assert.deepEqual(relay.hits, [], "nobody paired: nothing to wait for, nothing sent");

    // A phone pairs on this network while the tunnel runs.
    const setupToken = readFileSync(join(dataDir, "setup-token"), "utf8").trim();
    const reported = nextMessage(child, (m) => m.type === "tunnel" && m.paired === 1, "the pairing to be reported");
    const answered = nextMessage(child, (m) => m.type === "tunnel" && m.relay === "answering", "the relay's answer to be reported");
    const pairing = await fetch(`http://127.0.0.1:${port}/auth/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ setup_token: setupToken, device_name: "iPhone de Jimmy", tunnel_public_key: "c3".repeat(32) }),
    });
    assert.equal(pairing.status, 201);
    assert.deepEqual(await reported, { type: "tunnel", running: true, paired: 1, relay: null });
    // The first wait is short, so whether the relay answers is known at once.
    assert.deepEqual(await answered, { type: "tunnel", running: true, paired: 1, relay: "answering" });

    // And from then on it waits at the relay — there only, with the
    // credentials it was handed.
    await until(() => relay.hits.length >= 1, "the first wait at the relay");
    for (const hit of relay.hits) {
      assert.equal(hit.method, "GET");
      assert.match(hit.path, /^\/api\/v1\/tunnel\/frames\?rendezvous=[0-9a-f]{32}&as=host&wait=(1|25)$/);
      assert.equal(hit.token, "jeton-du-compte");
      assert.equal(hit.device, "cet-ordinateur");
      // So a refused session comes back as a 401, not a sign-in page.
      assert.equal(hit.accept, "application/json");
    }

    // Signed out on the desktop: the credentials are taken back.
    child.send({ type: "tunnel" });
    assert.deepEqual(await nextMessage(child, (m) => m.type === "tunnel" && m.running === false, "the stop to be reported"), {
      type: "tunnel",
      running: false,
      paired: 0,
      relay: null,
    });
    // The poll in flight may land; nothing after it.
    await new Promise((resolve) => setTimeout(resolve, 400));
    const settled = relay.hits.length;
    await new Promise((resolve) => setTimeout(resolve, 600));
    assert.equal(relay.hits.length, settled, "it stopped knocking at the relay");
  } catch (err) {
    if (stderr) console.error(stderr);
    throw err;
  } finally {
    child.kill();
    relay.server.closeAllConnections();
    await new Promise((resolve) => relay.server.close(resolve));
  }
});

// The desktop used to call its server ready as soon as something answered
// /health on the port it picked. Another Twoody on the same Mac, already
// on that port on 0.0.0.0, answered first — before this one had even
// written its setup token — and the desktop asked it for a session: 422,
// "Could not open a session on the embedded server". The desktop now waits
// for its own child to say it listens.
test("started as the desktop starts it, the server says it listens — its setup token already written", async () => {
  const port = await freePort();
  const dataDir = mkdtempSync(join(tmpdir(), "twoody-desktop-listening-"));
  const child = fork(join(root, "src/index.ts"), [], {
    cwd: root,
    execArgv: ["--import", "tsx", "--import", join(root, "test/fixtures/parentPort.mjs")],
    env: {
      ...process.env,
      HOST: "127.0.0.1",
      PORT: String(port),
      TWOODY_DATA_DIR: dataDir,
      TWOODY_LOCAL_ONLY: "1",
      // No tunnel: the announcement does not depend on it.
      TWOODY_TUNNEL: "",
      TWOODY_BONJOUR_DISABLED: "1",
      TWOODY_USER_TOKEN: "",
      TWOODY_BACKEND_URL: "",
      LOG_LEVEL: "warn",
    },
    stdio: ["ignore", "ignore", "pipe", "ipc"],
  });
  try {
    assert.deepEqual(await nextMessage(child, (m) => m.type === "listening", "the server to say it listens"), { type: "listening", port });
    assert.ok(readFileSync(join(dataDir, "setup-token"), "utf8").trim().length > 0);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`)).status, 200);
  } finally {
    child.kill("SIGTERM");
    rmSync(dataDir, { recursive: true, force: true });
  }
});
