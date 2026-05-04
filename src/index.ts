#!/usr/bin/env node
import { buildApp } from "./app.js";
import { ensureSetupToken, getActivePairingCode } from "./auth.js";
import { startBonjour } from "./bonjour.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();
const setupToken = ensureSetupToken();

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

  // Graceful shutdown so the mDNS cache doesn't keep stale entries
  // for ~75 s after we exit. SIGINT (Ctrl-C) and SIGTERM (launchd /
  // Docker) both get the cleanup; uncaught exits skip it on purpose
  // since `service.stop` is async and we'd be racing the OS exit.
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, async () => {
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
