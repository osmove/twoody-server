import { homedir } from "node:os";
import { join } from "node:path";
import { refusalToStart } from "./dataAtRest.js";

// Imported before anything that opens the database (db.ts makes DATA_DIR
// as it loads): with TWOODY_DATA_ENCRYPTION=require, a server whose data
// folder is not on an encrypted volume — that volume not mounted yet,
// typically — stops here, before a key or a row is written on the disk
// underneath (dataAtRest.ts, docs/encrypted-storage.md).

const refusal = refusalToStart(process.env, process.env.TWOODY_DATA_DIR ?? join(homedir(), ".twoody", "data"));
if (refusal) {
  console.error(`Twoody Server did not start: ${refusal}`);
  process.exit(78); // EX_CONFIG: systemd does not hammer a restart on it with RestartPreventExitStatus=78.
}
