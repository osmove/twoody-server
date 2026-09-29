#!/usr/bin/env node
import { buildApp } from "./app.js";
import { ensureSetupToken, getActivePairingCode } from "./auth.js";
import { startBonjour } from "./bonjour.js";
import { readBridgeClientEnv, startBridgeClient } from "./bridgeClient.js";
import { db, users } from "./db.js";
import { LOCAL_ONLY, isPrivateUrl } from "./outbound.js";
import {
  readTunnelEnv,
  startTunnelService,
  tunnelCredentialsFrom,
  type TunnelParentPort,
  type TunnelService,
} from "./tunnel/index.js";
import { adminToken } from "./adminAccess.js";
import { reindex } from "./documents/library.js";
import { startUsageMaintenance } from "./usageStore.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

// twoody-server is the single-user "Twoody Local" edition. Refuse to
// boot when bound publicly with more than one auth account on disk —
// that combination is a multi-user deployment for which clients should
// use Twoody Self-hosted (Rails). Failing fast here is gentler than
// silently shipping a server that has no rate limiting, no encrypted
// AR fields, and no admin audit trail.
function enforceSingleUserGuard() {
  const isPubliclyBound = HOST === "0.0.0.0" || HOST === "::";
  if (!isPubliclyBound) return;
  const userCount = db.select().from(users).all().length;
  if (userCount <= 1) return;
  console.error(
    `[twoody-server] Refusing to start: HOST=${HOST} with ${userCount} ` +
    `accounts in the local DB. twoody-server is single-user — multi-user ` +
    `deployments must use Twoody Self-hosted (Rails). ` +
    `See https://twoody.com/products/server`,
  );
  process.exit(1);
}

enforceSingleUserGuard();

const app = await buildApp();
const setupToken = ensureSetupToken();
// The answers kept before usage_events existed, copied once; the machine's
// load samples thinned out now and every hour.
startUsageMaintenance((message) => console.log(`  ${message}`));

