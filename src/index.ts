#!/usr/bin/env node
import { buildApp } from "./app.js";
import { ensureSetupToken, getActivePairingCode } from "./auth.js";

const PORT = parseInt(process.env.PORT ?? "3000", 10);
const HOST = process.env.HOST ?? "0.0.0.0";

const app = await buildApp();
const setupToken = ensureSetupToken();

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
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
