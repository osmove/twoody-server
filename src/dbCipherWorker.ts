import { parentPort, workerData } from "node:worker_threads";
import { encryptDatabaseFile } from "./dbCipher.js";

// dbOpen.ts encryptClearBackups: the migration backups earlier versions
// wrote in clear, encrypted one after the other off the server's event loop.
// Never imports db.ts: the database the server runs on is not opened here.

const { paths, hex } = workerData as { paths: string[]; hex: string };
for (const path of paths) {
  const result = encryptDatabaseFile(path, hex);
  parentPort?.postMessage({ path, result });
}
