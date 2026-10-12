import { parentPort, workerData } from "node:worker_threads";
import { encryptDatabaseFile } from "./dbCipher.js";

// dbOpen.ts: database files encrypted off the server's event loop — the
// migration backups earlier versions wrote in clear, one after the other,
// and the database itself at its first start with a key, so that its steps
// reach the Desktop while it runs (the Desktop shows them). Never imports
// db.ts: the database the server runs on is not opened here.

const { paths, hex } = workerData as { paths: string[]; hex: string };
for (const path of paths) {
  const result = encryptDatabaseFile(path, hex, {
    onPhase: (phase, bytes) => parentPort?.postMessage({ type: "phase", path, phase, bytes }),
  });
  parentPort?.postMessage({ type: "result", path, result });
}