// Read the version off package.json so Bonjour TXT records stamp
// the right release without us hand-bumping a string in two places.
function readPackageVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf-8"));
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\nTwoody Server ready on http://${HOST}:${PORT}\n`);
  if (LOCAL_ONLY) {
    console.log("  Local-only mode: calls outside this machine / the private network are refused.\n");
  }
  const admin = adminToken();
  if (!admin) {
    console.log("  Admin page: this machine only. Set TWOODY_ADMIN_TOKEN to open it from another device.\n");
  } else if (admin.length < 16) {
    console.log("  Admin page: TWOODY_ADMIN_TOKEN is shorter than 16 characters — pick a longer one.\n");
  }
  if (setupToken) {
    console.log("  First local account setup required.");
    console.log(`  Setup token: ${setupToken.token}`);
    console.log(`  Stored at: ${setupToken.path}\n`);
  }

  const activePairingCode = getActivePairingCode();
  if (activePairingCode) {
    console.log(`  Pairing code: ${activePairingCode}`);
    console.log("  (8-character code for `twoody setup` or device pairing)\n");
  } else if (process.env.TWOODY_PAIRING_CODE) {
    console.log("  Ignoring TWOODY_PAIRING_CODE: expected 8 uppercase alphanumeric characters.\n");
  }

  // Advertise the server on the LAN so the RN app's "Discover" button
  // can find it without the user typing an IP. Best-effort — failures
  // here don't affect the HTTP listener, the user can always fall
  // back to manual URL entry. Set TWOODY_BONJOUR_DISABLED=1 to skip
  // (useful in CI / Docker bridge networks where mDNS can't reach
  // the host).
  let bonjour: { stop(): Promise<void> } | null = null;
  if (process.env.TWOODY_BONJOUR_DISABLED !== "1") {
    try {
      bonjour = startBonjour({
        port:    PORT,
        version: readPackageVersion(),
        paired:  setupToken == null,
      });
      console.log(`  Advertised on the network as _twoody._tcp.\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Bonjour advertisement failed (${message}); manual URL entry still works.\n`);
    }
  }

  // Bridge client — long-polls an upstream Twoody backend so the
  // backend's smart_home_proxy / Mac-Bridge tasks land on this LAN.
  // Inert unless TWOODY_BACKEND_URL + TWOODY_USER_TOKEN +
  // HOME_ASSISTANT_URL + HOME_ASSISTANT_TOKEN are all set. Failures
  // here don't affect the HTTP listener; the user can drop the
  // backend env vars to disable it.
  const bridgeOpts = readBridgeClientEnv();
  // The bridge client ships document text, LLM output and Home
  // Assistant state to its upstream backend, so local-only mode keeps
  // it off unless that backend is itself on the private network.
  const bridgeAllowed =
    !bridgeOpts || !LOCAL_ONLY || (await isPrivateUrl(bridgeOpts.backendUrl));
  if (bridgeOpts && !bridgeAllowed) {
    console.log(`  Local-only mode: bridge client to ${bridgeOpts.backendUrl} not started.\n`);
  }
  const bridgeClient = bridgeOpts && bridgeAllowed ? startBridgeClient(bridgeOpts) : null;
  if (bridgeClient) {
    const caps = bridgeOpts!.capabilities?.length ? bridgeOpts!.capabilities.join(",") : "<none>";
    console.log(`  Bridge client connected to ${bridgeOpts!.backendUrl} (device id ${bridgeClient.deviceId.slice(0, 8)}…, capabilities: ${caps})\n`);
  }

  // The tunnel, when it is asked for: one wait at the relay per device
  // paired on this network, so a phone away from home reaches this
  // server without a port being opened on it. Off by default. In
  // local-only mode it is the one thing allowed out, through the one
  // door that mode has: the relay's frames endpoint, carrying frames the
  // relay cannot open (outbound.ts, `relayFetch`).
  const localBaseUrl = `http://127.0.0.1:${PORT}`;
  const onTunnelError = (err: unknown) => app.log.debug({ err }, "tunnel");
  const announceTunnel = (service: TunnelService) => {
    const paired = service.links.length;
    const through = LOCAL_ONLY ? `, and local-only lets out nothing but sealed frames to ${service.relay}` : ` via ${service.relay}`;
    console.log(
      paired > 0
        ? `  Reachable from outside for ${paired} paired device(s)${through}.\n`
        : `  Tunnel waiting at ${service.relay}: no device is paired for it yet. Pair one on this network first.\n`,
    );
  };
  const tunnelOptions = readTunnelEnv(localBaseUrl);
  let tunnel: TunnelService | null = null;
  if (tunnelOptions) {
    tunnel = startTunnelService({ ...tunnelOptions, onError: onTunnelError });
    announceTunnel(tunnel);
  }

  // Twoody Desktop runs this server as a utility process and hands it
  // the account's credentials by message rather than through the
  // environment, where any process of the same user could read them.
  // TWOODY_TUNNEL=1 is still what opts in: a server started without it
  // ignores the message.
  const parentPort = (process as unknown as { parentPort?: TunnelParentPort }).parentPort;
  if (parentPort && process.env.TWOODY_TUNNEL === "1") {
    parentPort.on("message", ({ data }) => {
      if ((data as { type?: unknown } | null)?.type !== "tunnel") return;
      tunnel?.stop();
      tunnel = null;
      const credentials = tunnelCredentialsFrom(data);
      // What the desktop shows: whether the tunnel runs, how many devices
      // it waits for, and what the relay says — each of which can change
      // while it runs.
      const report = () =>
        parentPort.postMessage({
          type: "tunnel",
          running: tunnel !== null,
          paired: tunnel?.links.length ?? 0,
          relay: tunnel?.relayState ?? null,
        });
      if (credentials) {
        tunnel = startTunnelService({
          ...credentials,
          localBaseUrl,
          onError: onTunnelError,
          onLinksChanged: report,
          onRelayStateChanged: report,
        });
        announceTunnel(tunnel);
      }
      report();
    });
    // Said once the listener exists, so the credentials are not sent to a
    // process that is not listening yet — the same handshake the bridge
    // worker uses.
    parentPort.postMessage({ type: "tunnel-ready" });
  }

  // Twoody Desktop waits for this, from its own child, before it opens a
  // session. An answer on the port proves nothing: another Twoody on the
  // same Mac, already there on 0.0.0.0, answered /health before this one
  // had started, and the desktop asked it for a session (422).
  parentPort?.postMessage({ type: "listening", port: PORT });

  // Catch up with files added or changed while the server was off. A
  // few seconds after boot, so first requests are not competing with it.
  setTimeout(() => {
    for (const { id } of db.select({ id: users.id }).from(users).all()) {
      void reindex(id).catch((err) => app.log.error(err, "document indexing failed"));
    }
  }, 3_000).unref();

  // Graceful shutdown so the mDNS cache doesn't keep stale entries
  // for ~75 s after we exit. SIGINT (Ctrl-C) and SIGTERM (launchd /
  // Docker) both get the cleanup; uncaught exits skip it on purpose
  // since `service.stop` is async and we'd be racing the OS exit.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
      try {
        bridgeClient?.stop();
      } catch {
        // Best-effort.
      }
      try {
        tunnel?.stop();
      } catch {
        // Best-effort.
      }
      try {
        await bonjour?.stop();
      } catch {
        // Best-effort.
      }
      try {
        await app.close();
      } catch {
        // Best-effort.
      }
      process.exit(0);
    });
  }
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
