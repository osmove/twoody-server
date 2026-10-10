#!/usr/bin/env node
// First: failures are written down from here on (crashReports.ts).
import "./crashReports.js";
import { buildApp } from "./app.js";
import { ensureSetupToken, getActivePairingCode } from "./auth.js";
import { startBonjour } from "./bonjour.js";
import { readBridgeClientEnv, startBridgeClient } from "./bridgeClient.js";
import { serveShareInProcess } from "./shares/serve.js";
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
import { setLocalPort } from "./account/approvals.js";
import { linkState, linkView, onLinkChanged } from "./account/link.js";
import { setDesktopAccount, startAccountService } from "./account/service.js";
import { ensureAccountFile, fingerprint } from "./account/store.js";
import { startMachineSampler } from "./machineSampler.js";
import { isFresh } from "./pairing.js";
import { startMeshLinks, startPeerStatusPoller } from "./peers/index.js";
import { startRosterRefresh } from "./vault/roster.js";
import { desktopVaultAccount } from "./vault/desktopAccount.js";
import { relayAccountThroughDesktop, relayShareCallsThroughDesktop } from "./account/desktopRelay.js";
import { sealDiscussionTitle, setDesktopVault, startVaultService } from "./vault/service.js";
import { startMemorySync } from "./vault/memories.js";
import { startMemoryWork } from "./memory/changes.js";
import { startLearning } from "./memory/learner.js";
import { startEmailSync } from "./email/sync.js";
import { startMicrosoftGraphSync } from "./microsoft/sync.js";
import { onTitled, startTitles } from "./discussionTitles.js";
import { builtinAddress, initEngine, preloadBuiltin, stopEngine } from "./engine.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";
setLocalPort(PORT);

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

// The engine (« Moteur », docs/builtin-runtime-design.md): the built-in
// llama.cpp runtime this server runs by itself — never started here, only
// on a chat to it — and the preference that chooses it. The Desktop runs
// its own (TWOODY_RUNTIME_OWNER=desktop, or this is its utility process).
const desktopChild = Boolean((process as unknown as { parentPort?: unknown }).parentPort);
const runtimeEngine = initEngine({ desktop: desktopChild, log: (line) => console.log(`  ${line}`) });
const migrated = (() => {
  try {
    return runtimeEngine.prefs.migrate();
  } catch (err) {
    console.warn(`  Could not write ${runtimeEngine.prefs.path}: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
})();

const app = await buildApp();
const setupToken = ensureSetupToken();
// The answers kept before model calls were recorded, copied once; the machine's
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
  if (!runtimeEngine.managedByDesktop) {
    const { prefs, source } = runtimeEngine.prefs.read();
    const installed = runtimeEngine.manager.available();
    const models = installed ? await runtimeEngine.manager.installedModels() : [];
    const described = prefs.engine === "custom" ? `custom (${prefs.custom_url ?? "no address"})` : prefs.engine;
    const why = source === "env" ? " (TWOODY_RUNTIME)" : migrated?.written && prefs.engine !== "auto" ? " (from BRIDGE_LOCAL_LLM_ENDPOINT, kept from before the built-in engine)" : "";
    console.log(`  Engine: ${described}${why}; twoody-server config set runtime=… changes it.`);
    console.log(
      installed
        ? `  Built-in llama.cpp runtime: installed, ${models.length} model(s)${models.length ? ` (${models.join(", ")})` : ": twoody-server models add <id>"}; ${prefs.builtin.preload === false || !["builtin", "auto"].includes(prefs.engine) ? "started on the first question" : "the default model loads now, in the background"}.\n`
        : "  Built-in llama.cpp runtime: not installed (twoody-server runtime install).\n",
    );
    if (installed) {
      void builtinAddress().catch(() => undefined);
      // The default model, loaded in the background now that the server
      // answers, and kept in memory when there is room (engine.ts).
      void preloadBuiltin({ log: (line) => console.log(`  ${line}`) });
    }
  }
  const admin = adminToken();
  if (!admin) {
    console.log(`  Admin page: this machine only, at http://127.0.0.1:${PORT}/admin. Set TWOODY_ADMIN_TOKEN to open it from another device.\n`);
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
  // The TXT record says whether this server is in an account, and the
  // fingerprint of its pairing key: published again when that changes.
  const advertise = (announce: boolean) => {
    try {
      bonjour = startBonjour({
        port:    PORT,
        version: readPackageVersion(),
        paired:  setupToken == null,
        account: linkState() === "linked" ? "linked" : "unlinked",
        fp:      fingerprint(ensureAccountFile()),
      });
      if (announce) console.log(`  Advertised on the network as _twoody._tcp.\n`);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.warn(`  Bonjour advertisement failed (${message}); manual URL entry still works.\n`);
    }
  };
  if (process.env.TWOODY_BONJOUR_DISABLED !== "1") {
    advertise(true);
    let advertised = linkState() === "linked";
    onLinkChanged((state) => {
      if ((state === "linked") === advertised) return;
      advertised = state === "linked";
      const previous = bonjour;
      bonjour = null;
      void (previous?.stop() ?? Promise.resolve()).then(() => advertise(false));
    });
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
  // Requests on folders shared from this computer are served here, by this
  // very server (shares/serve.ts): it holds the documents.
  const bridgeClient = bridgeOpts && bridgeAllowed ? startBridgeClient({ ...bridgeOpts, serveShare: serveShareInProcess }) : null;
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

  // A server in a Twoody account (account.json, `twoody-server login`):
  // heartbeat with its status, approvals by its rules, bridge and tunnel
  // (account/service.ts). Inert while it is not linked.
  const accountService = startAccountService({
    localBaseUrl,
    log: (message) => console.log(`  ${message}`),
    onTunnelError: (err) => app.log.debug({ err }, "tunnel"),
  });
  // The code is shown here, on this computer's console, and nowhere on the
  // network: the person reads it here and types it on the Desktop, the
  // app or twoody.com/appareil.
  const linkedTo = () => {
    const view = linkView();
    return `${view.account ? `the Twoody account ${view.account}` : "a Twoody account"}${view.account_computer_id ? ` (computer ${view.account_computer_id})` : ""}`;
  };
  onLinkChanged((state) => {
    if (state === "linked") console.log(`  Linked to ${linkedTo()}.\n`);
    else if (state === "unlinked") console.log("  Not linked to a Twoody account.\n");
    else if (state === "pending") {
      const view = linkView();
      if (view.user_code) console.log(`  To add this server to your Twoody account, enter the code ${view.user_code} at ${view.verification_uri ?? "https://twoody.com/appareil"} (or in Twoody Desktop, or the Twoody app, with the one-time secret ${view.approval_secret}), until ${new Date(view.expires_at!).toLocaleTimeString()}.\n`);
    }
  });
  if (linkState() === "linked") {
    console.log(`  Linked to ${linkedTo()}: heartbeat, approvals, bridge and tunnel on.\n`);
  } else if (isFresh()) {
    console.log("  To add this server to your Twoody account: twoody-server login\n");
  }
  // The account's other computers this one sends questions to: their
  // status every 20 s, for the router.
  const stopPeerPoller = startPeerStatusPoller(() => db.select({ id: users.id }).from(users).all().map((u) => u.id));
  // The mesh (docs/mesh-design.md §1): the verified vault roster, looked at
  // every minute; links asked for to its computers, and what leaves it
  // loses its links and sessions here.
  const stopMeshLinks = startMeshLinks(() => db.select({ id: users.id }).from(users).all().map((u) => u.id));
  const stopRoster = startRosterRefresh();
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
  // The machine's load, when no Desktop measures it (it posts its own
  // samples to /usage/samples): a Raspberry Pi, a NAS.
  const sampler = parentPort || process.env.TWOODY_MACHINE_SAMPLER === "0" ? null : startMachineSampler({ log: (message) => app.log.debug(message) });
  // The Desktop's account, for the account's computers (/providers
  // `computers`, /api/v1/peers, the router): in the tunnel message, or on
  // its own ({type:"account", backendUrl, userToken, deviceToken,
  // computerId, computerName}) — whether or not the tunnel is on.
  const desktopAccount = (data: unknown) => {
    const credentials = tunnelCredentialsFrom(data);
    const extra = (data ?? {}) as { computerId?: unknown; computerName?: unknown };
    const computerId = typeof extra.computerId === "string" || typeof extra.computerId === "number" ? String(extra.computerId) : null;
    setDesktopAccount(
      credentials
        ? {
            backendUrl: credentials.backendUrl,
            userToken: credentials.userToken,
            deviceToken: credentials.deviceToken,
            computerId,
            computerName: typeof extra.computerName === "string" ? extra.computerName.slice(0, 100) : null,
          }
        : null,
    );
  };
  if (parentPort) {
    // The vault's calls to the account go through the Desktop, which
    // speaks to it anyway: this server stays local-only (vault/desktopAccount.ts).
    const vaultAccount = desktopVaultAccount(parentPort);
    // And so do the mesh's: the account's computers, request_access and its
    // answer (account/desktopRelay.ts).
    relayAccountThroughDesktop(parentPort);
    // And the requests on folders shared with the person, which the Desktop
    // seals with the person's device keys (shares/guest.ts).
    relayShareCallsThroughDesktop(parentPort);
    parentPort.on("message", ({ data }) => {
      const type = (data as { type?: unknown } | null)?.type;
      if (type === "account" || type === "tunnel") desktopAccount(data);
      // The Desktop's vault keys, held in memory only (src/vault/service.ts).
      if (type === "vault") setDesktopVault(data, vaultAccount);
    });
  }
  // A headless computer in an account is a member of the encrypted history
  // once a person device approves it (docs/mesh-design.md §1): inert while
  // it is not linked. Inside Twoody Desktop the Desktop holds the keys.
  const vaultService = parentPort ? null : startVaultService({ log: (message) => console.log(`  ${message}`) });
  // Memories through the vault's own stream (lot S5), in both modes: with
  // this computer's keys, or the ones Twoody Desktop handed over. Inert
  // while this computer is no trusted member.
  const memorySync = startMemorySync({ log: (message) => console.log(`  ${message}`) });
  // The memories' links to their entities and their vectors (Mémoire v2),
  // for what was written before they existed: a while after start.
  const memoryWork = startMemoryWork();
  // What was said in passing, learned once a conversation is over.
  const learning = startLearning();
  // A new conversation's title, written by the model after its first
  // answer; a synchronised one's sealed for the other devices (headless).
  const titles = startTitles();
  onTitled((discussionId, title) => void sealDiscussionTitle(discussionId, title));
  // The person's mailbox, brought up to date every 10 minutes while
  // E-mails is on and a mailbox is set up (src/email/sync.ts).
  const emailSync = startEmailSync();
  // Outlook's calendar and contacts, read every 15 minutes while Agenda or
  // Contacts is on and the person linked their account (src/microsoft/).
  const graphSync = startMicrosoftGraphSync();
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
        accountService.stop();
        vaultService?.stop();
        memorySync.stop();
        memoryWork.stop();
        learning.stop();
        titles.stop();
        emailSync.stop();
        graphSync.stop();
        stopPeerPoller();
        stopMeshLinks();
        stopRoster();
        sampler?.stop();
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
      // The built-in runtime goes with the server (a unit's KillMode and a
      // container's init stop it too, should this not get to run).
      try {
        await stopEngine();
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
